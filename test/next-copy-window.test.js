import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { observerBudget } from "../scripts/next-copy-budget.mjs";
import { auditRun, coverage } from "../scripts/next-copy-audit.mjs";
import { observationReason, quoteFailure } from "../scripts/next-copy-reasons.mjs";
import { reconcile } from "../scripts/next-copy-reconcile.mjs";
import { wsDiagnostics } from "../scripts/next-copy-ws-diagnostics.mjs";
import { parsePumpLogSignal } from "../src/parser.js";
import { inspectTrade } from "../scripts/copy-candidate-trade.mjs";

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

test("the missed finalized SELL decodes on the recorded PumpSwap logs",()=>{
  const {wallet,tx}=JSON.parse(fs.readFileSync(new URL("./fixtures/next-copy-missed-sell-finalized.json",import.meta.url)));
  const signature=tx.transaction.signatures[0];
  const parsed=parsePumpLogSignal(tx.meta.logMessages,wallet,signature,{slot:tx.slot,observedAtMs:null});
  assert.equal(tx.slot,468032494);
  assert.equal(parsed.targetEventCount,1);
  assert.equal(parsed.trades[0].side,"SELL");
  const [verified]=inspectTrade(tx,wallet,signature);
  assert.equal(verified.eligible,true);
  assert.equal(verified.pre-verified.post,1379619673062n);
});

test("WS receipt counters include filtered frames and bound the signature sample",()=>{
  const diag=wsDiagnostics(1);
  const logs=["Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]","Log truncated"];
  diag.receive("a");
  diag.receive("a")("no_target_event",{signature:"first",logs},10);
  diag.receive("a")("no_target_event",{signature:"second",logs},11);
  diag.receive("a")("duplicate",{signature:"repeat",logs},10);
  diag.receive();
  const batch=diag.flush();
  assert.equal(batch.unmatched,1);
  assert.deepEqual(batch.wallets.a,{received:4,filtered:{no_target_event:2,duplicate:1},
    samples:[{reason:"no_target_event",signature:"first",slot:10,logCount:2,truncated:true}],omitted:1});
  assert.deepEqual(diag.flush(),{wallets:{},unmatched:0});
});

test("a late finality update can certify a timely pair, with post-cutoff prices excluded",()=>{
  const wallet="a",signature="buy",base={wallet,signature,slot:7,observedAt:10000};
  const rows=[
    {type:"START",at:0,wallets:[wallet]},
    {...base,type:"ELIGIBLE",side:"BUY",at:10001},
    {...base,type:"BUY_QUOTE",at:10002,quantityRaw:"50"},
    {...base,type:"SELL_QUOTE",kind:"10s",at:20001,quantityRaw:"50",netLamports:"-100"},
    {...base,type:"SELL_QUOTE",kind:"30s",at:40001,quantityRaw:"50",netLamports:"900"},
    {...base,type:"FINALIZED",at:41000}
  ];
  const options={start:0,end:30000,wallets:[wallet]};
  const beforeGrace=auditRun(rows,options)[wallet].horizons;
  const afterGrace=auditRun(rows,{...options,finalityEnd:120000})[wallet].horizons;
  assert.equal(beforeGrace["10s"].finalityUnknown,1);
  assert.equal(afterGrace["10s"].netLamports,"-100");
  assert.equal(afterGrace["30s"].pendingAtCutoff,1);
  assert.equal(afterGrace["30s"].netLamports,null);
});

test("an early stop creates a data gap and post-stop frames never enter the same run",t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"copy-window-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const wallet="a",run="run",start=Date.parse("2026-01-01T00:00:00Z"),end=start+60000;
  const manifest=path.join(dir,"manifest.json"),journal=path.join(dir,"journal.jsonl"),out=path.join(dir,"out");
  fs.writeFileSync(manifest,JSON.stringify({start:new Date(start),end:new Date(end),wallets:[wallet],
    labels:{[wallet]:"wallet"},runs:[run]}));
  const rows=[
    {type:"START",at:start,wallets:[wallet]},
    {type:"SUBSCRIBED",at:start+1000,gen:1,wallet},
    {type:"HEALTH",at:start+20000,subscriptions:1},
    {type:"STOP",at:start+22000},
    {type:"SIGNAL",at:start+30000,wallet,signature:"after-stop",provisionalSides:["BUY"]}
  ];
  fs.writeFileSync(journal,rows.map(row=>JSON.stringify({run,...row})).join("\n")+"\n");
  execFileSync(process.execPath,[fileURLToPath(new URL("../scripts/next-copy-window.mjs",import.meta.url)),manifest,out,journal]);
  const report=JSON.parse(fs.readFileSync(out+".json","utf8"));
  assert.equal(report.runs[run].ignoredAfterStop,1);
  assert.equal(report.runs[run].wallets[wallet].signals,0);
  assert.deepEqual(report.coverage[wallet].gaps.at(-1),{from:start+20000,to:end,type:"DATA_GAP"});
});
