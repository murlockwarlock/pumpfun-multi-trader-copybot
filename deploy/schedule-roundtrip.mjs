import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const mint = new PublicKey(process.argv[2]).toBase58();
const holdMinutes = Number(process.argv[3] ?? "30");
const directory = path.resolve(process.env.MANUAL_ORDER_DIR ?? "./data/manual-orders");
if (!Number.isFinite(holdMinutes) || holdMinutes < 1 || holdMinutes > 1_440) {
  throw new Error("hold minutes must be between 1 and 1440");
}
const now = Date.now();
const groupId = randomUUID();
const orders = [
  {
    version: 1,
    id: `${groupId}-buy`,
    groupId,
    side: "BUY",
    mint,
    executeAt: new Date(now).toISOString(),
    executionRoute: null,
    createdAt: new Date(now).toISOString()
  },
  {
    version: 1,
    id: `${groupId}-sell`,
    groupId,
    side: "SELL",
    mint,
    executeAt: new Date(now + holdMinutes * 60_000).toISOString(),
    executionRoute: null,
    createdAt: new Date(now).toISOString()
  }
];
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const files = orders.map((order) => {
  const target = path.join(
    directory,
    `${order.executeAt.replaceAll(":", "-")}-${order.id}.json`
  );
  return { target, temporary: `${target}.tmp`, order };
});
try {
  for (const { temporary, order } of files) {
    fs.writeFileSync(temporary, `${JSON.stringify(order, null, 2)}\n`, { mode: 0o600 });
  }
  for (const { target, temporary } of files) fs.renameSync(temporary, target);
} catch (error) {
  for (const { target, temporary } of files) {
    fs.rmSync(temporary, { force: true });
    fs.rmSync(target, { force: true });
  }
  throw error;
}
console.log(JSON.stringify({
  groupId,
  mint,
  buyAt: orders[0].executeAt,
  sellAt: orders[1].executeAt,
  holdMinutes
}));
