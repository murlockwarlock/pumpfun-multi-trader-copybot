import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { PublicKey } from "@solana/web3.js";
import { PumpExecutor } from "./pump-executor.js";
import { LaunchFollow, launchSignals, LAUNCH_TARGET } from "./launch-follow.js";
import { parsePumpLogSignal } from "./parser.js";
import { readOnlyBudgetFetch } from "./shadow-rpc-budget.js";
import { openLaunchArchive, mergeLaunchArchive } from "./launch-follow-archive.js";

const { config, publicKey, directory } = workerData;
const fatal = error => {
  parentPort.postMessage({type:"fatal",message:error.message,atMs:Date.now()});
  process.exit(1);
};
process.on("uncaughtException",fatal);
process.on("unhandledRejection",fatal);
try {
  fs.mkdirSync(directory,{recursive:true});
  const stateFile=path.join(directory,"state.json"), journal=path.join(directory,"events.jsonl");
  const archive=openLaunchArchive(path.join(directory,"archive.sqlite"));
  let journalBytes=fs.existsSync(journal)?fs.statSync(journal).size:0;
  const emit=row=>{
    const line=JSON.stringify(row)+"\n";
    if(journalBytes>=4*1024*1024) {
      fs.renameSync(journal,path.join(directory,"events-"+Date.now()+"-"+randomUUID()+".jsonl"));
      journalBytes=0;
    }
    fs.appendFileSync(journal,line,{flush:true});
    journalBytes+=Buffer.byteLength(line);
  };
  const renameWait = new Int32Array(new SharedArrayBuffer(4));
  const writes=[];
  const queueSamples=[];
  const loop=monitorEventLoopDelay({resolution:10});
  loop.enable();
  let afterRotationAtMs=null;
  const save=state=>{
    const start=performance.now();
    fs.writeFileSync(stateFile+".tmp",JSON.stringify(state),{flush:true});
    for (let attempt=0;;attempt++) {
      try { fs.renameSync(stateFile+".tmp",stateFile); break; }
      catch (error) {
        // Windows readers can briefly hold the old snapshot open.
        if (process.platform!=="win32" || !["EPERM","EBUSY","EACCES"].includes(error.code) || attempt===5) throw error;
        Atomics.wait(renameWait,0,0,10);
      }
    }
    writes.push(performance.now()-start);
    if(writes.length>256)writes.shift();
  };
  const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,"utf8")):{};
  let fixture;
  if(workerData.fixtureModule) {
    if(!process.env.NODE_TEST_CONTEXT) throw Error("Test quote injection outside node --test");
    fixture=await import(workerData.fixtureModule);
  }
  const rpcFetch=readOnlyBudgetFetch({request:fixture?.request});
  const executor=new PumpExecutor({...config,liveSlippageBps:state.epoch?.slippageBps??config.liveSlippageBps,
    rpcWsUrl:undefined,rpcFallbackHttpUrl:"",shadowReadOnlyFetch:rpcFetch},
    {publicKey:new PublicKey(publicKey)},{enableFallback:false});
  let quote=(...args)=>executor.quoteShadow(...args);
  let rpcStats=rpcFetch.stats;
  // Deterministic quotes are available only inside the isolated node test runner.
  if(fixture) {
    fixture.configure?.(executor);
    quote=fixture.quote??quote;
    rpcStats=fixture.rpcStats??rpcStats;
  }
  if(Boolean(state.testData)!==Boolean(workerData.fixtureModule)&&Object.keys(state).length) throw Error("Mixed fixture/production state");
  state.testData=Boolean(workerData.fixtureModule);
  const engine=new LaunchFollow({quote,emit,save,state,research:!fixture||fixture.research===true,archived:mint=>archive.has("launch",mint),maxAgeMs:config.fastMaxSignalAgeMs,
    maxDriftBps:config.fastMaxEntryDriftBps,slippageBps:config.liveSlippageBps,
    prioritySol:config.livePriorityFeeSol,tipSol:config.liveTipSol});
  if (state.epoch && !state.cohort) {
    const prior=Object.values(mergeLaunchArchive(state,path.join(directory,"archive.sqlite")).launches)
      .filter(p=>p.epochId===state.epoch.id)
      .sort((a,b)=>(a.decodedAtMs??a.confirmedAtMs??a.observedAtMs)-(b.decodedAtMs??b.confirmedAtMs??b.observedAtMs));
    engine.state.cohort={exploratory:[],holdout:[],breaches:0,migrationUncertain:prior.length>=25};
    for(const p of prior) engine.registerCohort(p);
    engine.record("COHORT_MIGRATED",{prior:prior.length});
  }
  let coverage={}, lastId=0;
  let lastDiagnosticAt=0;
  const diagnosticExecutor=new PumpExecutor({...config,rpcWsUrl:undefined,rpcFallbackHttpUrl:"",
    shadowReadOnlyFetch:readOnlyBudgetFetch({request:fixture?.request,perSecond:2,perMinute:4})},
    {publicKey:new PublicKey(publicKey)},{enableFallback:false});
  async function diagnose(launch) {
    if (!launch?.epochId||!launch.quoteStartedAtMs||!launch.curve||Date.now()-lastDiagnosticAt<60000) return;
    lastDiagnosticAt=Date.now();
    const checks=await Promise.all(["processed","confirmed"].map(async commitment=>{
      const began=Date.now();
      try {
        const result=await diagnosticExecutor.shadowAccountReadiness(launch.mint,launch.curve,launch.slot,commitment);
        return {commitment,...result,observedAfterMs:Date.now()-launch.observedAtMs,rpcMs:Date.now()-began};
      } catch(error) {
        return {commitment,ready:false,observedAfterMs:Date.now()-launch.observedAtMs,rpcMs:Date.now()-began,
          reason:error.message.replace(/https?:\/\/\S+/g,"[endpoint]").slice(0,200)};
      }
    }));
    launch.readinessDiagnostics=checks;
    engine.record("ACCOUNT_READINESS",{mint:launch.mint,sourceSlot:launch.slot,checks});
  }
  const heartbeat=()=>{
    engine.state.observation.writeSamplesMs=[...writes];
    engine.state.observation.writeAfterRotationAtMs=afterRotationAtMs;
    engine.state.observation.workerQueueSamplesMs=[...queueSamples];
    engine.state.observation.workerLoopMs=Object.fromEntries([50,95,99].map(p=>["p"+p,loop.percentile(p)/1e6]));
    parentPort.postMessage({type:"heartbeat",...engine.heartbeat(coverage,rpcStats()),lastId});
  };
  parentPort.on("message",message=>{
    try {
      if(message.kind==="coverage") coverage=message.coverage;
      else if(message.kind==="ws_coverage") {
        const observation=engine.state.observation;
        observation.wsChannels??={};
        observation.wsChannels[message.channel]={atMs:message.atMs,connected:message.connected,subscriptions:message.subscriptions};
        engine.record("WS_COVERAGE",{channel:message.channel,...observation.wsChannels[message.channel]});
        coverage={...coverage,wsAvailable:Object.values(observation.wsChannels).some(c=>c.connected&&c.subscriptions[LAUNCH_TARGET])};
        const gap=observation.gaps.find(g=>g.reason==="ws_unavailable"&&g.endMs===null);
        if(coverage.wsAvailable&&gap) {
          gap.endMs=message.atMs;
          engine.record("DATA_GAP_CLOSED",gap);
        }
      }
      else if(message.kind==="gap") engine.gap(message.reason,message.startMs,message.endMs);
      else if(message.kind==="confirmed") engine.confirm(message.tx,message.signature);
      else if(message.kind==="backfill_sweep") {
        const observation=engine.state.observation;
        const {kind,id,...sweep}=message;
        observation.lastBackfillSweep=sweep;
        for(const gap of observation.gaps) {
          if(gap.reason!=="ws_unavailable"||gap.endMs===null||gap.afterSweep||sweep.startedAtMs<gap.endMs+2000)continue;
          gap.afterSweep=sweep;
        }
        engine.record("BACKFILL_SWEEP",sweep);
      }
      else if(message.kind==="rpc_error") {
        const o=engine.state.observation;o.counters.backfillErrors=(o.counters.backfillErrors??0)+1;
        engine.record("RPC_ERROR",{message:message.message});
      }
      else if(message.kind==="ws_error") {
        const o=engine.state.observation;o.counters.wsErrors=(o.counters.wsErrors??0)+1;
        engine.record("WS_ERROR",{channel:message.channel,code:message.code,clean:message.clean});
      }
      else if(message.kind==="catalog") {
        const o=engine.state.observation;
        o.lastCatalogAtMs=Date.now(); o.catalog??={};
        for(const s of message.signatures) if(s.blockTime*1000>=o.startedAtMs-1000) o.catalog[s.signature]??={slot:s.slot,blockTime:s.blockTime,err:s.err??null,atMs:Date.now()};
        engine.record("BACKFILL",{signatures:message.signatures.length});
      } else if(message.kind==="resolvedSell") engine.creatorSell(message.trade);
      else if(message.value) {
        const {value,slot,observedAtMs}=message;
        const receivedAt=Date.now();
        queueSamples.push(receivedAt-observedAtMs);
        if(queueSamples.length>256)queueSamples.shift();
        if (!archive.has("ws",value.signature)) engine.observeWs(value.signature,observedAtMs);
        if(!value.err) {
          const start=Date.now();
          const {trades}=parsePumpLogSignal(value.logs,LAUNCH_TARGET,value.signature,{slot,observedAtMs});
          for(const t of trades) if(t.side==="SELL"&&t.mint) engine.creatorSell(t);
          for(const s of launchSignals(value,slot,observedAtMs)) {
            const isNew=!engine.state.launches[s.mint]&&!archive.has("launch",s.mint);
            void engine.launch({...s,workerQueueMs:receivedAt-observedAtMs,decodeMs:Date.now()-start})
              .then(()=>isNew?diagnose(engine.state.launches[s.mint]):undefined).catch(fatal);
          }
        }
      }
      lastId=message.id??lastId;
      parentPort.postMessage({type:"ack",id:message.id});
    } catch(e) {fatal(e);}
  });
  parentPort.postMessage({type:"ready",ready:true,recovered:Object.keys(engine.state.launches).length});
  setInterval(heartbeat,1000);
  if(!workerData.fixtureModule) setInterval(()=>{
    const started=performance.now();
    const rows=archive.compact(engine.state,Date.now());
    if(rows){
      writes.length=0;
      afterRotationAtMs=Date.now();
      engine.record("ARCHIVE_ROTATED",{rows,durationMs:performance.now()-started});
    }
  },60000);
} catch(e) {fatal(e);}
