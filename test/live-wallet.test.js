import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { loadLiveWallet } from "../src/live-wallet.js";

test("loads a 64-byte Solana key file and verifies its public address", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-wallet-"));
  try {
    const keypair = Keypair.generate();
    const file = path.join(tempDir, "wallet.json");
    fs.writeFileSync(file, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
    const loaded = loadLiveWallet(file, keypair.publicKey.toBase58());
    assert.equal(loaded.publicKey.toBase58(), keypair.publicKey.toBase58());
    assert.throws(() => loadLiveWallet(file, Keypair.generate().publicKey.toBase58()), /does not match/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rejects seed phrases and malformed key files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-wallet-"));
  try {
    const file = path.join(tempDir, "wallet.json");
    fs.writeFileSync(file, JSON.stringify("word word word"), { mode: 0o600 });
    assert.throws(() => loadLiveWallet(file), /64 byte values/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
