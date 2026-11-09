import fs from "node:fs";
import bs58 from "bs58";
import { LAUNCH_TARGET,confirmedLaunches,launchSignals } from "../src/launch-follow.js";
import { parsePumpTrades,parseConfirmedPumpLogSignal } from "../src/parser.js";

const [input,output]=process.argv.slice(2);
const data=JSON.parse(fs.readFileSync(input,"utf8"));
const idl=JSON.parse(fs.readFileSync(new URL("../node_modules/@pump-fun/pump-sdk/src/idl/pump.json",import.meta.url)));
const pump="6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const catalog=new Map(data.signatures.map(row=>[row.signature,row]));
const key=k=>typeof k==="string"?k:k?.pubkey;
const counts=values=>values.reduce((n,v)=>(n[v]=(n[v]??0)+1,n),{});
function balances(tx) {
  const map=new Map();
  for(const [rows,sign] of [[tx.meta.preTokenBalances,-1n],[tx.meta.postTokenBalances,1n]]) {
    for(const row of rows??[]) if(row.owner===LAUNCH_TARGET) {
      map.set(row.mint,(map.get(row.mint)??0n)+sign*BigInt(row.uiTokenAmount.amount));
    }
  }
  return Object.fromEntries([...map].filter(([,amount])=>amount).map(([mint,amount])=>[mint,String(amount)]));
}
function classify(signature,wsAtMs) {
  const tx=data.txs[signature], listed=catalog.get(signature);
  const base={signature,wsAtMs,confirmedBackfill:!!listed,confirmedSlotMatches:!!listed&&tx?.slot===listed.slot,slot:tx?.slot??listed?.slot??null,
    blockTime:tx?.blockTime??listed?.blockTime??null};
  if(!tx?.meta||!tx.transaction?.signatures?.includes(signature))return {...base,classification:"UNCONFIRMED"};
  if(tx.meta.err)return {...base,classification:"FAILED",error:tx.meta.err};
  const message=tx.transaction.message;
  const walletIndex=message.accountKeys.findIndex(k=>key(k)===LAUNCH_TARGET);
  const signer=message.accountKeys[walletIndex]?.signer===true;
  const deltas=balances(tx);
  const inner=new Map((tx.meta.innerInstructions??[]).map(g=>[g.index,g.instructions]));
  const instructions=message.instructions.flatMap((i,index)=>[i,...(inner.get(index)??[])]);
  const decoded=instructions.filter(i=>i.programId===pump&&i.data).flatMap(i=>{
    const bytes=bs58.decode(i.data);
    const spec=idl.instructions.find(s=>s.discriminator.every((b,n)=>bytes[n]===b));
    if(!spec)return [];
    const roles=Object.fromEntries(spec.accounts.map((a,n)=>[a.name,i.accounts[n]]));
    return [{name:spec.name,mint:roles.base_mint??roles.mint,user:roles.user,curve:roles.bonding_curve,quoteMint:roles.quote_mint??null}];
  });
  const createBuy=decoded.flatMap((c,index)=>{
    if(!signer||!["create","create_v2"].includes(c.name)||c.user!==LAUNCH_TARGET||BigInt(deltas[c.mint]??0)<=0n)return [];
    const b=decoded.slice(index+1).find(i=>i.name.startsWith("buy")&&i.mint===c.mint&&i.user===c.user&&i.curve===c.curve);
    return b?[{mint:c.mint,curve:c.curve,user:c.user,quoteMint:b.quoteMint,buyInstruction:b.name,tokenDeltaRaw:deltas[c.mint]}]:[];
  });
  const confirmed=confirmedLaunches(tx,signature,wsAtMs??data.auditAtMs);
  const wsReplay=launchSignals({signature,logs:tx.meta.logMessages},tx.slot,wsAtMs??data.auditAtMs);
  const tradeLogs=parseConfirmedPumpLogSignal(tx,LAUNCH_TARGET,signature).trades;
  const trades=parsePumpTrades(tx,LAUNCH_TARGET,signature);
  const sides=[...new Set(trades.map(t=>t.side))];
  const swapLog=tx.meta.logMessages?.some(l=>/Program log: Instruction: Swap/.test(l));
  const solDelta=walletIndex<0?null:tx.meta.postBalances[walletIndex]-tx.meta.preBalances[walletIndex];
  const otherBuy=signer&&swapLog&&solDelta<0&&Object.values(deltas).some(v=>BigInt(v)>0n);
  const classification=createBuy.length?"CREATE+BUY":sides.length===1?sides[0]:otherBuy?"BUY":"OTHER";
  return {...base,classification,signer,solDeltaLamports:solDelta,tokenDeltasRaw:deltas,
    programs:[...new Set(instructions.map(i=>i.programId))],topLevel:message.instructions.map(i=>i.parsed?.type??i.programId),
    createBuy,pumpInstructions:decoded,wsLaunchReplay:wsReplay.length,confirmedTradeEvents:tradeLogs.length,
    fallbackSides:sides,confirmedLaunches:confirmed.map(x=>({mint:x.mint,reason:x.unsupportedReason??null})),
    confirmedDecoderMatches:createBuy.length===confirmed.length&&createBuy.every(c=>confirmed.some(p=>p.mint===c.mint&&p.curve===c.curve)),
    reason:createBuy.length?confirmed[0]?.unsupportedReason??"confirmed_launch":otherBuy&&sides.length===0?"non_pump_swap":null};
}
const entries=Object.entries(data.ws).sort((a,b)=>a[1]-b[1]).map(([s,t])=>classify(s,t));
const backfillOnly=data.signatures.filter(s=>!(s.signature in data.ws)).map(s=>classify(s.signature,null));
const journal=data.journal.map(e=>({...e,time:Date.parse(e.at)})).sort((a,b)=>a.time-b.time);
const start=journal.filter(e=>e.event==="starting").at(-1)?.time??data.startMs;
const current=journal.filter(e=>e.time>=start&&e.time<=data.auditAtMs);
const channels=["primary","fallback"];
const targets=[...new Set(current.filter(e=>e.event==="subscribed").map(e=>e.sourceName))].sort();
const subscribed=Object.fromEntries(channels.map(c=>[c,new Set()]));
const coverage=Object.fromEntries(targets.map(t=>[t,{bothMs:0,partialMs:0,noneMs:0,primaryMs:0,fallbackMs:0}]));
let cursor=start;
function accrue(time) {
  const duration=Math.max(0,time-cursor);
  for(const name of targets) {
    const primary=subscribed.primary.has(name),fallback=subscribed.fallback.has(name);
    const row=coverage[name];
    row[primary&&fallback?"bothMs":primary||fallback?"partialMs":"noneMs"]+=duration;
    if(primary)row.primaryMs+=duration;
    if(fallback)row.fallbackMs+=duration;
  }
  cursor=time;
}
for(const e of current) {
  if(!channels.includes(e.websocketSource)||!["subscribed","websocket_closed","subscribing"].includes(e.event))continue;
  accrue(e.time);
  if(e.event==="subscribed")subscribed[e.websocketSource].add(e.sourceName);
  else subscribed[e.websocketSource].clear();
}
accrue(data.auditAtMs);
const q=values=>{
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  return {n:a.length,...Object.fromEntries([50,95,99].map(p=>["p"+p,a[Math.ceil(a.length*p/100)-1]??null]))};
};
const recovery=Object.fromEntries(channels.map(c=>{
  const closes=current.filter(e=>e.event==="websocket_closed"&&e.websocketSource===c);
  const restored=targets.flatMap(name=>closes.flatMap((close,index)=>{
    const ack=current.find(e=>e.event==="subscribed"&&e.websocketSource===c&&e.sourceName===name&&e.time>=close.time&&e.time<(closes[index+1]?.time??Infinity));
    return ack?[ack.time-close.time]:[];
  }));
  const pongs=current.filter(e=>e.event==="websocket_heartbeat"&&e.websocketSource===c);
  return [c,{closeCodes:counts(closes.map(x=>x.code??"unknown")),reconnects:closes.length,
    reconnectsPerHour:closes.length/((data.auditAtMs-start)/3600000),recoveryMs:q(restored),
    pongRttMs:q(pongs.map(x=>x.rttMs)),timeouts:current.filter(e=>e.event==="websocket_heartbeat_timeout"&&e.websocketSource===c).length}];
}));
const result={auditAt:new Date(data.auditAtMs).toISOString(),epochStartedAt:new Date(data.startMs).toISOString(),
  backfill:{endpointHost:data.endpointHost,fallbackUsed:data.fallbackUsed,sameHttpHost:data.sameHttpHost,
    boundaryCovered:data.pageCoveredBoundary,pageRows:data.pageRows,requests:data.rpcRequests,errors:data.errors,
    listed:catalog.size,wsMissingFromBackfill:entries.filter(e=>!e.confirmedBackfill).map(e=>e.signature),
    successfulBackfillOnly:backfillOnly.filter(e=>e.classification!=="FAILED").map(e=>e.signature)},
  classes:counts(entries.map(e=>e.classification)),entries,backfillOnly,
  websocket:{from:new Date(start).toISOString(),durationMs:data.auditAtMs-start,coverage,recovery},
  fast:{beforeMs:q(journal.filter(e=>e.event==="fast_signal_dispatched"&&e.time<start).map(e=>e.signalToResultMs)),
    afterMs:q(current.filter(e=>e.event==="fast_signal_dispatched").map(e=>e.signalToResultMs)),
    afterVerificationErrors:current.filter(e=>["fast_verification_error","fast_signal_mismatch"].includes(e.event)).length}};
fs.writeFileSync(output,JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({...result,entries:undefined,backfillOnly:undefined},null,2));
