import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectTrade } from "../scripts/copy-candidate-trade.mjs";
import { modelBuyQuantity,modelNet,timely } from "../scripts/next-copy-observer.mjs";
import { summarize } from "../scripts/next-copy-summary.mjs";

test("confirmed PumpSwap BUY resolves the base mint through signed wallet and pool deltas",()=>{
  const {wallet,tx}=JSON.parse(fs.readFileSync(new URL("./fixtures/copy-candidate-pumpswap.json",import.meta.url)));
  const sig=tx.transaction.signatures[0];
  const [trade]=inspectTrade(tx,wallet,sig);
  assert.equal(trade.side,"BUY");
  assert.equal(trade.mint,"E8KkwnRHHJRcLyrzBTqtr1HHrY8zmDZgBwztGu6FLcy2");
  assert.equal(trade.eligible,true);
  tx.transaction.message.accountKeys.find(k=>k.pubkey===wallet).signer=false;
  assert.deepEqual(inspectTrade(tx,wallet,sig),[]);
});

test("shadow quotes require confirmed state and meet a strict local deadline",()=>{
  const q={contextVerified:true,marketCommitment:"confirmed",marketContextSlot:100};
  assert.equal(timely(q,100,50,2550),true);
  assert.equal(timely(q,101,50,2550),false);
  assert.equal(timely(q,100,50,2551),false);
  assert.equal(timely({...q,marketCommitment:"processed"},100,50,2550),false);
  assert.equal(modelBuyQuantity({expectedTokenOutRaw:"1234",hardMinimumTokenOutRaw:"900"}),1221n);
  assert.equal(modelBuyQuantity({expectedTokenOutRaw:"1234",hardMinimumTokenOutRaw:"1222"}),1222n);
  assert.equal(modelNet({expectedSolOutRaw:"6000000"}),610000n);
});

test("pairs are isolated by run, size and exit trigger, and source finality gates net",()=>{
  const base={run:"run",wallet:"wallet",slot:100};
  const quote=(signature,extra)=>({...base,signature,quantityRaw:"1221",...extra});
  const rows=[
    quote("a",{type:"ELIGIBLE",side:"BUY"}), quote("b",{type:"ELIGIBLE",side:"BUY"}),
    quote("c",{type:"ELIGIBLE",side:"BUY"}),
    ...["a","b","c"].map(signature=>quote(signature,{type:"BUY_QUOTE"})),
    ...["a","b","c"].map(signature=>quote(signature,{type:"FINALIZED"})),
    quote("a",{type:"SELL_QUOTE",kind:"30s",netLamports:"100"}),
    quote("b",{type:"SELL_QUOTE",kind:"30s",netLamports:"-40"}),
    quote("c",{type:"SELL_QUOTE",kind:"30s",netLamports:"500",quantityRaw:"1222"}),
    quote("a",{type:"SELL_QUOTE",kind:"30s",netLamports:"999",run:"other"}),
    quote("a",{type:"SELL_QUOTE",kind:"target",exitSignature:"not-final",exitSlot:101,netLamports:"999"})
  ];
  const summary=summarize(rows).wallet;
  assert.equal(summary.buyRate,1);
  assert.deepEqual(summary.exits["30s"],{quoted:2,finalityUnknown:0,pairs:2,unknown:1,
    netLamports:"60",withoutBestLamports:"-40"});
  assert.equal(summary.exits.target.pairs,0);
  assert.equal(summary.exits.target.finalityUnknown,1);
  assert.equal(summary.exits.target.netLamports,null);
});
