const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_SCALE = 1_000_000;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function curveFeeBps(trade, fallbackBps) {
  const protocol = Number(trade?.curveState?.feeBasisPoints);
  const creator = Number(trade?.curveState?.creatorFeeBasisPoints);
  if (Number.isFinite(protocol) && protocol >= 0 && Number.isFinite(creator) && creator >= 0) {
    return protocol + creator;
  }
  return fallbackBps;
}

function reserves(trade) {
  const solRaw = positiveNumber(trade?.curveState?.virtualSolReservesRaw);
  const tokenRaw = positiveNumber(trade?.curveState?.virtualTokenReservesRaw);
  if (solRaw === null || tokenRaw === null) return null;
  return {
    sol: solRaw / LAMPORTS_PER_SOL,
    tokens: tokenRaw / TOKEN_SCALE
  };
}

// Pump trade events contain the post-trade virtual reserves. Quoting against
// those reserves models our transaction immediately after the copied wallet,
// rather than pretending we received the target wallet's average price.
export function quoteCurveBuyAfter(trade, spendSol, fallbackFeeBps) {
  const state = reserves(trade);
  if (!state || !Number.isFinite(spendSol) || spendSol <= 0) return null;
  const feeBps = curveFeeBps(trade, fallbackFeeBps);
  const feeRate = feeBps / 10_000;
  if (feeRate < 0 || feeRate >= 1) return null;
  const curveInputSol = spendSol * (1 - feeRate);
  const invariant = state.sol * state.tokens;
  const tokenAmount = state.tokens - invariant / (state.sol + curveInputSol);
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;
  return {
    tokenAmount,
    spendSol,
    pumpFeeSol: spendSol - curveInputSol,
    averagePriceSol: spendSol / tokenAmount,
    feeBps,
    source: "curve_post_event"
  };
}

export function quoteCurveSellAfter(trade, tokenAmount, fallbackFeeBps) {
  const state = reserves(trade);
  if (!state || !Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;
  const feeBps = curveFeeBps(trade, fallbackFeeBps);
  const feeRate = feeBps / 10_000;
  if (feeRate < 0 || feeRate >= 1) return null;
  const invariant = state.sol * state.tokens;
  const grossSol = state.sol - invariant / (state.tokens + tokenAmount);
  if (!Number.isFinite(grossSol) || grossSol <= 0) return null;
  const pumpFeeSol = grossSol * feeRate;
  return {
    grossSol,
    pumpFeeSol,
    proceedsSol: grossSol - pumpFeeSol,
    averagePriceSol: grossSol / tokenAmount,
    feeBps,
    source: "curve_post_event"
  };
}
