import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ExecutionLanes } from "../src/execution-lanes.js";

test("one WS notification submits B while A preparation is stalled", { timeout: 2000 }, async () => {
  const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const release = Promise.withResolvers(), second = Promise.withResolvers();
  const tasks = new Map(), submitted = [];
  const notify = vm.runInNewContext(source.slice(source.indexOf("function enqueueTrade("),
    source.indexOf("async function initializeTargetIngestion(")) + "\nprocessWebsocketSignature", {
    performance, setImmediate, config: { fastSignalEnabled: true, tradingMode: "live" },
    shadowTrader: null, liveLanes: new ExecutionLanes(), ingressLanes: new ExecutionLanes(),
    signatureTasks: tasks, fastMetrics: { detected: 0 }, log() {}, rememberLatency() {},
    rpc: { getTransactionWithRetry: async () => null },
    parsePumpLogSignal: trades => ({ trades }), resolvePumpCandidates: async trades => ({ trades, unsupportedTrades: [] }),
    trader: { async onTrade({ mint }) {
      if (mint === "A") await release.promise;
      submitted.push(mint);
      if (mint === "B") second.resolve();
      return {};
    } }
  });
  const target = { wallet: "w", fastEnabled: true, liveEnabled: true, ingestion: { has: () => false, markProcessed() {} } };
  const value = { signature: "one", logs: ["A","B"].map(mint => ({ mint, side: "BUY", signature: "one" })) };
  notify(target, value, 1, Date.now());
  notify(target, value, 1, Date.now());
  const done = Promise.all(tasks.values());
  await second.promise;
  assert.deepEqual(submitted, ["B"]);
  release.resolve();
  await done;
  assert.deepEqual(submitted, ["B","A"]);
});
