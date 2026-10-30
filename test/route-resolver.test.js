import assert from "node:assert/strict";
import test from "node:test";
import { WRAPPED_SOL_MINT } from "../src/rpc.js";
import { resolvePumpCandidates } from "../src/route-resolver.js";

const TOKEN_QUOTE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("classifies a token-quoted PumpSwap pool as an ordinary unsupported route", async () => {
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
  assert.deepEqual(result.trades, []);
  assert.equal(result.unsupportedTrades.length, 1);
  assert.equal(result.unsupportedTrades[0].reason, "unsupported_non_sol_quote");
  assert.equal(result.unsupportedTrades[0].trade.mint, "base-mint");
  assert.equal(result.unsupportedTrades[0].trade.unsupportedQuoteMint, TOKEN_QUOTE);
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
