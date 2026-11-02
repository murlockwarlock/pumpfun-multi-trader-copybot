import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LiveEngine } from "../src/live-engine.js";

function liveConfig(directory, overrides = {}) {
  return {
    tradingMode: "live",
    liveStateFile: path.join(directory, "state.json"),
    liveLogFile: path.join(directory, "trades.jsonl"),
    liveKillSwitchFile: path.join(directory, "STOP"),
    liveAutoPauseFile: path.join(directory, "AUTO_PAUSE_BUYS"),
    maxSignalAgeMs: 5_000,
    maxOpenPositions: 1,
    liveTradeSol: 0.005,
    liveMaxDailySpendSol: 0.03,
    liveMinReserveSol: 0.02,
    livePriorityFeeSol: 0.0001,
    liveTipSol: 0.000005,
    liveMaxHoldMs: 3_600_000,
    liveMaxEntryDriftBps: 500,
    fastMaxSignalAgeMs: 1_500,
    fastMaxEntryDriftBps: 2_500,
    fastSkipSimulation: true,
    ...overrides
  };
}

function concurrentFixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-concurrent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = new LiveEngine(liveConfig(dir, overrides), () => {});
  const never = new Promise(() => {});
  const calls = [];
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    prepare: async (side, mint, raw, options) => {
      calls.push({ side, mint, options });
      return { expectedSignature: side + mint, mint: new PublicKey(mint), tokenProgram: TOKEN_PROGRAM_ID,
        venue: "pump-curve", beforeTokenBalance: side === "BUY" ? 0n : 50n, lastValidBlockHeight: 123 };
    },
    submit: async prepared => prepared.expectedSignature,
    waitForTokenBalanceChange: () => never, confirm: () => never,
    tokenBalance: async () => 100n
  };
  const buy = () => {
    const mint = Keypair.generate().publicKey.toBase58();
    return { side: "BUY", mint, signature: mint, observedAtMs: Date.now(), signalSource: "processed_logs" };
  };
  return { engine, calls, buy };
}

for (const [reason, limits] of [
  ["max_open_positions", { maxOpenPositions: 1 }],
  ["daily_spend_limit", { maxOpenPositions: 2, liveMaxDailySpendSol: 0.005 }]
]) {
  test("concurrent preparation respects " + reason, async t => {
    const { engine, buy, calls } = concurrentFixture(t, limits);
    const results = await Promise.all([engine.onTrade(buy()), engine.onTrade(buy())]);
    assert.equal(calls.length, 1);
    assert.ok(results.some(r => r.reason === reason));
    assert.ok(results.some(r => r.type === "LIVE_SUBMITTED"));
  });
}

test("two live mints overlap in prepare and submit", { timeout: 3000 }, async t => {
  const { engine, buy } = concurrentFixture(t, { maxOpenPositions: 2 });
  for (const stage of ["prepare", "submit"]) {
    const implementation = engine.executor[stage];
    const both = Promise.withResolvers();
    let count = 0;
    engine.executor[stage] = async (...args) => {
      if (++count === 2) both.resolve();
      await both.promise;
      return implementation(...args);
    };
  }
  const results = await Promise.all([engine.onTrade(buy()), engine.onTrade(buy())]);
  assert.ok(results.every(r => r.type === "LIVE_SUBMITTED"));
});

test("pending exit survives duplicate signals and adjusted SELL uses processed", async t => {
  const { engine, buy, calls } = concurrentFixture(t);
  const tokens = Promise.withResolvers();
  engine.executor.waitForTokenBalanceChange = () => tokens.promise;
  const entry = buy();
  await engine.onTrade(entry);
  const exit = { ...entry, signature: "exit", side: "SELL" };
  assert.equal((await engine.onTrade(exit)).type, "LIVE_EXIT_PENDING");
  assert.equal((await engine.onTrade(exit)).reason, "exit_already_pending");
  const dispatch = engine.pendingExits.get(entry.mint);
  const release = Promise.withResolvers();
  const competing = engine.lanes.run(entry.mint, () => release.promise);
  tokens.resolve(100n);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.side === "SELL").length, 0);
  release.resolve();
  await competing;
  await dispatch;
  const sells = calls.filter(call => call.side === "SELL");
  assert.equal(sells.length, 2);
  assert.ok(sells.every(call => call.options.balanceCommitment === "processed"));
  assert.equal(engine.state.handledSignals.filter(s => s.side === "SELL").length, 1);
});

