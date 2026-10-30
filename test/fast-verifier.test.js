import assert from "node:assert/strict";
import test from "node:test";
import { compareFastTrades } from "../src/fast-verifier.js";

test("requires the confirmed trade set to match the fast signal exactly", () => {
  const fast = [{ side: "BUY", mint: "mint-a" }];
  assert.equal(compareFastTrades(fast, [{ side: "BUY", mint: "mint-a" }]).matches, true);
  assert.equal(compareFastTrades(fast, []).matches, false);
  assert.equal(compareFastTrades(fast, [{ side: "SELL", mint: "mint-a" }]).matches, false);
  assert.equal(compareFastTrades(fast, [
    { side: "BUY", mint: "mint-a" }, { side: "BUY", mint: "mint-b" }
  ]).matches, false);
});
