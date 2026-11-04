import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LiveEngine } from "../src/live-engine.js";

const SEEDS = [
  0x10203040, 0x55667788, 0x90abcdef, 0xdeadbeef,
  ...Array.from({ length: 28 }, (_, index) => index + 1)
];

function config(directory) {
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
    fastSkipSimulation: true
  };
}

function mintForSeed(seed) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(seed >>> 0, 0);
  return Keypair.fromSeed(bytes).publicKey.toBase58();
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function controlledExecutor(mint, {
  baseline = 50n,
  bought = 100n,
  afterBuy = 150n,
  afterSell = 50n,
  unknownBaseline = false
} = {}) {
  const buySignature = `copy-buy-${mint.slice(0, 8)}`;
  const sellSignature = `copy-sell-${mint.slice(0, 8)}`;
  const submissions = [];
  let balance = afterBuy;
  let activeSide = null;
  const executor = {
    prewarm: async () => {},
    balanceLamports: async () => 1_000_000_000n,
    tokenBalance: async () => balance,
    prepare: async (side, address) => ({
      expectedSignature: side === "BUY" ? buySignature : sellSignature,
      mint: new PublicKey(address),
      tokenProgram: TOKEN_PROGRAM_ID,
      venue: "pump-curve",
      beforeTokenBalance: side === "BUY" ? baseline : balance,
      beforeTokenBalanceKnown: side === "BUY" ? !unknownBaseline : true,
      beforeTokenBalanceEvidence: side === "BUY" && !unknownBaseline
        ? {
            kind: "multi_commitment_account_context", rooted: true,
            observations: [{ commitment: "finalized", slot: 123, amount: String(baseline) }]
          }
        : null,
      lastValidBlockHeight: 123
    }),
    submit: async prepared => {
      submissions.push(prepared.expectedSignature);
      activeSide = prepared.expectedSignature === buySignature ? "BUY" : "SELL";
      if (activeSide === "SELL") balance = afterSell;
      return prepared.expectedSignature;
    },
    confirm: async () => "confirmed",
    transactionTokenDelta: async signature => signature === buySignature ? bought : -bought,
    transactionWalletDelta: async signature => ({
      walletDeltaLamports: signature === buySignature ? "-5000000" : "4000000",
      feeLamports: "5000"
    }),
    signatureStatus: async () => ({ confirmationStatus: "confirmed", err: null })
  };
  return {
    executor,
    submissions,
    buySignature,
    sellSignature,
    setBalance(value) { balance = BigInt(value); },
    get activeSide() { return activeSide; }
  };
}

function reserveQuarantinedBuy(engine, mint, suffix) {
  const trade = { signature: `target-quarantined-${suffix}`, side: "BUY", mint };
  const signature = `copy-quarantined-${suffix}`;
  engine.state.reserveSignal(trade, {
    signature,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    rawAmount: "5000000",
    beforeTokenBalance: "0",
    beforeTokenBalanceKnown: false,
    lastValidBlockHeight: 123
  }, 5_000_000n);
  engine.state.quarantineMint(mint, {
    kind: "buy", reason: "inventory_baseline_unproven", signature,
    targetSignature: trade.signature
  });
  engine.state.updateSignal(trade.signature, {
    status: "position_quarantined", ownershipStatus: "quarantined",
    ownershipReason: "inventory_baseline_unproven"
  });
  return { trade, signature };
}

