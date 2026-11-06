import fs from 'node:fs';
const dir=process.argv[2]||'data/kaaox-pnl-evidence';
const window=JSON.parse(fs.readFileSync(dir+'/window.json')); const wallet=window.wallet;
const WSOL='So11111111111111111111111111111111111111112';
const programs={ '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P':'Pump curve','pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':'PumpSwap','CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':'Raydium CPMM','675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'Raydium AMM','whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'Orca'};
const out=[],positions=new Map();let missing=0;
const integer=n=>{if(!Number.isSafeInteger(n))throw Error('Unsafe RPC integer');return BigInt(n);};
for(const s of [...window.signatures].sort((a,b)=>a.slot-b.slot||(a.transactionIndex??0)-(b.transactionIndex??0))){
 const file=dir+'/'+s.signature+'.json';if(!fs.existsSync(file)){missing++;continue;}const t=JSON.parse(fs.readFileSync(file));if(!t?.meta){missing++;continue;}
 const m=t.meta,keys=t.transaction.message.accountKeys,idx=keys.findIndex(k=>k.pubkey===wallet);if(idx<0)continue;
 const signed=keys[idx].signer,fee=keys[0].pubkey===wallet?integer(m.fee):0n;
 const native=integer(m.postBalances[idx])-integer(m.preBalances[idx]);
 const pre=new Map(),post=new Map(),owned=new Set();
 for(const [balances,map] of [[m.preTokenBalances,pre],[m.postTokenBalances,post]])for(const b of balances||[])if(b.owner===wallet){map.set(b.mint,(map.get(b.mint)||0n)+BigInt(b.uiTokenAmount.amount));owned.add(b.accountIndex);}
 let rentAdjusted=native;for(const i of owned)rentAdjusted+=integer(m.postBalances[i])-integer(m.preBalances[i]);
 const deltas=[...new Set([...pre.keys(),...post.keys()])].filter(x=>x!==WSOL).map(mint=>({mint,pre:pre.get(mint)||0n,post:post.get(mint)||0n,delta:(post.get(mint)||0n)-(pre.get(mint)||0n)})).filter(x=>x.delta!==0n);
 const invoked=new Set((m.logMessages||[]).map(l=>/^Program (\w+) invoke/.exec(l)?.[1]).filter(Boolean));const venues=Object.entries(programs).filter(([p])=>invoked.has(p)).map(([,v])=>v);
 const swap=(m.logMessages||[]).some(l=>/Instruction: (Buy|Sell|Swap)/.test(l));
 const valid=!m.err&&signed&&venues.length>0&&swap&&deltas.length===1&&deltas[0].delta*rentAdjusted<0n;
 let row={signature:s.signature,time:s.blockTime,slot:s.slot,native,fee,rentAdjusted,venue:venues.join('+')||'Other',status:m.err?'failed':valid?'swap':'nontrade',deltas};
 if(valid){const d=deltas[0];let p=positions.get(d.mint);if(!p||p.qty!==d.pre){p={qty:d.pre,cost:0n,known:d.pre===0n,opened:s.blockTime,total:0n};positions.set(d.mint,p);}row.mint=d.mint;row.side=d.delta>0n?'BUY':'SELL';row.raw=d.delta<0n?-d.delta:d.delta;
 if(d.delta>0n){p.qty+=d.delta;p.cost-=rentAdjusted;p.total+=rentAdjusted;row.realized=0n;}
 else {const q=-d.delta;const cost=p.qty>0n?p.cost*q/p.qty:0n;row.known=p.known&&q<=p.qty;row.realized=row.known?rentAdjusted-cost:null;p.qty-=q;p.cost-=cost;p.total+=rentAdjusted;if(p.qty===0n){row.closed=true;row.cyclePnl=p.known?p.total:null;row.holdSeconds=s.blockTime-p.opened;positions.delete(d.mint);}}
 } else for(const d of deltas)positions.delete(d.mint);
 out.push(row);
}
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
fs.writeFileSync(dir+'/ledger.json',stringify({window,missing,rows:out,positions:[...positions]}));
function stats(days){const r=out.filter(r=>r.time>=window.end-days*86400),tr=r.filter(r=>r.status==='swap'),s=tr.filter(r=>r.side==='SELL'),closed=s.filter(r=>r.closed&&r.cyclePnl!==null);return {rows:r.length,buys:tr.filter(r=>r.side==='BUY').length,sells:s.length,knownSales:s.filter(r=>r.known).length,unknownSales:s.filter(r=>!r.known).length,unknownProceeds:s.filter(r=>!r.known).reduce((a,r)=>a+r.rentAdjusted,0n),conditionalRealized:s.filter(r=>r.known).reduce((a,r)=>a+r.realized,0n),fees:r.reduce((a,r)=>a+r.fee,0n),netNative:r.reduce((a,r)=>a+r.native,0n),closed:closed.length,wins:closed.filter(r=>r.cyclePnl>0n).length,venues:Object.fromEntries([...new Set(tr.map(r=>r.venue))].map(v=>[v,{buys:tr.filter(r=>r.venue===v&&r.side==='BUY').length,sells:s.filter(r=>r.venue===v).length,conditionalRealized:s.filter(r=>r.venue===v&&r.known).reduce((a,r)=>a+r.realized,0n)}]))};}
const result={missing,start:new Date(window.start*1000).toISOString(),end:new Date(window.end*1000).toISOString(),day:stats(1),week:stats(7)};fs.writeFileSync(dir+'/summary.json',stringify(result));console.log(stringify(result));
const sol=n=>(Number(n)/1e9).toFixed(9);
const md=['# Kaaox: RPC cash-flow and cost-basis reconciliation','',`UTC end: ${result.end}; 7d start: ${result.start}; 24h start: ${new Date((window.end-86400)*1000).toISOString()}.`,`Fetched ${window.signatures.length} finalized transactions across 14 days; missing RPC bodies: ${missing}.`, '',
'## Status: total realized trading PnL not established','',
'The figures below are a conditional weighted-average-cost reconstruction, NOT a fully verified trading PnL. Native wallet changes plus lamport changes in token accounts explicitly owned by the wallet neutralize observed account rent and include WSOL. Fees and any tips are already included in this cash flow; network fees must not be subtracted twice. However side transfers, temporary accounts absent from token balance metadata, and router payments have not all been independently allocated. Failed-attempt fees are listed for the wallet but not allocated to positions. Account-local pre-balances do not prove total wallet inventory. These limitations prohibit labeling the reconstructed subtotal as exact confirmed profit.', '',
'Buy cost is capitalized; SELL releases average cost using BigInt integer division. Unknown opening inventory and nontrade token movements invalidate cost attribution. This is conservative coverage, not proof that historical cost cannot be recovered from older history. No unrealized valuation or SOL/USD conversion is supplied. No server configuration was changed and no transactions were sent.','',
'| Metric | 24h | 7d |','|---|---:|---:|',
...Object.entries({buys:'Accepted BUY',sells:'Accepted SELL',knownSales:'SELL with reconstructed cost',unknownSales:'SELL without reconstructed cost',closed:'Reconstructed complete cycles',wins:'Winning reconstructed cycles'}).map(([k,n])=>`| ${n} | ${result.day[k]} | ${result.week[k]} |`),
`| Conditional subtotal SOL | ${sol(result.day.conditionalRealized)} | ${sol(result.week.conditionalRealized)} |`,
`| Unknown-cost sales net receipts SOL | ${sol(result.day.unknownProceeds)} | ${sol(result.week.unknownProceeds)} |`,
`| Wallet network fees incl. priority SOL | ${sol(result.day.fees)} | ${sol(result.week.fees)} |`,
`| Native SOL wallet change (NOT PnL) | ${sol(result.day.netNative)} | ${sol(result.week.netNative)} |`,
'| Exact realized PnL / unrealized PnL | Not established | Not established |','',
'## Venue (7d)','',
'Venue is the set of invoked supported programs, not a claim that each invocation executed a swap. Mixed routes are kept separate. Costs carry across venues; realized results are assigned once to the SELL transaction venue. A zero subtotal with unknown-cost sales is not zero economic profit.','',
'| Venue | BUY | SELL | Conditional subtotal SOL |','|---|---:|---:|---:|',
...Object.entries(result.week.venues).map(([v,s])=>`| ${v} | ${s.buys} | ${s.sells} | ${sol(s.conditionalRealized)} |`),'',
'## Largest observed SELL receipts (7d)','',
'| Mint | Venue | Raw sold | Net receipts SOL | Conditional realized SOL | TX |','|---|---|---:|---:|---:|---|',
...out.filter(r=>r.time>=window.start&&r.side==='SELL').sort((a,b)=>Number(b.rentAdjusted-a.rentAdjusted)).slice(0,15).map(r=>`| ${r.mint} | ${r.venue} | ${r.raw} | ${sol(r.rentAdjusted)} | ${r.known?sol(r.realized):'Unknown cost'} | [${r.signature.slice(0,10)}](https://solscan.io/tx/${r.signature}) |`),'',
'## Interpretation and reproducibility','',
'The old Kolscan +118.42 SOL / +97.90 SOL values refer to unspecified historical windows and cannot be compared as the same interval. This report does not establish that Kolscan is wrong. The current calculation does not establish a profitable copying strategy. Retain shadow observation; do not enable live based on these incomplete profit figures. Winner concentration and full-strategy win rate remain unestablished because most weekly sales lack reconstructed basis.','',
'Run `node scripts/kaaox-pnl.mjs` to collect a new window, then `node scripts/kaaox-pnl-report.mjs` to reproduce the ledger and this report. Evidence is stored under ignored `data/kaaox-pnl-evidence/` without RPC URLs or keys. `ledger.json` includes raw deltas, fees, transaction signatures and residual inventory; `summary.json` includes counts. The collection window is fixed at collection start. Native numeric RPC values are rejected when outside the safe integer range; all arithmetic thereafter uses BigInt. The classifier excludes failed swaps, non-signers and multiple non-WSOL delta transactions rather than inventing an allocation. Accordingly BUY/SELL counts are covered swaps, not a claim of complete economic activity.' ];
fs.writeFileSync('docs/kaaox-pnl-analysis.md',md.join('\n')+'\n');
