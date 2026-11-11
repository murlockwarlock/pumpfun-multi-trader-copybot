import fs from "node:fs";
import {setTimeout as wait} from "node:timers/promises";
import {auditRun} from "./next-copy-audit.mjs";
import {reconcile} from "./next-copy-reconcile.mjs";

const args=process.argv.slice(2);
const shouldWait=args.includes("--wait");
const checkChain=args.includes("--reconcile")||shouldWait;
const [manifestFile,out,...journals]=args.filter(a=>!a.startsWith("--"));
if (!manifestFile||!out||!journals.length) throw Error("Usage: next-copy-window.mjs MANIFEST OUTPUT_PREFIX JOURNAL... [--reconcile | --wait]");
const manifest=JSON.parse(fs.readFileSync(manifestFile,"utf8"));
const start=Date.parse(manifest.start), end=Date.parse(manifest.end);
if (!Number.isFinite(start)||!Number.isFinite(end)||end<=start) throw Error("Invalid experiment window");
if (shouldWait && Date.now()<end+90000) await wait(end+90000-Date.now());
const cutoff=Math.min(Date.now()-(checkChain&&!shouldWait&&Date.now()<end?90000:0),end);
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
const fmt=t=>new Intl.DateTimeFormat("ru-RU",{timeZone:"Asia/Qyzylorda",dateStyle:"short",timeStyle:"medium"}).format(t);
const fmtSol=v=>v===null?"UNKNOWN":(Number(v)/1e9).toFixed(9);
const duration=v=>(v/1000).toFixed(1)+" с";
for (const [id,list] of rows) {
  list.sort((a,b)=>a.at-b.at);
  const init=list.find(r=>r.type==="START");
  if (!init||init.at>cutoff||!manifest.runs.includes(id)) continue;
  const runStart=Math.max(start,init.at);
  // Truncate old runs at their last record. Wall-clock coverage is computed
  // separately so sequential/parallel partial runs do not hide gaps.
  const last=list.filter(r=>r.at<=cutoff).at(-1);
  if (!last||last.at<start) continue;
  const data=auditRun(list,{start:runStart,end:cutoff,wallets:init.wallets});
  const health=list.filter(r=>r.type==="HEALTH"&&r.at<=cutoff).at(-1);
  runs[id]={startedAt:init.at,lastAt:last.at,lastHealthAt:health?.at??null,rpc:health?.rpc??null,
    verificationRpc:health?.verification??null,wallets:data};
  for (const r of list) if (r.type==="SIGNAL"&&r.at>=start&&r.at<=cutoff) {
    seen.get(r.wallet)?.set(r.signature,r.slot);
  }
}
const independent=checkChain?await reconcile({wallets:manifest.wallets,seen,start,end:cutoff,
  endpoint:process.env.COPY_BACKFILL_RPC??"https://solana-rpc.publicnode.com"}):null;
