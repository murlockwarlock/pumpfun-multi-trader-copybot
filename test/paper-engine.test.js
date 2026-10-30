import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PaperEngine } from "../src/paper-engine.js";

test("restores an open paper position after restart", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-engine-"));
  try {
    const config = {
      logFile: path.join(tempDir, "trades.jsonl"),
      stateFile: path.join(tempDir, "state.json"),
      maxSignalAgeMs: 60_000,
      maxDailyLossSol: 0.02,
      maxOpenPositions: 1,
      latencyPenaltyBps: 300,
      pumpFeeBps: 125,
      paperTradeSol: 0.015
    };
    const trade = {
      side: "BUY",
      mint: "5ZQubmAuRaMjdHjnp4B2GMoakntsD8zzuzvsX2xZpump",
      averagePriceSol: 0.000001,
      blockTime: Math.floor(Date.now() / 1000),
      signature: "test-buy"
    };

    const first = new PaperEngine(config);
    assert.equal(first.onTrade(trade).type, "PAPER_BUY");
    assert.equal(first.positions.size, 1);

    const restarted = new PaperEngine(config);
    assert.equal(restarted.positions.size, 1);
    assert.equal(restarted.positions.get(trade.mint).entrySignature, "test-buy");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("keeps same-mint paper positions isolated by source trader", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-engine-multi-"));
  try {
    const config = {
      logFile: path.join(tempDir, "trades.jsonl"),
      stateFile: path.join(tempDir, "state.json"),
      maxSignalAgeMs: 60_000,
      maxDailyLossSol: 0.02,
      maxOpenPositions: 2,
      latencyPenaltyBps: 0,
      pumpFeeBps: 0,
      paperTradeSol: 0.01
    };
    const engine = new PaperEngine(config);
    const base = {
      side: "BUY",
      mint: "5ZQubmAuRaMjdHjnp4B2GMoakntsD8zzuzvsX2xZpump",
      averagePriceSol: 0.000001,
      blockTime: Math.floor(Date.now() / 1000)
    };
    assert.equal(engine.onTrade({ ...base, sourceWallet: "wallet-a", signature: "a-buy" }).type, "PAPER_BUY");
    assert.equal(engine.onTrade({ ...base, sourceWallet: "wallet-b", signature: "b-buy" }).type, "PAPER_BUY");
    assert.equal(engine.positions.size, 2);
    assert.equal(engine.onTrade({
      ...base, side: "SELL", sourceWallet: "wallet-b", signature: "b-sell"
    }).type, "PAPER_SELL");
    assert.equal(engine.positions.size, 1);
    assert.ok(engine.positions.has(`wallet-a:${base.mint}`));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
