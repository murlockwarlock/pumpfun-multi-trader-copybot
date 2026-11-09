import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../scripts/launch-follow-summary.mjs";
import { admitToCohort } from "../src/launch-cohort.js";
import { intervalRecoveries } from "../src/launch-ws-audit.js";
function fixture(pnls) {
  const launches={};
  for(const [i,pnl] of pnls.entries()) {
    const exits=Object.fromEntries([..."ABCDEF"].map(v=>[v,{status:"QUOTED",preparedAtMs:1000+i,quote:{marketContextSlot:2},
      netPnlSol:pnl,proceedsSol:.005+pnl+.00033,fixedFeesSol:.00033,rentNetSol:0,sellSlippageFloorPnlSol:pnl-.0005,latenessMs:10}]));
    launches[i]={mint:String(i),signature:String(i),slot:1,observedAtMs:100+i,confirmed:true,verification:"matched_create_buy_v2",
      accepted:true,entry:{marketContextSlot:1},exits};
  }
  return {launches,sells:{},observation:{startedAtMs:1,lastHeartbeatAtMs:2000,ws:{},confirmed:{},catalog:{},gaps:[]}};
}
test("portfolio reports fees, losses, drawdown and excludes unverified quotes",()=>{
  const s=fixture([.001,-.002,.001]);const r=summarize(s,{now:2000});
  assert.equal(r.portfolios.A.wins,2);assert.equal(r.portfolios.A.losses,1);
  assert.equal(r.portfolios.A.maxDrawdownSol,.002);assert.equal(r.portfolios.A.fixedFeesSol,.00099);
  s.launches[0].confirmed=false;
  const bad=summarize(s,{now:2000});assert.equal(bad.portfolios.A.closed,2);assert.equal(bad.portfolios.A.unverifiedQuotes,1);assert.equal(bad.verdict,"DATA_INVALID");
});
test("positive mean alone is not RESEARCH-GO and holdout never selects its own winner",()=>{
  const s=fixture(Array(50).fill(.001));
  for(let i=0;i<25;i++)s.launches[i].exits.B.netPnlSol=.002;
  for(let i=25;i<50;i++){s.launches[i].exits.A.netPnlSol=.1;s.launches[i].exits.B.netPnlSol=-.001;}
  const r=summarize(s,{now:2000});assert.equal(r.selectedRule,"B");assert.equal(r.verdict,"NO-GO");
  const volatile=fixture([...Array(25).fill(.001),...Array(24).fill(-.001),.025]);
  assert.ok(summarize(volatile,{now:2000}).holdout.A.netPnlSol>0);
  assert.equal(summarize(volatile,{now:2000}).verdict,"UNPROVEN");
});
test("DATA_GAP, missing observer and old market quotes are not valid profit evidence",()=>{
  const s=fixture(Array(50).fill(.002));
  assert.equal(summarize(s,{now:2000}).verdict,"RESEARCH-GO");
  s.observation.gaps.push({reason:"worker_restart",startMs:500,endMs:550});
  assert.equal(summarize(s,{now:2000}).verdict,"DATA_INVALID");
  assert.equal(summarize({}, {now:2000}).verdict,"DATA_INVALID");
  s.observation.gaps=[];s.launches[0].entry.marketContextSlot=0;
  assert.equal(summarize(s,{now:2000}).portfolios.A.closed,49);
});
function epochFixture() {
  const s=fixture(Array(50).fill(.002));
  s.epoch={id:"fixed",startsAtMs:50};
  for(const p of Object.values(s.launches)){
    p.epochId=s.epoch.id;
    Object.assign(p.entry,{marketCommitment:"confirmed",contextVerified:true});
    for(const x of Object.values(p.exits))Object.assign(x.quote,{marketCommitment:"confirmed",contextVerified:true});
  }
  for(let i=0;i<4;i++)s.launches["old"+i]={mint:"old"+i,signature:"old"+i,slot:0,observedAtMs:10,status:"SKIP",dataInvalid:true,exits:{}};
  s.observation.gaps.push({reason:"legacy_uninstrumented_state",startMs:null,endMs:40});
  return s;
}
test("four legacy launches and old gaps do not contaminate 25/25 prospective cohorts",()=>{
  const r=summarize(epochFixture(),{now:2000});
  assert.equal(r.auditLaunches,54);assert.equal(r.legacyLaunches.length,4);
  assert.equal(r.exploratory.A.observations,25);assert.equal(r.holdout.A.observations,25);
  assert.equal(r.verdict,"RESEARCH-GO");
});
test("missed and UNKNOWN outcomes stay in place and processed prices do not count",()=>{
  const s=epochFixture();
  s.launches[3].status="MISSED";s.launches[3].accepted=false;s.launches[3].exits={};
  s.launches[20].exits.F={status:"UNKNOWN"};
  s.launches[26].entry.marketCommitment="processed";
  const r=summarize(s,{now:2000});
  assert.equal(r.exploratory.F.unknown,2);assert.equal(r.holdout.A.closed,24);
  assert.equal(r.selectedRule,null);assert.equal(r.verdict,"DATA_INVALID");
});
test("gap intersection is evaluated per exit and reconciled empty gaps do not censor prices",()=>{
  const s=epochFixture();
  s.observation.gaps.push({reason:"ws_unavailable",startMs:1010,endMs:1015,backfillBeforeMs:990});
  let r=summarize(s,{now:2000});
  assert.equal(r.portfolios.A.closed,10);
  s.observation.gaps.at(-1).beforeSweep={endedAtMs:990,cursorAfter:"stable",quarantined:0};
  s.observation.gaps.at(-1).afterSweep={startedAtMs:4000,cursorBefore:"stable",cursorAfter:"stable",signatures:0,quarantined:0};
  r=summarize(s,{now:5000});
  assert.equal(r.portfolios.A.closed,50);assert.equal(r.observation.gaps.at(-1).reconciledEmpty,true);
});
test("late earlier launch after holdout starts stays visible without replacing a frozen member",()=>{
  const s=epochFixture();
  s.cohort={exploratory:[],holdout:[],breaches:0};
  for(let i=0;i<50;i++){
    s.launches[i].slot=i+10;
    s.launches[i].entry.marketContextSlot=i+10;
    for(const x of Object.values(s.launches[i].exits))x.quote.marketContextSlot=i+11;
    admitToCohort(s.cohort,s.launches[i]);
  }
  const pinned=structuredClone(s.cohort.exploratory);
  const late={mint:"late",signature:"late",slot:2,epochId:s.epoch.id,observedAtMs:700,status:"MISSED",confirmed:true,exits:{}};
  s.launches.late=late;
  admitToCohort(s.cohort,late);
  const r=summarize(s,{now:2000});
  assert.deepEqual(r.cohort.exploratory,pinned);
  assert.equal(r.launches,51);
  assert.equal(r.missed,1);
  assert.ok(r.invalidReasons.includes("cohort_boundary_integrity"));
  s.launches[0].slot=100;
  assert.equal(summarize(s,{now:2000}).exploratory.A.unknown,1);
});
test("WS recovery cannot borrow an ACK from another interval or another subscription",()=>{
  const events=[
    {event:"websocket_closed",websocketSource:"primary",atMs:1000},
    {event:"websocket_closed",websocketSource:"fallback",atMs:1001},
    {event:"subscribed",websocketSource:"primary",sourceName:"sniper",atMs:2000,at:"first"},
    {event:"subscribed",websocketSource:"fallback",sourceName:"sniper",atMs:3500,at:"later"},
    {event:"subscribed",websocketSource:"primary",sourceName:"other",atMs:3600,at:"later"}
  ];
  assert.deepEqual(intervalRecoveries(events,1001,2100,["sniper","other"]),{
    primary:{sniper:{at:"first",afterCloseMs:1000},other:null},fallback:{sniper:null,other:null}});
});