test("explicit SELL rejection allows immediate exit retry", async t => {
  const { engine, buy } = concurrentFixture(t);
  const trade = { ...buy(), side: "SELL" };
  engine.state.setPosition({ mint: trade.mint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), rawTokenAmount: "50" });
  engine.executor.submit = async () => { throw Error("simulation failed"); };
  assert.equal((await engine.onTrade(trade)).type, "LIVE_FAILED");
  assert.equal(engine.state.handledSignals.at(-1).status, "submit_rejected");
  engine.executor.submit = async p => p.expectedSignature;
  assert.equal((await engine.onTrade({ ...trade, signature: "emergency" })).type, "LIVE_SUBMITTED");
});

test("ambiguous submit persists signature, suppresses rebroadcast and reconciles after restart", async t => {
  const { engine, buy } = concurrentFixture(t);
  const trade = buy();
  let sends = 0;
  engine.executor.submit = async () => { sends++; throw Error("timeout"); };
  const result = await engine.onTrade(trade);
  assert.equal(result.type, "LIVE_SUBMIT_UNKNOWN");
  assert.equal(result.signature, "BUY" + trade.mint);
  assert.equal((await engine.onTrade(trade)).reason, "signal_already_handled");
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = { ...engine.executor, currentBlockHeight: async () => 100,
    signatureStatus: async sig => { assert.equal(sig, result.signature); return { confirmationStatus: "confirmed" }; } };
  await restored.maintenanceTrades();
  assert.equal(restored.positions.get(trade.mint).entrySignature, result.signature);
  assert.equal((await restored.onTrade(trade)).reason, "signal_already_handled");
  assert.equal(sends, 1);
});

test("two resolved mints share source signature and dedupe independently", async t => {
  const { engine, buy } = concurrentFixture(t, { maxOpenPositions: 2 });
  const trades = [buy(), buy()].map(trade => ({ ...trade, signature: "sourceTx", sourceWallet: "wallet" }));
  for (const trade of trades) assert.equal((await engine.onTrade(trade)).type, "LIVE_SUBMITTED");
  for (const trade of trades) assert.equal((await engine.onTrade(trade)).reason, "signal_already_handled");
});

