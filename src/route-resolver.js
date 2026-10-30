import { WRAPPED_SOL_MINT } from "./rpc.js";

function jupiterRoute(candidate, pool, poolAddress) {
  return {
    ...candidate,
    mint: candidate.mint ?? pool.baseMint,
    pool: candidate.pool ?? poolAddress,
    executionRoute: "jupiter",
    routeKind: candidate.routeKind ?? "token-quoted-pumpswap",
    quoteMint: pool.quoteMint,
    // PumpSwap events report quote-token atomic units. Treating those units as
    // lamports produced a fictitious SOL price and an invalid entry-drift check.
    solAmount: null,
    averagePriceSol: null
  };
}

export async function resolvePumpCandidates(candidates, rpc) {
  const trades = [];
  const unsupportedTrades = [];
  for (const candidate of candidates) {
    if (candidate.boundaryPool) {
      const pool = await rpc.resolvePumpPool(candidate.boundaryPool);
      if (pool.quoteMint !== WRAPPED_SOL_MINT) {
        trades.push(jupiterRoute(candidate, pool, candidate.boundaryPool));
      } else {
        trades.push(candidate);
      }
      continue;
    }
    if (!candidate.pool) {
      trades.push(candidate);
      continue;
    }
    const pool = await rpc.resolvePumpPool(candidate.pool);
    const resolved = { ...candidate, mint: pool.baseMint };
    if (pool.quoteMint !== WRAPPED_SOL_MINT) {
      trades.push(jupiterRoute(resolved, pool, candidate.pool));
    } else {
      trades.push(resolved);
    }
  }
  return { trades, unsupportedTrades };
}
