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
  const unsupportedTrades = [];
  const supportedCandidates = candidates.filter((candidate) => {
    if (candidate.executionRoute !== "raydium-cpmm" && candidate.venue !== "raydium-cpmm") {
      return true;
    }
    unsupportedTrades.push({
      trade: candidate,
      reason: "unsupported_venue:raydium-cpmm"
    });
    return false;
  });
  const trades = await Promise.all(supportedCandidates.map(async candidate => {
    if (candidate.boundaryPool) {
      const pool = await rpc.resolvePumpPool(candidate.boundaryPool);
      return pool.quoteMint !== WRAPPED_SOL_MINT ? jupiterRoute(candidate, pool, candidate.boundaryPool) : candidate;
    }
    if (!candidate.pool) {
      return candidate;
    }
    const pool = await rpc.resolvePumpPool(candidate.pool);
    const resolved = { ...candidate, mint: pool.baseMint };
    return pool.quoteMint !== WRAPPED_SOL_MINT ? jupiterRoute(resolved, pool, candidate.pool) : resolved;
  }));
  return { trades, unsupportedTrades };
}
