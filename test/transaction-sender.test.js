import assert from "node:assert/strict";
import test from "node:test";
import { priorityMicroLamports, TransactionSender } from "../src/transaction-sender.js";

test("converts a total priority-fee cap into compute-unit pricing", () => {
  assert.equal(priorityMicroLamports(0.0001, 400_000), 250_000);
});

test("enforces Helius Sender minimum tips before any transaction is built", () => {
  const config = {
    liveSendRoute: "helius-swqos",
    liveTipSol: 0.000001,
    heliusApiKey: "test-key",
    rpcHttpUrl: "https://example.invalid",
    heliusSenderUrl: "https://sender.helius-rpc.com/fast"
  };
  assert.throws(() => new TransactionSender(config, {}), /0.000005/);
});
