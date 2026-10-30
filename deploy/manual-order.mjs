import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const side = String(process.argv[2] ?? "").toUpperCase();
const mint = new PublicKey(process.argv[3]).toBase58();
const executeAt = new Date(process.argv[4] ?? Date.now());
const directory = path.resolve(
  process.env.MANUAL_ORDER_DIR ?? process.argv[5] ?? "./data/manual-orders"
);
if (!["BUY", "SELL"].includes(side) || !Number.isFinite(executeAt.getTime())) {
  throw new Error("Usage: node deploy/manual-order.mjs BUY|SELL MINT [EXECUTE_AT] [DIRECTORY]");
}
const id = randomUUID();
const order = {
  version: 1,
  id,
  side,
  mint,
  executeAt: executeAt.toISOString(),
  executionRoute: null,
  createdAt: new Date().toISOString()
};
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = path.join(directory, `${order.executeAt.replaceAll(":", "-")}-${id}.json`);
const temporary = `${target}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(order, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, target);
console.log(JSON.stringify(order));
