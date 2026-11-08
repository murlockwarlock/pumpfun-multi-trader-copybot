// Exercise the actual dispatch function from each revision without starting the service.
import vm from "node:vm";
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionLanes } from "../src/execution-lanes.js";

async function measure(source) {
  const start = performance.now();
  const submissions = [];
  let finishShadow;
  const shadowDone = new Promise(resolve => { finishShadow = resolve; });
  const trader = {
    async probeBuy() { await delay(5000); return { signalToPreparedMs: 5000 }; },
    async onTrade(trade) {
      if (trade.sourceLiveEnabled) {
        await delay(40);
        await delay(10);
        submissions.push(Math.round(performance.now() - start));
      }
      return { type: "SKIP" };
    }
  };
  const tasks = new Map();
  const ctx = { tradeQueue: Promise.resolve(), liveLanes: new ExecutionLanes(),
    shadowLanes: new ExecutionLanes(), ingressLanes: new ExecutionLanes(),
    config: { tradingMode: "live", fastSignalEnabled: true, fastShadowProbeEnabled: true },
    trader, signatureTasks: tasks, fastMetrics: { detected: 0 }, performance,
    shadowTrader: { onTrade: trade => { if (trade.mint === "monitor") finishShadow(); }, blockTrade: finishShadow }, setImmediate,
    log() {}, rememberLatency() {}, rpc: { getTransactionWithRetry: async () => null },
    parsePumpLogSignal: logs => ({ trades: logs }),
    resolvePumpCandidates: async trades => ({ trades, unsupportedTrades: [] })
  };
  const { dispatch, notify } = vm.runInNewContext(
    source.slice(source.includes("async function updateShadow(") ? source.indexOf("async function updateShadow(") : source.indexOf("function enqueueTrade("), source.indexOf("async function initializeTargetIngestion(")) +
      "\n;({dispatch: enqueueTrade, notify: processWebsocketSignature})", ctx
  );
  const monitor = dispatch({ mint: "monitor", side: "BUY", fastProfile: true }, "fixture", { shadowEligible: true });
  const seen = new Set();
  const target = { wallet: "live", fastEnabled: true, liveEnabled: true,
    ingestion: { has: sig => seen.has(sig), markProcessed: sig => seen.add(sig) } };
  for (const mint of ["a","b"]) {
    const value = { signature: mint, logs: [{ side: "BUY", mint, signature: mint }] };
    notify(target, value, 1, Date.now());
    notify(target, value, 1, Date.now());
  }
  await Promise.all([monitor, ...tasks.values()]);
  assert.equal(submissions.length, 2);
  await shadowDone;
  return submissions;
}
if (process.env.BENCH_BASE_REF) {
  const baselineSource = execFileSync("git", ["show", `${process.env.BENCH_BASE_REF}:src/index.js`], { encoding: "utf8" });
  const currentSource = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const samples = { baseline: [], current: [] };
  // Alternate isolated runs. Running every revision concurrently measures VM
  // startup of later fixtures inside the latency of earlier fixtures.
  for (let n = 0; n < 3; n++) {
    for (const label of n % 2 ? ["current", "baseline"] : ["baseline", "current"]) {
      samples[label].push(...await measure(label === "baseline" ? baselineSource : currentSource));
    }
  }
  const quantiles = a => {const s=[...a].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s[Math.ceil(s.length*.99)-1]};};
  console.log(JSON.stringify({baselineRef:process.env.BENCH_BASE_REF,samples,
    baseline:quantiles(samples.baseline),current:quantiles(samples.current),unit:"ms since notification"},null,2));
  assert.ok(Math.max(...samples.current)<1000);
  process.exit(0);
}
const [before, previousPR, previousHead, reviewHead, after] = await Promise.all([
  measure(execFileSync("git", ["show", "08b9df6:src/index.js"], { encoding: "utf8" })),
  measure(execFileSync("git", ["show", "49b0a58:src/index.js"], { encoding: "utf8" })),
  measure(execFileSync("git", ["show", "1b784bf:src/index.js"], { encoding: "utf8" })),
  measure(execFileSync("git", ["show", "ae07a26:src/index.js"], { encoding: "utf8" })),
  measure(fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8"))
]);
console.log({ before, previousPR, previousHead, reviewHead, after, unit: "ms since notification" });
assert.ok(before[0] >= 5000 && after[1] < 1000);
