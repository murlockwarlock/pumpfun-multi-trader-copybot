import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LAUNCH_TARGET,LaunchFollow,LaunchFollowSupervisor,confirmedLaunches,launchSignals } from "../src/launch-follow.js";

const fixtures=JSON.parse(fs.readFileSync(new URL("../docs/evidence/launch-follow-nonsol-confirmed.json",import.meta.url)));
for(const {signature,tx,mint,quoteMint} of fixtures) {
  test(`confirmed non-SOL CREATE+BUY is visible and never quoted (${signature.slice(0,8)})`,()=>{
    assert.deepEqual(launchSignals({signature,logs:tx.meta.logMessages},tx.slot,1000),[]);
    const [proof]=confirmedLaunches(tx,signature,1000);
    assert.equal(proof.mint,mint);
    assert.equal(proof.quoteMint,quoteMint);
    assert.equal(proof.averagePriceSol,null);
    const engine=new LaunchFollow({quote(){throw Error("unsupported launch must never quote");},save(){},emit(){}});
    engine.observeWs(signature,1000);
    engine.confirm(tx,signature);
    const launch=engine.state.launches[mint];
    assert.equal(launch.status,"SKIP");
    assert.equal(launch.reason,"unsupported_non_sol_curve");
    assert.equal(launch.verification,"matched_create_buy_instructions");
    assert.equal(launch.confirmed,true);
    assert.equal(engine.state.observation.gaps.length,0);
    const recovered=new LaunchFollow({quote(){throw Error("unsupported launch must never quote");},save(){},emit(){},
      archivedWsAt:s=>s===signature?1000:undefined});
    recovered.confirm(tx,signature);
    assert.equal(recovered.state.launches[mint].reason,"unsupported_non_sol_curve");
    assert.equal(recovered.state.launches[mint].observedAtMs,1000);
    assert.deepEqual(confirmedLaunches({...tx,meta:{...tx.meta,err:{InstructionError:[1,1]}}},signature,1000),[]);
    assert.deepEqual(confirmedLaunches({...tx,meta:{...tx.meta,postTokenBalances:tx.meta.preTokenBalances}},signature,1000),[]);
  });
}
test("audited launches restore to the existing epoch without quoting or changing its identity", {timeout:10000}, async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"launch-nonsol-audit-"));
  const stateFile=path.join(directory,"state.json");
  const startsAtMs=1794212377000;
  const epoch={id:"launch-follow-confirmed-v1:"+startsAtMs,startsAtMs,slippageBps:1000,maxAgeMs:1500,maxDriftBps:2500,
    fees:{baseSol:.000005,prioritySol:.0001,tipSol:.000005}};
  fs.writeFileSync(stateFile,JSON.stringify({testData:false,epoch,launches:{},sells:{},
    cohort:{exploratory:[],holdout:[],breaches:0},observation:{startedAtMs:startsAtMs,lastHeartbeatAtMs:Date.now(),
      ws:Object.fromEntries(fixtures.map(r=>[r.signature,r.wsAtMs])),confirmed:{},gaps:[],counters:{}}}));
  const ready=Promise.withResolvers();
  const client=new LaunchFollowSupervisor({directory,publicKey:LAUNCH_TARGET,
    config:{rpcHttpUrl:"https://never-called.invalid",liveSendRoute:"rpc",liveTipSol:0}},
    (event,d)=>{if(event==="launch_follow_ready")ready.resolve();if(d.reason==="worker_fatal")ready.reject(Error(d.message));});
  t.after(async()=>{await client.stop();fs.rmSync(directory,{recursive:true,force:true});});
  await ready.promise;
  const s=JSON.parse(fs.readFileSync(stateFile));
  assert.equal(s.epoch.id,epoch.id);
  assert.equal(s.cohort.exploratory.length,2);
  assert.equal(s.cohort.holdout.length,0);
  for(const record of fixtures) {
    const launch=s.launches[record.mint];
    assert.equal(launch.auditRecovered,true);
    assert.equal(launch.observedAtMs,record.wsAtMs);
    assert.equal(launch.quoteStartedAtMs,undefined);
  }
});
