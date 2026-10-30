import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { ManualOrderQueue } from "../src/manual-orders.js";

test("manual queue submits due orders and leaves future orders durable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copybot-manual-orders-"));
  const mint = Keypair.generate().publicKey.toBase58();
  const due = {
    id: "due",
    side: "BUY",
    mint,
    executeAt: new Date(Date.now() - 1_000).toISOString()
  };
  const future = {
    id: "future",
    side: "SELL",
    mint,
    executeAt: new Date(Date.now() + 60_000).toISOString()
  };
  fs.writeFileSync(path.join(directory, "due.json"), JSON.stringify(due));
  fs.writeFileSync(path.join(directory, "future.json"), JSON.stringify(future));
  const trades = [];
  const queue = new ManualOrderQueue(
    directory,
    async (trade) => {
      trades.push(trade);
      return { type: "LIVE_SUBMITTED" };
    },
    () => {}
  );

  await queue.poll();

  assert.equal(trades.length, 1);
  assert.equal(trades[0].signature, "manual:due:BUY");
  assert.equal(trades[0].mint, mint);
  assert.deepEqual(fs.readdirSync(directory), ["future.json"]);
});
