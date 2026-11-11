import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { observerBudget } from "../scripts/next-copy-budget.mjs";
import { auditRun, coverage } from "../scripts/next-copy-audit.mjs";
import { observationReason, quoteFailure } from "../scripts/next-copy-reasons.mjs";
import { reconcile } from "../scripts/next-copy-reconcile.mjs";

test("quote reservations protect quiet wallets and the opposite phase without increasing the cap",async()=>{
  let now=0;
  const budget=observerBudget({wallets:["a","b","c"],limit:45,unit:9,
    phaseReserves:{BUY:9,SELL:9},maxActive:1,now:()=>now});
  for (let i=0;i<3;i++) await budget.run("a","BUY",()=>budget.consume(9));
  await assert.rejects(budget.run("a","BUY",()=>{}),/reserved/);
  await budget.run("b","SELL",()=>budget.consume(9));
  await budget.run("c","BUY",()=>budget.consume(9));
  await assert.rejects(budget.run("a","SELL",()=>{}),/total/);
  now=60001;
  await budget.run("a","SELL",async()=>{
    await assert.rejects(budget.run("b","BUY",()=>{}),/active_quote/);
    assert.throws(()=>budget.consume(10),/fanout/);
    budget.consume(1);
  });
  await budget.run("b","BUY",()=>budget.consume(9));
});

test("coverage requires a per-wallet ACK after disconnect and stops at last proof",()=>{
  const rows=[
    {type:"START",at:0,wallets:["a","b"]},
    {type:"SUBSCRIBED",at:1000,wallet:"a",gen:1},
    {type:"SUBSCRIBED",at:2000,wallet:"b",gen:1},
    {type:"HEALTH",at:20000,subscriptions:2},
    {type:"WS_GAP",at:26000,gen:1,code:1006},
    {type:"SUBSCRIBED",at:40000,wallet:"a",gen:2},
    {type:"HEALTH",at:45000,subscriptions:1},
    {type:"SUBSCRIBED",at:50000,wallet:"b",gen:2},
    {type:"HEALTH",at:60000,subscriptions:2}
  ];
  const a=coverage(rows,"a",0,75000), b=coverage(rows,"b",0,75000);
  assert.equal(a.coveredMs,39000);
  assert.equal(b.coveredMs,28000);
  assert.deepEqual(b.unavailable,[{from:0,to:2000},{from:20000,to:50000},{from:60000,to:75000}]);
  assert.deepEqual(a.reconnects,[{from:26000,to:40000,code:1006}]);
  assert.deepEqual(b.reconnects,[{from:26000,to:50000,code:1006}]);
});

test("deadline, state absence, budget and legacy ambiguity stay distinct",()=>{
  assert.equal(quoteFailure({},10,5000,7550,2500),"quote_deadline");
  assert.equal(quoteFailure({},10,5000,7200,2500),"confirmed_state_unavailable");
  assert.equal(observationReason("failed to get account: Error: shadow_rpc_budget"),"OWN_RPC_BUDGET");
  assert.equal(observationReason("late_or_unproven_context"),"DEADLINE_OR_CONTEXT_UNDISTINGUISHED");
  assert.equal(observationReason("verification_http_429"),"RPC_429");
  assert.equal(observationReason("verification_queue_full"),"VERIFICATION_QUEUE");
  assert.equal(observationReason("verification_unavailable"),"SOURCE_OR_RPC_UNDISTINGUISHED");
});

test("fixed-horizon net and rent use matching timely quantity and finalized source only",()=>{
  const wallet="a",sig="sig";
  const events=[
    {type:"START",at:0,wallets:[wallet]},
    {type:"ELIGIBLE",side:"BUY",wallet,signature:sig,at:1,slot:7},
    {type:"BUY_QUOTE",wallet,signature:sig,at:2,slot:7,quantityRaw:"50"},
    {type:"FINALIZED",signature:sig,at:3,slot:7},
    {type:"SELL_QUOTE",kind:"30s",wallet,signature:sig,at:4,quantityRaw:"50",
      netLamports:"-100",netIfRentNotRecoveredLamports:"-200"},
    {type:"SELL_QUOTE",kind:"target",wallet,signature:sig,at:5,quantityRaw:"50",
      exitSignature:"exit",exitSlot:8,netLamports:"100"}
  ];
  const result=auditRun(events,{start:0,end:6,wallets:[wallet]})[wallet];
  assert.equal(result.horizons["30s"].netWithoutRentRecoveryLamports,"-200");
  assert.equal(result.horizons["30s"].withoutBestLamports,null);
  assert.equal(result.horizons.target.finalityUnknown,1);
  assert.equal(result.horizons.target.netLamports,null);
});

test("independent backfill identifies a missing signed PumpSwap trade and cannot fill a quote",async()=>{
  const {wallet,tx}=JSON.parse(fs.readFileSync(new URL("./fixtures/copy-candidate-pumpswap.json",import.meta.url)));
  const time=tx.blockTime;
  const signature=tx.transaction.signatures[0];
  const result=await reconcile({wallets:[wallet],seen:new Map(),start:(time-30)*1000,end:(time+30)*1000,endpoint:"fixture",
    pause:async()=>{},fetchImpl:async(_url,opts)=>{
      const {method}=JSON.parse(opts.body);
      const value={getSlot:tx.slot+100,getBlockTime:time+60,
        getSignaturesForAddress:[{signature,slot:tx.slot,err:null,blockTime:time}],getTransaction:tx}[method];
      return new Response(JSON.stringify({result:value}));
    }});
  assert.equal(result[wallet].status,"INVALID");
  assert.equal(result[wallet].knownMissing[0].signature,signature);
  assert.equal(result[wallet].knownMissing[0].trades[0].eligible,true);
});
