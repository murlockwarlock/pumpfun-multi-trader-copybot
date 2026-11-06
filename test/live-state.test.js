import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LiveState } from "../src/live-state.js";

test("reserves a live signal and daily spend atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new LiveState(file);
    const trade = { signature: "target-1", side: "BUY", mint: "mint-1" };
    assert.equal(state.reserveSignal(trade, { signature: "tx-1" }, 5_000_000n), true);
    assert.equal(state.reserveSignal(trade, {}, 5_000_000n), false);

    const restarted = new LiveState(file);
    assert.equal(restarted.hasHandled("target-1"), true);
    assert.equal(restarted.dailySpendLamports, 5_000_000n);
    assert.equal(restarted.handledSignals[0].signature, "tx-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("restores exact raw token amounts without floating point conversion", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new LiveState(file);
    state.setPosition({
      mint: "mint-1",
      rawTokenAmount: "9007199254740993000",
      tokenProgram: "program-1"
    });
    const restarted = new LiveState(file);
    assert.equal(restarted.positions.get("mint-1").rawTokenAmount, "9007199254740993000");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tracks realized loss and resets UTC daily risk counters", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new LiveState(file);
    state.recordRealizedPnl(-1_000_000n);
    state.recordRealizedPnl(-2_000_000n);
    assert.equal(state.dailyRealizedPnlLamports, -3_000_000n);
    assert.equal(state.consecutiveLosses, 2);
    state.recordRealizedPnl(500_000n);
    assert.equal(state.consecutiveLosses, 0);

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.day = "2000-01-01";
    fs.writeFileSync(file, JSON.stringify(saved));
    const restarted = new LiveState(file);
    assert.equal(restarted.resetDayIfNeeded(), true);
    assert.equal(restarted.dailyRealizedPnlLamports, 0n);
    assert.equal(restarted.consecutiveLosses, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quarantine is mint-scoped, sticky across restart, and cannot delete its position", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-quarantine-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new LiveState(file);
    state.setPosition({
      mint: "mint-1", rawTokenAmount: "100", inventoryBaselineRaw: "50",
      tokenProgram: "program-1", entrySignature: "copy-buy",
      targetEntrySignature: "target-buy", ownershipStatus: "quarantined"
    });
    state.quarantineMint("mint-1", {
      kind: "buy", reason: "inventory_baseline_unproven", signature: "copy-buy",
      targetSignature: "target-buy", evidence: { observedTokenBalance: "120" }
    });
    assert.equal(state.deletePosition("mint-1"), false);
    assert.equal(state.positions.has("mint-1"), true);

    const restarted = new LiveState(file);
    assert.equal(restarted.isQuarantined("mint-1"), true);
    assert.equal(restarted.getQuarantine("mint-1").firstSeenAt !== undefined, true);
    assert.throws(() => restarted.clearQuarantine("mint-1"), /audit evidence/);
    assert.equal(restarted.clearQuarantine("mint-1", {
      resolution: "operator verified transaction flow",
      evidence: { source: "confirmed_token_account_snapshot" },
      position: restarted.positions.get("mint-1")
    }), true);
    const audited = new LiveState(file);
    assert.equal(audited.isQuarantined("mint-1"), false);
    assert.equal(audited.positions.get("mint-1").rawTokenAmount, "100");
    assert.equal(audited.positions.get("mint-1").ownershipStatus, undefined);
    assert.equal(audited.quarantineAudit.at(-1).resolution, "operator verified transaction flow");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orphan quarantine cannot be cleared without restoring an auditable position", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-live-orphan-quarantine-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new LiveState(file);
    state.quarantineMint("mint-1", {
      kind: "buy", reason: "inventory_baseline_unproven", signature: "copy-buy",
      targetSignature: "target-buy"
    });
    assert.throws(
      () => state.clearQuarantine("mint-1", "operator saw the token account"),
      /audit evidence/
    );
    assert.equal(state.isQuarantined("mint-1"), true);
    assert.equal(state.clearQuarantine("mint-1", {
      resolution: "operator reconciled token account and restored ledger",
      evidence: { source: "confirmed_token_account_snapshot", observedAt: "test" },
      position: {
        mint: "mint-1", rawTokenAmount: "100", inventoryBaselineRaw: "50",
        tokenProgram: "program-1", entrySignature: "copy-buy",
        targetEntrySignature: "target-buy", costLamports: "5000000"
      }
    }), true);
    assert.equal(state.isQuarantined("mint-1"), false);
    assert.equal(state.positions.get("mint-1").rawTokenAmount, "100");
    assert.deepEqual(state.quarantineAudit.at(-1).restoredPosition, {
      rawTokenAmount: "100", inventoryBaselineRaw: "50", entrySignature: "copy-buy",
      targetEntrySignature: "target-buy", pendingExit: null
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
