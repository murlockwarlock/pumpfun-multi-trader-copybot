import fs from "node:fs";
import {setTimeout as wait} from "node:timers/promises";
import {auditRun} from "./next-copy-audit.mjs";
import {reconcile} from "./next-copy-reconcile.mjs";
import path from "node:path";
import { breakEven, runInput } from "./next-copy-economics.mjs";

const args=process.argv.slice(2);
const shouldWait=args.includes("--wait");
const checkChain=args.includes("--reconcile")||shouldWait;
const [manifestFile,out,...journals]=args.filter(a=>!a.startsWith("--"));
if (!manifestFile||!out||!journals.length) throw Error("Usage: next-copy-window.mjs MANIFEST OUTPUT_PREFIX JOURNAL... [--reconcile | --wait]");
const manifest=JSON.parse(fs.readFileSync(manifestFile,"utf8"));
const start=Date.parse(manifest.start), end=Date.parse(manifest.end);
if (!Number.isFinite(start)||!Number.isFinite(end)||end<=start) throw Error("Invalid experiment window");
const expectedStop=Date.parse(manifest.observerExpectedStop);
const reportAt=Math.max(end+90000,Number.isFinite(expectedStop)?expectedStop+20000:0);
if (shouldWait && Date.now()<reportAt) await wait(reportAt-Date.now());
const cutoff=Math.min(Date.now()-(checkChain&&!shouldWait&&Date.now()<end?90000:0),end);
const finalityEnd=cutoff===end?Math.min(Date.now(),end+90000):cutoff;
const rows=new Map(), malformed={};
for (const file of journals) {
  const contents=fs.readFileSync(file,"utf8");
  const lines=contents.split(/\r?\n/);
  // A concurrently appended partial line has not become a journal record.
  if (!contents.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (!line) continue;
    try {
      const row=JSON.parse(line);
      if (!row.run||!Number.isFinite(row.at)) throw Error("Malformed record");
      if (!rows.has(row.run)) rows.set(row.run,[]);
      rows.get(row.run).push(row);
    } catch { malformed[file]=(malformed[file]??0)+1; }
  }
}
const runs={};
const seen=new Map(manifest.wallets.map(w=>[w,new Map()]));
const buySignals=new Map(manifest.wallets.map(w=>[w,new Set()]));
const fmt=t=>new Intl.DateTimeFormat("ru-RU",{timeZone:"Asia/Qyzylorda",dateStyle:"short",timeStyle:"medium"}).format(t);
const fmtSol=v=>v===null?"UNKNOWN":(Number(v)/1e9).toFixed(9);
const duration=v=>(v/1000).toFixed(1)+" с";
for (const [id,all] of rows) {
  const list=all;
  list.sort((a,b)=>a.at-b.at);
  const stopped=list.findIndex(r=>r.type==="STOP");
  const afterStop=stopped<0?0:list.length-stopped-1;
  if (afterStop) list.length=stopped+1;
  const init=list.find(r=>r.type==="START");
  if (!init||init.at>cutoff||!manifest.runs.includes(id)) continue;
  const runStart=Math.max(start,init.at);
  // Truncate old runs at their last record. Wall-clock coverage is computed
  // separately so sequential/parallel partial runs do not hide gaps.
  const last=list.filter(r=>r.at<=cutoff).at(-1);
  if (!last||last.at<start) continue;
  const data=auditRun(list,{start:runStart,end:cutoff,finalityEnd,wallets:init.wallets,
    exitLimitSeconds:init.holdLimitSeconds});
  const health=list.filter(r=>r.type==="HEALTH"&&r.at<=cutoff).at(-1);
  runs[id]={startedAt:init.at,inputLamports:runInput(init).toString(),lastAt:last.at,lastHealthAt:health?.at??null,rpc:health?.rpc??null,
    stopAt:stopped<0?null:list[stopped].at,ignoredAfterStop:afterStop,
    verificationRpc:health?.verification??null,wallets:data};
  for (const r of list) if (r.type==="SIGNAL"&&r.at>=start&&r.at<=cutoff) {
    seen.get(r.wallet)?.set(r.signature,r.slot);
    if (r.provisionalSides?.includes("BUY")) buySignals.get(r.wallet)?.add(r.signature);
  }
  for (const r of list) if (r.at>=start&&r.at<=cutoff&&
    (r.type==="ELIGIBLE"&&r.side==="BUY"||r.type==="INELIGIBLE"&&r.trades?.some(t=>t.side==="BUY"))) {
    buySignals.get(r.wallet)?.add(r.signature);
  }
}
const independent=checkChain?await reconcile({wallets:manifest.wallets,seen,start,end:cutoff,
  endpoint:process.env.COPY_BACKFILL_RPC??"https://solana-rpc.publicnode.com"}):null;
