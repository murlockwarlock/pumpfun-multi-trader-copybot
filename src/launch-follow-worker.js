import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { PublicKey } from "@solana/web3.js";
import { PumpExecutor } from "./pump-executor.js";
import { LaunchFollow, launchSignals, LAUNCH_TARGET } from "./launch-follow.js";
import { parsePumpLogSignal } from "./parser.js";
import { readOnlyBudgetFetch } from "./shadow-rpc-budget.js";
import { openLaunchArchive } from "./launch-follow-archive.js";

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
  const rpcFetch=readOnlyBudgetFetch();
  const executor=new PumpExecutor({...config,liveSlippageBps:state.epoch?.slippageBps??config.liveSlippageBps,
    rpcWsUrl:undefined,rpcFallbackHttpUrl:"",shadowReadOnlyFetch:rpcFetch},
    {publicKey:new PublicKey(publicKey)},{enableFallback:false});
  let quote=(...args)=>executor.quoteShadow(...args);
  let rpcStats=rpcFetch.stats;
  // Deterministic quotes are available only inside the isolated node test runner.
  if(workerData.fixtureModule) {
    if(!process.env.NODE_TEST_CONTEXT) throw Error("Test quote injection outside node --test");
    const fixture=await import(workerData.fixtureModule);
    quote=fixture.quote; rpcStats=fixture.rpcStats??rpcStats;
  }
  if(Boolean(state.testData)!==Boolean(workerData.fixtureModule)&&Object.keys(state).length) throw Error("Mixed fixture/production state");
  state.testData=Boolean(workerData.fixtureModule);
  const engine=new LaunchFollow({quote,emit,save,state,research:!workerData.fixtureModule,archived:mint=>archive.has("launch",mint),maxAgeMs:config.fastMaxSignalAgeMs,
    maxDriftBps:config.fastMaxEntryDriftBps,slippageBps:config.liveSlippageBps,
    prioritySol:config.livePriorityFeeSol,tipSol:config.liveTipSol});
  let coverage={}, lastId=0;
  const heartbeat=()=>{
    engine.state.observation.writeSamplesMs=[...writes];
    parentPort.postMessage({type:"heartbeat",...engine.heartbeat(coverage,rpcStats()),lastId});
  };
  parentPort.on("message",message=>{
    try {
      if(message.kind==="coverage") coverage=message.coverage;
      else if(message.kind==="gap") engine.gap(message.reason,message.startMs,message.endMs);
      else if(message.kind==="confirmed") engine.confirm(message.tx,message.signature);
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
        if (!archive.has("ws",value.signature)) engine.observeWs(value.signature,observedAtMs);
        if(!value.err) {
          const start=Date.now();
          const {trades}=parsePumpLogSignal(value.logs,LAUNCH_TARGET,value.signature,{slot,observedAtMs});
          for(const t of trades) if(t.side==="SELL"&&t.mint) engine.creatorSell(t);
          for(const s of launchSignals(value,slot,observedAtMs)) void engine.launch({...s,
            workerQueueMs:start-observedAtMs,decodeMs:Date.now()-start}).catch(fatal);
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
    if(rows)engine.record("ARCHIVE_ROTATED",{rows,durationMs:performance.now()-started});
  },60000);
} catch(e) {fatal(e);}
