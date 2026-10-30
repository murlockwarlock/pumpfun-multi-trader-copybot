import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const [inputFile, outputDirectory] = process.argv.slice(2);
if (!inputFile || !outputDirectory) {
  throw new Error("Usage: node prepare-live-secrets.mjs INPUT_FILE OUTPUT_DIRECTORY");
}
const inputStat = fs.lstatSync(inputFile);
if (!inputStat.isFile() || inputStat.isSymbolicLink()) {
  throw new Error("Secret input must be a regular file");
}

const values = new Map();
for (const original of fs.readFileSync(inputFile, "utf8").split(/\r?\n/)) {
  const line = original.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) throw new Error("Each secret line must use name=value format");
  const name = line.slice(0, separator).trim().toLowerCase();
  const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  if (values.has(name)) throw new Error(`Duplicate secret label: ${name}`);
  values.set(name, value);
}
const jupiterKey = values.get("jupiter");
const walletSecret = values.get("wallet");
if (!jupiterKey || jupiterKey.length < 20) throw new Error("Invalid Jupiter API key");
if (!walletSecret) throw new Error("Missing wallet private key");

let secretBytes;
try {
  secretBytes = bs58.decode(walletSecret);
} catch {
  throw new Error("Wallet private key is not valid base58");
}
if (secretBytes.length !== 64) {
  throw new Error(`Wallet private key decoded to ${secretBytes.length} bytes, expected 64`);
}
const wallet = Keypair.fromSecretKey(secretBytes);

fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const walletFile = path.join(outputDirectory, "live-wallet.json");
const jupiterFile = path.join(outputDirectory, "jupiter-api-key");
fs.writeFileSync(walletFile, `${JSON.stringify([...secretBytes])}\n`, { mode: 0o600 });
fs.writeFileSync(jupiterFile, jupiterKey, { mode: 0o600 });
fs.chmodSync(walletFile, 0o600);
fs.chmodSync(jupiterFile, 0o600);

console.log(JSON.stringify({
  walletAddress: wallet.publicKey.toBase58(),
  walletFile,
  jupiterFile,
  jupiterKeyPresent: true
}));