if (independent&&manifest.priorAudit) {
  const prior=JSON.parse(fs.readFileSync(path.resolve(path.dirname(manifestFile),manifest.priorAudit),"utf8"));
  if (prior.start===start&&prior.cutoff<=cutoff) for (const wallet of manifest.wallets) {
    const current=independent[wallet],previous=prior.independent?.[wallet];
    const existing=new Set(current.knownMissing.map(r=>r.signature));
    for (const row of previous?.knownMissing??[]) {
      if (!existing.has(row.signature)&&!seen.get(wallet).has(row.signature)) current.knownMissing.push(row);
    }
    if (current.knownMissing.length) current.status="INVALID";
  }
}
const lines=["# Итоговое окно prospective shadow","",
  "Окно по Кызылорде "+fmt(start)+" – "+fmt(end)+". Срез "+fmt(cutoff)+". "+
  (cutoff<end?"IN PROGRESS.":"Экспериментальное окно завершено. Финальность источников учитывается до "+fmt(finalityEnd)+
    ". Котировки с timestamp после границы исключены."),"",
  "Влияние потери rent приведено отдельным net. Не менее 50 валидных пар на основном горизонте и достаточное покрытие нужны для оценки. "+
  "Независимая сверка использует finalized историю, без восстановления котировок. [Solana RPC](https://solana.com/docs/rpc/http/getsignaturesforaddress)",""];
