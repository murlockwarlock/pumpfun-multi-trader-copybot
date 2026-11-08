import fs from "node:fs";
const file = process.argv[2] ?? "data/sniper-launch-follow/state.json";
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,"utf8")) : {launches:{}};
const launches = Object.values(state.launches).sort((a,b)=>a.observedAtMs-b.observedAtMs);
const metric = v => {const a=v.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p95:a[Math.ceil(a.length*.95)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null};};
function portfolios(rows) {
  return Object.fromEntries(["A","B","C","D","E","F"].map(v=>{
    const quoted=rows.filter(p=>p.confirmed===true&&p.exits[v]?.status==="QUOTED");
    return [v,{closed:quoted.length,unknown:rows.filter(p=>p.exits[v]?.status==="UNKNOWN").length,
      unverifiedQuotes:rows.filter(p=>p.confirmed!==true&&p.exits[v]?.status==="QUOTED").length,
      netPnlSol:quoted.length?quoted.reduce((n,p)=>n+p.exits[v].netPnlSol,0):null,
      winRate:quoted.length?quoted.filter(p=>p.exits[v].netPnlSol>0).length/quoted.length:null,
      exitLatenessMs:metric(quoted.map(p=>p.exits[v].latenessMs))}];
  }));
}
const out={generatedAt:new Date().toISOString(),launches:launches.length,
  prepared:launches.filter(p=>p.accepted).length,
  skipReasons:Object.fromEntries([...new Set(launches.map(p=>p.reason).filter(Boolean))].map(r=>[r,launches.filter(p=>p.reason===r).length])),
  signalToPreparedMs:metric(launches.filter(p=>p.accepted).map(p=>p.signalToPreparedMs)),
  entryDriftBps:metric(launches.filter(p=>p.accepted).map(p=>p.entryDriftBps)),
  firstCreatorSellObservedMs:metric(launches.map(p=>state.sells?.[p.mint]?.[0]?.observedAtMs-p.observedAtMs)),
  portfolios:portfolios(launches),
  // Fixed before collecting observations: select with first 25 launches,
  // evaluate that choice with the next 25, including failures/UNKNOWN.
  exploratory:portfolios(launches.slice(0,25)),holdout:portfolios(launches.slice(25,50)),
  splitRule:"first 25 launches exploratory; next 25 holdout; no timer selection until exploration completes",
  verdict:"UNPROVEN"};
console.log(JSON.stringify(out,null,2));
