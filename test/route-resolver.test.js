import assert from "node:assert/strict";
import test from "node:test";
import { WRAPPED_SOL_MINT } from "../src/rpc.js";
import { resolvePumpCandidates } from "../src/route-resolver.js";

const TOKEN_QUOTE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("routes a token-quoted PumpSwap pool through Jupiter", async () => {
  const rpc = {
    resolvePumpPool: async (address) => ({
      address,
      baseMint: "base-mint",
      quoteMint: TOKEN_QUOTE
    })
  };
  const result = await resolvePumpCandidates([{
    signature: "poison-signature",
    side: "BUY",
    pool: "token-quoted-pool"
  }], rpc);
  assert.equal(result.unsupportedTrades.length, 0);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].mint, "base-mint");
  assert.equal(result.trades[0].quoteMint, TOKEN_QUOTE);
  assert.equal(result.trades[0].executionRoute, "jupiter");
  assert.equal(result.trades[0].routeKind, "token-quoted-pumpswap");
  assert.equal(result.trades[0].averagePriceSol, null);
});

test("resolves a SOL-quoted PumpSwap pool without changing its route", async () => {
  const rpc = {
    resolvePumpPool: async (address) => ({
      address,
      baseMint: "base-mint",
      quoteMint: WRAPPED_SOL_MINT
    })
  };
  const result = await resolvePumpCandidates([{
    signature: "supported-signature",
    side: "BUY",
    pool: "sol-pool"
  }], rpc);
  assert.equal(result.unsupportedTrades.length, 0);
  assert.equal(result.trades[0].mint, "base-mint");
});

test("marks Raydium CPMM signals unsupported instead of routing them to Pump", async () => {
  const result = await resolvePumpCandidates([{
    signature: "cpmm-signature",
    side: "BUY",
    mint: "cpmm-mint",
    venue: "raydium-cpmm",
    executionRoute: "raydium-cpmm"
  }], {});
  assert.equal(result.trades.length, 0);
  assert.equal(result.unsupportedTrades.length, 1);
  assert.equal(result.unsupportedTrades[0].reason, "unsupported_venue:raydium-cpmm");
  assert.equal(result.unsupportedTrades[0].trade.mint, "cpmm-mint");
});
