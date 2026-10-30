import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IngestionState } from "../src/ingestion-state.js";

test("restores the durable cursor and processed signatures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingestion-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const first = new IngestionState(file, 3);
    first.markProcessed("signature-1");
    first.markProcessed("signature-2");
    first.checkpoint("signature-2");

    const restarted = new IngestionState(file, 3);
    assert.equal(restarted.initialized, true);
    assert.equal(restarted.cursor, "signature-2");
    assert.equal(restarted.has("signature-1"), true);
    assert.equal(restarted.has("signature-2"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("keeps only the configured number of processed signatures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingestion-state-"));
  try {
    const file = path.join(tempDir, "state.json");
    const state = new IngestionState(file, 2);
    state.markProcessed("signature-1");
    state.markProcessed("signature-2");
    state.markProcessed("signature-3");

    assert.equal(state.has("signature-1"), false);
    assert.equal(state.has("signature-2"), true);
    assert.equal(state.has("signature-3"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
