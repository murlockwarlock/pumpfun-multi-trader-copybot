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
        venue: "pump-curve", beforeTokenBalance: side === "BUY" ? 0n : 100n, lastValidBlockHeight: 123 };
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
  engine.executor.processedTokenDelta = () => tokens.promise.then(() => 100n);
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
  assert.equal(sells.length, 1);
  assert.ok(sells.every(call => call.options.balanceCommitment === "processed"));
  assert.equal(engine.state.handledSignals.filter(s => s.side === "SELL").length, 1);
});

test("terminal BUY refunds once across retries and restart; ambiguous BUY keeps budget", async t => {
  const { engine, buy } = concurrentFixture(t, { liveMaxDailySpendSol: 0.005 });
  engine.executor.submit = async () => { throw Error("simulation failed"); };
  let entry;
  for (let i = 0; i < 3; i++) {
    entry = buy();
    assert.equal((await engine.onTrade(entry)).type, "LIVE_FAILED");
    assert.equal(engine.state.dailySpendLamports, 0n);
  }
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = { ...engine.executor, submit: async () => { throw Error("timeout"); } };
  assert.equal((await restored.onTrade(buy())).type, "LIVE_SUBMIT_UNKNOWN");
  restored.state.updateSignal(entry.signature, { status: "submit_rejected" });
  assert.equal(restored.state.dailySpendLamports, 5000000n);
  assert.equal(new LiveEngine(engine.config, () => {}).state.dailySpendLamports, 5000000n);
});

test("unresolved confirmation permits emergency SELL for another mint", {timeout: 2000}, async t => {
  const { engine, buy } = concurrentFixture(t);
  const unresolved = buy();
  engine.state.reserveSignal(unresolved, { signature: "unknown", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawAmount: "50", beforeTokenBalance: "0", lastValidBlockHeight: 100 });
  const status = Promise.withResolvers();
  engine.executor.signatureStatus = () => status.promise;
  engine.executor.currentBlockHeight = async () => 1;
  const other = buy();
  engine.state.setPosition({ mint: other.mint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawTokenAmount: "50", inventoryBaselineRaw: "0", openedAt: new Date(0).toISOString() });
  const [exit] = await engine.maintenanceTrades();
  assert.equal(exit.mint, other.mint);
  assert.equal((await engine.onTrade(exit)).type, "LIVE_SUBMITTED");
  status.resolve(null);
  await engine.reconcile();
});

test("shadow probe budget drops overlap while live BUY prepares", async t => {
  const { engine, buy } = concurrentFixture(t);
  const gate = Promise.withResolvers();
  engine.probeExecutor = { prepare: () => gate.promise };
  const probe = engine.probeBuy(buy(), 0.005);
  await assert.rejects(engine.probeBuy(buy(), 0.005), /busy/);
  assert.equal((await engine.onTrade(buy())).type, "LIVE_SUBMITTED");
  gate.resolve({ venue: "analytics" });
  assert.equal((await probe).rpcSource, "analytics");
});

function persistBuy(engine, entry) {
  engine.state.reserveSignal(entry, { signature: "copy" + entry.mint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawAmount: "5000000", beforeTokenBalance: "0", beforeTokenBalanceKnown: true,
    lastValidBlockHeight: 10 }, 5000000n);
  engine.state.updateSignal(entry.signature, { status: "processed" });
}

test("restored provisional BUY sells at processed before confirmation", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  engine.state.setPosition({ mint: entry.mint, targetEntrySignature: entry.signature,
    entrySignature: "copy" + entry.mint, provisional: true, rawTokenAmount: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58() });
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = { ...engine.executor, tokenBalance: async (_m,_p,commitment) => {
    assert.equal(commitment,"processed"); return 50n;
  } };
  const exit = { ...entry, side: "SELL", signature: "exit" };
  assert.equal((await restored.onTrade(exit)).type, "LIVE_SUBMITTED");
  assert.equal((await restored.onTrade(exit)).reason, "signal_already_handled");
});

test("pending exit without tokens survives restart and dispatches after confirmed evidence", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  const first = new LiveEngine(engine.config, () => {});
  first.executor = { ...engine.executor, tokenBalance: async () => 0n,
    signatureStatus: async () => ({ confirmationStatus: "processed" }),
    transactionTokenDelta: async () => 50n };
  const exit = { ...entry, side: "SELL", signature: "persisted-exit" };
  assert.equal((await first.onTrade(exit)).type, "LIVE_EXIT_PENDING");
  await first.reconcile();
  const second = new LiveEngine(engine.config, () => {});
  let sends = 0;
  second.executor = { ...engine.executor, tokenBalance: async () => 50n,
    submit: async p => { sends++; return p.expectedSignature; },
    signatureStatus: async () => ({ confirmationStatus: "confirmed" }),
    transactionTokenDelta: async () => 50n };
  await second.reconcile();
  assert.equal(sends, 1);
  assert.equal((await second.onTrade(exit)).reason, "signal_already_handled");
});

test("pre-existing token balance cannot be recovered as a fast BUY", async t => {
  const { engine, buy, calls } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  engine.state.updateSignal(entry.signature, { pendingExit: { signature: "foreign-exit" } });
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = { ...engine.executor,
    tokenBalance: async () => 50n,
    signatureStatus: async () => ({ confirmationStatus: "processed" }),
    transactionTokenDelta: async () => 0n,
    submit: async prepared => { calls.push({ side: "SELL" }); return prepared.expectedSignature; }
  };
  await restored.reconcile();
  assert.equal(restored.positions.size, 0);
  assert.equal(calls.filter(call => call.side === "SELL").length, 0);
});