test("32 deterministic production runs cover five LiveEngine scenario families across restart", async t => {
  const coverage = new Set();
  for (const seed of SEEDS) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-production-seed-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const mint = mintForSeed(seed);
    const scenario = seed % 5;
    const liveConfig = config(directory);

    if (scenario === 0) {
      coverage.add("confirmed_duplicate_sell_restart");
      const engine = new LiveEngine(liveConfig, () => {});
      const controlled = controlledExecutor(mint);
      engine.executor = controlled.executor;
      const buy = { signature: `target-buy-${seed}`, side: "BUY", mint,
        observedAtMs: Date.now(), signalSource: "processed_logs" };
      assert.equal((await engine.onTrade(buy)).type, "LIVE_SUBMITTED");
      await eventually(() => engine.state.handledSignals.find(s => s.targetSignature === buy.signature)?.status === "confirmed",
        `BUY did not confirm for seed ${seed}`);
      assert.equal(engine.positions.get(mint).rawTokenAmount, "100");
      assert.equal((await engine.onTrade(buy)).reason, "signal_already_handled");
      const sell = { signature: `target-sell-${seed}`, side: "SELL", mint,
        observedAtMs: Date.now(), signalSource: "processed_logs" };
      assert.equal((await engine.onTrade(sell)).type, "LIVE_SUBMITTED");
      await eventually(() => !engine.positions.has(mint), `SELL did not close seed ${seed}`);
      const restarted = new LiveEngine(liveConfig, () => {});
      assert.equal(restarted.positions.has(mint), false);
      assert.deepEqual(controlled.submissions, [controlled.buySignature, controlled.sellSignature]);
    } else if (scenario === 1) {
      coverage.add("partial_outflow_sticky_restart");
      const engine = new LiveEngine(liveConfig, () => {});
      const controlled = controlledExecutor(mint, { afterBuy: 110n });
      engine.executor = controlled.executor;
      const buy = { signature: `target-outflow-${seed}`, side: "BUY", mint,
        observedAtMs: Date.now(), signalSource: "processed_logs" };
      assert.equal((await engine.onTrade(buy)).type, "LIVE_SUBMITTED");
      await eventually(() => engine.state.isQuarantined(mint), `outflow not quarantined for seed ${seed}`);
      assert.equal(engine.positions.has(mint), false);
      const restarted = new LiveEngine(liveConfig, () => {});
      controlled.setBalance(150n);
      restarted.executor = controlled.executor;
      assert.equal((await restarted.onTrade({ ...buy, signature: `target-duplicate-${seed}` })).reason,
        "mint_inventory_quarantined");
      assert.equal(restarted.state.isQuarantined(mint), true);
      assert.deepEqual(controlled.submissions, [controlled.buySignature]);
    } else if (scenario === 2) {
      coverage.add("fast_baseline_gate");
      const engine = new LiveEngine(liveConfig, () => {});
      const controlled = controlledExecutor(mint, { unknownBaseline: true });
      engine.executor = controlled.executor;
      const buy = { signature: `target-fast-${seed}`, side: "BUY", mint,
        averagePriceSol: 0.00004, observedAtMs: Date.now(),
        signalSource: "processed_logs", fastProfile: true };
      const result = await engine.onTrade(buy);
      assert.equal(result.reason, "fast_buy_inventory_baseline_unavailable");
      assert.equal(engine.state.dailySpendLamports, 0n);
      assert.equal(engine.state.handledSignals.length, 0);
      assert.deepEqual(controlled.submissions, []);
    } else if (scenario === 3) {
      coverage.add("quarantine_failure_fee_restart");
      const first = new LiveEngine(liveConfig, () => {});
      const { trade } = reserveQuarantinedBuy(first, mint, seed);
      const restarted = new LiveEngine(liveConfig, () => {});
      let feeReads = 0;
      restarted.executor = {
        signatureStatus: async () => ({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }),
        transactionWalletDelta: async () => { feeReads += 1; return { feeLamports: "5000" }; }
      };
      await restarted.reconcile();
      await restarted.reconcile();
      const restored = new LiveEngine(liveConfig, () => {});
      assert.equal(restored.state.handledSignals.find(s => s.targetSignature === trade.signature).status,
        "failed_onchain");
      assert.equal(restored.state.dailySpendLamports, 5000n);
      assert.equal(restored.state.isQuarantined(mint), true);
      assert.equal(feeReads, 1);
      assert.equal(restored.releaseFailedBuyQuarantine(mint, {
        resolution: "confirmed BUY failure released with no inventory",
        evidence: { source: "controlled-confirmed-failure", seed },
        signature: `copy-quarantined-${seed}`, failedFeeLamports: "5000"
      }), true);
      const retry = controlledExecutor(mint, { baseline: 0n, afterBuy: 100n });
      restored.executor = retry.executor;
      assert.equal((await restored.onTrade({ signature: `target-retry-${seed}`, side: "BUY", mint,
        observedAtMs: Date.now(), signalSource: "processed_logs" })).type, "LIVE_SUBMITTED");
      await eventually(() => restored.positions.has(mint), `released BUY did not settle for seed ${seed}`);
      assert.deepEqual(retry.submissions, [retry.buySignature]);
      assert.equal(restored.state.isQuarantined(mint), false);
    } else {
      coverage.add("audited_resolution_sell_restart");
      const first = new LiveEngine(liveConfig, () => {});
      const { trade, signature } = reserveQuarantinedBuy(first, mint, seed);
      first.state.clearQuarantine(mint, {
        resolution: "confirmed token-account reconciliation",
        evidence: { source: "controlled-production-scenario", seed },
        position: {
          mint, rawTokenAmount: "100", inventoryBaselineRaw: "0",
          tokenProgram: TOKEN_PROGRAM_ID.toBase58(), entrySignature: signature,
          targetEntrySignature: trade.signature, costLamports: "5000000"
        }
      });
      const restarted = new LiveEngine(liveConfig, () => {});
      const controlled = controlledExecutor(mint, { baseline: 0n, afterBuy: 100n, afterSell: 0n });
      restarted.executor = controlled.executor;
      const sell = { signature: `target-resolved-sell-${seed}`, side: "SELL", mint,
        observedAtMs: Date.now(), signalSource: "processed_logs" };
      assert.equal((await restarted.onTrade(sell)).type, "LIVE_SUBMITTED");
      await eventually(() => !restarted.positions.has(mint), `resolved SELL did not close seed ${seed}`);
      assert.equal(restarted.state.isQuarantined(mint), false);
      assert.deepEqual(controlled.submissions, [controlled.sellSignature]);
    }
  }
  assert.deepEqual([...coverage].sort(), [
    "audited_resolution_sell_restart", "confirmed_duplicate_sell_restart",
    "fast_baseline_gate", "partial_outflow_sticky_restart",
    "quarantine_failure_fee_restart"
  ]);
  assert.equal(SEEDS.length, 32);
});
