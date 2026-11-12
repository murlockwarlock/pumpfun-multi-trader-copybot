import fs from "node:fs";
import bs58 from "bs58";
import { launchSignals, LAUNCH_TARGET } from "../src/launch-follow.js";
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
const lines = p => fs.readFileSync(p,"utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const idl = read("node_modules/@pump-fun/pump-sdk/src/idl/pump.json");
const specs = idl.instructions.filter(i => ["create", "create_v2"].includes(i.name));
function classify(signature, mint) {
  const f = `data/sniper-current-pnl/${signature}.json`;
  if (!fs.existsSync(f)) return { status: "UNKNOWN", reason: "raw_tx_missing" };
  const tx = read(f);
  if (!tx?.meta || tx.meta.err) return { status: "UNKNOWN", reason: "tx_not_successful" };
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(g=>g.instructions)];
  for (const i of instructions) {
    if (i.programId !== "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" || !i.data) continue;
    const b = bs58.decode(i.data), spec = specs.find(s => s.discriminator.every((v,n)=>b[n]===v));
    if (!spec) continue;
    const a = Object.fromEntries(spec.accounts.map((a,n)=>[a.name,i.accounts[n]]));
    if (a.mint===mint && a.user===LAUNCH_TARGET) return { status:"OWN_LAUNCH", curve:a.bonding_curve,
      logDetected: launchSignals({signature,logs:tx.meta.logMessages},tx.slot,Date.now()).some(s=>s.mint===mint) };
  }
  return { status:"OTHER_BUY" };
}
const signals = lines("data/sniper-live-snapshot.jsonl").filter(r=>r.sourceName==="sniper_7ufmve"&&r.side==="BUY");
const buys = signals.map(r=>({signature:(r.sourceSignature??r.targetSignature??r.signature).split(":")[0],mint:r.mint})).map(r=>({...r,...classify(r.signature,r.mint)}));
const shadow = lines("data/sniper-shadow-snapshot.jsonl").filter(r=>r.sourceName==="sniper_7ufmve");
const cycles = shadow.filter(r=>r.type==="SHADOW_SELL").map(s=>({ mint:s.mint,signature:s.entrySignature,pnlSol:s.pnlSol,
  pnlWithCloseSol:s.pnlSol-.00011,...classify(s.entrySignature,s.mint) }));
const ownKeys = new Set(buys.filter(r=>r.status==="OWN_LAUNCH").map(r=>r.signature+":"+r.mint));
const ownSkipReasons = {};
for (const r of shadow.filter(r=>r.type==="SHADOW_SKIP"&&r.side==="BUY")) {
  const sig=(r.sourceSignature??r.targetSignature??r.signature??"").split(":")[0];
  if (!ownKeys.has(sig+":"+r.mint)) continue;
  const reason=(r.reason??"unknown").replace(/:Mint account not found:.*/,":Mint account not found").replace(/_\d+bps$/,"_BPS");
  ownSkipReasons[reason]=(ownSkipReasons[reason]??0)+1;
}
const archived = read("docs/evidence/independent-sniper-entries.json").result.rows.filter(r=>r.creatorUserIsTarget);
const metric = values => { const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1]??null,p95:a[Math.ceil(a.length*.95)-1]??null,p99:a[Math.ceil(a.length*.99)-1]??null}; };
const subgroup = a=>({ n:a.length,wins:a.filter(r=>r.pnlSol>0).length,netSol:a.reduce((s,r)=>s+r.pnlSol,0),netWithCloseSol:a.reduce((s,r)=>s+r.pnlWithCloseSol,0) });
const result = {generatedAt:new Date().toISOString(),historicalOwnLaunches:archived.length,
  firstCreatorSellSeconds:metric(archived.map(r=>r.firstSellSeconds)),
  priorDetectedBuys:buys.length,counts:Object.fromEntries(["OWN_LAUNCH","OTHER_BUY","UNKNOWN"].map(s=>[s,buys.filter(r=>r.status===s).length])),
  previousAllCopy:subgroup(cycles),previousOwnLaunchCopy:subgroup(cycles.filter(r=>r.status==="OWN_LAUNCH")),ownSkipReasons,buys,cycles};
fs.mkdirSync("docs/evidence",{recursive:true});
fs.writeFileSync("docs/evidence/launch-follow-history.json",JSON.stringify(result,null,2)+"\n");
const sample=archived.find(r=>classify(r.buySignature,r.mint).logDetected);
if(sample){ const tx=read(`data/sniper-current-pnl/${sample.buySignature}.json`);
  fs.mkdirSync("test/fixtures",{recursive:true});
  fs.writeFileSync("test/fixtures/launch-follow.json",JSON.stringify({signature:sample.buySignature,mint:sample.mint,slot:tx.slot,logs:tx.meta.logMessages},null,2)+"\n"); }
console.log(JSON.stringify({...result,buys:undefined,cycles:undefined},null,2));
