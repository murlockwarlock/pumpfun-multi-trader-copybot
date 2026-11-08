import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { quoteSlotValid, EXIT_SECONDS } from "../src/launch-follow.js";
const metric = v => {const a=v.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p95:a[Math.ceil(a.length*.95)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null};};
const sum=(a,f)=>a.reduce((n,x)=>n+f(x),0);
const verified=p=>p.confirmed===true&&p.verification==="matched_create_buy_v2"&&!p.dataInvalid&&quoteSlotValid(p.entry,p.slot);
function portfolios(rows) {
  return Object.fromEntries(Object.keys(EXIT_SECONDS).map(v=>{
    const quotes=rows.filter(p=>p.exits[v]?.status==="QUOTED");
    const valid=quotes.filter(p=>verified(p)&&quoteSlotValid(p.exits[v].quote,Math.max(p.slot,p.entry.marketContextSlot)));
    const sorted=[...valid].sort((a,b)=>a.exits[v].preparedAtMs-b.exits[v].preparedAtMs);
    let equity=0,peak=0,maxDrawdownSol=0;
    for(const p of sorted){equity+=p.exits[v].netPnlSol;peak=Math.max(peak,equity);maxDrawdownSol=Math.max(maxDrawdownSol,peak-equity);}
    const pnl=valid.map(p=>p.exits[v].netPnlSol),mean=pnl.length?sum(pnl,x=>x)/pnl.length:null;
    const variance=pnl.length>1?sum(pnl,x=>(x-mean)**2)/(pnl.length-1):null;
    return [v,{observations:rows.length,admitted:rows.filter(p=>p.accepted).length,closed:valid.length,
      unknown:rows.filter(p=>p.exits[v]?.status==="UNKNOWN").length,unverifiedQuotes:quotes.length-valid.length,
      pending:rows.filter(p=>p.accepted&&!p.exits[v]).length,wins:pnl.filter(x=>x>0).length,losses:pnl.filter(x=>x<0).length,
      netPnlSol:pnl.length?sum(pnl,x=>x):null,meanPnlSol:mean,
      meanLower95:pnl.length>1?mean-2.064*Math.sqrt(variance/pnl.length):null,
      fixedFeesSol:sum(valid,p=>p.exits[v].fixedFeesSol),tradingFees:"already included in SDK net output",
      rentNetSol:sum(valid,p=>p.exits[v].rentNetSol??0),maxDrawdownSol:pnl.length?maxDrawdownSol:null,
      slippageFloorNetPnlSol:valid.length?sum(valid,p=>p.exits[v].sellSlippageFloorPnlSol):null,
      extraSellSlippage:Object.fromEntries([100,300,500].map(bps=>[bps,valid.length?sum(valid,p=>p.exits[v].netPnlSol-p.exits[v].proceedsSol*bps/10000):null])),
      exitLatenessMs:metric(valid.map(p=>p.exits[v].latenessMs))}];
  }));
}
export function summarize(state,{now=Date.now()}={}) {
  const launches=Object.values(state.launches??{}).sort((a,b)=>
    (a.slot??Number.MAX_SAFE_INTEGER)-(b.slot??Number.MAX_SAFE_INTEGER) ||
    a.observedAtMs-b.observedAtMs || a.signature.localeCompare(b.signature));
  const o=state.observation??{}, ws=Object.keys(o.ws??{}), confirmed=o.confirmed??{}, catalog=o.catalog??{};
  const missingMetadata=Object.keys(catalog).filter(s=>!catalog[s].err&&!confirmed[s]);
  const missingWs=Object.keys(catalog).filter(s=>!catalog[s].err&&!(s in (o.ws??{})));
  const all=portfolios(launches),exploratory=portfolios(launches.slice(0,25)),holdout=portfolios(launches.slice(25,50));
  const invalid=[];
  if(!o.startedAtMs||!o.lastHeartbeatAtMs||now-o.lastHeartbeatAtMs>15000)invalid.push("observer_missing_or_stale");
  if(o.gaps?.length)invalid.push("DATA_GAP");
  if(missingMetadata.length||o.unresolvedWs?.length)invalid.push("incomplete_signature_verification");
  if(missingWs.length)invalid.push("missing_ws_notifications");
  if(launches.some(p=>p.dataInvalid||p.verification==="source_mismatch"))invalid.push("invalid_source_or_market");
  if(Object.values(all).some(p=>p.unknown||p.unverifiedQuotes))invalid.push("incomplete_quote_observations");
  const completeExploration=launches.length>=25&&Object.values(exploratory).every(p=>p.closed===25);
  const selected=completeExploration?Object.keys(exploratory).sort((a,b)=>exploratory[b].netPnlSol-exploratory[a].netPnlSol||a.localeCompare(b))[0]:null;
  let verdict=invalid.length?"DATA_INVALID":"UNPROVEN";
  const h=selected?holdout[selected]:null;
  if(!invalid.length&&h?.closed===25) {
    if(h.netPnlSol<=0)verdict="NO-GO";
    else if(h.meanLower95>0&&h.slippageFloorNetPnlSol>0&&h.wins>=15&&h.maxDrawdownSol<h.netPnlSol)verdict="RESEARCH-GO";
  }
  const entries=launches.map(p=>({mint:p.mint,signature:p.signature,slot:p.slot,status:p.status,reason:p.reason??null,
    observedAtMs:p.observedAtMs,confirmed:p.confirmed??false,verification:p.verification??"pending",dataInvalid:p.dataInvalid??false,
    admitted:p.accepted??false,creatorSol:p.solAmount,creatorPriceSol:p.averagePriceSol,entryPriceSol:p.entryPriceSol??null,
    entryDriftBps:p.entryDriftBps??null,marketContextSlot:p.entry?.marketContextSlot??null,workerQueueMs:p.workerQueueMs??null,
    decodeMs:p.decodeMs??null,rpcMs:p.entry?.rpcMs??null,quoteMs:p.entry?.quoteMs??null,signalToPreparedMs:p.signalToPreparedMs??null,
    firstCreatorSell:state.sells?.[p.mint]?.[0]??null,exits:p.exits}));
  return {schemaVersion:2,testData:state.testData===true,generatedAt:new Date(now).toISOString(),verdict,invalidReasons:invalid,
    permission:"RESEARCH-GO is research only; never authorization for live transactions",
    observation:{startedAtMs:o.startedAtMs??null,lastHeartbeatAtMs:o.lastHeartbeatAtMs??null,durationMs:o.startedAtMs?now-o.startedAtMs:null,
      coverage:o.coverage??null,gaps:o.gaps??[],wsSignatures:ws.length,confirmedSignatures:Object.keys(confirmed).length,
      catalogSignatures:Object.keys(catalog).length,missingWs,missingMetadata,unresolvedWs:o.unresolvedWs??[],
      errors:o.counters??{},rpc:o.rpc??null},
    launches:launches.length,admitted:launches.filter(p=>p.accepted).length,missed:launches.filter(p=>p.status==="MISSED").length,
    skipReasons:Object.fromEntries([...new Set(launches.map(p=>p.reason).filter(Boolean))].map(r=>[r,launches.filter(p=>p.reason===r).length])),
    timing:Object.fromEntries(["workerQueueMs","decodeMs","rpcMs","quoteMs","signalToPreparedMs","entryDriftBps"].map(k=>[k,metric(entries.map(e=>e[k]))])),
    firstCreatorSellObservedMs:metric(entries.map(p=>p.firstCreatorSell?p.firstCreatorSell.observedAtMs-p.observedAtMs:null)),
    portfolios:all,exploratory,holdout,selectedRule:selected,entries,
    splitRule:"first 25 chronological launches exploratory; next 25 holdout, including missed launches; select only on complete exploration",
    decisionRule:"25 complete holdout observations for preselected rule; positive lower mean bound, slippage-floor net, >=15 wins, drawdown below net; otherwise UNPROVEN/NO-GO",
    limitations:["Quotes are not executed returns", "Processed state can roll back; minContextSlot proves freshness, not finality", "Fixed fees and rent refund are model assumptions", "Confidence bound is descriptive, not proof against selection bias or dependence"]};
}
export function writeReport(report,directory) {
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,"report.json"),JSON.stringify(report,null,2)+"\n");
  const rows=report.entries.flatMap(e=>Object.keys(EXIT_SECONDS).map(v=>{
    const x=e.exits[v];
    const included=e.confirmed&&e.verification==="matched_create_buy_v2"&&!e.dataInvalid&&e.marketContextSlot>=e.slot&&quoteSlotValid(x?.quote,e.marketContextSlot);
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
    `Launches: ${report.launches}; entries: ${report.admitted}; missed: ${report.missed}.`,
    `Invalidity reasons: ${report.invalidReasons.join(", ")||"none detected"}.`,
    `Observation duration: ${report.observation.durationMs??"UNKNOWN"} ms; DATA_GAP: ${report.observation.gaps.length}.`,
    `WS / confirmed / catalog signatures: ${report.observation.wsSignatures} / ${report.observation.confirmedSignatures} / ${report.observation.catalogSignatures}.`,
    `Missing WS / metadata: ${report.observation.missingWs.length} / ${report.observation.missingMetadata.length}.`,"",
    "| Exit | Closed | UNKNOWN | Unverified | Wins | Losses | Net SOL | Fees SOL | Slippage floor SOL | Max drawdown SOL |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...Object.entries(report.portfolios).map(([v,p])=>`| ${v} | ${p.closed} | ${p.unknown} | ${p.unverifiedQuotes} | ${p.wins} | ${p.losses} | ${p.netPnlSol??"UNKNOWN"} | ${p.fixedFeesSol} | ${p.slippageFloorNetPnlSol??"UNKNOWN"} | ${p.maxDrawdownSol??"UNKNOWN"} |`),"",
    report.splitRule,`Selected on exploratory: ${report.selectedRule??"none"}. Holdout is not used for selection.`,"",
    "Latency, drift, first creator SELL, errors, gaps and RPC consumption:","```json",JSON.stringify({timing:report.timing,firstCreatorSellObservedMs:report.firstCreatorSellObservedMs,rpc:report.observation.rpc,errors:report.observation.errors,gaps:report.observation.gaps,skipReasons:report.skipReasons},null,2),"```","",
    ...report.limitations.map(s=>`- ${s}`),"","Per-launch prices, timestamps and all exits: observations.csv / report.json."];
  fs.writeFileSync(path.join(directory,"report.md"),md.join("\n")+"\n");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const file=process.argv[2]??"data/sniper-launch-follow/state.json";
  const report=summarize(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{});
  if(process.argv[3])writeReport(report,process.argv[3]);
  console.log(JSON.stringify(report,null,2));
}
