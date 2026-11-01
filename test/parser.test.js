import assert from "node:assert/strict";
import test from "node:test";
import {
  parseConfirmedPumpLogSignal,
  parsePumpLogSignal,
  parsePumpLogTrades,
  parsePumpTrades
} from "../src/parser.js";

const TARGET = "sAdNbe1cKNMDqDsa4npB3TfL62T14uAo2MsUQfLvzLT";
const MINT = "hKyXZVKmrBDPhKKhdSaaGf1qrFwUkwjqrdzRc63farm";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const CURVE_SELL_LOG = "Program data: vdt/007mYe5DvF19jPjrmg7v696Nsrx23f3uNFDfyDVxupO9P8wzb0qJNLEAAAAATRPux/YWAAAADNntBUGU7+9bbyqxBdw8bAd+679sqIXoiaJsjwy7kuT5zuJqAAAAABuOCf4NAAAAwQYr0yjnAQAb4uUBBwAAAMFuGIeX6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAI72rgEAAAAAGhL9uhSe7QsDQtFAx1NZm1RjEZwJroJRw3JGegHs2K8eAAAAAAAAAPcXiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAHNlbGwAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAR3vXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABKiTSxAAAAABuOCf4NAAAAG+LlAQcAAAAeAAAAAAAAAPcXiAAAAAAAoCvbHAAAAAAAAAAAAAAAAA==";
const MULTI_HOP_AMM_LOG = "Program data: Z/RSHyz1d3d2M+RqAAAAAOGzaRIAAAAAcIamvAAAAAAAAAAAAAAAAEBZjr4AAAAAUir3WpUCAADJ9r30YhoAAHCGprwAAAAAGQAAAAAAAAANYHgAAAAAAAUAAAAAAAAANhMYAAAAAAA6c468AAAAAC0TFrwAAAAA6KMk0MFc9epmamCnr2kB/eZ8c1spZ1JtCUM0pLKBI7kM2e0FQZTv71tvKrEF3DxsB37rv2yoheiJomyPDLuS5OosK4VI7LHz6DrOi8H+Tu1/emSdOh1ReF/G97ZPDgRQR2EpnH6JUmAp8EbfPlLsQ6th1sRPmPQiUtH8TMOuRnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAVAAAAYnV5X2V4YWN0X3F1b3RlX2luX3YyAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAmwkMAAAAAAApwYj/////////////////AGBq4igzkhwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const MULTI_HOP_CURVE_LOG = "Program data: vdt/007mYe62B42VK5/oXuQat8tUW38/vwRJyedUChbPHwdwEbWu6gAAAAAAAAAAyeBAxz4fAAABDNntBUGU7+9bbyqxBdw8bAd+679sqIXoiaJsjwy7kuR2M+RqAAAAAAAAAAAAAAAAz/+zCYRQAgAAAAAAAAAAAM9nob3yUQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAL0AYAAAAAAABAVrEWf3SX1PpUUKfcaHSuiZC5JLihkNwvXxP9hJujdkAAAAAAAAAEAOZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAGJ1eV9leGFjdF9xdW90ZV9pbgAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAAB7hS8AAAAAAAAAAAAF2usXC9eTT253vQrB34zObyMGO60MozJCOAWS9xPrIbGQeScAAAAAOHINFAMAAAA//pQ1AQAAAGQAAAAAAAAAQA5lAAAAAACewLgBAAAAAAGVZwAAAAAA";
const MULTI_HOP_MINT = "DFZt6XrafYhwMbn2Ew1Uom7JLkVmMnDZXW96oYYDBMjf";
const ROUTE_DUST_MINT = "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S";

function emittedBy(program, dataLog) {
  return [`Program ${program} invoke [1]`, dataLog, `Program ${program} success`];
}

