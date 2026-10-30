import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PUMP_PROGRAM_ID,
  PUMP_SDK
} from "@pump-fun/pump-sdk";
import { config } from "../src/config.js";

const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const ZERO_KEY = new PublicKey("11111111111111111111111111111111");
const limit = Math.min(500, Math.max(20, Number(process.argv[2] ?? 150)));
const connection = new Connection(config.rpcHttpUrl, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: config.rpcTimeoutMs
});
const pump = new OnlinePumpSdk(connection);

async function getTransactionsRaw(batch) {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(config.rpcHttpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(config.rpcTimeoutMs),
      body: JSON.stringify(batch.map(({ signature }, id) => ({
        jsonrpc: "2.0",
        id,
        method: "getTransaction",
        params: [signature, {
          commitment: "confirmed",
          encoding: "json",
          maxSupportedTransactionVersion: 1
        }]
      })))
    });
    if (response.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`RPC HTTP ${response?.status ?? "unknown"}`);
  const payload = await response.json();
  const byId = new Map(payload.map((entry) => [entry.id, entry]));
  return batch.map((_, id) => {
    const entry = byId.get(id);
    if (entry?.error) throw new Error(`getTransaction RPC error: ${entry.error.message}`);
    return entry?.result ?? null;
  });
}

function decodeCreateEvents(transaction) {
  const events = [];
  for (const line of transaction?.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
    if (
      bytes.length <= CREATE_EVENT_DISCRIMINATOR.length ||
      !bytes.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)
    ) continue;
    try {
      events.push(PUMP_SDK.decodeCreateEventBc(bytes.subarray(8)));
    } catch {
      // Other programs can emit arbitrary data; only a valid Pump CreateEvent is useful.
    }
  }
  return events;
}

const signatures = await connection.getSignaturesForAddress(
  PUMP_PROGRAM_ID,
  { limit },
  "confirmed"
);
const candidates = [];
for (let offset = 0; offset < signatures.length; offset += 1) {
  const batch = signatures.slice(offset, offset + 1);
  const transactions = await getTransactionsRaw(batch);
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index];
    if (!transaction || transaction.meta?.err) continue;
    for (const event of decodeCreateEvents(transaction)) {
      const quoteMint = event.quoteMint;
      if (!quoteMint.equals(ZERO_KEY) && !quoteMint.equals(NATIVE_MINT)) continue;
      if (event.isCashbackEnabled || event.depth !== 0) continue;
      try {
        const curve = await pump.fetchBondingCurve(event.mint);
        if (curve.complete || curve.isCashbackCoin || curve.depth > 0) continue;
        candidates.push({
          mint: event.mint.toBase58(),
          name: event.name,
          symbol: event.symbol,
          createdAt: new Date(Number(event.timestamp) * 1_000).toISOString(),
          ageSeconds: Math.max(0, Math.floor(Date.now() / 1_000) - Number(event.timestamp)),
          realSolLiquidity: Number(curve.realQuoteReserves.toString()) / 1_000_000_000,
          virtualSolLiquidity: Number(curve.virtualQuoteReserves.toString()) / 1_000_000_000,
          realTokenReserves: curve.realTokenReserves.toString(),
          holderReward: curve.isHolderReward,
          mayhemMode: curve.isMayhemMode,
          creatorFeeBps: Number(curve.creatorFeeBps.toString()),
          createSignature: batch[index].signature
        });
      } catch {
        // The curve may have completed or disappeared between discovery and fetch.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

candidates.sort((left, right) => {
  if (right.realSolLiquidity !== left.realSolLiquidity) {
    return right.realSolLiquidity - left.realSolLiquidity;
  }
  return left.ageSeconds - right.ageSeconds;
});
console.log(JSON.stringify(candidates.slice(0, 20), null, 2));
