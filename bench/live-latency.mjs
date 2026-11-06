import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { LiveEngine } from "../src/live-engine.js";

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};

function config(dir, maxOpenPositions) {
  return {
    tradingMode: "live", liveStateFile: path.join(dir, "state.json"),
    liveLogFile: path.join(dir, "trades.jsonl"), liveKillSwitchFile: path.join(dir, "STOP"),
    liveAutoPauseFile: path.join(dir, "AUTO_PAUSE_BUYS"), maxSignalAgeMs: 60_000,
    fastMaxSignalAgeMs: 60_000, maxOpenPositions, liveTradeSol: 0.005,
    liveMaxDailySpendSol: 1_000, liveMinReserveSol: 0.02,
    livePriorityFeeSol: 0.0001, liveTipSol: 0.000005,
    liveMaxEntryDriftBps: 10_000, fastMaxEntryDriftBps: 10_000
  };
}

async function measure(side, count = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-latency-"));
  try {
    const engine = new LiveEngine(config(dir, count), () => {});
    const mints = Array.from({ length: count }, () => Keypair.generate().publicKey);
    if (side === "SELL") {
      for (const mint of mints) engine.state.setPosition({
        mint: mint.toBase58(), rawTokenAmount: "100", inventoryBaselineRaw: "0",
        tokenProgram: TOKEN_PROGRAM_ID.toBase58(), openedAt: new Date().toISOString(),
        entrySignature: `entry-${mint.toBase58()}`
      });
    }
    engine.executor = {
      prewarm: async () => {}, balanceLamports: async () => 1_000_000_000_000n,
      tokenBalance: async () => side === "BUY" ? 0n : 100n,
      prepare: async (_side, mintAddress) => ({
        expectedSignature: `${side}-${mintAddress}`, mint: new PublicKey(mintAddress),
        tokenProgram: TOKEN_PROGRAM_ID, venue: "pump-curve",
        beforeTokenBalance: side === "BUY" ? 0n : 100n,
        beforeTokenBalanceKnown: true, lastValidBlockHeight: 123
      }),
      submit: async prepared => prepared.expectedSignature,
      confirm: async () => new Promise(() => {})
    };
    const started = Date.now();
    const results = await Promise.all(mints.map((mint, index) => engine.onTrade({
      side, mint: mint.toBase58(), signature: `${side}-target-${index}`,
      observedAtMs: started, signalSource: "processed_logs"
    })));
    const values = results.map(result => result.signalToSubmitMs).filter(Number.isFinite);
    return {
      count: values.length,
      p50: percentile(values, 0.50), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
      min: Math.min(...values), max: Math.max(...values)
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log({ BUY: await measure("BUY"), SELL: await measure("SELL") });