test("legacy expired SELL is surfaced and never rebroadcast blindly", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  const sell = { ...entry, side: "SELL", signature: "old-sell" };
  engine.state.setPosition({ mint: entry.mint, rawTokenAmount: "50", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    openedAt: new Date().toISOString(), entrySignature: "copy-buy", exitRequest: { targetSignature: sell.signature } });
  engine.state.reserveSignal(sell, { signature: "copy-sell", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "50", rawAmount: "50", lastValidBlockHeight: 1 }, 0n);
  engine.state.updateSignal(sell.signature, { status: "expired_no_balance_change" });
  engine.executor.signatureStatus = async () => null;
  const retries = await engine.maintenanceTrades();
  assert.equal(retries.length, 0);
  await engine.reconcile();
  assert.equal(engine.state.handledSignals.at(-1).status, "legacy_exit_unknown");
  assert.equal((await engine.onTrade({ ...sell, signature: "new-sell" })).reason, "exit_already_pending");
});

test("confirmed SELL with stale balance becomes unknown without a duplicate", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  engine.state.setPosition({ mint: entry.mint, rawTokenAmount: "50", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    inventoryBaselineRaw: "0", openedAt: new Date().toISOString(), entrySignature: "copy-buy" });
  engine.executor.tokenBalance = async () => 50n;
  engine.executor.confirm = async () => "confirmed";
  engine.executor.prepare = async (side, mint, raw, options) => ({
    expectedSignature: "stale-sell", mint: new PublicKey(mint), tokenProgram: TOKEN_PROGRAM_ID,
    venue: "pump-curve", beforeTokenBalance: side === "SELL" ? 50n : 0n,
    lastValidBlockHeight: 123, balanceCommitment: options.balanceCommitment
  });
  const sell = { ...entry, side: "SELL", signature: "stale-sell" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_SUBMITTED");
  for (let i = 0; i < 20 && engine.state.handledSignals.at(-1).status === "submitted"; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(engine.state.handledSignals.at(-1).status, "confirmation_unknown");
  assert.equal((await engine.onTrade({ ...sell, signature: "stale-sell-retry" })).reason, "exit_already_pending");
});

test("confirmed SELL uses transaction token delta when wallet balance is stale", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  engine.state.setPosition({ mint: entry.mint, rawTokenAmount: "50", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    inventoryBaselineRaw: "0", openedAt: new Date().toISOString(), entrySignature: "copy-buy" });
  engine.executor.tokenBalance = async () => 50n;
  engine.executor.confirm = async () => "confirmed";
  engine.executor.transactionTokenDelta = async () => -50n;
  const sell = { ...entry, side: "SELL", signature: "meta-sell" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_SUBMITTED");
  for (let i = 0; i < 20 && engine.state.handledSignals.at(-1).status === "submitted"; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(engine.state.handledSignals.at(-1).status, "confirmed");
  assert.equal(engine.positions.has(entry.mint), false);
});

test("unknown SELL settlement emits a warning event, never live_settled", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-unknown-events-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const events = [];
  const engine = new LiveEngine(liveConfig(directory), (event, details) => events.push({ event, details }));
  engine.state.setPosition({ mint: mint.toBase58(), rawTokenAmount: "50",
    inventoryBaselineRaw: "0", tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(), entrySignature: "copy-buy" });
  engine.executor = {
    prewarm: async () => {}, tokenBalance: async () => 50n,
    prepare: async () => ({ expectedSignature: "unknown-sell", mint,
      tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve", beforeTokenBalance: 50n, lastValidBlockHeight: 123 }),
    submit: async () => "unknown-sell", confirm: async () => "confirmed",
    transactionTokenDelta: async () => 0n
  };
  await engine.onTrade({ signature: "target-unknown-sell", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  for (let i = 0; i < 20 && !events.some(item => item.event === "live_sell_unknown"); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(events.some(item => item.event === "live_sell_unknown"));
  assert.equal(events.some(item => item.event === "live_settled"), false);
});

for (const rollover of [false,true]) test("confirmed BUY failure refunds principal once, rollover=" + rollover, async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  if (rollover) {
    engine.state.day = "2000-01-01";
    engine.state.updateSignal(entry.signature, { spendDay: engine.state.day });
    engine.state.resetDayIfNeeded();
  }
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = { signatureStatus: async () => ({ confirmationStatus: "finalized", err: "failed" }),
    transactionWalletDelta: async () => ({ feeLamports: "5000" }) };
  await restored.reconcile();
  await restored.reconcile();
  const state = new LiveEngine(engine.config, () => {}).state;
  assert.equal(state.dailySpendLamports, rollover ? 0n : 5000n);
  assert.equal(state.handledSignals[0].failedFeeLamports, "5000");
});

test("pending SELL BUY failure waits for confirmed fee evidence and refunds once", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  engine.state.updateSignal(entry.signature, {
    pendingExit: { signature: "pending-exit", side: "SELL", mint: entry.mint }
  });
  const restored = new LiveEngine(engine.config, () => {});
  restored.executor = {
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }),
    transactionWalletDelta: async () => ({ feeLamports: "5000" })
  };
  await restored.reconcile();
  await restored.reconcile();
  const state = new LiveEngine(engine.config, () => {}).state;
  assert.equal(state.handledSignals[0].status, "failed_onchain");
  assert.equal(state.handledSignals[0].pendingExit, null);
  assert.equal(state.handledSignals[0].failedFeeLamports, "5000");
  assert.equal(state.dailySpendLamports, 5000n);
});

test("processed BUY error and missing fee metadata remain recoverable", async t => {
  const { engine, buy } = concurrentFixture(t);
  const entry = buy();
  persistBuy(engine, entry);
  engine.state.updateSignal(entry.signature, {
    pendingExit: { signature: "pending-exit", side: "SELL", mint: entry.mint }
  });
  const restored = new LiveEngine(engine.config, () => {});
  let status = { confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } };
  restored.executor = {
    signatureStatus: async () => status,
    transactionWalletDelta: async () => { throw new Error("history unavailable"); }
  };
  await restored.reconcile();
  assert.equal(restored.state.handledSignals[0].status, "processed");
  assert.equal(restored.state.dailySpendLamports, 5000000n);
  status = { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } };
  restored.executor.transactionWalletDelta = async () => ({ feeLamports: "5000" });
  await restored.reconcile();
  assert.equal(restored.state.handledSignals[0].status, "failed_onchain");
  assert.equal(restored.state.dailySpendLamports, 5000n);
});

