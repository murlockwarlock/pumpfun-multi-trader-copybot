import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { ShadowEngine } from "../src/shadow-engine.js";
import { ShadowClient } from "../src/shadow-client.js";

// Same accounting engine and disk workload in both runs. Sample live prepare +
// submit timers while eight monitor portfolios persist BUY/SELL state.
for (const isolated of [false, true]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-load-"));
  const targetTraders = Array.from({ length: 8 }, (_, i) => ({ name: String(i), wallet: String(i) }));
  const config = { targetTraders, shadowLogFile: path.join(dir, "log"), shadowStateDir: dir,
    maxSignalAgeMs: 60000, shadowMaxDailyLossSol: 100, shadowMaxOpenPositionsPerTrader: 4,
    shadowTradeSol: 0.005, shadowTxFeeSol: 0.0001, shadowLatencyPenaltyBps: 0, pumpFeeBps: 100 };
  const engine = isolated ? await ShadowClient.open(config) : new ShadowEngine(config);
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const latencies = [];
  try {
    histogram.enable();
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const submission = delay(3).then(() => delay(2)).then(() => latencies.push(performance.now() - start));
      await Promise.all(targetTraders.map(async ({ wallet }) => {
        for (const side of ["BUY","SELL"]) {
          const result = await engine.onTrade({ mint: String(i), side, sourceWallet: wallet,
            signature: [wallet,i,side].join(":"), blockTime: Math.floor(Date.now()/1000), averagePriceSol: 1 });
          assert.equal(result.type, "SHADOW_" + side);
        }
      }));
      await submission;
    }
    histogram.disable();
    latencies.sort((a,b) => a-b);
    console.log(isolated ? "worker" : "inline", "p50/p95/p99 ms",
      { submit: [50,95,99].map(p => +latencies[p-1].toFixed(2)),
        eventLoop: [50,95,99].map(p => +(histogram.percentile(p)/1e6).toFixed(2)) });
  } finally {
    if (isolated) await engine.worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
