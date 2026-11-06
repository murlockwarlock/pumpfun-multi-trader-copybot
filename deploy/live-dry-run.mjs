import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { loadLiveWallet } from "../src/live-wallet.js";
import { PumpExecutor } from "../src/pump-executor.js";

const mint = process.argv[2];
const amountSol = Number(process.argv[3] ?? "0.005");
const route = String(process.argv[4] ?? "direct").toLowerCase();
if (!mint || !Number.isFinite(amountSol) || amountSol <= 0) {
  throw new Error("Usage: node deploy/live-dry-run.mjs MINT [AMOUNT_SOL] [direct|jupiter]");
}
const projectRoot = path.resolve(import.meta.dirname, "..");
const walletFile = process.env.CANARY_WALLET_FILE ?? config.liveWalletFile;
const jupiterFile = process.env.CANARY_JUPITER_KEY_FILE ??
  path.join(projectRoot, "secrets", "jupiter-api-key");
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
  {
    executionRoute: route === "jupiter" ? "jupiter" : null,
    balanceCommitment: "processed",
    requireBaselineContext: true,
    skipSimulation: true
  }
);
const observations = prepared.beforeTokenBalanceEvidence?.observations ?? [];
const zeroBaseline = prepared.beforeTokenBalance === 0n &&
  prepared.beforeTokenBalanceKnown === true &&
  observations.length === 3 &&
  observations.every(observation => observation.amount === "0" && observation.delegate === null);
if (!zeroBaseline) {
  throw new Error("canary preflight blocked: token baseline is non-zero, delegated, or unproven");
}
console.log(JSON.stringify({
  submitted: false,
  wallet: wallet.publicKey.toBase58(),
  mint,
  amountSol,
  route,
  venue: prepared.venue,
  router: prepared.jupiterRouter,
  expectedRawTokens: prepared.jupiterExpectedOut,
  baseline: prepared.beforeTokenBalance.toString(),
  baselineCommitment: "processed+confirmed+finalized",
  noDelegate: true,
  transactionBytes: prepared.transaction.serialize().length,
  lastValidBlockHeight: prepared.lastValidBlockHeight
}, null, 2));
