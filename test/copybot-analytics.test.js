import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeShadow, buildFunnel, buildReport, screenCachedCandidates, sizeStudySnapshot } from "../scripts/copybot-analytics.mjs";

const t = iso => Date.parse(iso);

test("shadow report separates old sniper PnL from the last 24 hours and detects a repeated snapshot", () => {
  const old = [
    { type: "SHADOW_SELL", at: "2026-11-02T15:42:32.783Z", sourceName: "sniper_7ufmve", targetSignature: "a", pnlSol: -0.002978536 },
    { type: "SHADOW_SELL", at: "2026-11-03T13:08:19.566Z", sourceName: "sniper_7ufmve", targetSignature: "b", pnlSol: 0.001422417 },
    { type: "SHADOW_SELL", at: "2026-11-04T15:09:15.442Z", sourceName: "sniper_7ufmve", targetSignature: "c", pnlSol: -0.000385839 },
    { type: "SHADOW_SELL", at: "2026-11-04T15:09:25.354Z", sourceName: "sniper_7ufmve", targetSignature: "d", pnlSol: -0.000600983 },
    { type: "SHADOW_SELL", at: "2026-11-04T16:01:57.041Z", sourceName: "sniper_7ufmve", targetSignature: "e", pnlSol: -0.000209516 },
    { type: "SHADOW_SELL", at: "2026-11-04T16:06:06.336Z", sourceName: "sniper_7ufmve", targetSignature: "f", pnlSol: -0.000575694 },
    { type: "SHADOW_SELL", at: "2026-11-12T04:00:00.000Z", sourceName: "candidate_4rt", targetSignature: "g", pnlSol: 0.001 }
  ];
  const report = analyzeShadow(old, { now: t("2026-11-12T05:00:00.000Z"), oldSnapshot: { net: -0.003328151 } });
  assert.equal(report.bySource.sniper_7ufmve.trades, 6);
  assert.ok(Math.abs(report.bySource.sniper_7ufmve.netSol - (-0.003328151)) < 1e-12);
  assert.equal(report.last24h.trades, 1);
  assert.equal(report.repeatedHistoricalSnapshot, true);
  assert.equal(report.duplicates.length, 0);
});

test("funnel keeps finalized evidence, loss reasons, gaps and latency percentiles separate", () => {
  const rows = [
    { type: "START", at: 0, wallets: ["w"] },
    { type: "SIGNAL", at: 100, wallet: "w", signature: "s1", provisionalSides: ["BUY"] },
    { type: "FINALIZED", at: 110, signature: "s1", slot: 7 },
    { type: "ELIGIBLE", at: 120, wallet: "w", signature: "s1", side: "BUY" },
    { type: "BUY_QUOTE", at: 150, wallet: "w", signature: "s1", latencyMs: 50, quote: { quoteMs: 40 } },
    { type: "SELL_QUOTE", at: 400, wallet: "w", signature: "s1", latencyMs: 250, netLamports: "-1" },
    { type: "SIGNAL", at: 500, wallet: "w", signature: "s2", provisionalSides: ["BUY"] },
    { type: "UNKNOWN", at: 510, wallet: "w", phase: "BUY", reason: "rpc_budget" },
    { type: "WS_GAP", at: 520, wallet: "w", durationMs: 1000 }
  ];
  const report = buildFunnel(rows, { wallet: "w", start: 0, end: 1000 });
  assert.equal(report.status, "DATA_GAP");
  assert.deepEqual(report.counts, { wsNotification: 2, parsedSignal: 2, confirmed: 1, eligibleBuy: 1, buyQuote: 1, sellQuote: 1, closed: 1 });
  assert.equal(report.reasons.OWN_RPC_BUDGET, 1);
  assert.equal(report.latencies.signalToPrepared.p50, 50);
  assert.equal(report.latencies.sellQuote.p95, 250);
  assert.equal(report.missing.parsedSignalToConfirmed, 1);
});

test("cached candidate screen excludes incomplete candidates and never treats missing coverage as a loss", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-candidate-"));
  const trade = { signature: "s", side: "BUY", quoteKind: "SOL", venue: "pumpswap" };
  fs.writeFileSync(path.join(dir, "entry-trades-cand_one.json"), JSON.stringify({ trader: { name: "one", wallet: "wallet-one" }, signatures: [{ signature: "s" }], trades: [trade, { ...trade, side: "SELL" }] }));
  fs.writeFileSync(path.join(dir, "entry-trades-cand_two.json"), JSON.stringify({ trader: { name: "two", wallet: "wallet-two" }, signatures: [{ signature: "t" }], trades: [{ side: "BUY", quoteKind: "UNKNOWN" }] }));
  fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify({ transaction: { message: { accountKeys: [{ signer: true, pubkey: "wallet-one" }, { signer: true, pubkey: "wallet-three" }] } } }));
  const report = screenCachedCandidates(dir);
  assert.equal(report.cachedFiles, 2);
  assert.equal(report.screenedCandidates, 2);
  assert.equal(report.authenticatedSigners, 2);
  assert.deepEqual(report.top[0].wallet, "wallet-one");
  assert.deepEqual(report.excludedForInsufficientCoverage, ["wallet-two"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("five-size smoke is explicitly not a prospective strategy comparison", () => {
  const report = sizeStudySnapshot("docs/evidence/next-copy-size-smoke.json");
  assert.equal(report.status, "UNPROVEN");
  assert.equal(report.scenarios.length, 5);
  assert.equal(report.comparableProspectivePairs, 0);
  assert.equal(report.rpcBudget.oneBuyPlusOneSell, 71);
  assert.equal(report.rpcBudget.oneBuyPlusFourSells, 176);
  assert.match(report.rpcBudget.conclusion, /insufficient/);
  assert.ok(report.scenarios.every(s => s.contextVerified && s.independent));
});

test("report keeps a read-only server observation separate from shadow economics", () => {
  const report = buildReport({ combinedRows: [{ type: "START", run: "run-1", at: 1, wallets: [] }], shadowRows: [], now: 2,
    serverStatus: { checkedAt: "2026-11-12T10:20:14.300Z", systemd: "active", stopLive: true, liveTraderWallets: "none", liveDispatchOrSettlement24h: { LIVE_SUBMITTED: 0 } } });
  assert.equal(report.serverStatus.systemd, "active");
  assert.equal(report.serverStatus.liveDispatchOrSettlement24h.LIVE_SUBMITTED, 0);
  assert.equal(report.shadow.last24h.trades, 0);
});
