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
    ...overrides
  };
}

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
    assert.equal(engine.positions.size, 0);

    releaseConfirmation("confirmed");
    for (let attempt = 0; attempt < 20 && engine.positions.size === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(engine.positions.get(mint.toBase58()).rawTokenAmount, "100");
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