const coverageByWallet={};
const intro=[...lines];
const walletReports={};
for (const wallet of manifest.wallets) {
  const section=lines.length;
  const spans=Object.values(runs).flatMap(r=>r.wallets[wallet]?.spans??[]).sort((a,b)=>a.from-b.from);
  const gaps=[];
  let covered=0,cursor=start;
  for (const {from,to} of spans) {
    if (from>cursor) gaps.push({from:cursor,to:from});
    covered+=Math.max(0,to-Math.max(from,cursor));
    cursor=Math.max(cursor,to);
  }
  if (cursor<cutoff) gaps.push({from:cursor,to:cutoff});
  for (const gap of gaps) gap.type="DATA_GAP";
  const chain=independent?.[wallet];
  const status=chain?.status==="INVALID"?"INVALID":chain?.status==="VERIFIED"&&!Object.keys(malformed).length?"VERIFIED":"UNKNOWN";
  coverageByWallet[wallet]={coveredMs:covered,unprovenMs:cutoff-start-covered,gaps,status};
  if (chain) for (const tx of chain.knownMissing) {
    tx.blockTimeOverlapsGap=gaps.some(g=>tx.blockTime*1000>=g.from-3000 && tx.blockTime*1000<=g.to+3000);
  }
  const missed=chain?.knownMissing??[];
  const minimumSignals=new Set([...seen.get(wallet).keys(),...missed.map(t=>t.signature)]).size;
  const minimumBuy=new Set([...buySignals.get(wallet),...missed.filter(t=>t.trades.some(x=>x.side==="BUY")).map(t=>t.signature)]).size;
  coverageByWallet[wallet].minimumSignals=minimumSignals;
  coverageByWallet[wallet].minimumBuy=minimumBuy;
  lines.push("## "+(manifest.labels[wallet]??wallet),"",
    "`"+wallet+"`","",
    "Наблюдаемое WS-покрытие "+duration(covered)+", неподтверждённые интервалы "+duration(cutoff-start-covered)+
    " ("+gaps.length+"). Независимая сверка **"+status+"**."+
    (chain?" История "+chain.listed+" сигнатур, "+chain.knownMissing.length+" доказанных пропусков, "+
      chain.unclassified+" непроверенных тел, "+chain.slotMismatches.length+" расхождений слота, "+
      chain.rpcErrors+" RPC-ошибок. Нижняя граница "+(chain.lowerBoundary?"достигнута.":"не достигнута.")+
      " Из пропущенных "+chain.knownMissing.filter(x=>x.blockTimeOverlapsGap).length+
      " пересекают интервалы неполного покрытия по приближённому blockTime.":""),"",
    "Знаменатель источников "+(status==="VERIFIED"?String(minimumSignals):"UNKNOWN, подтверждённая нижняя граница "+minimumSignals)+
    ". BUY, различимые по журналу или сверке, минимум "+minimumBuy+".","");
  for (const [id,r] of Object.entries(runs)) {
    const w=r.wallets[wallet];
    if (!w) continue;
    const input=BigInt(r.inputLamports),threshold=breakEven(input);
    lines.push("### Run `"+id+"`","",
      "Размер "+fmtSol(input)+" SOL. Для безубыточности нужно "+fmtSol(threshold.minOut)+
      " SOL после SELL haircut или "+fmtSol(threshold.sellQuote)+" SOL до него (после торговой комиссии SDK).","",
      "Начат "+fmt(r.startedAt)+", последняя запись "+fmt(r.lastAt)+". Зафиксировано "+
      w.signals+" сигналов, "+w.observedBuy+" BUY по логам или подтверждённым телам, "+w.eligibleBuy+
      " допустимых BUY, "+w.timelyBuy+" своевременных котировок"+
      (w.eligibleBuy?" ("+(100*w.timelyBuy/w.eligibleBuy).toFixed(1)+"%)":"")+
      ", "+w.unresolvedSignals+" неразобранных сигналов.","",
      ...(cutoff===end?[(r.stopAt!==null?"STOP в "+fmt(r.stopAt)+", записей после STOP "+r.ignoredAfterStop+".":"В доступном журнале STOP отсутствует."),""]:[]),
      "Причины по фазам `"+JSON.stringify(w.causes)+"`. Лог старого процесса объединял некоторые причины. "+
      "Зафиксировано разрывов WS "+w.reconnects.length+", восстановлений "+w.reconnects.filter(x=>x.to!==null).length+". "+
      "RPC-счётчики всего run — "+
      (r.rpc?r.rpc.requests+" аккаунтных запросов, "+r.rpc.errors+" ошибок, "+r.rpc.rateLimited+" HTTP 429, "+r.rpc.budgetRejected+" локальных отказов.":"нет heartbeat.")+
      (r.verificationRpc?" Проверки: "+JSON.stringify(r.verificationRpc)+".":" Для проверок доступны только журналированные отказы."),"",
      ...(w.rentRangeLamports?["Оценка rent по BUY "+fmtSol(w.rentRangeLamports[0])+"–"+
        fmtSol(w.rentRangeLamports[1])+" SOL. При невозврате максимального наблюдавшегося rent для безубыточности "+
        "нужно получить "+fmtSol(breakEven(input,BigInt(w.rentRangeLamports[1])).minOut)+" SOL после SELL haircut.",""]:[]),
      "| Выход | Пары | UNKNOWN | Из них не наступил срок | Из них финальность UNKNOWN | Net, SOL | Без лучшей | Без возврата rent |",
      "|---|---:|---:|---:|---:|---:|---:|---:|",
      ...Object.entries(w.horizons).map(([kind,h])=>"| "+kind+" | "+h.pairs+" | "+h.unknown+" | "+h.pendingAtCutoff+
        " | "+h.finalityUnknown+" | "+
        fmtSol(h.netLamports)+" | "+fmtSol(h.withoutBestLamports)+" | "+fmtSol(h.netWithoutRentRecoveryLamports)+" |"),"");
    const main=w.horizons["30s"];
    let decision="UNPROVEN";
    if (cutoff===end&&status==="VERIFIED"&&w.unresolvedSignals===0&&
        main.pairs>=50&&main.pairs/w.eligibleBuy>=0.7) {
      decision=BigInt(main.netLamports)>0n&&BigInt(main.withoutBestLamports)>0n?"RESEARCH-GO":"NO-GO";
    }
    lines.push("Экономика **"+decision+"**.","");
  }
  if (cutoff===end) {
    const next=wallet===manifest.wallets[1]?"исключить адрес из следующего отбора и оставить только как контроль высокой частоты при диагностике доставки":
      "повторить наблюдение с раздельными резервами бюджета, если следующему решению нужны подтверждённые пары";
    lines.push("При UNPROVEN следующий шаг — "+next+".","");
  }
  walletReports[wallet]=[...intro,...lines.slice(section)].join("\n")+"\n";
}
const json={start,end,cutoff,finalityEnd,complete:cutoff>=end,runs,coverage:coverageByWallet,independent,malformed};
const files=[[".json",JSON.stringify(json,null,2)+"\n"],[".md",lines.join("\n")+"\n"],
  ...Object.entries(walletReports).map(([w,report])=>["-"+w.slice(0,6)+".md",report])];
for (const [suffix,value] of files) {
  fs.writeFileSync(out+suffix+".tmp",value);
  fs.renameSync(out+suffix+".tmp",out+suffix);
}
