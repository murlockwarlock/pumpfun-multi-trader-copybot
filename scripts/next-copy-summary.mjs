import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function summarize(rows) {
  const result = {};
  const runs = new Map();
  const walletData = wallet => result[wallet] ??= {
    signals:0,eligibleBuy:0,eligibleSell:0,buyQuotes:0,buyRate:null,ineligible:0,unknown:{},exits:{}
  };
  for (const r of rows) {
    if (!runs.has(r.run)) runs.set(r.run,{buys:new Map(),finalized:new Map(),exits:[]});
    const run = runs.get(r.run);
    if (r.type === "START") r.wallets.forEach(walletData);
    if (r.type === "FINALIZED") run.finalized.set(r.signature,r.slot);
    if (!r.wallet) continue;
    const w = walletData(r.wallet);
    const key = r.wallet+":"+r.signature;
    if (r.type === "SIGNAL") w.signals++;
    if (r.type === "INELIGIBLE") w.ineligible++;
    if (r.type === "ELIGIBLE") w[r.side==="BUY"?"eligibleBuy":"eligibleSell"]++;
    if (r.type === "BUY_QUOTE") {w.buyQuotes++;run.buys.set(key,r);}
    if (r.type === "SELL_QUOTE") run.exits.push(r);
    if (r.type === "UNKNOWN") w.unknown[r.phase] = (w.unknown[r.phase]??0)+1;
  }
  for (const run of runs.values()) {
    const used = new Set();
    for (const sell of run.exits) {
      const key = sell.wallet+":"+sell.signature;
      const id = key+":"+sell.kind;
      if (used.has(id)) continue;
      const buy = run.buys.get(key);
      if (!buy || buy.quantityRaw !== sell.quantityRaw) continue;
      used.add(id);
      const exits = walletData(sell.wallet).exits;
      const tally = exits[sell.kind] ??= {quoted:0,finalityUnknown:0,nets:[]};
      tally.quoted++;
      if (run.finalized.get(buy.signature)!==buy.slot ||
          (sell.exitSignature && run.finalized.get(sell.exitSignature)!==sell.exitSlot)) {
        tally.finalityUnknown++;
        continue;
      }
      tally.nets.push(BigInt(sell.netLamports));
    }
  }
  for (const w of Object.values(result)) {
    if (w.eligibleBuy) w.buyRate=w.buyQuotes/w.eligibleBuy;
    for (const kind of ["10s","30s","120s","target"]) {
      const t = w.exits[kind] ??= {quoted:0,finalityUnknown:0,nets:[]};
      const total = t.nets.reduce((s,n)=>s+n,0n);
      const best = t.nets.reduce((best,n)=>best===null||n>best?n:best,null);
      t.pairs=t.nets.length;
      t.unknown=w.eligibleBuy-t.pairs;
      t.netLamports=t.pairs?total.toString():null;
      t.withoutBestLamports=t.pairs>1?(total-best).toString():null;
      delete t.nets;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const rows = process.argv.slice(2).flatMap(file=>fs.readFileSync(file,"utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
  console.log(JSON.stringify(summarize(rows),null,2));
}
