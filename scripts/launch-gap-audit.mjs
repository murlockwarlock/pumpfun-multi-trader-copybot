import fs from "node:fs";
import path from "node:path";

const [snapshot, journal, output] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(snapshot, "utf8"));
const events = fs.readFileSync(journal,"utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .map(event=>({...event,atMs:Date.parse(event.at)})).sort((a,b)=>a.atMs-b.atMs);
const checkpoint = Date.parse("2026-11-09T07:35:40.179Z");
const sniper = events.filter(e=>e.sourceName==="sniper_7ufmve");
const o = state.observation;
const signatures = new Map();
for (const e of sniper.filter(e=>e.event==="target_trade"&&Number.isFinite(e.blockTime))) {
  signatures.set(e.sourceSignature??e.signature.split(":")[0],{blockTime:e.blockTime,side:e.side,source:e.signalSource});
}
for (const [signature,tx] of Object.entries(o.confirmed??{})) {
  if (Number.isFinite(tx.blockTime)&&!signatures.has(signature)) signatures.set(signature,tx);
}
const gaps = o.gaps.filter(g=>g.reason==="ws_unavailable"&&g.startMs<=checkpoint).map((g,index)=>{
  const finish=g.endMs??checkpoint;
  const closes=events.filter(e=>e.event==="websocket_closed"&&e.atMs>=g.startMs-3000&&e.atMs<=finish);
  const nearby=[...signatures].filter(([,tx])=>tx.blockTime*1000+2000>=g.startMs&&tx.blockTime*1000-1000<=finish);
  const absent=nearby.filter(([sig])=>!(sig in o.ws)).map(([sig])=>sig);
  const restore=Object.fromEntries(["primary","fallback"].map(channel=>[channel,sniper.find(e=>
    e.event==="subscribed"&&e.websocketSource===channel&&e.atMs>=g.startMs)?.at??null]));
  const polls=sniper.filter(e=>e.event==="backfill_ok");
  return {id:index+1,start:new Date(g.startMs).toISOString(),end:g.endMs===null?null:new Date(g.endMs).toISOString(),
    durationMs:g.endMs===null?null:g.endMs-g.startMs,closeChannels:[...new Set(closes.map(e=>e.websocketSource))],
    closeCodes:[...new Set(closes.map(e=>e.code).filter(x=>x!=null))],restore,
    loggedBackfillBefore:polls.filter(e=>e.atMs<=g.startMs).at(-1)?.at??null,
    loggedBackfillDuring:polls.filter(e=>e.atMs>=g.startMs&&e.atMs<=finish).length,
    loggedBackfillAfter:polls.find(e=>e.atMs>finish)?.at??null,
    nearbySignatures:nearby.map(([sig])=>sig),absentFromWs:absent,
    missedLaunches:Object.values(state.launches).filter(p=>p.status==="MISSED"&&nearby.some(([s])=>s===p.signature)).map(p=>p.signature)};
});
const metric=values=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  return {n:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p95:a[Math.ceil(a.length*.95)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null,max:a.at(-1)??null};
};
const windows=Object.fromEntries([["rolling24h",checkpoint-86400000],["integrityRelease",Date.parse("2026-11-08T14:38:07Z")]].map(([name,start])=>{
  const r=sniper.filter(e=>e.atMs>=start&&e.atMs<=checkpoint);
  const signals=r.filter(e=>e.event==="fast_signal_dispatched");
  const failures=r.filter(e=>e.event==="fast_shadow_probe_failed");
  const reasons={};
  const failureSources={};
  for(const e of failures){
    const reason=(e.message??"unknown").replace(/:[ ]*[1-9A-HJ-NP-Za-km-z]{32,44}$/, "");
    reasons[reason]=(reasons[reason]??0)+1;
    const source=r.find(x=>x.event==="target_trade"&&x.signature===e.signature&&x.side==="BUY")?.signalSource??"unmatched";
    failureSources[source]=(failureSources[source]??0)+1;
  }
  return [name,{signals:signals.length,buySignals:signals.filter(e=>e.trades?.some(t=>t.startsWith("BUY:"))).length,
    sellSignals:signals.filter(e=>e.trades?.some(t=>t.startsWith("SELL:"))).length,
    verified:r.filter(e=>e.event==="fast_signal_verified").length,probes:r.filter(e=>e.event==="fast_shadow_probe").length,
    quoteTooOld:r.filter(e=>e.event==="fast_quote_too_old").length,failed:failures.length,reasons,failureSources,
    failureLatencyMs:metric(failures.map(e=>e.atMs-r.find(x=>x.signature===e.signature&&x.event==="target_trade"&&x.side==="BUY")?.observedAtMs)),
    dispatchMs:metric(signals.map(e=>e.signalToResultMs))}];
}));
const summary={count:gaps.length,durationMs:metric(gaps.map(g=>g.durationMs)),
  totalMs:gaps.reduce((n,g)=>n+(g.durationMs??0),0),bothChannels:gaps.filter(g=>g.closeChannels.length===2).length,
  restoredBoth:gaps.filter(g=>Object.values(g.restore).every(Boolean)).length,
  withLoggedBackfillDuring:gaps.filter(g=>g.loggedBackfillDuring).length,
  withNearbySignatures:gaps.filter(g=>g.nearbySignatures.length).length,
  absentFromWs:[...new Set(gaps.flatMap(g=>g.absentFromWs))],missedLaunches:[...new Set(gaps.flatMap(g=>g.missedLaunches))],windows,
  caveat:"Historical closes did not record close codes. BlockTime matching is approximate. Logged backfill is sparse and no nearby signature is not proof that a gap was empty."};
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,"ws-gap-audit.json"),JSON.stringify({summary,gaps},null,2)+"\n");
console.log(JSON.stringify(summary,null,2));
