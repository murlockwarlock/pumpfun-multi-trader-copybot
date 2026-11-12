import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LaunchFollow, launchSignals } from "../src/launch-follow.js";
import { readOnlyBudgetFetch } from "../src/shadow-rpc-budget.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/launch-follow.json", import.meta.url)));
const signal = { mint: "mint", signature: "buy", slot:1, observedAtMs: 1000, averagePriceSol: .000005 };
test("research rejects processed context and a confirmed quote arriving after the original deadline",async()=>{
  for(const commitment of ["processed","confirmed"]){
    let now=1000;
    const engine=new LaunchFollow({research:true,now:()=>now,save(){},emit(){},schedule(){},quote:async()=>{
      if(commitment==="confirmed")now+=1501;
      return {marketCommitment:commitment,contextVerified:true,marketContextSlot:1,expectedTokenOutRaw:"1000000000",tokenDecimals:6};
    }});
    engine.heartbeat({wsAvailable:true,lastPollAtMs:now},{});
    now=engine.state.epoch.startsAtMs;
    await engine.launch({...signal,observedAtMs:now});
    const p=engine.state.launches.mint;
    assert.equal(p.reason,commitment==="processed"?"confirmed_quote_unproven":"quote_too_old");
    assert.equal(p.entry,undefined);
  }
});
test("epoch starts on healthy coverage and preserves the preregistered limits across restart",()=>{
  let now=1234;
  const options={research:true,now:()=>now,quote(){},save(){},emit(){},maxAgeMs:1500,maxDriftBps:2500};
  const first=new LaunchFollow(options);
  first.heartbeat({wsAvailable:false,lastPollAtMs:now},{});
  assert.equal(first.state.epoch,undefined);
  first.heartbeat({wsAvailable:true,lastPollAtMs:now},{});
  assert.equal(first.state.epoch.startsAtMs,2000);
  assert.equal(first.epochFor(1999),null);
  now=4000;
  const restored=new LaunchFollow({...options,state:structuredClone(first.state),maxAgeMs:9000,maxDriftBps:9999});
  assert.equal(restored.state.epoch.id,first.state.epoch.id);
  assert.equal(restored.maxAgeMs,1500);
  assert.equal(restored.maxDriftBps,2500);
});
function setup(overrides = {}) {
  let time = 1000, saved;
  const events = [], timers = [], calls = [];
  const engine = new LaunchFollow({ now:()=>time, save:s=>{saved=structuredClone(s);},
    emit:r=>events.push(r), schedule:(f,ms)=>timers.push({f,ms}),
    quote:async(side,...args)=>{calls.push([side,...args]); return side==="BUY"
      ? {expectedTokenOutRaw:"1000000000",tokenDecimals:6,marketContextSlot:1}
      : {expectedSolOutRaw:"6000000",marketContextSlot:1};}, ...overrides });
  return { engine, events, timers, calls, setTime:t=>{time=t;}, saved:()=>saved };
}
test("real archived CREATE+BUY: target is creation user and same-mint buyer",()=>{
  const out=launchSignals(fixture,fixture.slot,1000);
  assert.equal(out.length,1); assert.equal(out[0].mint,fixture.mint);
  assert.equal(out[0].observedAtMs,1000); assert.ok(out[0].curveState);
});
test("failed, truncated, forged-program and wrong-user launches fail closed",()=>{
  assert.deepEqual(launchSignals({...fixture,err:{}},fixture.slot,1000),[]);
  assert.deepEqual(launchSignals({...fixture,logs:["Program data: G3KpTd7rY3Y="]},1,1000),[]);
  const forged=fixture.logs.map(l=>l.replaceAll("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P","11111111111111111111111111111111"));
  assert.deepEqual(launchSignals({...fixture,logs:forged},1,1000),[]);
  const logs=fixture.logs.map(l=>{
    if(!l.startsWith("Program data: G3Kp")) return l;
    const b=Buffer.from(l.slice(14),"base64"); let o=8;
    for(let n=0;n<3;n++) o+=4+b.readUInt32LE(o);
    b.fill(0,o+64,o+96); return "Program data: "+b.toString("base64");
  });
  assert.deepEqual(launchSignals({...fixture,logs},1,1000),[]);
});
test("ordinary BUY or wrong-mint CREATE never triggers launch-follow",()=>{
  const logs=fixture.logs.filter(l=>!l.startsWith("Program data: G3Kp"));
  assert.deepEqual(launchSignals({...fixture,logs},1,1000),[]);
  const changed=fixture.logs.map(l=>{
    if(!l.startsWith("Program data: G3Kp"))return l;
    const b=Buffer.from(l.slice(14),"base64");let o=8;for(let n=0;n<3;n++)o+=4+b.readUInt32LE(o);
    b.fill(0,o,o+32);return "Program data: "+b.toString("base64");
  });
  assert.deepEqual(launchSignals({...fixture,logs:changed},1,1000),[]);
});
test("duplicate websockets and replay after restart never create second BUY",async()=>{
  const h=setup();await Promise.all([h.engine.launch(signal),h.engine.launch(signal)]);
  assert.equal(h.calls.length,1);
  const restored=setup({state:h.saved()});await restored.engine.launch(signal);
  assert.equal(restored.calls.length,0);
  assert.equal(restored.engine.state.launches.mint.exits.A.reason,"restart_observation_gap");
});
test("creator SELL while BUY quote is pending cancels the entry",async()=>{
  const pending=Promise.withResolvers();const h=setup({quote:()=>pending.promise});
  const task=h.engine.launch(signal);
  h.engine.creatorSell({mint:"mint",signature:"sell",observedAtMs:1050});
  pending.resolve({expectedTokenOutRaw:"1000000000",tokenDecimals:6,marketContextSlot:1});await task;
  assert.equal(h.engine.state.launches.mint.reason,"creator_sold_during_preparation");
  assert.equal(h.timers.length,0);
});
test("six independent exits, F cannot race into duplicate quote or PnL",async()=>{
  const h=setup();await h.engine.launch(signal);
  for(const [variant,seconds] of Object.entries({A:1,B:3,C:5,D:10,E:15,F:16})) {
    h.setTime(1000+seconds*1000);
    await Promise.all([h.engine.exit("mint",variant,1000+seconds*1000),h.engine.exit("mint",variant,1000+seconds*1000)]);
  }
  const p=h.engine.state.launches.mint;
  assert.equal(h.calls.length,7);assert.equal(p.status,"COMPLETE");
  assert.equal(Object.keys(p.exits).length,6);
  for(const r of Object.values(p.exits)) assert.ok(Math.abs(r.netPnlSol-.00067)<1e-12);
});
test("missing and overdue quotes stay UNKNOWN, no historical price substitution",async()=>{
  const h=setup();await h.engine.launch(signal);h.setTime(5000);
  await h.engine.exit("mint","A",2000);
  assert.equal(h.calls.length,1);assert.equal(h.engine.state.launches.mint.exits.A.status,"UNKNOWN");
  h.engine.quote=async()=>{throw Error("429");};await h.engine.exit("mint","B",5000);
  assert.equal(h.engine.state.launches.mint.exits.B.status,"UNKNOWN");
  assert.equal(h.engine.state.launches.mint.exits.B.netPnlSol,undefined);
});
test("price protection and stale signals remain enforced",async()=>{
  const h=setup();await h.engine.launch({...signal,averagePriceSol:.000001});
  assert.equal(h.engine.state.launches.mint.reason,"entry_drift");
  h.setTime(9000);await h.engine.launch({...signal,mint:"stale",signature:"stale"});
  assert.equal(h.engine.state.launches.stale.reason,"stale_signal");assert.equal(h.calls.length,1);
});
test("independent mint prepares while first mint is blocked",async()=>{
  const pending=Promise.withResolvers();const h=setup({quote:(_s,m)=>m==="mint"?pending.promise:Promise.resolve({expectedTokenOutRaw:"1000000000",tokenDecimals:6,marketContextSlot:1})});
  const a=h.engine.launch(signal);await h.engine.launch({...signal,mint:"other",signature:"other"});
  assert.equal(h.engine.state.launches.other.status,"OPEN");
  pending.resolve({expectedTokenOutRaw:"1000000000",tokenDecimals:6,marketContextSlot:1});await a;
});
test("request budget refuses writes, fanout overflow and retries after 429",async()=>{
  let count=0,time=0;
  const rpc=readOnlyBudgetFetch({now:()=>time,perSecond:2,request:async()=>{count++;return {status:count===2?429:200};}});
  const options=method=>({body:JSON.stringify({method})});
  await assert.rejects(rpc("url",options("sendTransaction")),/unapproved/);
  await rpc("url",options("getAccountInfo"));
  await assert.rejects(rpc("url",options("getAccountInfo")),/429/);
  time=2000;await assert.rejects(rpc("url",options("getAccountInfo")),/budget/);assert.equal(count,2);
  time=31000;await rpc("url",options("getAccountInfo"));assert.equal(count,3);
});
