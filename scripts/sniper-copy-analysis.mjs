import fs from 'node:fs';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const lines=f=>fs.readFileSync(f,'utf8').trim().split(/\r?\n/).map(JSON.parse);
const historical=read('work/entry-trades-cand_7ufmve.json');
// Reproduce the historical algorithm verbatim, without its RPC/main section.
const source=fs.readFileSync('work/analyze-entry-quality.mjs','utf8');
const build=new Function(source.slice(source.indexOf('function closeTolerance('),source.indexOf('const BUCKETS ='))+';return buildCycles;')();
const replay=build(historical.trades), cycles=replay.cycles.filter(c=>c.complete);
const live=lines('data/sniper-live-snapshot.jsonl');
const signals=live.filter(r=>r.sourceName==='sniper_7ufmve');
const shadow=lines('data/sniper-shadow-snapshot.jsonl').filter(r=>r.sourceName==='sniper_7ufmve');
const buys=shadow.filter(r=>r.type==='SHADOW_BUY'),sells=shadow.filter(r=>r.type==='SHADOW_SELL');
const sum=(a,f)=>a.reduce((s,x)=>s+f(x),0);
const quant=(a,p)=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.ceil(p*a.length)-1]:null;};
const metric=a=>({n:a.filter(Number.isFinite).length,p50:quant(a,.5),p95:quant(a,.95),p99:quant(a,.99)});
const net=sum(sells,x=>x.pnlSol),holds=sells.map(s=>(Date.parse(s.at)-Date.parse(buys.find(b=>b.targetSignature===s.entrySignature).at))/1000);
const reasons={};for(const r of shadow.filter(r=>r.type==='SHADOW_SKIP')){const key=(r.reason||'unknown').replace(/:Mint account not found:.*/,':Mint account not found').replace(/_\d+bps$/,'_BPS');reasons[key]=(reasons[key]||0)+1;}
const result={generatedAt:new Date().toISOString(),historical:{buys:historical.trades.filter(t=>t.side==='BUY').length,sells:historical.trades.filter(t=>t.side==='SELL').length,duplicates:historical.trades.length-new Set(historical.trades.map(t=>t.signature+':'+t.mint+':'+t.side)).size,complete:cycles.length,otherClosed:replay.cycles.length-cycles.length,unmatchedSells:replay.unmatchedSells,open:replay.openCycles.length,subtotal:sum(cycles,c=>c.pnlSol),walletFlowSelected:sum(cycles,c=>sum(c.trades,t=>t.walletDeltaSol)),top10Share:sum([...cycles].sort((a,b)=>b.pnlSol-a.pnlSol).slice(0,10),c=>c.pnlSol)/sum(cycles,c=>c.pnlSol)},shadow:{records:shadow.length,detectedBuy:signals.filter(r=>r.side==='BUY').length,detectedSell:signals.filter(r=>r.side==='SELL').length,buys:buys.length,sells:sells.length,wins:sells.filter(r=>r.pnlSol>0).length,net,mean:net/sells.length,median:quant(sells.map(s=>s.pnlSol),.5),holds:metric(holds),prepare:metric(buys.map(b=>b.signalToPreparedMs)),drift:metric(buys.map(b=>b.entryDriftBps)),decode:metric(signals.map(s=>s.decodeMs)),resolve:metric(signals.map(s=>s.resolveMs)),queue:metric(signals.map(s=>s.queueDelayMs)),reasons,feeOnlyLosses:sells.filter(s=>s.pnlSol<0&&s.pnlSol+.00022>0).length},manual:live.filter(r=>r.type==='LIVE_BUY'||r.type==='LIVE_SELL'||r.type==='LIVE_REALIZED_PNL')};
const scenarios=[100,300,750,1500].map(ms=>({delayMs:ms,eligibleByTimeOnly:holds.filter(h=>h*1000>ms).length,pnl:'unknown: no delayed historical pool state or landing evidence'}));
fs.writeFileSync('data/sniper-copy-analysis.json',JSON.stringify({result,scenarios,cycles},(_,v)=>typeof v==='bigint'?v.toString():v,2));
const fmt=n=>Number(n).toFixed(9), link=s=>`[${s.slice(0,8)}](https://solscan.io/tx/${s})`;
const doc=['# sniper_7ufmve copy profitability','',
'A. Exact trader net profit is not established. The saved historical algorithm reproduces the subtotal below, but omits unmatched sales, open positions and potentially transfers/tips; it is not full-wallet net PnL.',
`B. Actual live-triggered shadow result at 0.005 SOL: ${fmt(net)} SOL across ${sells.length} closed modeled trades. These are quotes/models, not executed returns. The sample does not demonstrate profitable copying.`, '',
'Classification: **SHADOW ONLY**. Negative observed shadow economics and incomplete coverage do not support a live canary. They do not prove every future trade loses.','',
'## Historical selection audit','',
`Saved source: ${historical.generatedAt}; historical original report window 2026-10-17T14:54:15Z to 2026-11-01T14:54:15Z.`,
'```json',JSON.stringify(result.historical,null,2),'```',
'The old code has no explicit positive-profit filter in cycle completion. It requires an observed BUY, near-zero post-SELL balance, matching token quantities and positive quote totals. Thus 94/94 is a conditional win rate over matched complete cycles, not all trading outcomes. Nontrade flows and missing venues can invalidate inventory provenance. Reproduction from saved decoded rows is not independent RPC verification of every cycle. Wallet flow on selected transactions is not profit either: it includes rent/other transfers.','',
'## Live observations','',`Snapshot spans ${shadow[0]?.at} through ${shadow.at(-1)?.at}.`,
'```json',JSON.stringify(result.shadow,null,2),'```',
'Prepare/drift samples are successful accepted BUY probes only; they are selection-biased. Decode/resolve/queue are local measured stages. BlockTime has second resolution and does not give an accurate subsecond network-detection latency. None of these measurements proves landing or SELL execution latency. Curve exits use post-event reserve modeling; PumpSwap exit uses target-price penalty. CLOSE cost and failed actual executions are absent from these paper results.','',
'| Mint | Shadow net SOL | BUY | SELL | Exit model |','|---|---:|---|---|---|',
...sells.map(s=>`| ${s.mint} | ${fmt(s.pnlSol)} | ${link(s.entrySignature)} | ${link(s.targetSignature)} | ${s.quoteSource} |`),'',
'## Fee and delay sensitivity','',
'Shadow fixed fee is 0.00011 SOL per side: 0.00022 SOL per round trip, or 4.4% of 0.005 SOL and 2.2% of 0.01 SOL, before trading fees, slippage and CLOSE. Configured 125 bps each side implies break-even price ratio (1 + fixedCost / size) / (1 - 0.0125)^2: approximately 7.06% at 0.005 SOL and 4.80% at 0.01 SOL. These are assumptions, not actual measured average fees. Priority cap 0.0001 SOL and tip 0.000005 SOL are not universally the charged fee.',
`Removing the 0.00022 fixed round-trip charge changes ${result.shadow.feeOnlyLosses} losing modeled trades into wins. Thus fees alone do not explain most losses. At 0.01 SOL, assuming identical token price/impact and fixed fees, the six-trade extrapolation is ${fmt(2*net+sells.length*.00022)} SOL; this is not a fresh executable quote.`,
'Rent is temporary capital while the account exists and must be credited back when closed; CLOSE transaction fees remain a cost. Without confirmed historical landing/pool states, assigning a price change to 100–1500 ms would fabricate returns.','',
'| Assumed extra entry/exit delay | Accepted shadow holds longer than entry delay | PnL |','|---|---:|---|',
...scenarios.map(s=>`| ${s.delayMs} / ${s.delayMs} ms | ${s.eligibleByTimeOnly} / ${holds.length} | Unknown |`),
'Timing counts only compare accepted shadow holding intervals; they do not prove a BUY lands before source SELL.','',
'## Historical top 10 matched gains','',
'| Mint | Conditional SOL | Entry TX | Final exit TX |','|---|---:|---|---|',
...[...cycles].sort((a,b)=>b.pnlSol-a.pnlSol).slice(0,10).map(c=>`| ${c.mint} | ${fmt(c.pnlSol)} | ${link(c.trades[0].signature)} | ${link(c.trades.at(-1).signature)} |`),
'There are no losing complete cycles in this selected historical dataset; no fictional top-10 loss list is supplied. The shadow losses above are actual recorded models.','',
'## Manual control and CLOSE costs','',
'The November 4 manual PumpSwap pair recorded wallet deltas -0.007970040 SOL (BUY), +0.004489791 SOL (SELL), +0.001403840 SOL (CLOSE), totaling -0.002076409 SOL. This is realized wallet-delta accounting for that pair, not a universal trading fee. CLOSE records network fee 0.000105 SOL and reclaimed rent 0.001513840 SOL; the difference between reclaimed rent and net wallet credit is 0.000110 SOL. Do not subtract rent again. Adding a modeled 0.000110 SOL CLOSE to the six shadow cycles gives -0.003988151 SOL. At the same modeled prices, 0.01 SOL gives -0.005336302 SOL before CLOSE and -0.005996302 SOL with CLOSE. Full fixed-cost break-even with 0.000330 SOL per round trip and 125 bps per side is about 9.32% at 0.005 SOL and 5.93% at 0.01 SOL. Actual charged amounts and DEX fees may differ.',
'## Verification limits','',
'Current 24h/7d trader PnL and per-venue full coverage are not established here. The separate current RPC collection is not interchangeable with the historical window. Raw historical transactions for all 94 cycles, complete token-owner flows, exact tips/rent allocation, and delayed pool/landing states are required to claim audited net returns. The saved report and server journal do not contain all these facts. No execution configuration changes or real transactions were made.',
'Reproduce with `node scripts/sniper-copy-analysis.mjs` using the saved local historical files and downloaded JSONL snapshots. Machine-readable cycle details, signatures and summary are in ignored `data/sniper-copy-analysis.json`.','',
'## Prior real execution records (control only)','```json',JSON.stringify(result.manual,null,2),'```'];
if(fs.existsSync('data/sniper-current-pnl/summary.json')) {
 const current=read('data/sniper-current-pnl/summary.json');
 doc.push('', '## Completed fixed-window RPC reconstruction', '',
 'The cache contains every transaction body in the saved 5,958-signature 14-day collection (missing = 0). The 7d window ends 2026-11-06T12:40:26Z, not at report publication. The extra prior week supplies opening inventory where observable. These are conditional cost-model results, not a newly certified whole-wallet PnL.',
 '```json',JSON.stringify(current,null,2),'```',
 'Lamport values in this JSON are exact integer strings. The 7d reconstructed subtotal is +403.853108528 SOL; 320 unknown-cost SELLs received 249.897213220 SOL. The 24h subtotal is +94.505392317 SOL; 22 unknown-cost SELLs received 16.525988426 SOL. Receipts are not profit. Known-cycle wins: 98 of 102 weekly, 26 of 26 daily; these exclude unknown-cost positions and are not whole-strategy win rates. Pump curve subtotal +403.712770602 SOL; PumpSwap subtotal -0.121980508 SOL; mixed-route remainder +0.262318434 SOL. Cash transfers, account-local inventory and unallocated failed-attempt fees prevent upgrading these figures to audited net PnL.');
}
if(fs.existsSync('data/sniper-raw-audit.json')) {
 const raw=read('data/sniper-raw-audit.json');
 doc.push('', '## Independent raw check of the 94 selected cycles', '',
 '```json',JSON.stringify({...raw,rows:undefined},null,2),'```',
 'All successfully checked cycle transactions require the target signer, successful metadata and safe numeric lamport inputs. Raw audit details include each BUY/partial SELL signature, slot, time, token quantity, native balance change, token-account lamport change and network fee. Priority fees are already part of meta.fee. Tips and ancillary transfers are included in native changes but not proven individually; the adjusted flow therefore remains selected-transaction cash flow, not fully attributed trade profit.',
 'The historical collector explicitly used filters.status=succeeded. Consequently even fetching every saved historical signature cannot recover failed transactions that the collector never listed. The 94/94 claim has both completion-selection bias and successful-transaction selection.');
 fs.mkdirSync('docs/evidence',{recursive:true});fs.writeFileSync('docs/evidence/sniper-94-cycle-raw-audit.json',JSON.stringify(raw,null,2));
}
doc.push('', '## Actionable probe observation', '',
 'On 2026-11-07, a finalized getAccountInfo check for 4wERfPyXhdrDxbZnqoVvMRPNxBKUSQDtRPHhJD71pump returned an existing Token-2022 mint on both configured execution and analytics RPCs (slots 466562863 and 466562866). It had previously produced Mint account not found during shadow preparation. This rules out permanent current absence for that mint, but does not prove its availability at the original processed observation. Transient RPC visibility, timing or the preparation lookup require a separate reproducible diagnosis; this report does not assert a proven root cause or modify the executor.');
fs.writeFileSync('docs/sniper-7ufmve-copy-profitability.md',doc.join('\n')+'\n');console.log(JSON.stringify(result,null,2));
