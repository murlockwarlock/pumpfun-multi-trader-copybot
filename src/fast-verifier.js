function tradeKey(trade) {
  return `${trade.side}:${trade.mint}`;
}

export function tradeKeys(trades) {
  return trades.map(tradeKey).sort();
}

export function compareFastTrades(fastTrades, confirmedTrades) {
  const fast = tradeKeys(fastTrades);
  const confirmed = tradeKeys(confirmedTrades);
  return {
    matches: fast.length > 0 && JSON.stringify(fast) === JSON.stringify(confirmed),
    fast,
    confirmed
  };
}
