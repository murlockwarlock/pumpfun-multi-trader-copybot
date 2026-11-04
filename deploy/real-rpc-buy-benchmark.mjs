import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config.js";
import { loadLiveWallet } from "../src/live-wallet.js";
import { PumpExecutor } from "../src/pump-executor.js";

const mintAddress = process.argv[2];
const runs = Math.min(20, Math.max(3, Number(process.argv[3] ?? 7)));
if (!mintAddress || !Number.isInteger(runs)) {
  throw new Error("Usage: node deploy/real-rpc-buy-benchmark.mjs MINT [WARM_RUNS]");
}
const mint = new PublicKey(mintAddress);
const projectRoot = path.resolve(import.meta.dirname, "..");
const walletFile = process.env.BENCH_WALLET_FILE ?? path.join(projectRoot, "secrets", "live-wallet.json");
const jupiterFile = process.env.BENCH_JUPITER_KEY_FILE ?? path.join(projectRoot, "secrets", "jupiter-api-key");
const benchConfig = {
  ...config,
  jupiterApiKey: process.env.JUPITER_API_KEY ?? fs.readFileSync(jupiterFile, "utf8").trim(),
  liveSimulate: false
};
const wallet = loadLiveWallet(walletFile);
const executor = new PumpExecutor(benchConfig, wallet);
const amountSol = Number(process.env.BENCH_AMOUNT_SOL ?? benchConfig.liveTradeSol);
if (!Number.isFinite(amountSol) || amountSol <= 0) {
  throw new Error("BENCH_AMOUNT_SOL must be a positive number");
}
const amount = BigInt(Math.round(amountSol * 1_000_000_000));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const summarize = samples => {
  const keys = ["totalMs", "marketRouteMs", "quoteMs", "balanceMs", "blockhashMs", "assembleSignMs", "prepareMs", "readyMs"];
  return Object.fromEntries(keys.map(key => {
    const values = samples.map(sample => sample[key]).filter(Number.isFinite);
    return [key, values.length === 0 ? null : {
      p50: Number(percentile(values, 0.50).toFixed(2)),
      p95: Number(percentile(values, 0.95).toFixed(2)),
      p99: Number(percentile(values, 0.99).toFixed(2)),
      n: values.length
    }];
  }));
};

async function measure(route) {
  const samples = [];
  for (let index = 0; index < runs + 1; index += 1) {
    const timing = {};
    const startedAt = performance.now();
    await executor.prepare("BUY", mint.toBase58(), amount, {
      executionRoute: route === "jupiter" ? "jupiter" : null,
      skipSimulation: true,
      balanceCommitment: "processed",
      requireBaselineContext: true,
      timing
    });
    timing.totalMs = performance.now() - startedAt;
    if (index > 0) samples.push(timing);
  }
  return summarize(samples);
}

console.log(JSON.stringify({
  submitted: false,
  rpcHost: new URL(benchConfig.rpcHttpUrl).host,
  mint: mint.toBase58(),
  amountSol,
  runs,
  routes: {
    direct: await measure("direct"),
    jupiter: await measure("jupiter")
  },
  note: "Preparation only; no transaction was submitted. Each run uses the FAST BUY processed commitment plus processed/confirmed/finalized baseline reads. Signal/queue latency is not included."
}, null, 2));
