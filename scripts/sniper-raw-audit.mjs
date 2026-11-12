import fs from 'node:fs';
const dir='data/sniper-current-pnl',wallet='7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL';
const old=JSON.parse(fs.readFileSync('data/sniper-copy-analysis.json'));
const safe=n=>{if(!Number.isSafeInteger(n))throw Error('Unsafe RPC balance');return BigInt(n);};
const rows=old.cycles.map(c=>{
 let delta=0n,fee=0n,rentDelta=0n,missing=0;const transactions=[];
 for(const t of c.trades){const p=`${dir}/${t.signature}.json`;if(!fs.existsSync(p)){missing++;continue;}
 const tx=JSON.parse(fs.readFileSync(p)),m=tx?.meta,k=tx?.transaction?.message?.accountKeys;if(!m||m.err)throw Error('Historical cycle transaction missing or failed');const index=k.findIndex(x=>x.pubkey===wallet);if(index<0||!k[index].signer)throw Error('Historical cycle signer mismatch');
 const native=safe(m.postBalances[index])-safe(m.preBalances[index]);let accounts=0n;
 for(const i of new Set([...m.preTokenBalances,...m.postTokenBalances].filter(x=>x.owner===wallet).map(x=>x.accountIndex)))accounts+=safe(m.postBalances[i])-safe(m.preBalances[i]);
 const paid=k[0].pubkey===wallet?safe(m.fee):0n;delta+=native;rentDelta+=accounts;fee+=paid;
 transactions.push({signature:t.signature,side:t.side,mint:t.mint,slot:tx.slot,blockTime:tx.blockTime,nativeLamports:String(native),ownedAccountLamportChange:String(accounts),networkFeeIncludingPriority:String(paid),rawTokenDelta:t.rawTokenDelta});
 }
 return {mint:c.mint,missing,transactions,eventSubtotal:c.pnlSol,walletLamportChange:String(delta),ownedAccountChange:String(rentDelta),adjustedWalletFlow:String(delta+rentDelta),networkFeeIncludingPriority:String(fee),holdSeconds:c.holdMinutes*60};
});
const result={missing:rows.reduce((s,r)=>s+r.missing,0),cycles:rows.length,networkFeesLamports:rows.reduce((s,r)=>s+BigInt(r.networkFeeIncludingPriority),0n).toString(),adjustedSelectedFlowLamports:rows.reduce((s,r)=>s+BigInt(r.adjustedWalletFlow),0n).toString(),note:'Adjusted selected-transaction cash flow includes all native costs and cancels observed account rent; not full-wallet PnL or proof of no simultaneous external transfers.',rows};
fs.writeFileSync('data/sniper-raw-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined}));