const lines=["# Итоговое окно prospective shadow","",
  "Окно по Кызылорде "+fmt(start)+" – "+fmt(end)+". Срез "+fmt(cutoff)+". "+
  (cutoff<end?"IN PROGRESS.":"Экспериментальное окно завершено."),"",
  "Минимальный выход до безубыточности после проскальзывания — 0,005330000 SOL. Это +6,60% к вложенным 0,005 SOL. "+
  "До SELL haircut 100 bps требуется минимум 5 383 839 lamports (+7,67678%) на моделируемое количество после BUY haircut. "+
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
  const chain=independent?.[wallet];
  const status=chain?.status==="INVALID"?"INVALID":chain?.status==="VERIFIED"&&!Object.keys(malformed).length?"VERIFIED":"UNKNOWN";
  coverageByWallet[wallet]={coveredMs:covered,unprovenMs:cutoff-start-covered,gaps,status};
  if (chain) for (const tx of chain.knownMissing) {
    tx.blockTimeOverlapsGap=gaps.some(g=>tx.blockTime*1000>=g.from-3000 && tx.blockTime*1000<=g.to+3000);
  }
  lines.push("## "+(manifest.labels[wallet]??wallet),"",
    "`"+wallet+"`","",
    "Наблюдаемое WS-покрытие "+duration(covered)+", неподтверждённые интервалы "+duration(cutoff-start-covered)+
    " ("+gaps.length+"). Независимая сверка **"+status+"**."+
    (chain?" История "+chain.listed+" сигнатур, "+chain.knownMissing.length+" доказанных пропусков, "+
      chain.unclassified+" непроверенных тел, "+chain.slotMismatches.length+" расхождений слота, "+
      chain.rpcErrors+" RPC-ошибок. Нижняя граница "+(chain.lowerBoundary?"достигнута.":"не достигнута.")+
      " Из пропущенных "+chain.knownMissing.filter(x=>x.blockTimeOverlapsGap).length+
      " пересекают интервалы неполного покрытия по приближённому blockTime.":""),"");
  for (const [id,r] of Object.entries(runs)) {
    const w=r.wallets[wallet];
    if (!w) continue;
    lines.push("### Run `"+id+"`","",
      "Начат "+fmt(r.startedAt)+", последняя запись "+fmt(r.lastAt)+". Зафиксировано "+
      w.signals+" сигналов, "+w.observedBuy+" BUY по логам или подтверждённым телам, "+w.eligibleBuy+
      " допустимых BUY, "+w.timelyBuy+" своевременных котировок"+
      (w.eligibleBuy?" ("+(100*w.timelyBuy/w.eligibleBuy).toFixed(1)+"%)":"")+
      ", "+w.unresolvedSignals+" неразобранных сигналов.","",
      "Причины по фазам `"+JSON.stringify(w.causes)+"`. Лог старого процесса объединял некоторые причины. "+
      "Зафиксировано разрывов WS "+w.reconnects.length+", восстановлений "+w.reconnects.filter(x=>x.to!==null).length+". "+
      "RPC-счётчики всего run — "+
      (r.rpc?r.rpc.requests+" аккаунтных запросов, "+r.rpc.errors+" ошибок, "+r.rpc.rateLimited+" HTTP 429, "+r.rpc.budgetRejected+" локальных отказов.":"нет heartbeat.")+
      (r.verificationRpc?" Проверки: "+JSON.stringify(r.verificationRpc)+".":" Для проверок доступны только журналированные отказы."),"",
      ...(w.rentRangeLamports?["Оценка rent по BUY "+fmtSol(w.rentRangeLamports[0])+"–"+
        fmtSol(w.rentRangeLamports[1])+" SOL. При невозврате максимального наблюдавшегося rent для безубыточности "+
        "нужно получить "+fmtSol(5330000+w.rentRangeLamports[1])+" SOL после SELL haircut.",""]:[]),
      "| Выход | Пары | UNKNOWN | Net, SOL | Без лучшей | Без возврата rent |",
      "|---|---:|---:|---:|---:|---:|",
      ...Object.entries(w.horizons).map(([kind,h])=>"| "+kind+" | "+h.pairs+" | "+h.unknown+" | "+
        fmtSol(h.netLamports)+" | "+fmtSol(h.withoutBestLamports)+" | "+fmtSol(h.netWithoutRentRecoveryLamports)+" |"),"");
    const decision=w.horizons["30s"].pairs<50||status!=="VERIFIED"||cutoff<end
      ? "UNPROVEN" : "ТРЕБУЕТ ОЦЕНКИ";
    lines.push("Экономика **"+decision+"**.","");
  }
  walletReports[wallet]=[...intro,...lines.slice(section)].join("\n")+"\n";
}
const json={start,end,cutoff,complete:cutoff>=end,runs,coverage:coverageByWallet,independent,malformed};
const files=[[".json",JSON.stringify(json,null,2)+"\n"],[".md",lines.join("\n")+"\n"],
  ...Object.entries(walletReports).map(([w,report])=>["-"+w.slice(0,6)+".md",report])];
for (const [suffix,value] of files) {
  fs.writeFileSync(out+suffix+".tmp",value);
  fs.renameSync(out+suffix+".tmp",out+suffix);
}
