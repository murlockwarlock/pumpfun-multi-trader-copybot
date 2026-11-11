import {setTimeout as wait} from "node:timers/promises";
import {inspectTrade} from "./copy-candidate-trade.mjs";

export async function reconcile({wallets,seen,start,end,endpoint,fetchImpl=fetch,pause=wait}) {
  const out={};
  let cooldown=false;
  async function rpc(method,params) {
    if (cooldown) throw Error("independent_rpc_cooldown");
    await pause(420);
    const response=await fetchImpl(endpoint,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(6000)});
    if (response.status===429) cooldown=true;
    if (!response.ok) throw Error("independent_rpc_http_"+response.status);
    const body=await response.json();
    if (body.error) throw Error("independent_rpc_error_"+body.error.code);
    return body.result;
  }
  let headTime=null;
  try {
    const head=await rpc("getSlot",[{commitment:"finalized"}]);
    headTime=await rpc("getBlockTime",[head]);
  } catch { /* Coverage is unknown without the finalized upper boundary. */ }
  for (const wallet of wallets) {
    const r=out[wallet]={headTime,lowerBoundary:false,listed:0,unseen:0,unclassified:0,
      failed:0,rpcErrors:0,knownMissing:[],slotMismatches:[],status:"UNKNOWN"};
    let before;
    const observed=seen.get(wallet)??new Map();
    let classified=0;
    for (let i=0;i<8;i++) {
      let batch;
      try {batch=await rpc("getSignaturesForAddress",[wallet,{limit:1000,before,commitment:"finalized"}]);}
      catch {r.rpcErrors++;break;}
      if (!Array.isArray(batch)) {r.rpcErrors++;break;}
      for (const row of batch) {
        if (row.blockTime===null) {r.unclassified++;continue;}
        // Block time is coarse. Ambiguous edge events cannot prove a miss.
        const time=row.blockTime*1000;
        if (time<start-3000 || time>end+3000) continue;
        const edge=time<start+3000 || time>end-3000;
        r.listed++;
        if (row.err) {r.failed++;continue;}
        if (observed.has(row.signature)) {
          if (observed.get(row.signature)!==row.slot) r.slotMismatches.push(row.signature);
          continue;
        }
        r.unseen++;
        if (classified>=48 || edge) {r.unclassified++;continue;}
        classified++;
        try {
          const tx=await rpc("getTransaction",[row.signature,{commitment:"finalized",encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
          if (!tx||tx.slot!==row.slot||tx.transaction?.signatures?.[0]!==row.signature||tx.meta?.err!==null||
            !Array.isArray(tx.meta.logMessages)||
            tx.meta.logMessages.some(s=>s.includes("Log truncated"))) {r.unclassified++;continue;}
          const trades=inspectTrade(tx,wallet,row.signature).filter(t=>t.authenticated);
          if (trades.length) r.knownMissing.push({signature:row.signature,slot:row.slot,blockTime:row.blockTime,
            trades:trades.map(t=>({side:t.side,eligible:t.eligible,mint:t.mint,venue:t.venue}))});
        } catch {r.rpcErrors++;r.unclassified++;}
      }
      if (batch.length<1000 || (batch.at(-1)?.blockTime??Infinity)*1000<start-3000) {
        r.lowerBoundary=true;
        break;
      }
      before=batch.at(-1).signature;
    }
    if (r.knownMissing.length || r.slotMismatches.length) r.status="INVALID";
    else if (r.lowerBoundary && headTime*1000>=end+3000 && !r.rpcErrors && !r.unclassified) r.status="VERIFIED";
  }
  return out;
}
