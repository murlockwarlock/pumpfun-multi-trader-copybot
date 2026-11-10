import test from "node:test";
import assert from "node:assert/strict";
import { shadowEconomics } from "../scripts/copy-strategy-feasibility.mjs";

test("copy evidence counts losses and open entries and separates measured entry from modeled exit",()=>{
  const rows=[
    {type:"SHADOW_BUY",targetSignature:"a",quoteSource:"prepared_at_observation",signalToPreparedMs:150},
    {type:"SHADOW_BUY",targetSignature:"b",quoteSource:"curve_post_event"},
    {type:"SHADOW_BUY",targetSignature:"c",quoteSource:"target_price_penalty"},
    {type:"SHADOW_SELL",entrySignature:"a",pnlSol:.003,proceedsSol:.00811,quoteSource:"target_price_penalty"},
    {type:"SHADOW_SELL",entrySignature:"b",pnlSol:-.001,proceedsSol:.00411,quoteSource:"curve_post_event"}
  ];
  const e=shadowEconomics(rows);
  assert.equal(e.closed,2);
  assert.equal(e.open,1);
  assert.equal(e.losses,1);
  assert.equal(e.measuredQuotes,1);
  assert.equal(e.twoSidedMeasured,0);
  assert.equal(e.netSol,.002);
  assert.equal(e.withoutLargestSol,-.001);
  assert.equal(e.expectedNetSol,null);
});
test("absence of a closed observation leaves model PnL unknown",()=>{
  const e=shadowEconomics([{type:"SHADOW_SKIP",side:"BUY",reason:"quote_unavailable"}]);
  assert.equal(e.netSol,null);
  assert.equal(e.afterCloseSol,null);
  assert.equal(e.rejectedBuys.quote_unavailable,1);
});
