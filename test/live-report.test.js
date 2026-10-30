import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLiveReport, formatLiveReport } from "../src/live-report.js";

test("builds an admin report from exact realized live records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-report-"));
  const file = path.join(directory, "live.jsonl");
  const day = new Date().toISOString().slice(0, 10);
  try {
    fs.writeFileSync(file, [
      { type: "LIVE_BUY", at: `${day}T01:00:00.000Z`, sourceName: "one", targetSignature: "buy-1" },
      { type: "LIVE_SELL", at: `${day}T02:00:00.000Z`, sourceName: "one", targetSignature: "sell-1", realizedPnlLamports: "1000000" },
      { type: "LIVE_SELL", at: `${day}T03:00:00.000Z`, sourceName: "two", targetSignature: "sell-2", realizedPnlLamports: "-400000" },
      { type: "LIVE_SKIP", at: `${day}T04:00:00.000Z`, sourceName: "two", targetSignature: "skip-1", reason: "entry_price_drift" }
    ].map(JSON.stringify).join("\n"));
    const report = buildLiveReport(file, day, []);
    assert.equal(report.buys, 1);
    assert.equal(report.sells, 2);
    assert.equal(report.wins, 1);
    assert.equal(report.losses, 1);
    assert.equal(report.traders.one.signals, 2);
    assert.equal(report.traders.two.skips, 1);
    assert.ok(Math.abs(report.realizedPnlSol - 0.0006) < 1e-12);
    assert.match(formatLiveReport(report), /0\.000600000 SOL/);
    assert.match(formatLiveReport(report), /По трейдерам/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
