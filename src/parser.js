import { PUMP_SDK } from "@pump-fun/pump-sdk";

export const PUMP_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  // Raydium CPMM does not emit a Pump-compatible Anchor trade event. It is
  // accepted here only for confirmed, signer-authenticated balance-delta
  // decoding; route resolution blocks it from execution below.
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
]);
export const RAYDIUM_CPMM_PROGRAM =
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

export const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
]);

const LAMPORTS_PER_SOL = 1_000_000_000;
const PUMP_TOKEN_DECIMALS = 6;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const EVENT_PREFIX = "Program data: ";
const EVENT_DISCRIMINATORS = new Map([
  ["189,219,127,211,78,230,97,238", {
    kind: "curve",
    program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  }],
  ["103,244,82,31,44,245,119,119", {
    kind: "amm-buy",
    program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
  }],
  ["62,47,55,10,165,3,220,42", {
    kind: "amm-sell",
    program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
  }]
]);

export function authenticatedProgramData(logs) {
  const stack = [];
  const records = [];
  for (const line of logs ?? []) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = Math.max(0, depth - 1);
      stack.push(invoke[1]);
      continue;
    }
    if (line.startsWith(EVENT_PREFIX)) {
      if (stack.length > 0) records.push({ line, program: stack.at(-1) });
      continue;
    }
    const complete = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:)/.exec(line);
    if (!complete) continue;
    const index = stack.lastIndexOf(complete[1]);
    if (index >= 0) stack.length = index;
  }
  return records;
}

function keyString(key) {
  return typeof key === "string" ? key : key?.pubkey;
}

function keyIsSigner(key) {
  return typeof key === "object" && key?.signer === true;
}

function rawAmount(balance) {
  return BigInt(balance?.uiTokenAmount?.amount ?? "0");
}

function aggregateBalances(balances, owner) {
  const totals = new Map();
  for (const balance of balances ?? []) {
    if (balance.owner !== owner) continue;
    const existing = totals.get(balance.mint) ?? {
      amount: 0n,
      decimals: balance.uiTokenAmount?.decimals ?? 0
    };
    existing.amount += rawAmount(balance);
    totals.set(balance.mint, existing);
  }
  return totals;
}

