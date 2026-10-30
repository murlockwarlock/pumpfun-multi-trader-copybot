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
const timeoutMs = Math.min(600_000, Math.max(10_000, Number(process.argv[2] ?? 180_000)));
const minimumRealSol = Math.max(0, Number(process.argv[3] ?? 0.2));
const connection = new Connection(config.rpcHttpUrl, {
  commitment: "processed",
  wsEndpoint: config.rpcWsUrl,
  confirmTransactionInitialTimeout: config.rpcTimeoutMs
});
const pump = new OnlinePumpSdk(connection);

function createEvents(logs) {
  const events = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const bytes = Buffer.from(line.slice("Program data: ".length), "base64");
    if (bytes.length <= 8 || !bytes.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;
    try {
      events.push(PUMP_SDK.decodeCreateEventBc(bytes.subarray(8)));
    } catch {
      // Not a Pump CreateEvent.
    }
  }
  return events;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let subscription;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(null), timeoutMs);
  try {
    subscription = connection.onLogs(
    PUMP_PROGRAM_ID,
    async ({ err, logs, signature }) => {
      if (err) return;
      for (const event of createEvents(logs)) {
        const quoteMint = event.quoteMint;
        if (!quoteMint.equals(ZERO_KEY) && !quoteMint.equals(NATIVE_MINT)) continue;
        if (event.isCashbackEnabled || Number(event.depth) !== 0) continue;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            if (attempt > 0) await sleep(500 * attempt);
            const curve = await pump.fetchBondingCurve(event.mint);
            const realSolLiquidity = Number(curve.realQuoteReserves.toString()) / 1_000_000_000;
            if (
              curve.complete ||
              curve.isCashbackCoin ||
              Number(curve.depth) > 0 ||
              realSolLiquidity < minimumRealSol
            ) break;
            clearTimeout(timer);
            resolve({
              mint: event.mint.toBase58(),
              name: event.name,
              symbol: event.symbol,
              createdAt: new Date(Number(event.timestamp) * 1_000).toISOString(),
              realSolLiquidity,
              virtualSolLiquidity: Number(curve.virtualQuoteReserves.toString()) / 1_000_000_000,
              holderReward: curve.isHolderReward,
              mayhemMode: curve.isMayhemMode,
              creatorFeeBps: Number(curve.creatorFeeBps.toString()),
              createSignature: signature
            });
            return;
          } catch (error) {
            if (attempt === 4) reject(error);
          }
        }
      }
    },
      "processed"
    );
  } catch (error) {
    reject(error);
  }
});

if (subscription !== undefined) {
  await connection.removeOnLogsListener(subscription).catch(() => {});
}
if (!result) {
  console.error(`No eligible Pump coin observed within ${timeoutMs}ms`);
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(result, null, 2));
}