test("quarantined BUY still reconciles a confirmed failure and refunds once across restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-quarantine-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = liveConfig(directory);
  const first = new LiveEngine(config, () => {});
  const mint = Keypair.generate().publicKey.toBase58();
  const buy = { signature: "quarantined-target-buy", side: "BUY", mint };
  first.state.reserveSignal(buy, {
    signature: "quarantined-copy-buy", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawAmount: "5000000", beforeTokenBalance: "0", beforeTokenBalanceKnown: false,
    lastValidBlockHeight: 123
  }, 5_000_000n);
  first.state.updateSignal(buy.signature, {
    status: "position_quarantined", ownershipStatus: "quarantined",
    ownershipReason: "inventory_baseline_unproven"
  });
  first.state.quarantineMint(mint, {
    kind: "buy", reason: "inventory_baseline_unproven",
    signature: "quarantined-copy-buy", targetSignature: buy.signature
  });

  const restarted = new LiveEngine(config, () => {});
  let feeReads = 0;
  restarted.executor = {
    signatureStatus: async () => ({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }),
    transactionWalletDelta: async () => { feeReads += 1; return { feeLamports: "7000" }; }
  };
  await restarted.reconcile();
  await restarted.reconcile();
  const restored = new LiveEngine(config, () => {});
  const signal = restored.state.handledSignals.find(s => s.targetSignature === buy.signature);
  assert.equal(signal.status, "failed_onchain");
  assert.equal(restored.state.dailySpendLamports, 7000n);
  assert.equal(restored.state.isQuarantined(mint), true);
  assert.equal(restored.positions.has(mint), false);
  assert.equal(feeReads, 1);

  assert.throws(() => restored.state.clearQuarantine(mint, {
    resolution: "not a failed-buy release", evidence: { source: "test" },
    position: { mint, rawTokenAmount: "1", inventoryBaselineRaw: "0",
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(), entrySignature: "wrong",
      targetEntrySignature: "wrong" }
  }), /coherent evidence-backed position/);
  assert.equal(restored.releaseFailedBuyQuarantine(mint, {
    resolution: "confirmed BUY failure released with no inventory",
    evidence: { confirmationStatus: "finalized", error: "InstructionError" },
    signature: "quarantined-copy-buy", failedFeeLamports: "7000"
  }), true);
  assert.equal(restored.state.isQuarantined(mint), false);
  let retrySubmits = 0;
  restored.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    prepare: async (_side, address) => ({ expectedSignature: "retry-copy-buy",
      mint: new PublicKey(address), tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve", beforeTokenBalance: 0n, beforeTokenBalanceKnown: true,
      lastValidBlockHeight: 123 }),
    submit: async () => { retrySubmits += 1; return "retry-copy-buy"; },
    confirm: async () => new Promise(() => {})
  };
  assert.equal((await restored.onTrade({ signature: "retry-target-buy", side: "BUY", mint,
    observedAtMs: Date.now(), signalSource: "processed_logs" })).type, "LIVE_SUBMITTED");
  assert.equal(retrySubmits, 1);
  assert.equal(restored.state.dailySpendLamports, 5_007_000n);
  const released = new LiveEngine(config, () => {});
  assert.equal(released.state.isQuarantined(mint), false);
  assert.equal(released.state.quarantineAudit.at(-1).disposition, "failed_buy_no_inventory");
});