function toTokenNumber(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

function eventNumber(value, scale = 1) {
  const number = Number(value?.toString());
  return Number.isFinite(number) ? number / scale : NaN;
}

function fastTrade({
  signature,
  side,
  mint,
  pool,
  tokenAmount,
  solAmount,
  blockTime,
  slot,
  observedAtMs,
  venue,
  curveState
}) {
  if (
    !Number.isFinite(tokenAmount) ||
    tokenAmount <= 0 ||
    !Number.isFinite(solAmount) ||
    solAmount <= 0
  ) {
    return null;
  }
  return {
    signature,
    side,
    mint,
    ...(pool ? { pool } : {}),
    tokenAmount,
    solAmount,
    averagePriceSol: solAmount / tokenAmount,
    blockTime,
    slot,
    observedAtMs,
    signalSource: "processed_logs",
    venue,
    ...(curveState ? { curveState } : {})
  };
}

// Pump emits authenticated Anchor events in the same processed log notification
// that triggers logsSubscribe. Decoding them removes the confirmed
// getTransaction round trip from the hot path. The event's user field must
// equal the target, so transactions that merely mention the wallet are ignored.
export function parsePumpLogTrades(
  logs,
  targetWallet,
  signature = "unknown",
  { slot = null, observedAtMs = Date.now() } = {}
) {
  return parsePumpLogSignal(
    logs,
    targetWallet,
    signature,
    { slot, observedAtMs }
  ).trades;
}

// A router can execute several authenticated Pump legs in one transaction.
// Those legs are one economic trade, not independent wallet decisions. In
// particular, Axiom may route SOL -> stablecoin -> Raydium -> a token-quoted
// Pump curve. Collapse that sequence to the final coin so the hot path never
// mistakes an intermediate stablecoin for the copied asset.
export function parsePumpLogSignal(
  logs,
  targetWallet,
  signature = "unknown",
  { slot = null, observedAtMs = Date.now() } = {}
) {
  const events = [];
  for (const { line, program } of authenticatedProgramData(logs)) {
    let data;
    try {
      data = Buffer.from(line.slice(EVENT_PREFIX.length), "base64");
    } catch {
      continue;
    }
    if (data.length < 9) continue;
    const descriptor = EVENT_DISCRIMINATORS.get([...data.subarray(0, 8)].join(","));
    if (!descriptor || descriptor.program !== program) continue;
    const { kind } = descriptor;

    try {
      const payload = data.subarray(8);
      if (kind === "curve") {
        const event = PUMP_SDK.decodeTradeEventBc(payload);
        if (event.user.toBase58() !== targetWallet) continue;
        events.push({
          kind,
          side: event.isBuy ? "BUY" : "SELL",
          mint: event.mint.toBase58(),
          tokenAmount: eventNumber(event.tokenAmount, 10 ** PUMP_TOKEN_DECIMALS),
          quoteAmountRaw: eventNumber(event.solAmount),
          quoteMint: event.quoteMint.toBase58(),
          blockTime: eventNumber(event.timestamp),
          venue: "pump-curve",
          curveState: {
            virtualSolReservesRaw: event.virtualSolReserves.toString(),
            virtualTokenReservesRaw: event.virtualTokenReserves.toString(),
            realSolReservesRaw: event.realSolReserves.toString(),
            realTokenReservesRaw: event.realTokenReserves.toString(),
            feeBasisPoints: Number(event.feeBasisPoints.toString()),
            creatorFeeBasisPoints: Number(event.creatorFeeBasisPoints.toString()),
            cashbackFeeBasisPoints: Number(event.cashbackFeeBasisPoints.toString()),
            buybackFeeBasisPoints: Number(event.buybackFeeBasisPoints.toString())
          }
        });
        continue;
      }

      const isBuy = kind === "amm-buy";
      const event = isBuy
        ? PUMP_SDK.decodeBuyEventAmm(payload)
        : PUMP_SDK.decodeSellEventAmm(payload);
      if (event.user.toBase58() !== targetWallet) continue;
      events.push({
        kind,
        side: isBuy ? "BUY" : "SELL",
        pool: event.pool.toBase58(),
        tokenAmount: eventNumber(
          isBuy ? event.baseAmountOut : event.baseAmountIn,
          10 ** PUMP_TOKEN_DECIMALS
        ),
        quoteAmountRaw: eventNumber(
          isBuy ? event.userQuoteAmountIn : event.userQuoteAmountOut
        ),
        blockTime: eventNumber(event.timestamp),
        venue: "pumpswap"
      });
    } catch {
      // New/unknown event layouts fail closed and are handled by the
      // confirmed-transaction fallback in the ingestion layer.
    }
  }

  if (events.length === 0) {
    return { trades: [], endpointMint: null, routeKind: null, targetEventCount: 0 };
  }

  const directTrade = (event) => fastTrade({
    signature,
    side: event.side,
    mint: event.mint,
    pool: event.pool,
    tokenAmount: event.tokenAmount,
    solAmount: event.quoteAmountRaw / LAMPORTS_PER_SOL,
    blockTime: event.blockTime,
    slot,
    observedAtMs,
    venue: event.venue,
    curveState: event.curveState
  });
  const hasTokenQuotedCurve = events.some(
    (event) => event.kind === "curve" && event.quoteMint !== SYSTEM_PROGRAM
  );
  const oneSide = events.every((event) => event.side === events[0].side);

  if (events.length > 1 && hasTokenQuotedCurve && oneSide) {
    const side = events[0].side;
    const endpoint = side === "BUY" ? events.at(-1) : events[0];
    const solBoundary = side === "BUY" ? events[0] : events.at(-1);
    const boundaryUsesSol = solBoundary.kind === "curve"
      ? solBoundary.quoteMint === SYSTEM_PROGRAM
      : Boolean(solBoundary.pool);
    const endpointMint = endpoint.mint ?? null;
    const trade = boundaryUsesSol && endpointMint
      ? fastTrade({
          signature,
          side,
          mint: endpointMint,
          tokenAmount: endpoint.tokenAmount,
          solAmount: solBoundary.quoteAmountRaw / LAMPORTS_PER_SOL,
          blockTime: endpoint.blockTime ?? solBoundary.blockTime,
          slot,
          observedAtMs,
          venue: "multi-hop"
        })
      : null;
    if (trade) {
      trade.routeKind = "multi-hop";
      trade.executionRoute = "jupiter";
      if (solBoundary.pool) trade.boundaryPool = solBoundary.pool;
    }
    return {
      trades: trade ? [trade] : [],
      endpointMint,
      executionRoute: "jupiter",
      routeKind: "multi-hop",
      targetEventCount: events.length
    };
  }

  const trades = events
    .filter((event) => event.kind !== "curve" || event.quoteMint === SYSTEM_PROGRAM)
    .map(directTrade)
    .filter(Boolean);
  const endpointMint = trades.length === 1 ? trades[0].mint ?? null : null;
  return {
    trades,
    endpointMint,
    routeKind: trades.length === 1 ? "direct" : null,
    targetEventCount: events.length
  };
}

function authenticatedPumpTransaction(tx, targetWallet) {
  const message = tx?.transaction?.message;
  const meta = tx?.meta;
  if (!message || !meta || meta.err) return null;

  const accountKeys = message.accountKeys ?? [];
  const keys = accountKeys.map(keyString);
  if (!keys.some((key) => PUMP_PROGRAMS.has(key))) return null;

  const targetIndex = keys.indexOf(targetWallet);
  if (targetIndex < 0 || !keyIsSigner(accountKeys[targetIndex])) return null;
  return { message, meta, accountKeys, keys, targetIndex };
}

// Re-decode the authenticated Pump event from a confirmed transaction. This is
// intentionally independent of wallet balance deltas: routers and repeated
// buys can produce valid Pump events that the balance-delta fallback cannot
// price reliably. The confirmed transaction and signer checks make this safe
// to use as the live-execution gate.
export function parseConfirmedPumpLogSignal(
  tx,
  targetWallet,
  signature = "unknown",
  { observedAtMs = null } = {}
) {
  const context = authenticatedPumpTransaction(tx, targetWallet);
  if (!context) {
    return { trades: [], endpointMint: null, routeKind: null, targetEventCount: 0 };
  }
  return parsePumpLogSignal(
    context.meta.logMessages,
    targetWallet,
    signature,
    { slot: tx.slot ?? null, observedAtMs }
  );
}

export function parsePumpTrades(tx, targetWallet, signature = "unknown") {
  const context = authenticatedPumpTransaction(tx, targetWallet);
  if (!context) return [];
  const { meta, targetIndex } = context;
  const venue = context.keys.includes(RAYDIUM_CPMM_PROGRAM)
    ? "raydium-cpmm"
    : context.keys.includes("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")
      ? "pumpswap"
      : "pump-curve";

  const logSignal = parsePumpLogSignal(
    meta.logMessages,
    targetWallet,
    signature,
    { slot: tx.slot ?? null, observedAtMs: null }
  );

  const preLamports = BigInt(meta.preBalances?.[targetIndex] ?? 0);
  const postLamports = BigInt(meta.postBalances?.[targetIndex] ?? 0);
  const solDelta = Number(postLamports - preLamports) / LAMPORTS_PER_SOL;

  const pre = aggregateBalances(meta.preTokenBalances, targetWallet);
  const post = aggregateBalances(meta.postTokenBalances, targetWallet);
  const mints = new Set([...pre.keys(), ...post.keys()]);
  const trades = [];

  for (const mint of mints) {
    if (QUOTE_MINTS.has(mint)) continue;
    if (logSignal.endpointMint && mint !== logSignal.endpointMint) continue;
    const before = pre.get(mint) ?? { amount: 0n, decimals: post.get(mint)?.decimals ?? 0 };
    const after = post.get(mint) ?? { amount: 0n, decimals: before.decimals };
    const rawDelta = after.amount - before.amount;
    if (rawDelta === 0n) continue;
    if (rawDelta === 1n || rawDelta === -1n) continue;

    const tokenDelta = toTokenNumber(rawDelta, after.decimals);
    const side = rawDelta > 0n ? "BUY" : "SELL";

    // Initial scope is SOL-paired trades only. Opposing signs rule out most
    // transfers, token-to-token routes and account-maintenance transactions.
    if (side === "BUY" && solDelta >= 0) continue;
    if (side === "SELL" && solDelta <= 0) continue;

    const tokenAmount = Math.abs(tokenDelta);
    const solAmount = Math.abs(solDelta);
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || solAmount <= 0) continue;

    const trade = {
      signature,
      side,
      mint,
      tokenAmount,
      solAmount,
      averagePriceSol: solAmount / tokenAmount,
      blockTime: tx.blockTime ?? null,
      slot: tx.slot ?? null,
      ...(logSignal.executionRoute
        ? {
            executionRoute: logSignal.executionRoute,
            routeKind: logSignal.routeKind,
            venue: logSignal.routeKind
          }
        : { venue })
    };
    if (venue === "raydium-cpmm" && !trade.executionRoute) {
      trade.executionRoute = "raydium-cpmm";
      trade.routeKind = "raydium-cpmm";
    }
    trades.push(trade);
  }

  return trades;
}
