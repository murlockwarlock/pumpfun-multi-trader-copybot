import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ShadowEngine } from "../src/shadow-engine.js";

test("gives every monitored trader an independent shadow portfolio", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-shadow-"));
  const config = {
    targetTraders: [
      { name: "alpha", wallet: "wallet-a" },
      { name: "beta", wallet: "wallet-b" }
    ],
    shadowLogFile: path.join(directory, "shadow.jsonl"),
    shadowStateDir: path.join(directory, "states"),
    maxSignalAgeMs: 60_000,
    shadowMaxDailyLossSol: 1,
    shadowMaxOpenPositionsPerTrader: 1,
    shadowLatencyPenaltyBps: 0,
    pumpFeeBps: 100,
    shadowTradeSol: 0.005,
    shadowTxFeeSol: 0.0001
  };
  const base = {
    side: "BUY",
    mint: "mint",
    averagePriceSol: 0.000001,
    blockTime: Math.floor(Date.now() / 1_000)
  };
  try {
    const engine = new ShadowEngine(config);
    assert.equal(engine.onTrade({
      ...base, signature: "a-buy", sourceWallet: "wallet-a", sourceName: "alpha"
    }).type, "SHADOW_BUY");
    assert.equal(engine.onTrade({
      ...base, signature: "b-buy", sourceWallet: "wallet-b", sourceName: "beta"
    }).type, "SHADOW_BUY");
    assert.equal(engine.positions.size, 2);
    const sell = engine.onTrade({
      ...base, side: "SELL", signature: "b-sell",
      sourceWallet: "wallet-b", sourceName: "beta"
    });
    assert.equal(sell.type, "SHADOW_SELL");
    assert.ok(sell.pnlSol < 0);
    assert.equal(engine.positions.size, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
