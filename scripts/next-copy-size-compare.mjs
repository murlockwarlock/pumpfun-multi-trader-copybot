import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {auditRun} from "./next-copy-audit.mjs";
import {breakEven,runInput} from "./next-copy-economics.mjs";
import {verifySuite} from "./next-copy-size-study.mjs";

const HORIZONS=["10s","30s","120s","target"];
const MAX_TIME_SPREAD_MS=750;
const MAX_SLOT_SPREAD=6;

function tight(rows, keys, limit) {
  const values=rows.flatMap(r=>keys.map(k=>r[k]));
  return values.every(Number.isFinite)&&Math.max(...values)-Math.min(...values)<=limit;
}

export function comparable(rows) {
  const a=rows[0];
  return rows.length>1&&rows.every(r=>r&&r.signature===a.signature&&r.sourceSlot===a.sourceSlot&&
    r.exitSignature===a.exitSignature&&r.exitSlot===a.exitSlot&&r.buyVenue===a.buyVenue&&r.sellVenue===a.sellVenue)&&
    tight(rows,["dueAt"],MAX_TIME_SPREAD_MS)&&tight(rows,["buyStartedAt"],MAX_TIME_SPREAD_MS)&&
    tight(rows,["sellStartedAt"],MAX_TIME_SPREAD_MS)&&tight(rows,["buyAt"],MAX_TIME_SPREAD_MS)&&
    tight(rows,["sellAt"],MAX_TIME_SPREAD_MS)&&tight(rows,["buySlot","buyMaxSlot"],MAX_SLOT_SPREAD)&&
    tight(rows,["sellSlot","sellMaxSlot"],MAX_SLOT_SPREAD);
}

function percentile(values,p) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted[Math.ceil(sorted.length*p)-1]??null;
}

export function economics(pairs,input,rate) {
  const ordered=[...pairs].sort((a,b)=>a.sellAt-b.sellAt||a.signature.localeCompare(b.signature));
  let sum=0n,peak=0n,drawdown=0n,best=null,wins=0,rentNet=0n,rentKnown=true;
  for (const row of ordered) {
    const n=BigInt(row.netLamports);
    sum+=n;
    if (sum>peak) peak=sum;
    if (peak-sum>drawdown) drawdown=peak-sum;
    if (best===null||n>best) best=n;
    if (n>0n) wins++;
    if (row.netWithoutRentRecoveryLamports==null) rentKnown=false;
    else rentNet+=BigInt(row.netWithoutRentRecoveryLamports);
  }
  const count=pairs.length;
  const sol=n=>Number(n)/1e9;
  const minReserve=side=>{
    const values=pairs.map(r=>r[side]?.quoteRaw??r[side]?.realSolRaw).filter(v=>v!=null).map(Number);
    return values.length?Math.min(...values)/1e9:null;
  };
  const maxRent=pairs.reduce((n,r)=>Math.max(n,r.rentLamports??0),0);
  return {pairs:count,winRate:count?wins/count:null,netLamports:count?String(sum):null,netSol:count?sol(sum):null,
    netUsd:count?sol(sum)*Number(rate):null,roi:count?Number(sum)/Number(input*BigInt(count)):null,
    withoutBestLamports:count>1?String(sum-best):null,maxDrawdownLamports:count?String(drawdown):null,
    netWithoutRentRecoveryLamports:count&&rentKnown?String(rentNet):null,
    breakEvenSellQuoteWithMaxRentLamports:count&&maxRent?String(breakEven(input,BigInt(maxRent)).sellQuote):null,
    buyMinimumSolReserve:minReserve("buyReserves"),sellMinimumSolReserve:minReserve("sellReserves"),
    buyLatencyP95Ms:percentile(pairs.map(r=>r.buyLatencyMs),.95),
    sellLatencyP95Ms:percentile(pairs.map(r=>r.sellLatencyMs),.95),
    entryDriftP95Bps:percentile(pairs.map(r=>r.entryDriftBps),.95),
    buyImpactP95Bps:percentile(pairs.map(r=>r.buyImpactBps),.95),
    sellImpactP95Bps:percentile(pairs.map(r=>r.sellImpactBps),.95)};
}

