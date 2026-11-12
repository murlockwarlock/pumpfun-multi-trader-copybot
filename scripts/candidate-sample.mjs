import fs from 'node:fs';
import {PublicKey} from '@solana/web3.js';
const candidates={decu:'4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9',trunoest:'ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT',Nyhrox:'6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC'};
const url=fs.readFileSync('.env','utf8').match(/^RPC_HTTP_URL=(.*)$/m)[1].trim().replace(/^['"]|['"]$/g,'');
fs.mkdirSync('data/candidate-sample',{recursive:true});
async function rpc(method,params){for(let n=0;n<6;n++){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();const j=await r.json();if(j.error)throw Error();return j.result;}catch{await new Promise(r=>setTimeout(r,1000*(n+1)));}}throw Error('RPC unavailable');}
const rows=[];
for(const [name,wallet] of Object.entries(candidates)){
 new PublicKey(wallet);const sigs=await rpc('getSignaturesForAddress',[wallet,{limit:100,commitment:'finalized'}]);
 let signed=0,successfulSigned=0,ownedDelta=0;
 for(const s of sigs){const f='data/candidate-sample/'+s.signature+'.json';let t;if(fs.existsSync(f))t=JSON.parse(fs.readFileSync(f));else{t=await rpc('getTransaction',[s.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:1}]);fs.writeFileSync(f,JSON.stringify(t));}
 if(t?.transaction.message.accountKeys.some(k=>k.pubkey===wallet&&k.signer)){signed++;if(!t.meta.err)successfulSigned++;}
 const totals=new Map();for(const [bs,sign] of [[t?.meta?.preTokenBalances,-1n],[t?.meta?.postTokenBalances,1n]])for(const b of bs||[])if(b.owner===wallet)totals.set(b.mint,(totals.get(b.mint)||0n)+sign*BigInt(b.uiTokenAmount.amount));if([...totals.values()].some(x=>x!==0n))ownedDelta++;
 }
 rows.push({name,wallet,sample:sigs.length,start:sigs.at(-1)?.blockTime,end:sigs[0]?.blockTime,signed,successfulSigned,ownedDelta,failed:sigs.filter(s=>s.err).length,signatures:sigs.map(s=>s.signature)});console.log(JSON.stringify(rows.at(-1)));
 fs.writeFileSync('data/candidate-sample/summary.json',JSON.stringify(rows,null,2));
}