test("returns after live submission while confirmation settles in the background", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-engine-"));
  let releaseConfirmation;
  const confirmation = new Promise((resolve) => {
    releaseConfirmation = resolve;
  });
  const mint = Keypair.generate().publicKey;
  const config = liveConfig(directory);
  const engine = new LiveEngine(config, () => {});
  let prepareOptions;
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    prepare: async (_side, _mint, _rawAmount, options) => {
      prepareOptions = options;
      return ({
      expectedSignature: "copy-signature",
      mint: new PublicKey(mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve",
      beforeTokenBalance: 0n,
      lastValidBlockHeight: 123
      });
    },
    submit: async () => "copy-signature",
    confirm: async () => confirmation,
    tokenBalance: async () => 100n
  };

  try {
    const startedAt = Date.now();
    const result = await engine.onTrade({
      signature: "target-signature",
      side: "BUY",
      mint: mint.toBase58(),
      blockTime: Math.floor(Date.now() / 1_000),
      observedAtMs: Date.now(),
      signalSource: "processed_logs",
      executionRoute: "jupiter"
    });
    assert.equal(result.type, "LIVE_SUBMITTED");
    assert.equal(prepareOptions.executionRoute, "jupiter");
    assert.ok(Date.now() - startedAt < 200);
    for (let attempt = 0; attempt < 20 && engine.positions.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(engine.positions.size, 1);
    assert.equal(engine.positions.get(mint.toBase58()).provisional, true);

    releaseConfirmation("confirmed");
    for (
      let attempt = 0;
      attempt < 20 && engine.positions.get(mint.toBase58())?.provisional;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(engine.positions.get(mint.toBase58()).rawTokenAmount, "100");
    assert.equal(engine.positions.get(mint.toBase58()).provisional, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("submits an early SELL from the processed BUY balance before BUY confirmation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-early-sell-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  const buyConfirmation = new Promise(() => {});
  const sellConfirmation = new Promise(() => {});
  const submissions = [];
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    waitForTokenBalanceChange: async () => 100n,
    tokenBalance: async (_mint, _program, commitment) => {
      assert.equal(commitment, "processed");
      return 100n;
    },
    prepare: async (side, _mint, _rawAmount, options) => ({
      expectedSignature: side === "BUY" ? "copy-buy" : "copy-sell",
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 100n,
      lastValidBlockHeight: 123,
      expectedTokenOutRaw: side === "BUY" ? "100" : null,
      tokenDecimals: 0,
      balanceCommitment: options.balanceCommitment
    }),
    submit: async (prepared) => {
      submissions.push(prepared.expectedSignature);
      return prepared.expectedSignature;
    },
    confirm: async (signature) => signature === "copy-buy"
      ? buyConfirmation
      : sellConfirmation
  };

  try {
    const buy = await engine.onTrade({
      signature: "target-buy",
      side: "BUY",
      mint: mint.toBase58(),
      averagePriceSol: 0.00004,
      observedAtMs: Date.now(),
      signalSource: "processed_logs",
      fastProfile: true
    });
    assert.equal(buy.type, "LIVE_SUBMITTED");
    for (let attempt = 0; attempt < 20 && engine.positions.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(engine.positions.get(mint.toBase58()).provisional, true);

    const sell = await engine.onTrade({
      signature: "target-sell",
      side: "SELL",
      mint: mint.toBase58(),
      observedAtMs: Date.now(),
      signalSource: "processed_logs"
    });
    assert.equal(sell.type, "LIVE_SUBMITTED");
    assert.equal(sell.signature, "copy-sell");
    assert.deepEqual(submissions, ["copy-buy", "copy-sell"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manual BUY pause never blocks an emergency SELL", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-pause-"));
  const mint = Keypair.generate().publicKey;
  const config = liveConfig(directory);
  fs.writeFileSync(config.liveKillSwitchFile, "paused\n");
  const engine = new LiveEngine(config, () => {});
  engine.state.setPosition({
    mint: mint.toBase58(),
    rawTokenAmount: "100",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    openedAt: new Date().toISOString(),
    entrySignature: "entry",
    costLamports: "5000000"
  });
  engine.executor = {
    prewarm: async () => {},
    tokenBalance: async () => 100n,
    prepare: async () => ({
      expectedSignature: "sell-signature",
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve",
      beforeTokenBalance: 100n,
      lastValidBlockHeight: 123
    }),
    submit: async () => "sell-signature",
    confirm: async () => new Promise(() => {})
  };
  try {
    const result = await engine.onTrade({
      signature: "target-sell",
      side: "SELL",
      mint: mint.toBase58(),
      blockTime: Math.floor(Date.now() / 1_000),
      observedAtMs: Date.now(),
      signalSource: "processed_logs"
    });
    assert.equal(result.type, "LIVE_SUBMITTED");
    assert.equal(result.side, "SELL");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an entry when our quoted price drift exceeds the cap", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-drift-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let submitted = false;
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    prepare: async () => ({
      expectedSignature: "copy-signature",
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve",
      beforeTokenBalance: 0n,
      lastValidBlockHeight: 123,
      expectedTokenOutRaw: "1000000",
      tokenDecimals: 6
    }),
    submit: async () => { submitted = true; return "copy-signature"; }
  };
  try {
    const result = await engine.onTrade({
      signature: "target-buy-drift",
      side: "BUY",
      mint: mint.toBase58(),
      averagePriceSol: 0.001,
      blockTime: Math.floor(Date.now() / 1_000),
      observedAtMs: Date.now(),
      signalSource: "processed_logs"
    });
    assert.equal(result.type, "LIVE_SKIP");
    assert.match(result.reason, /^entry_price_drift_/);
    assert.equal(submitted, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fast profile uses its own drift window and latency prepare options", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-fast-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let prepareOptions;
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    prepare: async (_side, _mint, _rawAmount, options) => {
      prepareOptions = options;
      return {
        expectedSignature: "fast-copy-signature",
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        venue: "pump-curve",
        beforeTokenBalance: 0n,
        lastValidBlockHeight: 123,
        expectedTokenOutRaw: "1000000",
        tokenDecimals: 6
      };
    },
    submit: async () => "fast-copy-signature",
    confirm: async () => new Promise(() => {}),
    tokenBalance: async () => 100n
  };
  try {
    const result = await engine.onTrade({
      signature: "target-fast-buy",
      side: "BUY",
      mint: mint.toBase58(),
      averagePriceSol: 0.0042,
      observedAtMs: Date.now(),
      signalSource: "processed_logs",
      venue: "pump-curve",
      fastProfile: true
    });
    assert.equal(result.type, "LIVE_SUBMITTED");
    assert.ok(result.entryDriftBps > 1_800 && result.entryDriftBps < 2_000);
    assert.equal(prepareOptions.venueHint, "pump-curve");
    assert.equal(prepareOptions.skipSimulation, true);
    assert.equal(prepareOptions.skipBeforeTokenBalance, true);
    assert.equal(prepareOptions.targetAveragePriceSol, 0.0042);
    assert.equal(prepareOptions.maxEntryDriftBps, 2_500);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("shadow probe measures the actual ready-to-submit quote without sending", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-probe-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let options;
  engine.executor = {
    prepare: async (_side, _mint, _rawAmount, value) => {
      options = value;
      return {
        expectedSignature: "unsigned-probe-only",
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        venue: "pump-curve",
        beforeTokenBalance: 0n,
        lastValidBlockHeight: 123,
        expectedTokenOutRaw: "125000000000",
        tokenDecimals: 6
      };
    }
  };
  try {
    const quote = await engine.probeBuy({
      signature: "target-probe",
      side: "BUY",
      mint: mint.toBase58(),
      averagePriceSol: 0.000000035,
      observedAtMs: Date.now(),
      venue: "pump-curve"
    }, 0.005);
    assert.equal(quote.expectedTokenOutRaw, "125000000000");
    assert.equal(quote.copyPriceSol, 0.005 / 125_000);
    assert.equal(options.skipSimulation, true);
    assert.equal(options.skipBeforeTokenBalance, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("creates a durable max-hold exit request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-hold-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory, { liveMaxHoldMs: 60_000 }), () => {});
  engine.state.setPosition({
    mint: mint.toBase58(),
    rawTokenAmount: "100",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    openedAt: new Date(Date.now() - 120_000).toISOString(),
    entrySignature: "entry",
    costLamports: "5000000"
  });
  engine.executor = {};
  try {
    const trades = await engine.maintenanceTrades();
    assert.equal(trades.length, 1);
    assert.equal(trades[0].side, "SELL");
    assert.equal(trades[0].signalSource, "max_hold");
    const restarted = new LiveEngine(liveConfig(directory, { liveMaxHoldMs: 60_000 }), () => {});
    assert.equal(restarted.positions.get(mint.toBase58()).exitRequest.reason, "max_hold");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restart reconciliation finalizes a durable processed BUY position", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-reconcile-"));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  engine.state.reserveSignal({
    signature: "target-reconcile-buy",
    side: "BUY",
    mint: mint.toBase58()
  }, {
    signature: "copy-reconcile-buy",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "0",
    rawAmount: "5000000",
    lastValidBlockHeight: 123,
    venue: "pump-curve"
  }, 5_000_000n);
  engine.state.updateSignal("target-reconcile-buy", { status: "processed" });
  engine.state.setPosition({
    mint: mint.toBase58(),
    rawTokenAmount: "100",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    openedAt: new Date().toISOString(),
    entrySignature: "copy-reconcile-buy",
    targetEntrySignature: "target-reconcile-buy",
    costLamports: "5000000",
    provisional: true
  });
  engine.executor = {
    signatureStatus: async () => ({ err: null, confirmationStatus: "confirmed" }),
    currentBlockHeight: async () => 100,
    tokenBalance: async () => 100n,
    transactionWalletDelta: async () => ({ walletDeltaLamports: "-5000100" })
  };

  try {
    const trades = await engine.maintenanceTrades();
    assert.deepEqual(trades, []);
    const position = engine.positions.get(mint.toBase58());
    assert.equal(position.provisional, false);
    assert.equal(position.entryWalletDeltaLamports, "-5000100");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("monitor-only traders cannot open live positions", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-monitor-"));
  const mint = Keypair.generate().publicKey.toBase58();
  const engine = new LiveEngine(liveConfig(directory, {
    liveTraderWallets: ["wallet-live"]
  }), () => {});
  try {
    const result = await engine.onTrade({
      signature: "monitor-buy",
      side: "BUY",
      mint,
      sourceWallet: "wallet-monitor",
      sourceName: "monitor"
    });
    assert.equal(result.type, "LIVE_SKIP");
    assert.equal(result.reason, "trader_monitor_only");
    assert.equal(engine.positions.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a sell from another trader cannot close an owned live position", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-owner-"));
  const mint = Keypair.generate().publicKey.toBase58();
  const engine = new LiveEngine(liveConfig(directory, {
    liveTraderWallets: ["wallet-a", "wallet-b"]
  }), () => {});
  engine.state.setPosition({
    mint,
    sourceWallet: "wallet-a",
    sourceName: "trader-a",
    rawTokenAmount: "100",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    openedAt: new Date().toISOString(),
    entrySignature: "entry",
    costLamports: "5000000"
  });
  try {
    const result = await engine.onTrade({
      signature: "wrong-owner-sell",
      side: "SELL",
      mint,
      sourceWallet: "wallet-b",
      sourceName: "trader-b"
    });
    assert.equal(result.type, "LIVE_SKIP");
    assert.equal(result.reason, "position_owned_by_other_trader");
    assert.equal(engine.positions.size, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
