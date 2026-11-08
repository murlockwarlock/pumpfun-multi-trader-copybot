import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../scripts/launch-follow-summary.mjs";
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
