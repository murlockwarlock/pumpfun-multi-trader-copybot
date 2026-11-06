// Read-only RPC evidence collector. Never imports the trading executor.
import fs from 'node:fs';
import path from 'node:path';
const wallet = '3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG';
for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
  const m = /^([^#=\s]+)=(.*)$/.exec(l); if(m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const dir = process.argv[2] || 'data/kaaox-pnl-evidence'; fs.mkdirSync(dir,{recursive:true});
const end = Math.floor(Date.now()/1000), start=end-7*86400;
async function rpc(method,params) {
  for(let a=0;a<8;a++) {
    try { const r=await fetch(process.env.RPC_HTTP_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)}); if(!r.ok)throw Error('http'); const j=await r.json(); if(j.error)throw Error('rpc'); return j.result; }
    catch { if(a===7)throw Error('RPC unavailable: '+method); await new Promise(r=>setTimeout(r,Math.min(5000,500*2**a))); }
  }
}
let sigs=[],before;
while(true){ const page=await rpc('getSignaturesForAddress',[wallet,{limit:1000,commitment:'finalized',...(before?{before}:{})}]); sigs.push(...page); if(!page.length||page.at(-1).blockTime<start-7*86400||page.length<1000)break; before=page.at(-1).signature; }
sigs=sigs.filter(x=>x.blockTime<=end && x.blockTime>=start-7*86400);
fs.writeFileSync(path.join(dir,'window.json'),JSON.stringify({wallet,start,end,lookbackStart:start-7*86400,signatures:sigs},null,2));
let i=0; await Promise.all(Array.from({length:3},async()=>{ while(i<sigs.length){const s=sigs[i++],f=path.join(dir,s.signature+'.json'); if(!fs.existsSync(f)){ const tx=await rpc('getTransaction',[s.signature,{commitment:'finalized',encoding:'jsonParsed',maxSupportedTransactionVersion:1}]); fs.writeFileSync(f,JSON.stringify(tx)); } if(i%50===0)console.log('Fetched',i,'/',sigs.length); await new Promise(r=>setTimeout(r,120)); }}));
console.log(JSON.stringify({start,end,count:sigs.length,directory:dir}));