for (const sold of [40n, 100n]) test(`SELL confirmed after quarantine settles ${sold} proven tokens`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `copybot-live-quarantine-sell-${sold}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = liveConfig(directory);
  const mint = Keypair.generate().publicKey.toBase58();
  const first = new LiveEngine(config, () => {});
  const position = {
    mint, rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(),
    entrySignature: "entry-before-quarantine", targetEntrySignature: "target-buy",
    entryWalletDeltaLamports: "-5000000", costLamports: "5000000"
  };
  first.state.setPosition(position);
  const sell = { signature: `target-sell-${sold}`, side: "SELL", mint };
  first.state.reserveSignal(sell, {
    signature: `copy-sell-${sold}`, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "150", beforeTokenBalanceKnown: true, rawAmount: "100",
    lastValidBlockHeight: 123, entrySignature: position.entrySignature
  });
  first.state.updateSignal(sell.signature, { status: "submitted", signature: `copy-sell-${sold}` });
  first.state.quarantineMint(mint, {
    kind: "position", reason: "inventory_baseline_unproven",
    signature: position.entrySignature, targetSignature: position.targetEntrySignature
  });
  first.state.setPosition(position);

  const restarted = new LiveEngine(config, () => {});
  restarted.executor = {
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: null }),
    tokenBalance: async () => 50n + (100n - sold),
    transactionTokenDelta: async () => -sold
  };
  await restarted.reconcile();
  const expectedRemaining = 100n - sold;
  assert.equal(restarted.positions.get(mint)?.rawTokenAmount ?? null,
    expectedRemaining === 0n ? null : expectedRemaining.toString());
  assert.equal(restarted.state.handledSignals.find(s => s.targetSignature === sell.signature).status,
    "reconciled_confirmed");
  const realized = restarted.state.dailyRealizedPnlLamports;
  await restarted.reconcile();
  const reloaded = new LiveEngine(config, () => {});
  assert.equal(reloaded.state.dailyRealizedPnlLamports, realized);
  assert.equal(reloaded.positions.get(mint)?.rawTokenAmount ?? null,
    expectedRemaining === 0n ? null : expectedRemaining.toString());
  assert.equal(reloaded.state.isQuarantined(mint), true);
  if (sold === 100n) {
    assert.equal(reloaded.releaseClosedSellQuarantine(mint, {
      resolution: "confirmed full SELL left zero strategy inventory",
      evidence: { source: "transaction_token_delta", observedDelta: "-100" },
      signature: `copy-sell-${sold}`, targetSignature: sell.signature,
      rawSoldAmount: "100"
    }), true);
    assert.equal(reloaded.state.isQuarantined(mint), false);
    let submits = 0;
    reloaded.executor = {
      prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
      prepare: async (_side, address) => ({ expectedSignature: "post-close-buy",
        mint: new PublicKey(address), tokenProgram: TOKEN_PROGRAM_ID,
        venue: "pump-curve", beforeTokenBalance: 0n, beforeTokenBalanceKnown: true,
        lastValidBlockHeight: 123 }),
      submit: async () => { submits += 1; return "post-close-buy"; },
      confirm: async () => new Promise(() => {})
    };
    assert.equal((await reloaded.onTrade({ signature: "post-close-target-buy", side: "BUY", mint,
      observedAtMs: Date.now(), signalSource: "processed_logs" })).type, "LIVE_SUBMITTED");
    assert.equal(submits, 1);
  } else {
    assert.throws(() => reloaded.releaseClosedSellQuarantine(mint, {
      resolution: "partial SELL is not terminal", evidence: { source: "test" },
      signature: `copy-sell-${sold}`, targetSignature: sell.signature,
      rawSoldAmount: sold.toString()
    }), /zero remaining position/);
  }
});

for (const sold of [40n, 100n]) test(`SELL settlement survives crash boundary for ${sold} tokens`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `copybot-live-sell-crash-${sold}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = liveConfig(directory);
  const mint = Keypair.generate().publicKey.toBase58();
  const targetSignature = `crash-target-sell-${sold}`;
  const transactionSignature = `crash-copy-sell-${sold}`;
  const first = new LiveEngine(config, () => {});
  const position = {
    mint, rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(),
    entrySignature: "crash-entry", targetEntrySignature: "crash-buy",
    entryWalletDeltaLamports: "-5000000", costLamports: "5000000"
  };
  first.state.setPosition(position);
  first.state.quarantineMint(mint, {
    kind: "position", reason: "inventory_baseline_unproven",
    signature: position.entrySignature, targetSignature: position.targetEntrySignature
  });
  first.state.setPosition(position);
  first.state.reserveSignal({ signature: targetSignature, side: "SELL", mint }, {
    signature: transactionSignature, tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "150", beforeTokenBalanceKnown: true, rawAmount: "100",
    lastValidBlockHeight: 123, entrySignature: position.entrySignature
  });
  first.state.updateSignal(targetSignature, { status: "submitted", signature: transactionSignature });
  const applied = first.state.applySellSettlement({
    mint, targetSignature, signature: transactionSignature,
    entrySignature: position.entrySignature, rawSoldAmount: sold,
    sellWalletDeltaLamports: sold === 40n ? "2000000" : "4000000",
    allowQuarantined: true
  });
  assert.equal(applied.remainingRaw, (100n - sold).toString());

  const restarted = new LiveEngine(config, () => {});
  restarted.executor = {
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: null }),
    tokenBalance: async () => { throw new Error("must not reread balance after atomic settlement"); },
    transactionTokenDelta: async () => { throw new Error("must not reread SELL delta after atomic settlement"); },
    transactionWalletDelta: async () => { throw new Error("must not reread SELL proceeds after atomic settlement"); }
  };
  await restarted.reconcile();
  const expectedRemaining = 100n - sold;
  assert.equal(restarted.positions.get(mint)?.rawTokenAmount ?? null,
    expectedRemaining === 0n ? null : expectedRemaining.toString());
  assert.equal(restarted.state.handledSignals.find(s => s.targetSignature === targetSignature).status,
    "reconciled_confirmed");
  const persisted = restarted.state.getSellSettlement(targetSignature);
  assert.equal(persisted.pnlRecorded, sold === 100n);
  if (sold === 100n) assert.equal(restarted.state.dailyRealizedPnlLamports, -1_000_000n);
  const beforeRetry = restarted.state.dailyRealizedPnlLamports;
  await restarted.reconcile();
  const reloaded = new LiveEngine(config, () => {});
  assert.equal(reloaded.state.dailyRealizedPnlLamports, beforeRetry);
});

