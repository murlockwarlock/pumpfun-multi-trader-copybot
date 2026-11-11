import { observationReason } from "./next-copy-reasons.mjs";

const EXITS=["10s","30s","120s","target"];
const CONFIRMED_HEARTBEAT_MAX_MS=45000;

export function coverage(rows,wallet,start,end) {
  const spans=[];
  let opened=null,lastProof=null,gen=null;
  function close() {
    if (opened!==null) {
      const from=Math.max(start,opened), to=Math.min(end,lastProof);
      if (to>from) spans.push({from,to,gen});
    }
    opened=null;
    lastProof=null;
    gen=null;
  }
  for (const r of rows) {
    if (r.at>end) break;
    if (r.type==="SUBSCRIBED"&&r.wallet===wallet) {
      close();
      opened=lastProof=r.at;
      gen=r.gen;
    } else if (r.type==="WS_GAP"&&r.gen===gen || r.type==="STOP") {
      // A close message can be delayed by dead-connection detection.
      close();
    } else if (opened!==null && ((r.type==="HEALTH" &&
      (r.subscribedWallets?.includes(wallet) ?? r.subscriptions===rows[0]?.wallets?.length) &&
      (r.gen===undefined || r.gen===gen)) || (r.type==="SIGNAL"&&r.wallet===wallet))) {
      const proof=r.type==="HEALTH" && Number.isFinite(r.lastPong) ? Math.min(r.at,r.lastPong) : r.at;
      if (proof<opened) continue;
      if (proof-lastProof>CONFIRMED_HEARTBEAT_MAX_MS) {
        const previousGen=gen;
        close();
        // A heartbeat after a journal hole proves only this new interval.
        opened=proof;
        gen=r.gen??previousGen;
      }
      lastProof=Math.max(lastProof,proof);
    }
  }
  close();
  const unavailable=[];
  let cursor=start;
  for (const span of spans) {
    if (span.from>cursor) unavailable.push({from:cursor,to:span.from});
    cursor=Math.max(cursor,span.to);
  }
  if (cursor<end) unavailable.push({from:cursor,to:end});
  const reconnects=[];
  let outage=null;
  for (const r of rows) {
    if (r.at>end) break;
    if (r.at<start) continue;
    if (r.type==="WS_GAP") outage??={from:r.at,to:null,code:r.code};
    if (outage&&r.type==="SUBSCRIBED"&&r.wallet===wallet) {
      reconnects.push({...outage,to:r.at});
      outage=null;
    }
  }
  if (outage) reconnects.push(outage);
  return {spans,unavailable,reconnects,coveredMs:spans.reduce((n,s)=>n+s.to-s.from,0),
    unprovenMs:unavailable.reduce((n,s)=>n+s.to-s.from,0)};
}

function count(map,key) { map[key]=(map[key]??0)+1; }

export function auditRun(rows,{start,end,wallets}) {
  const out={};
  const legacy=rows.find(r=>r.type==="START")?.budgetVersion!==2;
  for (const wallet of wallets) {
    const own=rows.filter(r=>r.wallet===wallet&&r.at>=start&&r.at<=end);
    const counts={BUY:{},SOURCE:{},SELL:{}};
    const signal=new Set(), knownBuy=new Set(), eligible=new Set(), buys=new Map(), resolved=new Set();
    const finalized=new Map(rows.filter(r=>r.type==="FINALIZED"&&r.at<=end).map(r=>[r.signature,r.slot]));
    for (const r of own) {
      if (r.type==="SIGNAL") {
        signal.add(r.signature);
        if (r.provisionalSides?.includes("BUY")) knownBuy.add(r.signature);
      }
      if (r.type==="ELIGIBLE" || r.type==="INELIGIBLE" || r.type==="TARGET_SELL_SIGNAL") resolved.add(r.signature);
      if (r.type==="INELIGIBLE" && r.trades?.some(t=>t.side==="BUY")) {
        knownBuy.add(r.signature);
        count(counts.BUY,r.trades.some(t=>t.side==="BUY"&&
          (t.quote==="nonSOL" || !["pump-curve","pumpswap"].includes(t.venue)))?"MARKET_OR_LIQUIDITY":"SOURCE_INELIGIBLE");
      }
      if (r.type==="ELIGIBLE" && r.side==="BUY") {
        knownBuy.add(r.signature);
        eligible.add(r.signature);
      }
      if (r.type==="BUY_QUOTE" && eligible.has(r.signature)) buys.set(r.signature,r);
      if (r.type==="UNKNOWN" && counts[r.phase]) {
        const category=observationReason(r.reason);
        count(counts[r.phase],legacy&&category==="OWN_RPC_BUDGET"?"OWN_BUDGET_OR_COOLDOWN":category);
      }
    }
    const horizons={};
    for (const kind of EXITS) {
      const pairs=new Map();
      let finalityUnknown=0;
      for (const r of own) {
        if (r.type!=="SELL_QUOTE"||r.kind!==kind||pairs.has(r.signature)) continue;
        const b=buys.get(r.signature);
        if (!b||b.quantityRaw!==r.quantityRaw) continue;
        if (finalized.get(b.signature)!==b.slot ||
            (kind==="target"&&(!r.exitSignature||finalized.get(r.exitSignature)!==r.exitSlot))) {
          finalityUnknown++;
          continue;
        }
        pairs.set(r.signature,r);
      }
      const exits=[...pairs.values()];
      const nets=exits.map(r=>BigInt(r.netLamports));
      const total=nets.reduce((a,b)=>a+b,0n);
      const best=nets.reduce((a,b)=>a===null||b>a?b:a,null);
      const rent=exits.map(r=>r.netIfRentNotRecoveredLamports);
      horizons[kind]={pairs:pairs.size,unknown:eligible.size-pairs.size,finalityUnknown,
        netLamports:pairs.size?String(total):null,withoutBestLamports:pairs.size>1?String(total-best):null,
        netWithoutRentRecoveryLamports:rent.length&&rent.every(v=>v!==undefined)?String(rent.reduce((a,b)=>a+BigInt(b),0n)):null};
    }
    const span=coverage(rows,wallet,start,end);
    const rents=[...buys.values()].map(r=>Math.round(r.quote?.rentSol*1e9)).filter(Number.isSafeInteger);
    out[wallet]={...span,signals:signal.size,observedBuy:knownBuy.size,
      unresolvedSignals:[...signal].filter(s=>!resolved.has(s)).length,
      eligibleBuy:eligible.size,timelyBuy:buys.size,causes:counts,horizons,
      rentRangeLamports:rents.length?[Math.min(...rents),Math.max(...rents)]:null};
  }
  return out;
}
