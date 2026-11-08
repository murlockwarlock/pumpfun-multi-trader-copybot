import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bs58 from "bs58";
import { LaunchFollowSupervisor, LaunchFollow, confirmedLaunches, launchSignals, LAUNCH_TARGET } from "../src/launch-follow.js";
import { summarize, writeReport } from "../scripts/launch-follow-summary.mjs";
const fixture=JSON.parse(fs.readFileSync(new URL("./fixtures/launch-follow.json",import.meta.url)));
const tx=JSON.parse(fs.readFileSync(new URL("./fixtures/launch-follow-confirmed.json",import.meta.url)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await sleep(30);}throw Error("condition timeout");}
const data=directory=>({directory,publicKey:LAUNCH_TARGET,fixtureModule:new URL("./fixtures/launch-market.mjs",import.meta.url).href,
  config:{rpcHttpUrl:"https://never-called.invalid",liveSendRoute:"rpc",liveTipSol:.000005,livePriorityFeeSol:.0001,liveSlippageBps:1000,fastMaxSignalAgeMs:1500,fastMaxEntryDriftBps:2500}});
const state=dir=>{try{return JSON.parse(fs.readFileSync(path.join(dir,"state.json")));}catch{return null;}};
function isolated(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),"launch-integrity-"));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
const coverage={kind:"coverage",coverage:{wsAvailable:true,lastPollAtMs:Date.now()}};
test("saved real CREATE+BUY → Worker IPC → durable BUY/all six SELL → CSV/JSON/Markdown",{timeout:25000},async t=>{
  const dir=isolated(t),events=[];
  const client=new LaunchFollowSupervisor(data(dir),(event,detail)=>events.push({event,...detail}));
  t.after(()=>client.stop());
  await until(()=>events.some(e=>e.event==="launch_follow_ready"));
  client.post({...coverage,coverage:{...coverage.coverage,lastPollAtMs:Date.now()}});
  client.post({value:fixture,slot:fixture.slot,observedAtMs:Date.now()});
  client.post({kind:"confirmed",signature:fixture.signature,tx});
  await until(()=>state(dir)?.launches[fixture.mint]?.accepted || events.some(e=>e.reason==="worker_fatal"))
    .catch(error=>{throw new Error(JSON.stringify({launch:state(dir)?.launches[fixture.mint],events}),{cause:error});});
  assert.equal(state(dir)?.launches[fixture.mint]?.accepted,true,JSON.stringify(events));
  client.post({kind:"resolvedSell",trade:{mint:fixture.mint,signature:"fixture-only-creator-sell",slot:fixture.slot+1,observedAtMs:Date.now(),tokenAmount:100}});
  await until(()=>state(dir)?.launches[fixture.mint]?.status==="COMPLETE",18000);
  await until(()=>client.health().state==="HEALTHY")
    .catch(error=>{throw new Error(JSON.stringify({health:client.health(),events}),{cause:error});});
  const s=state(dir),p=s.launches[fixture.mint];assert.equal(p.confirmed,true);
  for(const v of "ABCDEF")assert.equal(p.exits[v].status,"QUOTED");
  const report=summarize(s);assert.equal(report.testData,true);assert.equal(report.verdict,"UNPROVEN");
  assert.equal(report.portfolios.A.closed,1);assert.equal(report.portfolios.F.closed,1);
  writeReport(report,path.join(dir,"report"));
  for(const f of ["report.json","observations.csv","report.md"])assert.ok(fs.statSync(path.join(dir,"report",f)).size>10);
  assert.equal(fs.readFileSync(path.join(dir,"report","observations.csv"),"utf8").trim().split("\n").length,7);
  assert.ok(fs.readFileSync(path.join(dir,"events.jsonl"),"utf8").includes('"type":"BUY"'));
});
test("worker crash/restart preserves mint dedupe and records DATA_GAP",{timeout:12000},async t=>{
  const dir=isolated(t),events=[],client=new LaunchFollowSupervisor(data(dir),(event,d)=>events.push({event,...d}));
  t.after(()=>client.stop());await until(()=>events.some(e=>e.event==="launch_follow_ready"));
  client.post(coverage);client.post({value:fixture,slot:fixture.slot,observedAtMs:Date.now()});
  await until(()=>state(dir)?.launches[fixture.mint]?.accepted);
  await client.worker.terminate();
  await until(()=>events.filter(e=>e.event==="launch_follow_ready").length===2);
  client.post({value:fixture,slot:fixture.slot,observedAtMs:Date.now()});await sleep(200);
  const rows=fs.readFileSync(path.join(dir,"events.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter(r=>r.type==="BUY").length,1);
  assert.ok(state(dir).observation.gaps.some(g=>g.reason==="worker_restart"));
  assert.equal(summarize(state(dir)).verdict,"DATA_INVALID");
});
test("disk failure warns parent and terminates instead of silently dropping records",{timeout:10000},async t=>{
  const dir=isolated(t),events=[],client=new LaunchFollowSupervisor(data(dir),(event,d)=>events.push({event,...d}),{restartMs:5000});
  t.after(()=>client.stop());await until(()=>events.some(e=>e.event==="launch_follow_ready"));
  fs.mkdirSync(path.join(dir,"state.json.tmp"));client.post({value:fixture,slot:fixture.slot,observedAtMs:Date.now()});
  await until(()=>events.some(e=>e.reason==="worker_fatal"));assert.equal(client.health().state,"DEGRADED");
});
test("missing WS found via existing confirmed backfill never requests late quote",()=>{
  let calls=0;const engine=new LaunchFollow({quote:()=>{calls++;},save(){},emit(){}});
  engine.confirm(tx,fixture.signature);
  const p=engine.state.launches[fixture.mint];assert.equal(p.status,"MISSED");assert.equal(p.reason,"missing_ws");assert.equal(calls,0);
  assert.equal(summarize(engine.state).verdict,"DATA_INVALID");
});
test("successful tx with wrong creator/mint/BUY evidence is not confirmation",async()=>{
  const valid=confirmedLaunches(tx,fixture.signature,Date.now());assert.equal(valid.length,1);
  const wrong=structuredClone(tx);wrong.meta.logMessages=[];
  assert.deepEqual(confirmedLaunches(wrong,fixture.signature,Date.now()),[]);
  const wrongRole=structuredClone(tx);
  for(const i of wrongRole.transaction.message.instructions) {
    if(i.data&&bs58.decode(i.data).subarray(0,8).join(",")==="214,144,76,236,95,139,49,180") i.accounts[5]="11111111111111111111111111111111";
  }
  assert.deepEqual(confirmedLaunches(wrongRole,fixture.signature,Date.now()),[]);
  const engine=new LaunchFollow({quote:async()=>({expectedTokenOutRaw:"100",marketContextSlot:fixture.slot,tokenDecimals:6}),save(){},emit(){},schedule(){}});
  await engine.launch(launchSignals(fixture,fixture.slot,Date.now())[0]);engine.confirm(wrong,fixture.signature);
  assert.equal(engine.state.launches[fixture.mint].confirmed,false);
  assert.equal(engine.state.launches[fixture.mint].verification,"source_mismatch");
});
test("Worker 429 becomes a counted skip and warning, never a model fill",{timeout:8000},async t=>{
  const dir=isolated(t),events=[];
  const options={...data(dir),fixtureModule:new URL("./fixtures/launch-rate-limit.mjs",import.meta.url).href};
  const client=new LaunchFollowSupervisor(options,(event,d)=>events.push({event,...d}));
  t.after(()=>client.stop());await until(()=>events.some(e=>e.event==="launch_follow_ready"));
  client.post(coverage);client.post({value:fixture,slot:fixture.slot,observedAtMs:Date.now()});
  await until(()=>events.some(e=>e.reason==="quote_rpc_errors"));
  assert.match(state(dir).launches[fixture.mint].reason,/429/);
  assert.equal(state(dir).observation.rpc.rateLimited,1);assert.equal(state(dir).launches[fixture.mint].accepted,undefined);
});
test("WS loss and stale backfill distinguish observer failure from inactive target",()=>{
  let now=100000;
  const engine=new LaunchFollow({quote(){},save(){},emit(){},now:()=>now});
  assert.equal(engine.heartbeat({wsAvailable:true,lastPollAtMs:now},{}).activity,"IDLE_VERIFIED_BY_BACKFILL");
  assert.equal(engine.heartbeat({wsAvailable:false,lastPollAtMs:now},{}).activity,"DEGRADED");
  assert.ok(engine.state.observation.gaps.some(g=>g.reason==="ws_unavailable"));
});
test("missing worker responses trigger watchdog warning and restart",{timeout:12000},async t=>{
  const dir=isolated(t),events=[],client=new LaunchFollowSupervisor(data(dir),(event,d)=>events.push({event,...d}),{timeoutMs:3000});
  t.after(()=>client.stop());await until(()=>events.some(e=>e.event==="launch_follow_ready"));
  // Remove delivery only in the fixture; a running worker becomes unresponsive to the supervisor.
  client.worker.removeAllListeners("message");
  await until(()=>events.some(e=>e.reason==="worker_unresponsive"),6000);
  await until(()=>events.filter(e=>e.event==="launch_follow_ready").length===2,6000);
});
