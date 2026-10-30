import { WRAPPED_SOL_MINT } from "./rpc.js";

function unsupported(candidate, pool, poolAddress) {
  return {
    trade: {
      ...candidate,
      mint: candidate.mint ?? pool.baseMint,
      unsupportedPool: poolAddress,
      unsupportedQuoteMint: pool.quoteMint
    },
    reason: "unsupported_non_sol_quote"
  };
}

export async function resolvePumpCandidates(candidates, rpc) {
  const trades = [];
  const unsupportedTrades = [];
  for (const candidate of candidates) {
    if (candidate.boundaryPool) {
      const pool = await rpc.resolvePumpPool(candidate.boundaryPool);
      if (pool.quoteMint !== WRAPPED_SOL_MINT) {
        unsupportedTrades.push(unsupported(candidate, pool, candidate.boundaryPool));
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
      unsupportedTrades.push(unsupported(resolved, pool, candidate.pool));
    } else {
      trades.push(resolved);
    }
  }
  return { trades, unsupportedTrades };
}