function transaction({
  beforeTokens,
  afterTokens,
  beforeSol,
  afterSol,
  program = PUMP,
  mint = MINT,
  logs = []
}) {
  const tokenBalance = (amount, balanceMint = mint) => ({
    owner: TARGET,
    mint: balanceMint,
    uiTokenAmount: { amount: String(amount), decimals: 6 }
  });
  return {
    blockTime: 1_800_000_000,
    slot: 123,
    transaction: {
      message: {
        accountKeys: [
          { pubkey: TARGET, signer: true },
          { pubkey: program, signer: false }
        ]
      }
    },
    meta: {
      err: null,
      preBalances: [beforeSol, 0],
      postBalances: [afterSol, 0],
      preTokenBalances: [tokenBalance(beforeTokens)],
      postTokenBalances: [tokenBalance(afterTokens)],
      logMessages: logs
    }
  };
}

test("parses a SOL-paired Pump buy", () => {
  const tx = transaction({
    beforeTokens: 0,
    afterTokens: 2_000_000_000,
    beforeSol: 10_000_000_000,
    afterSol: 8_000_000_000
  });
  const [trade] = parsePumpTrades(tx, TARGET, "buy-signature");
  assert.equal(trade.side, "BUY");
  assert.equal(trade.tokenAmount, 2000);
  assert.equal(trade.solAmount, 2);
});

test("parses a SOL-paired Pump sell", () => {
  const tx = transaction({
    beforeTokens: 2_000_000_000,
    afterTokens: 0,
    beforeSol: 8_000_000_000,
    afterSol: 11_000_000_000
  });
  const [trade] = parsePumpTrades(tx, TARGET, "sell-signature");
  assert.equal(trade.side, "SELL");
  assert.equal(trade.tokenAmount, 2000);
  assert.equal(trade.solAmount, 3);
});

test("ignores transactions that do not invoke Pump", () => {
  const tx = transaction({
    beforeTokens: 0,
    afterTokens: 2_000_000_000,
    beforeSol: 10_000_000_000,
    afterSol: 8_000_000_000,
    program: "11111111111111111111111111111111"
  });
  assert.deepEqual(parsePumpTrades(tx, TARGET, "transfer-signature"), []);
});

test("ignores Pump transfers that only mention the target wallet", () => {
  const tx = transaction({
    beforeTokens: 0,
    afterTokens: 2_000_000_000,
    beforeSol: 10_000_000_000,
    afterSol: 8_000_000_000
  });
  tx.transaction.message.accountKeys[0].signer = false;
  assert.deepEqual(parsePumpTrades(tx, TARGET, "spam-airdrop"), []);
});

test("decodes an authenticated Pump trade directly from processed logs", () => {
  const [trade] = parsePumpLogTrades(
    emittedBy(PUMP, CURVE_SELL_LOG),
    TARGET,
    "fast-signature",
    { slot: 456, observedAtMs: 1_234 }
  );

  assert.equal(trade.side, "SELL");
  assert.equal(trade.mint, "5ZQubmAuRaMjdHjnp4B2GMoakntsD8zzuzvsX2xZpump");
  assert.equal(trade.venue, "pump-curve");
  assert.equal(trade.slot, 456);
  assert.equal(trade.observedAtMs, 1_234);
  assert.equal(trade.signalSource, "processed_logs");
  assert.ok(trade.tokenAmount > 25_000_000);
  assert.ok(trade.solAmount > 2.9);
  assert.match(trade.curveState.virtualSolReservesRaw, /^\d+$/);
  assert.match(trade.curveState.virtualTokenReservesRaw, /^\d+$/);
});

test("rejects spoofed event bytes emitted by a non-Pump program", () => {
  assert.deepEqual(
    parsePumpLogTrades(
      emittedBy("11111111111111111111111111111111", CURVE_SELL_LOG),
      TARGET,
      "spoofed"
    ),
    []
  );
});

