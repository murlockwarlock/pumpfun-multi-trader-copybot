import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath,pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { CONTROL_INPUT } from "./next-copy-economics.mjs";

const SOURCE="https://api.exchange.coinbase.com/products/SOL-USD/ticker";

export function sizeScenarios(rate) {
  if (!/^\d+(?:\.\d{1,12})?$/.test(rate)) throw Error("Invalid SOL/USD price");
  const [whole,fraction=""]=rate.split(".");
  const numerator=BigInt(whole+fraction), scale=10n**BigInt(fraction.length);
  if (numerator<=0n) throw Error("Invalid SOL/USD price");
  const dollars=[5,10,20,30].map(usd=>({id:"usd"+usd,usd,
    inputLamports:(BigInt(usd)*1_000_000_000n*scale/numerator).toString()}));
  const rows=[{id:"control",usd:null,inputLamports:CONTROL_INPUT.toString()},...dollars];
  if (rows.some(r=>BigInt(r.inputLamports)<1n||BigInt(r.inputLamports)>BigInt(Number.MAX_SAFE_INTEGER))||
      new Set(rows.map(r=>r.inputLamports)).size!==rows.length) throw Error("Invalid or duplicate scenario amount");
  return rows;
}

export async function freezeRate(request=fetch) {
  const response=await request(SOURCE,{signal:AbortSignal.timeout(8000),cache:"no-store"});
  if (!response.ok) throw Error("SOL/USD source unavailable");
  const {price,time}=await response.json();
  const observedAt=new Date().toISOString(), age=Date.parse(observedAt)-Date.parse(time);
  if (typeof price!=="string"||!Number.isFinite(age)||age< -10000||age>120000) throw Error("SOL/USD quote unavailable or stale");
  sizeScenarios(price);
  return {source:SOURCE,usdPerSol:price,tradeAt:time,observedAt};
}

export function verifySuite(suite) {
  if (suite?.fx?.source!==SOURCE||!Number.isFinite(Date.parse(suite.fx.observedAt))||!Number.isFinite(Date.parse(suite.fx.tradeAt))||
      JSON.stringify(sizeScenarios(suite.fx.usdPerSol))!==JSON.stringify(suite.scenarios)||
      !Array.isArray(suite.wallets)||!suite.wallets.length||suite.wallets.length>5||
      new Set(suite.wallets).size!==suite.wallets.length) throw Error("Invalid size study manifest");
  suite.wallets.forEach(w=>new PublicKey(w));
}

function formatSize(lamports) {
  const raw=BigInt(lamports);
  return (raw/1_000_000_000n)+"."+(raw%1_000_000_000n).toString().padStart(9,"0");
}

async function main([mode,file,...args]) {
  if (mode==="prepare"&&file&&args.length) {
    args.forEach(w=>new PublicKey(w));
    const fx=await freezeRate();
    const suite={fx,wallets:args,scenarios:sizeScenarios(fx.usdPerSol)};
    verifySuite(suite);
    fs.writeFileSync(file,JSON.stringify(suite,null,2)+"\n",{flag:"wx"});
    console.log(JSON.stringify(suite,null,2));
    return;
  }
  if (mode!=="run"||!file||args.length!==1) throw Error("Usage: next-copy-size-study.mjs prepare MANIFEST WALLET... | run MANIFEST PRIVATE_RPC_FILE");
  const suite=JSON.parse(fs.readFileSync(file,"utf8"));
  verifySuite(suite);
  const age=Date.now()-Date.parse(suite.fx.observedAt);
  if (age<0||age>900000) throw Error("Freeze a fresh SOL/USD rate before starting the study");
  const endpoints=JSON.parse(fs.readFileSync(args[0],"utf8"));
  const targets=suite.scenarios.map(({id})=>endpoints[id]);
  if (targets.some(t=>!/^https:\/\//.test(t?.http)||!/^wss:\/\//.test(t?.ws))||
      new Set(targets.map(t=>t.http)).size!==targets.length) {
    throw Error("Provide five distinct dedicated HTTPS quote/verification endpoints and WSS endpoints");
  }
  const dir=path.dirname(file);
  const journals=suite.scenarios.map(s=>path.join(dir,s.id+".jsonl"));
  if (journals.some(f=>fs.existsSync(f))) throw Error("Use a fresh study directory");
  const children=[];
  const stop=()=>children.forEach(c=>c.kill("SIGTERM"));
  process.once("SIGINT",stop);
  process.once("SIGTERM",stop);
  const observer=fileURLToPath(new URL("./next-copy-observer.mjs",import.meta.url));
  try {
    await Promise.all(suite.scenarios.map((s,i)=>new Promise((resolve,reject)=>{
      const env={...process.env,COPY_OBSERVER_RPC:targets[i].http,COPY_OBSERVER_WS:targets[i].ws,
        COPY_OBSERVER_STUDY:JSON.stringify({scenario:s.id,fx:suite.fx})};
      const child=spawn(process.execPath,[observer,journals[i],...suite.wallets,"--size-sol="+formatSize(s.inputLamports)],
        {env,stdio:"inherit"});
      children.push(child);
      child.once("error",reject);
      child.once("exit",code=>code===0?resolve():reject(Error("Observer exited for "+s.id)));
    })));
  } finally {stop();}
}

if (process.argv[1]&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