test("audited quarantine resolution restores an orphan position before SELL after restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-quarantine-resolution-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = liveConfig(directory);
  const first = new LiveEngine(config, () => {});
  const mint = Keypair.generate().publicKey.toBase58();
  const buy = { signature: "orphan-target-buy", side: "BUY", mint };
  first.state.reserveSignal(buy, {
    signature: "orphan-copy-buy", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawAmount: "5000000", beforeTokenBalance: "0", beforeTokenBalanceKnown: false,
    lastValidBlockHeight: 123
  }, 5_000_000n);
  first.state.updateSignal(buy.signature, {
    status: "position_quarantined", ownershipStatus: "quarantined",
    ownershipReason: "inventory_baseline_unproven"
  });
  first.state.quarantineMint(mint, {
    kind: "buy", reason: "inventory_baseline_unproven",
    signature: "orphan-copy-buy", targetSignature: buy.signature
  });
  first.state.clearQuarantine(mint, {
    resolution: "operator matched confirmed token-account inventory to BUY",
    evidence: { source: "confirmed_token_account_snapshot", rawBalance: "100" },
    position: {
      mint, rawTokenAmount: "100", inventoryBaselineRaw: "0",
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(), entrySignature: "orphan-copy-buy",
      targetEntrySignature: buy.signature, costLamports: "5000000"
    }
  });

  const restarted = new LiveEngine(config, () => {});
  const submissions = [];
  restarted.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    tokenBalance: async () => 100n,
    prepare: async () => ({ expectedSignature: "resolved-copy-sell", mint: new PublicKey(mint),
      tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve", beforeTokenBalance: 100n,
      beforeTokenBalanceKnown: true, lastValidBlockHeight: 123 }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async () => new Promise(() => {})
  };
  const result = await restarted.onTrade({ signature: "resolved-target-sell", side: "SELL", mint,
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(result.type, "LIVE_SUBMITTED");
  assert.deepEqual(submissions, ["resolved-copy-sell"]);
  assert.equal(restarted.state.isQuarantined(mint), false);
  assert.equal(restarted.positions.get(mint).rawTokenAmount, "100");
});

test("expired unknown retains budget; hung mint A permits confirmed B recovery", {timeout: 2000}, async t => {
  const { engine, buy } = concurrentFixture(t);
  const [a,b,c] = [buy(),buy(),buy()];
  for (const trade of [a,b,c]) persistBuy(engine, trade);
  let requests = 0;
  engine.executor.signatureStatus = async sig => {
    if (sig === "copy"+a.mint) { requests++; return new Promise(() => {}); }
    return sig === "copy"+b.mint ? { confirmationStatus: "confirmed" } : null;
  };
  engine.executor.currentBlockHeight = async () => 1000;
  void engine.reconcile();
  await new Promise(resolve => setImmediate(resolve));
  void engine.reconcile();
  assert.equal(requests,1);
  assert.ok(engine.positions.has(b.mint));
  assert.equal(engine.state.dailySpendLamports,15000000n);
  assert.equal(engine.state.handledSignals[2].status,"processed");
});

test("explicit SELL rejection allows immediate exit retry", async t => {
  const { engine, buy } = concurrentFixture(t);
  const trade = { ...buy(), side: "SELL" };
  engine.state.setPosition({ mint: trade.mint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), rawTokenAmount: "50", inventoryBaselineRaw: "0" });
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
  await restored.reconcile();
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
    tokenBalance: async () => 100n,
    processedTokenDelta: async () => 100n
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
    processedTokenDelta: async () => 100n,
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
       averagePriceSol: 0.00005,
      observedAtMs: Date.now(),
      signalSource: "processed_logs",
       fastProfile: false
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

test("foreign transfer during an unlanded BUY cannot create a provisional position or SELL", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-foreign-transfer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let releaseBuy;
  const buyConfirmed = new Promise(resolve => { releaseBuy = resolve; });
  const submissions = [];
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    prepare: async (side) => ({
      expectedSignature: side === "BUY" ? "foreign-buy" : "foreign-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 50n : 160n, lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async signature => signature === "foreign-buy" ? buyConfirmed : "confirmed",
    tokenBalance: async () => 160n,
    transactionTokenDelta: async signature => signature === "foreign-buy" ? 100n : -100n
  };
  const buy = {
    signature: "foreign-target-buy", side: "BUY", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs"
  };
  assert.equal((await engine.onTrade(buy)).type, "LIVE_SUBMITTED");
  const sell = { ...buy, signature: "foreign-target-sell", side: "SELL" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_EXIT_PENDING");
  assert.equal(engine.positions.size, 0);
  assert.deepEqual(submissions, ["foreign-buy"]);

  releaseBuy("confirmed");
  const pending = engine.pendingExits.get(mint.toBase58());
  await pending;
  assert.deepEqual(submissions, ["foreign-buy", "foreign-sell"]);
  assert.equal(engine.positions.size, 0);
});

test("a trusted early SELL remains accounted when BUY confirmation arrives after it", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-early-close-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let releaseBuy;
  let releaseSell;
  const buyConfirmed = new Promise(resolve => { releaseBuy = resolve; });
  const sellConfirmed = new Promise(resolve => { releaseSell = resolve; });
  const submissions = [];
  let balanceReads = 0;
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    processedTokenDelta: async () => 100n,
    prepare: async side => ({
      expectedSignature: side === "BUY" ? "late-buy" : "early-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 100n, lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async signature => signature === "late-buy" ? buyConfirmed : sellConfirmed,
    tokenBalance: async () => [100n, 100n, 0n][balanceReads++] ?? 0n,
    transactionTokenDelta: async signature => signature === "late-buy" ? 100n : -100n,
    transactionWalletDelta: async () => ({ walletDeltaLamports: "-5000000" })
  };
  const buy = { signature: "late-target-buy", side: "BUY", mint: mint.toBase58(),
     observedAtMs: Date.now(), signalSource: "processed_logs", fastProfile: false };
  assert.equal((await engine.onTrade(buy)).type, "LIVE_SUBMITTED");
  const sell = { ...buy, signature: "early-target-sell", side: "SELL" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_SUBMITTED");
  releaseSell("confirmed");
  for (let attempt = 0; attempt < 40 && engine.state.handledSignals.at(-1).status !== "confirmed"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  releaseBuy("confirmed");
  for (let attempt = 0; attempt < 40 && engine.state.handledSignals.some(s => s.targetSignature === buy.signature && s.status !== "confirmed"); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual(submissions, ["late-buy", "early-sell"]);
  assert.equal(engine.positions.size, 0);
  const buySignal = engine.state.handledSignals.find(s => s.targetSignature === buy.signature);
  assert.equal(buySignal.status, "confirmed");
  assert.equal(buySignal.closedWhileConfirming, true);
});

test("restart recovery quarantines an old balance after the BUY inventory was withdrawn", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-inventory-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey.toBase58();
  const first = new LiveEngine(liveConfig(directory), () => {});
  const entry = { signature: "inventory-target-buy", side: "BUY", mint };
  first.state.reserveSignal(entry, {
    signature: "inventory-copy-buy", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "50", beforeTokenBalanceKnown: true,
    rawAmount: "5000000", lastValidBlockHeight: 123
  }, 5_000_000n);
  first.state.updateSignal(entry.signature, {
    status: "processed",
    pendingExit: { signature: "inventory-target-sell", side: "SELL", mint }
  });

  const restored = new LiveEngine(liveConfig(directory), () => {});
  let submits = 0;
  restored.executor = {
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: null }),
    transactionTokenDelta: async () => 100n,
    tokenBalance: async () => 50n,
    submit: async () => { submits += 1; return "must-not-submit"; }
  };
  await restored.reconcile();
  const recovered = restored.state.handledSignals.find(s => s.targetSignature === entry.signature);
  assert.equal(restored.positions.size, 0);
  assert.equal(submits, 0);
  assert.equal(recovered.status, "position_quarantined");
  assert.equal(recovered.ownershipReason, "post_buy_inventory_ambiguous");
  assert.ok(recovered.pendingExit);

  const restarted = new LiveEngine(liveConfig(directory), () => {});
  restarted.executor = { ...restored.executor, submit: async () => { submits += 1; return "must-not-submit"; } };
  await restarted.reconcile();
  assert.equal(restarted.positions.size, 0);
  assert.equal(submits, 0);
});

test("pending SELL dispatches immediately after confirmed BUY without processed attribution", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-confirmed-exit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let releaseBuy;
  const buyConfirmed = new Promise(resolve => { releaseBuy = resolve; });
  const submissions = [];
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    prepare: async side => ({
      expectedSignature: side === "BUY" ? "confirmed-buy" : "confirmed-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 100n, lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async signature => signature === "confirmed-buy" ? buyConfirmed : "confirmed",
    tokenBalance: async () => 100n,
    transactionTokenDelta: async signature => signature === "confirmed-buy" ? 100n : -100n
  };
  const buy = { signature: "confirmed-target-buy", side: "BUY", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs" };
  assert.equal((await engine.onTrade(buy)).type, "LIVE_SUBMITTED");
  const sell = { ...buy, signature: "confirmed-target-sell", side: "SELL" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_EXIT_PENDING");
  assert.deepEqual(submissions, ["confirmed-buy"]);

  releaseBuy("confirmed");
  await engine.pendingExits.get(mint.toBase58());
  assert.deepEqual(submissions, ["confirmed-buy", "confirmed-sell"]);
  assert.equal(engine.state.handledSignals.filter(s => s.side === "SELL").length, 1);
});

for (const [label, settledBalance] of [["external outflow", 80n], ["external inflow", 120n]]) {
  test(`SELL settlement uses its transaction delta despite ${label}`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `copybot-live-sell-delta-${label.replaceAll(" ", "-")}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const mint = Keypair.generate().publicKey;
    const engine = new LiveEngine(liveConfig(directory), () => {});
    let balanceReads = 0;
    engine.state.setPosition({
      mint: mint.toBase58(), rawTokenAmount: "100", inventoryBaselineRaw: "50",
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(),
      entrySignature: "delta-buy", costLamports: "5000000"
    });
    engine.executor = {
      prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
      prepare: async (_side, _mint, _raw, options) => ({
        expectedSignature: "delta-sell", mint, tokenProgram: TOKEN_PROGRAM_ID,
        venue: "pump-curve", beforeTokenBalance: 150n,
        lastValidBlockHeight: 123, balanceCommitment: options.balanceCommitment
      }),
      submit: async () => "delta-sell",
      confirm: async () => "confirmed",
      tokenBalance: async () => balanceReads++ === 0 ? 150n : settledBalance,
      transactionTokenDelta: async () => -40n,
      transactionWalletDelta: async () => ({ walletDeltaLamports: "4000000" })
    };
    const result = await engine.onTrade({ signature: `target-${label}`, side: "SELL",
      mint: mint.toBase58(), observedAtMs: Date.now(), signalSource: "processed_logs" });
    assert.equal(result.type, "LIVE_SUBMITTED");
    for (let attempt = 0; attempt < 20 && engine.state.handledSignals.at(-1).status === "submitted"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(engine.positions.get(mint.toBase58()).rawTokenAmount, "60");
    assert.equal(engine.state.handledSignals.at(-1).status, "reconciled_confirmed");
    await engine.reconcile();
    const restarted = new LiveEngine(liveConfig(directory), () => {});
    assert.equal(restarted.positions.get(mint.toBase58()).rawTokenAmount, "60");
  });
}

test("SELL with unavailable transaction metadata remains unknown and is not duplicated", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-sell-no-metadata-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  engine.state.setPosition({ mint: mint.toBase58(), rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(), entrySignature: "entry" });
  let submits = 0;
  let balanceReads = 0;
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    prepare: async () => ({ expectedSignature: "no-metadata-sell", mint, tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve", beforeTokenBalance: 150n, lastValidBlockHeight: 123 }),
    submit: async () => { submits += 1; return "no-metadata-sell"; },
    confirm: async () => "confirmed", tokenBalance: async () => balanceReads++ === 0 ? 150n : 120n,
    transactionTokenDelta: async () => null
  };
  const sell = { signature: "no-metadata-target", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs" };
  assert.equal((await engine.onTrade(sell)).type, "LIVE_SUBMITTED");
  for (let attempt = 0; attempt < 20 && engine.state.handledSignals.at(-1).status === "submitted"; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(engine.state.handledSignals.at(-1).status, "confirmation_unknown");
  assert.equal(engine.positions.get(mint.toBase58()).rawTokenAmount, "100");
  assert.equal(submits, 1);
  assert.equal((await engine.onTrade({ ...sell, signature: "no-metadata-retry" })).reason, "exit_already_pending");
});

test("FAST BUY without inventory provenance is rejected before submit", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-fast-preexisting-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let balanceReads = 0;
  const submissions = [];
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    tokenBalance: async () => { balanceReads += 1; return 50n; },
    prepare: async (side) => ({
      expectedSignature: side === "BUY" ? "copy-buy" : "copy-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 50n, lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    transactionTokenDelta: async () => 0n,
    confirm: async () => "confirmed"
  };

  const buy = await engine.onTrade({
    signature: "target-fast-preexisting-buy", side: "BUY", mint: mint.toBase58(),
    averagePriceSol: 0.00004, observedAtMs: Date.now(), signalSource: "processed_logs", fastProfile: true
  });
  assert.equal(buy.type, "LIVE_SKIP");
  assert.equal(buy.reason, "fast_buy_inventory_baseline_unavailable");
  assert.equal(engine.positions.size, 0);
  assert.equal(balanceReads, 0);
  assert.equal(engine.state.dailySpendLamports, 0n);
  const sell = await engine.onTrade({
    signature: "target-fast-preexisting-sell", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs"
  });
  assert.equal(sell.reason, "no_live_position");
  assert.deepEqual(submissions, []);
});

test("default PumpExecutor FAST prepare semantics block a BUY before funds are spent", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-fast-delta-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  const submissions = [];
  engine.executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000,
    processedTokenDelta: async () => 100n,
    transactionTokenDelta: async () => 100n,
    tokenBalance: async (_mint, _program, commitment) => commitment === "processed" ? 150n : 150n,
    prepare: async (side) => ({
      expectedSignature: side === "BUY" ? "copy-buy" : "copy-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 150n,
      beforeTokenBalanceKnown: side === "BUY" ? false : true,
      lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async () => "confirmed"
  };

  const buy = await engine.onTrade({
    signature: "target-fast-delta-buy", side: "BUY", mint: mint.toBase58(),
    averagePriceSol: 0.00004, observedAtMs: Date.now(), signalSource: "processed_logs", fastProfile: true
  });
  assert.equal(buy.type, "LIVE_SKIP");
  assert.equal(buy.reason, "fast_buy_inventory_baseline_unavailable");
  assert.equal(engine.positions.has(mint.toBase58()), false);
  assert.equal(engine.inventoryHealth().quarantinedMints, 0);
  assert.equal((await engine.onTrade({
    signature: "target-fast-delta-sell", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs"
  })).reason, "no_live_position");
  assert.deepEqual(submissions, []);
});

test("lost FAST BUY response with pre-existing tokens keeps the SELL pending", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-fast-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory, { fastRequireInventoryBaseline: false }), () => {});
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    tokenBalance: async () => 50n,
    prepare: async (side) => ({
      expectedSignature: side === "BUY" ? "copy-timeout-buy" : "copy-timeout-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 0n : 50n, lastValidBlockHeight: 123
    }),
    submit: async () => { throw new Error("timeout"); },
    confirm: async () => new Promise(() => {})
  };
  assert.equal((await engine.onTrade({
    signature: "target-timeout-buy", side: "BUY", mint: mint.toBase58(),
    averagePriceSol: 0.00004, observedAtMs: Date.now(), signalSource: "processed_logs", fastProfile: true
  })).type, "LIVE_SUBMIT_UNKNOWN");
  assert.equal(engine.positions.size, 0);
  const sell = await engine.onTrade({
    signature: "target-timeout-sell", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs"
  });
  assert.equal(sell.type, "LIVE_EXIT_PENDING");
  assert.equal(engine.positions.size, 0);
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
    inventoryBaselineRaw: "0",
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
        beforeTokenBalanceKnown: true,
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
  engine.probeExecutor = {
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
    beforeTokenBalanceKnown: true,
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
    await engine.reconcile();
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

test("partial external outflow quarantines the mint and compensating inflow never clears it across two restarts", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-partial-outflow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey.toBase58();
  const config = liveConfig(directory, { maxOpenPositions: 1 });
  const first = new LiveEngine(config, () => {});
  const buy = { signature: "target-partial-outflow-buy", side: "BUY", mint };
  first.state.reserveSignal(buy, {
    signature: "copy-partial-outflow-buy", tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    beforeTokenBalance: "50", beforeTokenBalanceKnown: true, rawAmount: "5000000",
    lastValidBlockHeight: 123, pendingExit: { signature: "target-partial-outflow-sell", side: "SELL", mint }
  }, 5_000_000n);
  first.state.updateSignal(buy.signature, { status: "processed" });
  let sends = 0;
  first.executor = {
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: null }),
    transactionTokenDelta: async () => 100n,
    tokenBalance: async () => 110n,
    submit: async () => { sends += 1; return "must-not-submit"; }
  };

  await first.reconcile();
  assert.equal(first.positions.size, 0);
  assert.equal(first.inventoryHealth().quarantinedMints, 1);
  assert.equal(first.state.handledSignals.find(s => s.targetSignature === buy.signature).status,
    "position_quarantined");
  assert.equal(first.state.dailySpendLamports, 5_000_000n);

  const restarted = new LiveEngine(config, () => {});
  restarted.executor = first.executor;
  assert.equal(restarted.inventoryHealth().quarantinedBuysWithoutPosition, 1);
  // A foreign +40 restoring the numerical balance to 150 is intentionally not
  // represented as a resolution event and must not make a new BUY possible.
  assert.equal((await restarted.onTrade({
    signature: "other-wallet-buy", side: "BUY", mint,
    sourceWallet: "other-wallet", observedAtMs: Date.now(), signalSource: "processed_logs"
  })).reason, "mint_inventory_quarantined");
  assert.equal(sends, 0);

  const restartedAgain = new LiveEngine(config, () => {});
  assert.equal(restartedAgain.inventoryHealth().quarantinedMints, 1);
  assert.equal(restartedAgain.state.dailySpendLamports, 5_000_000n);
  assert.equal(restartedAgain.state.getQuarantine(mint).reason, "post_buy_inventory_ambiguous");
});

test("processed deficit remains sticky after a foreign top-up and confirmed settlement", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-sticky-quarantine-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let sends = 0;
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    processedTokenDelta: async () => 100n,
    transactionTokenDelta: async () => 100n,
    prepare: async side => ({
      expectedSignature: side === "BUY" ? "sticky-buy" : "sticky-sell",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? 50n : 150n,
      beforeTokenBalanceKnown: true, lastValidBlockHeight: 123,
      expectedTokenOutRaw: side === "BUY" ? "100" : null, tokenDecimals: 0
    }),
    submit: async prepared => { sends += 1; return prepared.expectedSignature; },
    confirm: async () => "confirmed",
    tokenBalance: async (_mint, _program, commitment) => commitment === "processed" ? 120n : 150n
  };

  assert.equal((await engine.onTrade({
    signature: "sticky-target-buy", side: "BUY", mint: mint.toBase58(),
    averagePriceSol: 0.00005, observedAtMs: Date.now(), signalSource: "processed_logs"
  })).type, "LIVE_SUBMITTED");
  for (let i = 0; i < 40 && !engine.state.isQuarantined(mint.toBase58()); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const signal = engine.state.handledSignals.find(s => s.targetSignature === "sticky-target-buy");
  assert.equal(signal.status, "position_quarantined");
  assert.equal(engine.positions.size, 0);
  assert.equal((await engine.onTrade({
    signature: "sticky-target-sell", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs"
  })).reason, "position_ownership_quarantined");
  assert.equal(sends, 1);

  const restarted = new LiveEngine(engine.config, () => {});
  assert.equal(restarted.state.isQuarantined(mint.toBase58()), true);
  assert.equal(restarted.state.handledSignals.find(s => s.targetSignature === "sticky-target-buy").status,
    "position_quarantined");
});

test("zero balance after SELL preparation quarantines and keeps the position through restart", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-zero-after-prepare-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let submits = 0;
  let reads = 0;
  engine.state.setPosition({
    mint: mint.toBase58(), rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(),
    entrySignature: "zero-entry", costLamports: "5000000"
  });
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    tokenBalance: async () => reads++ === 0 ? 150n : 0n,
    prepare: async () => ({ expectedSignature: "must-not-submit", mint,
      tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve", beforeTokenBalance: 0n,
      lastValidBlockHeight: 123 }),
    submit: async () => { submits += 1; return "must-not-submit"; }
  };
  const result = await engine.onTrade({ signature: "zero-target-sell", side: "SELL",
    mint: mint.toBase58(), observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(result.reason, "position_inventory_disappeared");
  assert.equal(submits, 0);
  assert.equal(engine.positions.get(mint.toBase58()).ownershipStatus, "quarantined");
  assert.equal(engine.inventoryHealth().quarantinedPositions, 1);
  const restarted = new LiveEngine(engine.config, () => {});
  assert.equal(restarted.positions.has(mint.toBase58()), true);
  assert.equal(restarted.state.isQuarantined(mint.toBase58()), true);
});

test("zero balance before SELL preparation does not delete the open position", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-zero-before-prepare-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey.toBase58();
  const engine = new LiveEngine(liveConfig(directory), () => {});
  engine.state.setPosition({ mint, rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(), entrySignature: "entry" });
  let prepared = false;
  engine.executor = {
    prewarm: async () => {}, tokenBalance: async () => 0n,
    prepare: async () => { prepared = true; throw new Error("must not prepare"); }
  };
  const result = await engine.onTrade({ signature: "zero-before-sell", side: "SELL", mint,
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(result.reason, "position_inventory_disappeared");
  assert.equal(prepared, false);
  assert.equal(engine.positions.has(mint), true);
  assert.equal(engine.state.isQuarantined(mint), true);
});

test("temporary SELL balance RPC failure preserves the position without quarantine", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-balance-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey.toBase58();
  const engine = new LiveEngine(liveConfig(directory), () => {});
  engine.state.setPosition({ mint, rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(), entrySignature: "entry" });
  engine.executor = { prewarm: async () => {}, tokenBalance: async () => { throw new Error("RPC timeout"); } };
  const result = await engine.onTrade({ signature: "rpc-timeout-sell", side: "SELL", mint,
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(result.reason, "sell_balance_unavailable");
  assert.equal(engine.positions.get(mint).ownershipStatus, undefined);
  assert.equal(engine.state.isQuarantined(mint), false);
});

test("partial SELL and the subsequent SELL account each transaction delta once", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-partial-sell-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mint = Keypair.generate().publicKey;
  const engine = new LiveEngine(liveConfig(directory), () => {});
  let balanceReads = 0;
  const submissions = [];
  engine.state.setPosition({ mint: mint.toBase58(), rawTokenAmount: "100", inventoryBaselineRaw: "50",
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(), entrySignature: "entry",
    costLamports: "5000000" });
  engine.executor = {
    prewarm: async () => {}, balanceLamports: async () => 1_000_000_000,
    tokenBalance: async () => [150n, 110n, 110n, 50n][balanceReads++] ?? 50n,
    prepare: async (_side, _mint, _raw, options) => ({
      expectedSignature: options.balanceCommitment === "confirmed" ? `sell-${submissions.length + 1}` : "unused",
      mint, tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve", beforeTokenBalance: 150n,
      lastValidBlockHeight: 123
    }),
    submit: async prepared => { submissions.push(prepared.expectedSignature); return prepared.expectedSignature; },
    confirm: async () => "confirmed",
    transactionTokenDelta: async signature => signature === "sell-1" ? -40n : -60n,
    transactionWalletDelta: async signature => ({
      walletDeltaLamports: signature === "entry" ? "-5000000" :
        signature === "sell-1" ? "2000000" : "4000000"
    })
  };
  const first = await engine.onTrade({ signature: "target-sell-1", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(first.type, "LIVE_SUBMITTED");
  for (let i = 0; i < 40 && engine.positions.get(mint.toBase58())?.rawTokenAmount !== "60"; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(engine.positions.get(mint.toBase58()).rawTokenAmount, "60");
  const second = await engine.onTrade({ signature: "target-sell-2", side: "SELL", mint: mint.toBase58(),
    observedAtMs: Date.now(), signalSource: "processed_logs" });
  assert.equal(second.type, "LIVE_SUBMITTED");
  for (let i = 0; i < 40 && engine.positions.has(mint.toBase58()); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(engine.positions.has(mint.toBase58()), false);
  assert.deepEqual(submissions, ["sell-1", "sell-2"]);
  assert.deepEqual(engine.state.handledSignals.filter(s => s.side === "SELL").map(s => s.status),
    ["reconciled_confirmed", "confirmed"]);
  assert.equal(engine.state.dailyRealizedPnlLamports, 1_000_000n);
});
