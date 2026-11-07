import fs from 'node:fs';
import bs58 from 'bs58';
const wallet='7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL',pump='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const read=f=>JSON.parse(fs.readFileSync(f));
const old=read('work/entry-trades-cand_7ufmve.json');
const src=fs.readFileSync('work/analyze-entry-quality.mjs','utf8');
const build=new Function(src.slice(src.indexOf('function closeTolerance('),src.indexOf('const BUCKETS ='))+';return buildCycles;')();
const groups=build(old.trades);
const idl=read('node_modules/@pump-fun/pump-sdk/src/idl/pump.json');
const creation=idl.instructions.filter(i=>['create','create_v2'].includes(i.name));
function creates(tx){
 const instructions=[...tx.transaction.message.instructions,...(tx.meta?.innerInstructions||[]).flatMap(g=>g.instructions)];
 return instructions.flatMap((i,index)=>{
  if(i.programId!==pump||!i.data)return [];
  const bytes=bs58.decode(i.data),spec=creation.find(s=>s.discriminator.every((v,n)=>bytes[n]===v));if(!spec)return [];
  const a=Object.fromEntries(spec.accounts.map((a,n)=>[a.name,i.accounts[n]]));
  return [{instruction:index,kind:spec.name,mint:a.mint,user:a.user,curve:a.bonding_curve}];
 });
}
const buys=old.trades.filter(t=>t.side==='BUY');
const rows=buys.map(t=>{
 const tx=read(`data/sniper-current-pnl/${t.signature}.json`);
 const launch=creates(tx).find(c=>c.mint===t.mint);
 const mintInit=tx.meta.innerInstructions.flatMap(g=>g.instructions).find(i=>i.parsed?.type==='initializeMint2'&&i.parsed.info.mint===t.mint);
 const cycle=[...groups.cycles,...groups.openCycles].find(c=>c.trades.some(x=>x.signature===t.signature));
 const sells=cycle?.trades.filter(x=>x.side==='SELL')||[];
 const ins=tx.transaction.message.instructions;
 const buySpec=idl.instructions.filter(s=>s.name.startsWith('buy'));
 const buyIndex=ins.findIndex(i=>i.programId===pump&&i.accounts?.includes(t.mint)&&i.data&&buySpec.some(s=>s.discriminator.every((v,n)=>bs58.decode(i.data)[n]===v)));
 return {mint:t.mint,buySignature:t.signature,slot:tx.slot,time:tx.blockTime,sizeSol:t.economicSol,launchSignature:launch?t.signature:null,creation:launch||null,mintInitialized:!!mintInit,tokenProgram:mintInit?.programId||null,buyInstruction:buyIndex,launchBeforeBuy:!!launch&&launch.instruction<buyIndex,creatorUserIsTarget:launch?.user===wallet,feePayer:tx.transaction.message.accountKeys[0].pubkey,sameTransaction:!!launch&&!!mintInit,slotGap:launch?0:null,priorIndependentBuyers:launch?0:null,firstSellSeconds:sells.length?sells[0].blockTime-t.blockTime:null,sellCount:sells.length,outcome:cycle?.complete?(cycle.pnlSol>0?'selected_profit':'selected_loss'):cycle?.closedAt?'excluded_closed':'open_or_unmatched',conditionalCyclePnl:cycle?.complete?cycle.pnlSol:null,rule:'SKIP: no proven pre-BUY independent signal'};
});
const split=rows[Math.floor(rows.length*.7)].time;
const counts=a=>({buys:a.length,atomicLaunchBuy:a.filter(r=>r.sameTransaction&&r.launchBeforeBuy).length,targetLaunchUser:a.filter(r=>r.creatorUserIsTarget).length,groups:Object.fromEntries([...new Set(a.map(r=>r.outcome))].map(g=>[g,{n:a.filter(r=>r.outcome===g).length,atomic:a.filter(r=>r.outcome===g&&r.sameTransaction).length}]))});
fs.mkdirSync('data/independent-sniper',{recursive:true});
const result={wallet,splitUTC:new Date(split*1000).toISOString(),all:counts(rows),early:counts(rows.filter(r=>r.time<split)),late:counts(rows.filter(r=>r.time>=split)),rows};
fs.writeFileSync('data/independent-sniper/entries.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,rows:undefined},null,2));
if(process.argv.includes('--controls')){
 const env=fs.readFileSync('.env','utf8');const url=env.match(/^RPC_HTTP_URL=(.*)$/m)[1].trim();
 const slots=[rows[0].slot,rows[Math.floor(rows.length/2)].slot,rows.at(-1).slot].flatMap(s=>[s,s-1,s+1,s-10,s+10]);
 for(const slot of slots){const f=`data/independent-sniper/block-${slot}.json`;if(fs.existsSync(f))continue;let success=false;
 for(let n=0;n<4;n++){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBlock',params:[slot,{commitment:'finalized',encoding:'jsonParsed',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:1}]}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error();const j=await r.json();if(j.error||!j.result)throw Error();fs.writeFileSync(f,JSON.stringify(j.result));success=true;break;}catch{await new Promise(r=>setTimeout(r,2000*(n+1)));}}console.log({slot,success});}
}
const controls=[];const targetMints=new Set(buys.map(t=>t.mint));
for(const f of fs.readdirSync('data/independent-sniper').filter(f=>/^block-\d+.json$/.test(f))){const block=read('data/independent-sniper/'+f);for(const [index,tx] of block.transactions.entries()){if(tx.meta?.err)continue;for(const c of creates(tx)){if(targetMints.has(c.mint))continue;controls.push({...c,slot:Number(f.match(/\d+/)[0]),transactionIndex:index,signature:tx.transaction.signatures[0],targetSigner:tx.transaction.message.accountKeys.some(k=>k.pubkey===wallet&&k.signer),laterTargetBuyInSavedWindow:false});}}}
fs.writeFileSync('data/independent-sniper/controls.json',JSON.stringify(controls,null,2));console.log({controlLaunches:controls.length});
const link=s=>s?`[${s.slice(0,9)}](https://solscan.io/tx/${s})`:'unknown';
const report=['# Independent Pump sniper: NOT REPRODUCIBLE','',
'1. Observed pattern: the target participates in creating its own mint and buying it in the same atomic transaction in 111 of 153 archived BUY rows. The CreateV2 user account is the target. In 108 cases the top-level BUY discriminator also establishes instruction order; three BUY instructions are unresolved by this limited decoder.',
'2. No public pre-BUY signal is demonstrated for these atomic launch purchases. The creation notification exposes a transaction that already contains the target BUY; it is not a window between instructions.',
'3. Demonstrated lead: zero positive slots. Creation and BUY share the transaction and slot; even same-slot following transactions cannot precede its BUY.',
'4. Public creation detection can observe launches, but this study establishes no rule selecting these tokens before their creator BUY through the existing RPC/WebSocket.',
'5. No independent profitable holdout strategy was established. Historical delayed pool prices at 5/10/15/30 seconds are unavailable. PnL for such hypothetical trades is unknown, not zero.',
'6. No independent shadow-sniper was enabled: the requested prerequisite of a reproducible independent early signal was not met. Independent live samples = 0. Existing monitoring remains unchanged.','',
'## Evidence and scope','',
'153 archived BUY rows were checked, including buys in selected profitable cycles, excluded closed cycles and open/unmatched positions. Selection follows the saved historical dataset and is not complete wallet history. It contains no selected losing complete cycle; excluded cycles are not silently labeled losses. All 153 cached raw BUY bodies are available. The report does not prove the strategy cannot ever have another public signal; it falsifies treating the observed creation events as earlier opportunities.',
'```json',JSON.stringify({...result,rows:undefined},null,2),'```',
'Counters represent BUY rows, not unique cycles. Creator means the on-chain creation instruction user, not proof of real-world identity or exclusive authorship. Neither private bundles nor collusion are inferred. Token-2022 InitializeMint2 identifies the exact mint. For atomic launches, the mint and curve are created in the BUY transaction; there are no earlier independent transactions trading that newly initialized mint. No millisecond ordering is inferred from blockTime.',
'## Time split and hypothesis tests','',
`The first approximately 70% of BUY rows form the early period; split ${result.splitUTC}. The later period has ${result.late.buys} BUY rows. The structural assertion "creation and target BUY are the same transaction" uses no fitted threshold. The 35 late-period target creations confirm persistence, not profitability.`,
'| Hypothesis | Finding | Independent actionable lead |','|---|---|---|',
'| Target reacts to a public launch | 111 launches are inside its own BUY transaction | None shown |',
'| Several earlier independent buyers | Impossible before creation for the 111 atomic cases; remaining cases unknown | Not supported as a general explanation |',
'| Specific creator | Target itself is creation user in 111 cases; identifying it here is already too late | None |',
'| About 5 SOL entry | Observed transaction amount is revealed with BUY | Look-ahead if used for entry |',
'| Token-2022 mint | Present on atomic target launches, but also a platform capability | No demonstrated selection advantage |',
'| Reserve/holder concentration threshold | Pre-BUY account history and cross-launch concentration panel not reconstructed | Unknown |',
'| Particular funding or activity sequence | No independently validated precursor in this dataset | Unknown |',
'| Private bundle advantage | Atomic transaction suffices to explain ordering; bundle participation not established | Unknown |','',
'## Control group','',
`Fetched 15 full finalized blocks: each of three time-stratified entry slots plus offsets -10,-1,+1,+10. Found ${controls.length} successful other Pump launches absent from the target BUY mint set in the saved historical window. This is a small, nonrepresentative structural control, not enough to estimate strategy precision, recall or expected profit. "Not bought" is limited to the saved target dataset, not all future time.`,
'| Control mint | Launch | Slot | Creator user | Rule |','|---|---|---:|---|---|',
...controls.map(c=>`| ${c.mint} | ${link(c.signature)} | ${c.slot} | ${c.user} | SKIP; no independent edge proved |`),
'An indiscriminate creation trigger would include these other launches without evidence they are profitable or would be selected by the target. They are counterexamples to creation identifying target choices, not proven losing trades. No fitted trading rule is claimed; false-positive rates and holdout trading PnL remain unknown.',
'## All archived entry examples','',
'Launch signature equals BUY signature where creation is proved. Instruction indexes are zero-based; -1 means unresolved. Missing launch rows are explicitly unknown. First SELL interval and counts come from matched archived cycles, and do not imply all inventory was closed or that time-based exit is optimal.',
'| Mint | Launch | Target BUY | Slot | Create/BUY index | SOL | First SELL seconds | SELL count | Outcome group | Independent decision |','|---|---|---|---:|---|---:|---:|---:|---|---|',
...rows.map(r=>`| ${r.mint} | ${link(r.launchSignature)} | ${link(r.buySignature)} | ${r.slot} | ${r.creation?.instruction??'?'} / ${r.buyInstruction} | ${r.sizeSol} | ${r.firstSellSeconds??'?'} | ${r.sellCount} | ${r.outcome} | SKIP |`),
'## Economics and missing counterfactuals','',
'The current configured model uses 0.0001 SOL priority cap, 0.000005 SOL tip and nominal 0.000005 SOL base fee per swap; actual fees can differ. At 0.005 SOL, modeled BUY+SELL fixed cost 0.00022 SOL is 4.4%. The earlier observed CLOSE net expense was 0.00011 SOL, bringing modeled fixed total to 0.00033 SOL. With 125 bps trading fee on each side, break-even price growth is (1 + 0.00033 / 0.005) / (1 - 0.0125)^2 - 1 = about 9.32%, before further slippage or failures. Returned rent is not a permanent loss; it still requires temporary capital.',
'There is no legitimate independent pre-BUY entry timestamp in the 111 atomic cases. Thus no historical copy quote, 5/10/15/30-second exit price, TP/SL profitability or successful landing is fabricated. The existing following-trade shadow sample was negative (-0.003328151 SOL for six cycles before additional CLOSE); that does not measure a new independent strategy.',
'## Decision','',
'**NOT REPRODUCIBLE** with the demonstrated public creation events and existing observation path. This is a scoped conclusion about the identified atomic-launch advantage, not proof that every untested strategy is impossible. A generic launch detector would create a new unvalidated strategy rather than reproduce this entry advantage. No global stream, shadow strategy, live order, wallet, service, deployment or executor change was made.',
'Reproduce: `node scripts/independent-sniper-analysis.mjs` uses cached BUY transactions and control blocks; optional `--controls` fetches at most the 15 fixed blocks with retries and local caching. Published evidence records all entry features and both control launches without secrets.'];
fs.mkdirSync('docs/evidence',{recursive:true});
fs.writeFileSync('docs/evidence/independent-sniper-entries.json',JSON.stringify({result,controls},null,2));
fs.writeFileSync('docs/independent-pump-sniper.md',report.join('\n')+'\n');
