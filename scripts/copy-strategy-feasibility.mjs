import fs from "node:fs";
import bs58 from "bs58";
import { pathToFileURL } from "node:url";
import { parsePumpTrades,parseConfirmedPumpLogSignal } from "../src/parser.js";
import { confirmedLaunches } from "../src/launch-follow.js";

const SOL="So11111111111111111111111111111111111111112";
const PUMP="6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const idl=readIdl();
function readIdl() {
  const data=JSON.parse(fs.readFileSync(new URL("../node_modules/@pump-fun/pump-sdk/src/idl/pump.json",import.meta.url)));
  return data.instructions.filter(i=>i.accounts.some(a=>a.name==="quote_mint"));
}
const names=["candidate_4rt","kaaox","sniper_7ufmve"];
const countBy=(rows,key)=>rows.reduce((out,r)=>(out[key(r)]=(out[key(r)]??0)+1,out),{});
const sum=(rows,fn)=>rows.reduce((n,r)=>n+fn(r),0);
const read=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const lines=file=>fs.readFileSync(file,"utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const signature=r=>(r.sourceSignature??r.targetSignature??r.signature??"").split(":")[0];
const stats=values=>{
  const x=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return {n:x.length,p50:x[Math.ceil(x.length*.5)-1]??null,p95:x[Math.ceil(x.length*.95)-1]??null};
};

export function shadowEconomics(rows) {
  const buys=rows.filter(r=>r.type==="SHADOW_BUY");
  const sells=rows.filter(r=>r.type==="SHADOW_SELL");
  const measured=buys.filter(r=>r.quoteSource==="prepared_at_observation"&&Number.isFinite(r.signalToPreparedMs));
  const pnl=sum(sells,r=>r.pnlSol);
  const largest=[...sells].sort((a,b)=>b.pnlSol-a.pnlSol)[0];
  const measuredEntries=new Set(measured.map(r=>r.targetSignature));
  const measuredPairs=sells.filter(r=>r.quoteSource==="prepared_at_observation"&&measuredEntries.has(r.entrySignature));
  return {buys:buys.length,closed:sells.length,open:buys.length-sells.length,wins:sells.filter(r=>r.pnlSol>0).length,
    losses:sells.filter(r=>r.pnlSol<0).length,netSol:sells.length?pnl:null,
    afterCloseSol:sells.length?pnl-.00011*sells.length:null,
    extraSlippageAndCloseSol:sells.length?pnl-.00011*sells.length-sum(sells,r=>r.proceedsSol*(1-.99**2)):null,
    withoutLargestSol:sells.length>1?pnl-largest.pnlSol:null,
    largest:largest?{pnlSol:largest.pnlSol,signature:largest.targetSignature,quoteSource:largest.quoteSource}:null,
    sources:countBy(buys,r=>r.quoteSource),exitSources:countBy(sells,r=>r.quoteSource),
    measuredQuotes:measured.length,prepareMs:stats(measured.map(r=>r.signalToPreparedMs)),
    driftBps:stats(measured.map(r=>r.entryDriftBps)),signalAgeMs:stats(buys.map(r=>r.signalAgeMs)),
    rejectedBuys:countBy(rows.filter(r=>r.type==="SHADOW_SKIP"&&r.side==="BUY"),r=>String(r.reason)
      .replace(/:[ ]*[1-9A-HJ-NP-Za-km-z]{32,44}$/,"").replace(/_\d+bps$/,"_BPS")),
    twoSidedMeasured:measuredPairs.length,expectedNetSol:null};
}

function originalWallet(wallet, catalog, txs) {
  const positions=new Map(), result={listed:catalog.length,missing:0,failed:0,nonSigner:0,other:0,unknownBasisSales:0,
    buys:0,sells:0,decodedBuySignals:0,decodedSellSignals:0,nonSolSignals:0,knownSales:0,positiveSales:0,negativeSales:0,conditionalRealizedSol:null,
    paidFeeSol:0,failedFeeSol:0,solOnlyDirectBuys:0,solOnlyDirectSells:0,ownLaunches:0,venues:{}};
  // RPC address history is newest first, including intra-slot transaction order.
  for(const row of [...catalog].reverse()) {
    const tx=txs[row.signature];
    if(!tx?.meta){result.missing++;positions.clear();continue;}
    const keys=tx.transaction.message.accountKeys,meta=tx.meta;
    const index=keys.findIndex(k=>k.pubkey===wallet);
    const fee=keys[0]?.pubkey===wallet?meta.fee/1e9:0;
    result.paidFeeSol+=fee;
    if(meta.err){result.failed++;result.failedFeeSol+=fee;continue;}
    const owned=new Set(),before=new Map(),after=new Map();
    for(const [records,map] of [[meta.preTokenBalances,before],[meta.postTokenBalances,after]]) {
      for(const b of records??[]) if(b.owner===wallet){
        owned.add(b.accountIndex);
        map.set(b.mint,(map.get(b.mint)??0n)+BigInt(b.uiTokenAmount.amount));
      }
    }
    const deltas=[...new Set([...before.keys(),...after.keys()])].filter(m=>m!==SOL)
      .map(m=>({mint:m,pre:before.get(m)??0n,post:after.get(m)??0n})).filter(d=>d.pre!==d.post);
    const invalidate=()=>{for(const d of deltas)positions.delete(d.mint);};
    if(index<0||!keys[index].signer){result.nonSigner++;invalidate();continue;}
    const decoded=parsePumpTrades(tx,wallet,row.signature);
    result.decodedBuySignals+=decoded.filter(t=>t.side==="BUY").length;
    result.decodedSellSignals+=decoded.filter(t=>t.side==="SELL").length;
    const authenticated=parseConfirmedPumpLogSignal(tx,wallet,row.signature).trades;
    const launches=confirmedLaunches(tx,row.signature,row.blockTime*1000);
    result.ownLaunches+=launches.length;
    const inner=(meta.innerInstructions??[]).flatMap(g=>g.instructions);
    const instructions=[...tx.transaction.message.instructions,...inner];
    const nonSol=instructions.some(i=>{
      if(i.programId!==PUMP||!i.data)return false;
      const bytes=bs58.decode(i.data);
      const spec=idl.find(s=>s.discriminator.every((b,j)=>bytes[j]===b));
      if(!spec||! /^(buy|sell)/.test(spec.name))return false;
      const quote=i.accounts[spec.accounts.findIndex(a=>a.name==="quote_mint")];
      return Boolean(quote&&![SOL,"11111111111111111111111111111111"].includes(quote));
    });
    if(nonSol)result.nonSolSignals+=decoded.length;
    const direct=authenticated.filter(t=>!nonSol&&!t.executionRoute&&!launches.some(l=>l.mint===t.mint)&&
      (t.venue==="pump-curve"||(t.venue==="pumpswap"&&t.pool&&
      [...(meta.preTokenBalances??[]),...(meta.postTokenBalances??[])].some(b=>b.owner===t.pool&&b.mint===SOL))));
    result.solOnlyDirectBuys+=direct.filter(t=>t.side==="BUY").length;
    result.solOnlyDirectSells+=direct.filter(t=>t.side==="SELL").length;
    const d=deltas[0];
    const adjust=[...new Set([index,...owned])];
    const safe=adjust.every(i=>Number.isSafeInteger(meta.preBalances[i])&&Number.isSafeInteger(meta.postBalances[i]));
    const cash=safe?adjust.reduce((n,i)=>n+BigInt(meta.postBalances[i])-BigInt(meta.preBalances[i]),0n):0n;
    const t=d&&decoded.find(t=>t.mint===d.mint&&t.side===(d.post>d.pre?"BUY":"SELL"));
    // Multi-asset routes and token-quoted launches have no unambiguous SOL basis.
    if(deltas.length!==1||!t||nonSol||launches.some(l=>l.unsupportedReason)||(d.post-d.pre)*cash>=0n) {
      result.other++;invalidate();continue;
    }
    result.venues[t.venue]=(result.venues[t.venue]??0)+1;
    let position=positions.get(d.mint);
    if(!position||position.qty!==d.pre)position={qty:d.pre,cost:0n,known:d.pre===0n};
    if(t.side==="BUY"){result.buys++;position.cost-=cash;}
    else {
      result.sells++;
      if(position.known&&position.qty>0n){
        const basis=position.cost*(d.pre-d.post)/position.qty;
        const profit=Number(cash-basis)/1e9;
        result.knownSales++;
        if(profit>0)result.positiveSales++;
        if(profit<0)result.negativeSales++;
        result.conditionalRealizedSol=(result.conditionalRealizedSol??0)+profit;
        position.cost-=basis;
      } else result.unknownBasisSales++;
    }
    position.qty=d.post;
    if(position.qty===0n)positions.delete(d.mint);
    else positions.set(d.mint,position);
  }
  result.remainingMints=positions.size;
  return result;
}

function build(capture, retry, live, shadow) {
  const start=Date.parse("2026-11-06T13:42:44Z");
  const stop=capture.end*1000;
  const common=rows=>rows.filter(r=>Date.parse(r.at)>=start&&Date.parse(r.at)<=stop);
  const wallets=Object.fromEntries(names.map(name=>{
    const h=capture.history[name],txs={...h.txs,...(name==="kaaox"?retry.txs:{})};
    const ss=shadow.filter(r=>r.sourceName===name),ll=live.filter(r=>r.sourceName===name);
    const economic=shadowEconomics(ss);
    return [name,{sourceWindow:{...originalWallet(h.wallet,h.rows,txs),boundaryCovered:h.boundaryCovered},
      logged:{uniqueSignatures:new Set(ll.filter(r=>r.side).map(signature)).size,
        buy:ll.filter(r=>r.side==="BUY").length,sell:ll.filter(r=>r.side==="SELL").length},
      allShadow:economic,commonShadow:shadowEconomics(common(ss)),
      commonLogged:{buy:common(ll).filter(r=>r.side==="BUY").length,sell:common(ll).filter(r=>r.side==="SELL").length}}];
  }));
  return {start:new Date(capture.start*1000).toISOString(),end:new Date(capture.end*1000).toISOString(),
    commonShadowStart:new Date(start).toISOString(),wallets,routes:retry.routes??capture.routes};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [capture,retry,live,shadow,out,extra]=process.argv.slice(2);
  const evidence=build(read(capture),read(retry),lines(live),lines(shadow));
  if(extra)evidence.additionalQuoteSnapshots=read(extra);
  fs.writeFileSync(out,JSON.stringify(evidence,null,2)+"\n");
}
