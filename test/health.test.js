import assert from "node:assert/strict";
import test from "node:test";
import { assessTargetHealth } from "../src/health.js";

function target(wallet, lastSuccessfulPollAt) {
  return {
    name: wallet,
    wallet,
    liveEnabled: wallet === "live",
    lastSuccessfulPollAt,
    lastWsMessageAt: null,
    ingestion: { cursor: `${wallet}-cursor` }
  };
}

test("one stale target does not declare the whole RPC connection dead", () => {
  const health = assessTargetHealth([
    target("live", 99_000),
    target("monitor", 1_000)
  ], 10_000, 100_000);
  assert.equal(health.rpcSilenceMs, 1_000);
  assert.deepEqual(health.staleTargets.map((item) => item.wallet), ["monitor"]);
  assert.equal(health.allTargetsStale, false);
});

test("requests process recovery only when every target is stale", () => {
  const health = assessTargetHealth([
    target("live", 1_000),
    target("monitor", 2_000)
  ], 10_000, 100_000);
  assert.equal(health.allTargetsStale, true);
});
