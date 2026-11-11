import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { inspectTrade, ownedBalances } from "./copy-candidate-trade.mjs";

const [directory, seedFile, retryStage, journal] = process.argv.slice(2);
if (!directory || !seedFile) throw Error("Usage: copy-candidate-screen.mjs CACHE_DIR PREVIOUS_CAPTURE [screen LIVE_JOURNAL | deep]");
fs.mkdirSync(directory, { recursive: true });
const endpoint = process.env.COPY_HISTORY_RPC ?? "https://api.mainnet-beta.solana.com";
const cache = file => directory + "/" + file + ".json";
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v));
const prior = read(seedFile);
const now = retryStage==="deep" ? read(cache("screen")).now : Math.floor(Date.now() / 1000);
let calls = 0, errors = 0;
const limit = retryStage === "deep" ? 270 : 355;
async function rpc(method, params) {
  if (calls >= limit) return undefined;
  for (let attempt = 0; attempt < 2 && calls < limit; attempt++) {
    calls++;
    await delay(415);
    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method, params }), signal: AbortSignal.timeout(4500)
      });
      const json = await res.json();
      if (!res.ok || json.error) throw Error("RPC error");
      return json.result;
    } catch {
      errors++;
      if (attempt === 0) await delay(2200);
    }
  }
}
const list = (address, limit, before) => rpc("getSignaturesForAddress", [address, {limit, before, commitment:"confirmed"}]);
async function body(sig) {
  const file = cache(sig);
  if (fs.existsSync(file)) return read(file);
  const tx = await rpc("getTransaction", [sig, {encoding:"jsonParsed", commitment:"confirmed", maxSupportedTransactionVersion:0}]);
  if (tx) write(file, tx);
  return tx;
}
const excluded = new Set(Object.values(prior.history).map(h => h.wallet));
let seeds = {};
if (retryStage === "deep") seeds = read(cache("screen")).seeds;
else {
  const h = prior.history.kaaox;
  const loggedPools = journal ? fs.readFileSync(journal,"utf8").trim().split(/\r?\n/).map(JSON.parse).filter(t=>t.sourceName==="kaaox" && t.pool).reverse().map(t=>t.pool) : [];
  const addresses = [...new Set([...loggedPools, ...Object.entries(h.txs).flatMap(([sig,tx]) =>
    inspectTrade(tx,h.wallet,sig).filter(t => t.eligible).map(t => t.pool ?? t.mint))])];
  // Recent primary venue fills give verifiable leads without relying on profile labels.
  for (const address of addresses.slice(0, 5)) {
    if (Object.keys(seeds).length >= 15) break;
    const page = await list(address, 14) ?? [];
    for (const s of page) {
      if (Object.keys(seeds).length >= 15) break;
      if (s.err) continue;
      const tx = await body(s.signature);
      for (const k of tx?.transaction.message.accountKeys ?? []) {
        if (!k.signer || excluded.has(k.pubkey) || seeds[k.pubkey]) continue;
        const trade = inspectTrade(tx,k.pubkey,s.signature).find(t => t.authenticated);
        if (trade) seeds[k.pubkey] = trade;
        if (Object.keys(seeds).length >= 15) break;
      }
    }
  }
  write(cache("seeds"),seeds);
}
const history = {};
const addresses = retryStage === "deep" ? read(cache("screen")).rank.slice(0,2).map(x=>x.wallet) : Object.keys(seeds);
const from = now - (retryStage === "deep" ? 7 * 24 : 72) * 3600;
for (const wallet of addresses) {
  const deep = retryStage==="deep";
  const pageSize = deep ? 1000 : 16;
  const listed = [];
  let coverage=false;
  for (let i=0; i<(deep?8:1); i++) {
    const batch=await list(wallet,pageSize,listed.at(-1)?.signature);
    if (!batch) break;
    listed.push(...batch);
    if (batch.length<pageSize || (batch.at(-1)?.blockTime??Infinity)<from) {
      coverage=true;
      break;
    }
  }
  const inWindow = listed.filter(r => !r.blockTime || (r.blockTime>=from && r.blockTime<=now));
  // Sample contiguous sections across the seven-day catalog. A skipped body
  // resets inventory, so separated sections cannot fabricate a cost basis.
  const sampled = deep && inWindow.length>120;
  const selected = sampled ? new Set(Array.from({length:8},(_,i)=>
    Math.floor((inWindow.length-15)*i/7)).flatMap(start=>inWindow.slice(start,start+15).map(r=>r.signature))) : null;
  const page = selected ? inWindow.filter(r=>selected.has(r.signature)) : inWindow;
  const txs = {};
  for (const s of page) if (!s.err) {
    const tx = await body(s.signature);
    if (tx) txs[s.signature]=tx;
  }
  const rows = [];
  const bought = new Map();
  const holds = [];
  let pnl = 0, known = 0, unknownBasis = 0, wins = 0, losses = 0;
  for (const s of [...inWindow].reverse()) {
    const tx = txs[s.signature];
    if (!tx) {if (!s.err) bought.clear();continue;}
    const trades = inspectTrade(tx,wallet,s.signature);
    rows.push(...trades);
    for (const {mint} of ownedBalances(tx,wallet)) {
      const t = trades.find(t=>t.mint===mint && t.eligible);
      const b = bought.get(mint);
      bought.delete(mint);
      if (!t) continue;
      if (t.side === "BUY") {
        if (t.pre === 0n) bought.set(mint,t);
        continue;
      }
      if (b && b.post === t.pre && Number.isFinite(b.blockTime) && Number.isFinite(t.blockTime)) {
        holds.push(t.blockTime-b.blockTime);
      }
      if (b && b.post === t.pre && t.post === 0n) {
        const fee = row => txs[row.signature].transaction.message.accountKeys[0]?.pubkey===wallet
          ? txs[row.signature].meta.fee/1e9 : 0;
        const value=t.solAmount-b.solAmount-fee(t)-fee(b);
        pnl+=value;
        known++;
        if (value>0) wins++;
        if (value<0) losses++;
      } else unknownBasis++;
    }
  }
  holds.sort((a,b)=>a-b);
  const missing=page.filter(r=>!r.err&&!txs[r.signature]).length;
  const buy=rows.filter(t=>t.side==="BUY"), sell=rows.filter(t=>t.side==="SELL");
  const score=Math.min(20,buy.filter(t=>t.eligible).length*3)+Math.min(20,sell.filter(t=>t.eligible).length*3)
    +Math.min(20,holds.filter(s=>s>=10).length*5)+(coverage&&!missing?20:0)+(known>0&&pnl>0?10:0);
  history[wallet]={wallet,score,listed:inWindow.length,sampled:page.length,fetched:Object.keys(txs).length,
    failed:inWindow.filter(r=>r.err).length,sampledOldest:page.at(-1)?.blockTime??null,
    oldest:listed.at(-1)?.blockTime??null,coverage,missing,buy:buy.length,sell:sell.length,
    eligibleBuy:buy.filter(t=>t.eligible).length,eligibleSell:sell.filter(t=>t.eligible).length,
    unsupported:rows.filter(t=>!t.eligible&&t.quote==="unknown").length,nonSol:rows.filter(t=>t.quote==="nonSOL").length,
    venues:rows.reduce((counts,t)=>(counts[t.venue]=(counts[t.venue]??0)+1,counts),{}),
    launches:rows.filter(t=>t.launch).length,holdP10:holds[Math.ceil(holds.length*.1)-1]??null,holds:holds.length,
    holdP50:holds[Math.ceil(holds.length*.5)-1]??null,
    conditionalPnl:known?pnl:null,known,unknownBasis,wins,losses,
    examples:["BUY","SELL"].flatMap(side=>rows.filter(t=>t.eligible&&t.side===side).slice(-2).map(t=>({
      signature:t.signature,slot:t.slot,side,mint:t.mint,venue:t.venue,liquidityLamports:t.liquidityLamports
    })))};
}
const rank=Object.values(history).sort((a,b)=>b.score-a.score);
write(cache(retryStage==="deep"?"deep":"screen"),{from,now,calls,errors,seeds,rank});
console.log(JSON.stringify({count:rank.length,calls,errors,rank:rank.map(r=>[r.wallet,r.score,r.buy,r.sell])}));