export function compareStudy(suite,journals) {
  verifySuite(suite);
  const runs=suite.scenarios.map(s=>{
    const rows=journals[s.id]??[];
    if (!rows.length) return null;
    const init=rows[0];
    if (init.type!=="START"||rows.some(r=>r.run!==init.run)||rows.slice(1).some(r=>r.type==="START")||
        runInput(init)!==BigInt(s.inputLamports)||init.study?.scenario!==s.id||
        JSON.stringify(init.study.fx)!==JSON.stringify(suite.fx)||
        JSON.stringify(init.wallets)!==JSON.stringify(suite.wallets)) throw Error("Journal does not match scenario "+s.id);
    const stop=rows.findIndex(r=>r.type==="STOP");
    return stop<0?rows:rows.slice(0,stop+1);
  });
  const allStarted=runs.every(Boolean);
  const start=allStarted?Math.max(...runs.map(r=>r[0].at)):null;
  const end=allStarted?Math.min(...runs.map(r=>r.at(-1).at)):null;
  const wallets={};
  for (const wallet of suite.wallets) {
    const observed=new Set();
    const reports=runs.map(rows=>{
      if (!rows||start===null||end<=start) return null;
      for (const r of rows) if (r.wallet===wallet&&r.at>=start&&r.at<=end&&
          (r.type==="SIGNAL"&&r.provisionalSides?.includes("BUY")||
           r.type==="ELIGIBLE"&&r.side==="BUY"||r.type==="INELIGIBLE"&&r.trades?.some(t=>t.side==="BUY"))) {
        observed.add(r.signature);
      }
      return auditRun(rows,{start,end,wallets:[wallet],includePairs:true})[wallet];
    });
    const horizons={};
    for (const kind of HORIZONS) {
      const pairs=reports.map(r=>r?.horizons[kind].observations??[]);
      const bySig=pairs.map(p=>new Map(p.map(row=>[row.signature,row])));
      const matched=pairs[0].map(r=>bySig.map(m=>m.get(r.signature))).filter(group=>group.every(Boolean)&&comparable(group));
      horizons[kind]=suite.scenarios.map((s,i)=>{
        const input=BigInt(s.inputLamports),threshold=breakEven(input);
        return {...s,breakEvenMinOutLamports:String(threshold.minOut),breakEvenSellQuoteLamports:String(threshold.sellQuote),
          eligibleBuy:reports[i]?.eligibleBuy??null,timelyBuy:reports[i]?.timelyBuy??null,
          observedBuy:reports[i]?.observedBuy??null,
          missingSignalRate:reports[i]&&observed.size?1-reports[i].observedBuy/observed.size:null,
          unknownSources:reports[i]?.unresolvedSignals??null,causes:reports[i]?.causes??null,
          independent:economics(pairs[i],input,suite.fx.usdPerSol),
          matched:economics(matched.map(group=>group[i]),input,suite.fx.usdPerSol)};
      });
    }
    wallets[wallet]={observedBuyUnion:observed.size,coverage:"UNKNOWN",status:"UNPROVEN",horizons};
  }
  return {fx:suite.fx,start,end,allStarted,complete:runs.every(r=>r?.at(-1).type==="STOP"),
    maxTimeSpreadMs:MAX_TIME_SPREAD_MS,maxSlotSpread:MAX_SLOT_SPREAD,wallets};
}

function markdown(report) {
  const value=n=>n===null?"UNKNOWN":n.toFixed(6);
  const pct=n=>n===null?"UNKNOWN":(n*100).toFixed(2)+"%";
  const rows=["# Shadow copy по размерам","",
    "Курс "+report.fx.usdPerSol+" USD/SOL, время сделки "+report.fx.tradeAt+", снимок "+report.fx.observedAt+".",
    "Сопоставимые пары используют общий сигнал и все пять независимых котировок. Полнота всей истории требует отдельной сверки.",
    "Доля пропусков вычислена среди BUY-сигнатур, известных хотя бы одному наблюдателю.","",
    "| Трейдер | Сценарий | Размер SOL | Выход | Пар отдельно / сопоставимо | Win rate | Net SOL | Net USD | ROI | Без лучшей SOL | Просадка SOL | Без возврата rent SOL | Пропуски | Статус |",
    "|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
  for (const [w,x] of Object.entries(report.wallets)) for (const [h,entries] of Object.entries(x.horizons)) {
    for (const s of entries) {
      const m=s.matched;
      const sol=v=>v===null?"UNKNOWN":(Number(v)/1e9).toFixed(9);
      rows.push("| "+w+" | "+s.id+" | "+value(Number(s.inputLamports)/1e9)+" | "+h+" | "+s.independent.pairs+" / "+m.pairs+
        " | "+pct(m.winRate)+" | "+value(m.netSol)+" | "+value(m.netUsd)+" | "+pct(m.roi)+
        " | "+sol(m.withoutBestLamports)+" | "+sol(m.maxDrawdownLamports)+" | "+sol(m.netWithoutRentRecoveryLamports)+
        " | "+pct(s.missingSignalRate)+" | "+x.status+" |");
    }
  }
  return rows.join("\n")+"\n";
}

if (process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [file,output]=process.argv.slice(2);
  if (!file||!output) throw Error("Usage: next-copy-size-compare.mjs MANIFEST OUTPUT_PREFIX");
  const suite=JSON.parse(fs.readFileSync(file,"utf8"));
  verifySuite(suite);
  const journals=Object.fromEntries(suite.scenarios.map(s=>{
    const filePath=path.join(path.dirname(file),s.id+".jsonl");
    if (!fs.existsSync(filePath)) return [s.id,[]];
    const content=fs.readFileSync(filePath,"utf8");
    return [s.id,content.slice(0,content.lastIndexOf("\n")+1).split(/\r?\n/).filter(Boolean).map(JSON.parse)];
  }));
  const report=compareStudy(suite,journals);
  fs.writeFileSync(output+".json",JSON.stringify(report,null,2)+"\n");
  fs.writeFileSync(output+".md",markdown(report));
}
