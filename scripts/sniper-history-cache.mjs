// Complete the saved historical signature list; reuse current-window RPC bodies.
import fs from 'node:fs';
const dir='data/sniper-current-pnl';
const old=JSON.parse(fs.readFileSync('work/entry-trades-cand_7ufmve.json'));
const url=fs.readFileSync('.env','utf8').match(/^RPC_HTTP_URL=(.*)$/m)[1].trim().replace(/^['"]|['"]$/g,'');
const pending=old.signatures.filter(s=>!fs.existsSync(`${dir}/${s.signature}.json`));
console.log({savedSignatures:old.signatures.length,missing:pending.length});
let done=0;
for(const s of pending){
 let tx;
 for(let n=0;n<7;n++){
  try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:1}]}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();if(j.error||!j.result)throw Error('RPC unavailable');tx=j.result;break;}catch{if(n===6)throw Error('Failed historical signature '+s.signature);await new Promise(r=>setTimeout(r,1000*(n+1)));}
 }
 fs.writeFileSync(`${dir}/${s.signature}.json`,JSON.stringify(tx));if(++done%50===0)console.log({done,total:pending.length});await new Promise(r=>setTimeout(r,200));
}
console.log('Historical signature cache complete');