test("rejects a valid Pump event when its authenticated user is not the target", () => {
  assert.deepEqual(
    parsePumpLogTrades(
      emittedBy(PUMP, CURVE_SELL_LOG),
      "11111111111111111111111111111111"
    ),
    []
  );
});

test("fails closed on malformed processed logs", () => {
  assert.deepEqual(
    parsePumpLogTrades(["Program data: vdt/007mYe4="], TARGET, "bad"),
    []
  );
});

test("uses authenticated confirmed events when balance deltas cannot price the trade", () => {
  const tx = transaction({
    beforeTokens: 2_000_000_000,
    afterTokens: 2_000_000_000,
    beforeSol: 10_000_000_000,
    afterSol: 10_000_000_000,
    logs: emittedBy(PUMP, CURVE_SELL_LOG)
  });
  assert.deepEqual(parsePumpTrades(tx, TARGET, "confirmed-event"), []);
  const signal = parseConfirmedPumpLogSignal(tx, TARGET, "confirmed-event");
  assert.equal(signal.trades.length, 1);
  assert.equal(signal.trades[0].side, "SELL");
  assert.equal(signal.trades[0].mint, "5ZQubmAuRaMjdHjnp4B2GMoakntsD8zzuzvsX2xZpump");
});

test("collapses a real Axiom multi-hop route to its final Pump coin", () => {
  const signal = parsePumpLogSignal(
    [
      ...emittedBy(PUMP_AMM, MULTI_HOP_AMM_LOG),
      ...emittedBy(PUMP, MULTI_HOP_CURVE_LOG)
    ],
    TARGET,
    "3JhHULgf9gKukx2kNGu4covS7yDTihtTLUbpBgmGNiqAKpaJGsXMP1kQoa5sYMRBwhadtLJSP7qPoT5M7TwLqj1k",
    { slot: 789, observedAtMs: 2_345 }
  );

  assert.equal(signal.trades.length, 1);
  assert.equal(signal.trades[0].side, "BUY");
  assert.equal(signal.trades[0].mint, MULTI_HOP_MINT);
  assert.equal(signal.trades[0].venue, "multi-hop");
  assert.equal(signal.trades[0].executionRoute, "jupiter");
  assert.equal(signal.trades[0].boundaryPool, "Gf7sXMoP8iRw4iiXmJ1nq4vxcRycbGXy5RL8a8LnTd3v");
  assert.ok(signal.trades[0].solAmount > 0);
  assert.ok(signal.trades[0].tokenAmount > 0);
});

test("confirmed parsing keeps only the multi-hop endpoint and ignores route dust", () => {
  const tx = transaction({
    beforeTokens: 0,
    afterTokens: 150_000_000,
    beforeSol: 10_000_000_000,
    afterSol: 9_980_000_000,
    mint: MULTI_HOP_MINT,
    logs: [
      ...emittedBy(PUMP_AMM, MULTI_HOP_AMM_LOG),
      ...emittedBy(PUMP, MULTI_HOP_CURVE_LOG)
    ]
  });
  tx.meta.preTokenBalances.push({
    owner: TARGET,
    mint: ROUTE_DUST_MINT,
    uiTokenAmount: { amount: "0", decimals: 9 }
  });
  tx.meta.postTokenBalances.push({
    owner: TARGET,
    mint: ROUTE_DUST_MINT,
    uiTokenAmount: { amount: "1", decimals: 9 }
  });

  const trades = parsePumpTrades(tx, TARGET, "multi-hop-confirmed");
  assert.equal(trades.length, 1);
  assert.equal(trades[0].mint, MULTI_HOP_MINT);
  assert.equal(trades[0].executionRoute, "jupiter");
});

test("ignores a one-atomic-unit token balance artifact", () => {
  const tx = transaction({
    beforeTokens: 0,
    afterTokens: 1,
    beforeSol: 10_000_000_000,
    afterSol: 9_999_000_000
  });
  assert.deepEqual(parsePumpTrades(tx, TARGET, "dust"), []);
});
