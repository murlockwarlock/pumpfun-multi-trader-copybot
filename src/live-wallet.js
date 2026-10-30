import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

export function loadLiveWallet(file, expectedAddress = "") {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("LIVE_WALLET_FILE must be a regular file, not a symlink");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("LIVE_WALLET_FILE must not be readable by group or other users (chmod 600)");
  }

  let secret;
  try {
    secret = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("LIVE_WALLET_FILE must contain a JSON array");
  }
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error("LIVE_WALLET_FILE must contain exactly 64 byte values");
  }

  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (expectedAddress && wallet.publicKey.toBase58() !== expectedAddress) {
    throw new Error("LIVE_WALLET_ADDRESS does not match LIVE_WALLET_FILE");
  }
  return wallet;
}
