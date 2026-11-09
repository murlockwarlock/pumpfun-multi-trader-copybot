import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { quoteSlotValid, EXIT_SECONDS } from "../src/launch-follow.js";
import { mergeLaunchArchive } from "../src/launch-follow-archive.js";
const metric = v => {const a=v.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p95:a[Math.ceil(a.length*.95)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null};};
const sum=(a,f)=>a.reduce((n,x)=>n+f(x),0);
const verified=p=>p.confirmed===true&&p.verification==="matched_create_buy_v2"&&!p.dataInvalid&&quoteSlotValid(p.entry,p.slot);
const completeQuote=q=>q?.marketCommitment==="confirmed"&&q.contextVerified===true;
const overlaps=(g,start,end)=>(g.startMs??-Infinity)<=end&&(g.endMs??Infinity)>=start;
const flat=p=>p.confirmed===true&&p.status==="SKIP"&&["entry_price_limit","entry_drift","creator_sold_before_entry","creator_sold_during_preparation","shadow_capacity","unsupported_non_sol_curve"].includes(p.reason);
function eligible(p,v,gaps,epoch) {
  const exit=p.exits[v];
  return exit?.status==="QUOTED"&&verified(p)&&quoteSlotValid(exit.quote,Math.max(p.slot,p.entry.marketContextSlot))&&
    (!epoch||(completeQuote(p.entry)&&completeQuote(exit.quote)))&&
    !gaps.some(g=>overlaps(g,p.observedAtMs,exit.preparedAtMs));
}
function portfolios(rows,gaps=[],epoch=null) {
  return Object.fromEntries(Object.keys(EXIT_SECONDS).map(v=>{
    const quotes=rows.filter(p=>p.exits[v]?.status==="QUOTED");
    const valid=quotes.filter(p=>eligible(p,v,gaps,epoch));
    const abstentions=epoch?rows.filter(p=>flat(p)&&!gaps.some(g=>overlaps(g,p.observedAtMs,p.decisionAtMs??p.observedAtMs))).length:0;
    const sorted=[...valid].sort((a,b)=>a.exits[v].preparedAtMs-b.exits[v].preparedAtMs);
    let equity=0,peak=0,maxDrawdownSol=0;
    for(const p of sorted){equity+=p.exits[v].netPnlSol;peak=Math.max(peak,equity);maxDrawdownSol=Math.max(maxDrawdownSol,peak-equity);}
    const pnl=[...valid.map(p=>p.exits[v].netPnlSol),...Array(abstentions).fill(0)];
    const mean=pnl.length?sum(pnl,x=>x)/pnl.length:null;
    const variance=pnl.length>1?sum(pnl,x=>(x-mean)**2)/(pnl.length-1):null;
    return [v,{observations:rows.length,admitted:rows.filter(p=>p.accepted).length,closed:valid.length,
      abstentions,resolved:valid.length+abstentions,unknown:rows.length-valid.length-abstentions,unverifiedQuotes:quotes.length-valid.length,
      pending:rows.filter(p=>p.accepted&&!p.exits[v]).length,wins:pnl.filter(x=>x>0).length,losses:pnl.filter(x=>x<0).length,
      netPnlSol:pnl.length?sum(pnl,x=>x):null,meanPnlSol:mean,
      meanLower95:pnl.length>1?mean-2.064*Math.sqrt(variance/pnl.length):null,
      fixedFeesSol:sum(valid,p=>p.exits[v].fixedFeesSol),tradingFees:"already included in SDK net output",
      rentNetSol:sum(valid,p=>p.exits[v].rentNetSol??0),maxDrawdownSol:pnl.length?maxDrawdownSol:null,
      slippageFloorNetPnlSol:valid.length?sum(valid,p=>p.exits[v].sellSlippageFloorPnlSol):null,
      adverseNetPnlSol:valid.length?sum(valid,p=>{
        const exit=p.exits[v];
        const haircut=(exit.slippageBps??0)/10000;
        return exit.proceedsSol*(1-haircut)**2-.005-exit.fixedFeesSol-(p.entry.rentSol??0);
      }):null,
      extraSellSlippage:Object.fromEntries([100,300,500].map(bps=>[bps,valid.length?sum(valid,p=>p.exits[v].netPnlSol-p.exits[v].proceedsSol*bps/10000):null])),
      exitLatenessMs:metric(valid.map(p=>p.exits[v].latenessMs))}];
  }));
}
export function auditGaps(o) {
  const transactions={...o.catalog,...o.confirmed};
  return (o.gaps??[]).map(g=>{
    const evidence=Object.entries(transactions).filter(([,t])=>Number.isFinite(t.blockTime)&&
      overlaps(g,t.blockTime*1000-1000,t.blockTime*1000+2000));
    const unreceived=evidence.filter(([s])=>!(s in (o.ws??{}))).map(([s])=>s);
    const before=g.beforeSweep, after=g.afterSweep;
    const swept=g.startMs!==null&&g.endMs!==null&&before?.cursorAfter&&before.endedAtMs<=g.startMs&&
      g.startMs-before.endedAtMs<=60000&&after?.startedAtMs>=g.endMs+2000&&
      after.cursorBefore===before.cursorAfter&&after.cursorAfter===before.cursorAfter&&
      after.signatures===0&&after.quarantined===0&&before.quarantined===0;
    return {...g,durationMs:g.endMs!==null&&g.startMs!==null?g.endMs-g.startMs:null,
      candidateSignatures:evidence.map(([s])=>s),unreceived,
      reconciledEmpty:g.reason==="ws_unavailable"&&swept&&evidence.length===0&&
        !Object.values(transactions).some(t=>t.blockTime==null&&overlaps(g,t.atMs-60000,t.atMs))};
  });
}
export function summarize(state,{now=Date.now()}={}) {
  const audit=Object.values(state.launches??{});
  const epoch=state.epoch??null;
  const launches=audit.filter(p=>!epoch||p.epochId===epoch.id).sort((a,b)=>
    (a.slot??Number.MAX_SAFE_INTEGER)-(b.slot??Number.MAX_SAFE_INTEGER) ||
    a.observedAtMs-b.observedAtMs || a.signature.localeCompare(b.signature));
  const o=state.observation??{}, ws=Object.keys(o.ws??{}), confirmed=o.confirmed??{}, catalog=o.catalog??{};
  const missingMetadata=Object.keys(catalog).filter(s=>!catalog[s].err&&!confirmed[s]);
  const missingWs=Object.keys(catalog).filter(s=>!catalog[s].err&&!(s in (o.ws??{})));
  const gapAudit=auditGaps(o);
  const start=epoch?.startsAtMs??o.startedAtMs??now;
  const registry=state.cohort;
  const byMint=new Map(launches.map(p=>[p.mint,p]));
  const pinned=keys=>keys.map(key=>{
    const launch=byMint.get(key.mint);
    return launch?.signature===key.signature&&launch.slot===key.slot?launch:
      {...key,status:"UNKNOWN",reason:"cohort_identity_missing_or_reorg",dataInvalid:true,exits:{}};
  });
  const exploration=registry?pinned(registry.exploratory):launches.slice(0,25);
  const validation=registry?pinned(registry.holdout):launches.slice(25,50);
  const cohort=[...exploration,...validation];
  const end=cohort.length<50?now:Math.max(...cohort.map(p=>{
    const entryAt=p.preparedAtMs??p.observedAtMs;
    if (!p.accepted) return p.decisionAtMs??entryAt;
    if (Object.keys(p.exits).length<6) return Math.min(now,entryAt+3600000);
    return Math.max(entryAt,...Object.values(p.exits).map(x=>x.preparedAtMs??x.dueAtMs??entryAt));
  }));
  const gaps=gapAudit.filter(g=>!g.reconciledEmpty&&overlaps(g,start,end));
  const all=portfolios(launches,gaps,epoch),exploratory=portfolios(exploration,gaps,epoch),holdout=portfolios(validation,gaps,epoch);
  const invalid=[];
  if(!o.startedAtMs||!o.lastHeartbeatAtMs||now-o.lastHeartbeatAtMs>15000)invalid.push("observer_missing_or_stale");
  if(gaps.length)invalid.push("DATA_GAP");
  if(registry?.breaches||registry?.migrationUncertain)invalid.push("cohort_boundary_integrity");
  const inPeriod=t=>t>=start&&t<=end;
  if(missingMetadata.some(s=>inPeriod(catalog[s].blockTime*1000||catalog[s].atMs))||
    (o.unresolvedWs??[]).some(s=>inPeriod(o.ws[s]??0)))invalid.push("incomplete_signature_verification");
  if(cohort.some(p=>p.dataInvalid||p.verification==="source_mismatch"))invalid.push("invalid_source_or_market");
  if([...Object.values(exploratory),...Object.values(holdout)].some(p=>p.unverifiedQuotes))invalid.push("unverified_quotes");
  const completeExploration=exploration.length===25&&Object.values(exploratory).every(p=>p.resolved===25);
  const selected=completeExploration?Object.keys(exploratory).sort((a,b)=>(exploratory[b].netPnlSol??0)-(exploratory[a].netPnlSol??0)||a.localeCompare(b))[0]:null;
  let verdict=invalid.length?"DATA_INVALID":"UNPROVEN";
  if(epoch&&launches.length===0)verdict="UNPROVEN";
  const h=selected?holdout[selected]:null;
  if(!invalid.length&&h?.resolved===25&&h.closed>0) {
    if(h.netPnlSol<=0)verdict="NO-GO";
    else if(h.meanLower95>0&&h.slippageFloorNetPnlSol>0&&(!epoch||h.adverseNetPnlSol>0)&&h.wins>=15&&h.maxDrawdownSol<h.netPnlSol)verdict="RESEARCH-GO";
  }
  const entries=launches.map(p=>({mint:p.mint,signature:p.signature,slot:p.slot,status:p.status,reason:p.reason??null,
    quoteMint:p.quoteMint??null,tokenAmountRaw:p.tokenAmountRaw??null,sourceBlockTime:p.blockTime??null,auditRecovered:p.auditRecovered??false,
    observedAtMs:p.observedAtMs,confirmed:p.confirmed??false,verification:p.verification??"pending",dataInvalid:p.dataInvalid??false,
    admitted:p.accepted??false,creatorSol:p.solAmount,creatorPriceSol:p.averagePriceSol,entryPriceSol:p.entryPriceSol??null,
    entryDriftBps:p.entryDriftBps??null,marketContextSlot:p.entry?.marketContextSlot??null,workerQueueMs:p.workerQueueMs??null,
    decodeMs:p.decodeMs??null,rpcMs:p.entry?.rpcMs??null,quoteMs:p.entry?.quoteMs??null,signalToPreparedMs:p.signalToPreparedMs??null,
    firstCreatorSell:state.sells?.[p.mint]?.[0]??null,exits:p.exits,
    eligibleExits:Object.keys(EXIT_SECONDS).filter(v=>eligible(p,v,gaps,epoch))}));
  return {schemaVersion:2,testData:state.testData===true,generatedAt:new Date(now).toISOString(),verdict,invalidReasons:invalid,
    epoch,cohort:registry??null,auditLaunches:audit.length,legacyLaunches:audit.filter(p=>epoch&&p.epochId!==epoch.id).map(p=>({mint:p.mint,signature:p.signature,status:p.status,reason:p.reason})),
    permission:"RESEARCH-GO is research only; never authorization for live transactions",
    observation:{startedAtMs:o.startedAtMs??null,lastHeartbeatAtMs:o.lastHeartbeatAtMs??null,durationMs:o.startedAtMs?now-o.startedAtMs:null,
      coverage:o.coverage??null,gaps:gapAudit,epochGaps:gaps.length,wsSignatures:ws.length,confirmedSignatures:Object.keys(confirmed).length,
      catalogSignatures:Object.keys(catalog).length,missingWs,missingMetadata,unresolvedWs:o.unresolvedWs??[],
      errors:o.counters??{},rpc:o.rpc??null},
    launches:launches.length,admitted:launches.filter(p=>p.accepted).length,missed:launches.filter(p=>p.status==="MISSED").length,
    funnel:{ws:ws.filter(s=>o.ws[s]>=start).length,createBuy:launches.length,confirmed:launches.filter(p=>p.confirmed).length,
      attemptedBuy:launches.filter(p=>p.quoteStartedAtMs!=null).length,accepted:launches.filter(p=>p.accepted).length,
      exits:Object.fromEntries(Object.entries(all).map(([v,p])=>[v,{quotes:p.closed+p.unverifiedQuotes,valid:p.closed,unknown:p.unknown}])),
      rejectTiming:Object.fromEntries([...new Set(launches.map(p=>p.reason).filter(Boolean))].map(reason=>[reason,metric(launches.filter(p=>p.reason===reason).map(p=>p.quoteElapsedMs??(p.decisionAtMs-p.observedAtMs)))]))},
    writeMs:metric(o.writeSamplesMs??[]),
    writeAfterRotationAtMs:o.writeAfterRotationAtMs??null,
    workerQueue:metric(o.workerQueueSamplesMs??[]),
    workerLoopMs:o.workerLoopMs??null,
    rpcLatencyMs:metric(o.rpc?.latencyMs??[]),
    wsChannels:o.wsChannels??{},
    readiness:launches.filter(p=>p.readinessDiagnostics||p.quoteTelemetry).map(p=>({mint:p.mint,slot:p.slot,checks:p.readinessDiagnostics??[],
      quoteTelemetry:p.quoteTelemetry,firstConfirmedContextMs:p.quoteTelemetry?.marketCommitment==="confirmed"&&p.quoteTelemetry.firstContextAtMs?
        p.quoteTelemetry.firstContextAtMs-p.observedAtMs:null})),
    skipReasons:Object.fromEntries([...new Set(launches.map(p=>p.reason).filter(Boolean))].map(r=>[r,launches.filter(p=>p.reason===r).length])),
    timing:Object.fromEntries(["workerQueueMs","decodeMs","rpcMs","quoteMs","signalToPreparedMs","entryDriftBps"].map(k=>[k,metric(entries.map(e=>e[k]))])),
    firstCreatorSellObservedMs:metric(entries.map(p=>p.firstCreatorSell?p.firstCreatorSell.observedAtMs-p.observedAtMs:null)),
    portfolios:all,exploratory,holdout,selectedRule:selected,entries,
    splitRule:"first 25 chronological launches exploratory; next 25 holdout, including missed launches; select only on complete exploration",
    decisionRule:"25 complete holdout observations for preselected rule; positive lower mean bound, slippage-floor net, >=15 wins, drawdown below net; otherwise UNPROVEN/NO-GO",
    limitations:["PnL is modeled from observed quotes. Execution delay and realized slippage are unmeasured.",
      "Processed state can roll back. The new epoch requires confirmed reads at the original deadline. Confirmed does not imply finality.",
      "The adverse scenario approximates BUY and SELL slippage as two multiplicative haircuts and assumes unrecovered rent plus the CLOSE fee.",
      "Confidence bound is descriptive, not proof against selection bias or dependence"]};
}
export function writeReport(report,directory) {
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");
  const rows=report.entries.flatMap(e=>Object.keys(EXIT_SECONDS).map(v=>{
    const x=e.exits[v];
    const included=e.eligibleExits.includes(v);
    return {mint:e.mint,signature:e.signature,slot:e.slot,entryStatus:e.status,reason:e.reason,
      observedAtMs:e.observedAtMs,creatorPriceSol:e.creatorPriceSol,entryPriceSol:e.entryPriceSol,entryDriftBps:e.entryDriftBps,
      signalToPreparedMs:e.signalToPreparedMs,firstSellAtMs:e.firstCreatorSell?.observedAtMs??null,
      workerQueueMs:e.workerQueueMs,decodeMs:e.decodeMs,rpcMs:e.rpcMs,quoteMs:e.quoteMs,marketContextSlot:e.marketContextSlot,
      variant:v,exitStatus:x?.status??(e.admitted?"PENDING":"NOT_ENTERED"),netPnlSol:included?x?.netPnlSol??null:null,
      unverifiedQuotePnlSol:included?null:x?.netPnlSol??null,includedInVerifiedModel:included,exitReason:x?.reason??null,
      fixedFeesSol:x?.fixedFeesSol??null,slippageFloorPnlSol:x?.sellSlippageFloorPnlSol??null,
      sourceVerified:e.confirmed,verification:e.verification,dataInvalid:e.dataInvalid};
  }));
  const keys=rows.length?Object.keys(rows[0]):["mint","signature","variant","exitStatus","netPnlSol"];
  const cell=v=>'"'+String(v??"").replaceAll('"','""')+'"';
  fs.writeFileSync(path.join(directory,"observations.csv"),[keys.join(","),...rows.map(r=>keys.map(k=>cell(r[k])).join(","))].join("\n")+"\n");
  const md=[`# sniper_launch_follow: ${report.verdict}`,"",report.permission,"",
    `Generated: ${report.generatedAt}. Test fixture: ${report.testData}.`,
    `Epoch: ${report.epoch?.id??"legacy"}; audit launches: ${report.auditLaunches}; epoch launches: ${report.launches}; entries: ${report.admitted}; missed: ${report.missed}.`,
    `Invalidity reasons: ${report.invalidReasons.join(", ")||"none detected"}.`,
    `Observation duration: ${report.observation.durationMs??"UNKNOWN"} ms; DATA_GAP: ${report.observation.gaps.length}.`,
    `WS / confirmed / catalog signatures: ${report.observation.wsSignatures} / ${report.observation.confirmedSignatures} / ${report.observation.catalogSignatures}.`,
    `Missing WS / metadata: ${report.observation.missingWs.length} / ${report.observation.missingMetadata.length}.`,"",
    "| Exit | Closed | UNKNOWN | Unverified | Wins | Losses | Net SOL | Fees SOL | Slippage floor SOL | Max drawdown SOL |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.portfolios).map(([v,p])=>`| ${v} | ${p.closed} | ${p.unknown} | ${p.unverifiedQuotes} | ${p.wins} | ${p.losses} | ${p.netPnlSol??"UNKNOWN"} | ${p.fixedFeesSol} | ${p.slippageFloorNetPnlSol??"UNKNOWN"} | ${p.maxDrawdownSol??"UNKNOWN"} |`),"",
    report.splitRule,`Selected on exploratory: ${report.selectedRule??"none"}. Holdout is not used for selection.`,"",
    "Funnel, latency, drift, first creator SELL, errors and RPC consumption:","```json",JSON.stringify({funnel:report.funnel,timing:report.timing,writeMs:report.writeMs,firstCreatorSellObservedMs:report.firstCreatorSellObservedMs,rpc:report.observation.rpc,errors:report.observation.errors,epochGaps:report.observation.epochGaps,skipReasons:report.skipReasons},null,2),"```","",
    ...report.limitations.map(s=>`- ${s}`),"","Per-launch prices, timestamps and all exits: observations.csv / report.json."];
  fs.writeFileSync(path.join(directory,"report.md"),md.join("\n")+"\n");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const file=process.argv[2]??"data/sniper-launch-follow/state.json";
  const snapshot=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
  const archive=path.join(path.dirname(file),"archive.sqlite");
  const report=summarize(fs.existsSync(archive)?mergeLaunchArchive(snapshot,archive):snapshot);
  if(process.argv[3])writeReport(report,process.argv[3]);
  console.log(JSON.stringify(report,null,2));
}
