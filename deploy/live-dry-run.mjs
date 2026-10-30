import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { loadLiveWallet } from "../src/live-wallet.js";
import { PumpExecutor } from "../src/pump-executor.js";

const mint = process.argv[2];
const amountSol = Number(process.argv[3] ?? "0.005");
const route = String(process.argv[4] ?? "jupiter").toLowerCase();
if (!mint || !Number.isFinite(amountSol) || amountSol <= 0) {
  throw new Error("Usage: node deploy/live-dry-run.mjs MINT [AMOUNT_SOL]");
}
const projectRoot = path.resolve(import.meta.dirname, "..");
const walletFile = path.join(projectRoot, "secrets", "live-wallet.json");
const jupiterFile = path.join(projectRoot, "secrets", "jupiter-api-key");
const wallet = loadLiveWallet(walletFile);
const dryConfig = {
  ...config,
  jupiterApiKey: fs.readFileSync(jupiterFile, "utf8").trim()
};
const executor = new PumpExecutor(dryConfig, wallet);
const prepared = await executor.prepare(
  "BUY",
  mint,
  BigInt(Math.round(amountSol * 1_000_000_000)),
  { executionRoute: route === "jupiter" ? "jupiter" : null }
);
console.log(JSON.stringify({
  submitted: false,
  wallet: wallet.publicKey.toBase58(),
  mint,
  amountSol,
  route,
  venue: prepared.venue,
  router: prepared.jupiterRouter,
  expectedRawTokens: prepared.jupiterExpectedOut,
  transactionBytes: prepared.transaction.serialize().length,
  lastValidBlockHeight: prepared.lastValidBlockHeight
}, null, 2));
