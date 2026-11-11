import bs58 from "bs58";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { authenticatedProgramData, parseConfirmedPumpLogSignal, parsePumpTrades } from "../src/parser.js";

export const SOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATES = new Set(["214,144,76,236,95,139,49,180","24,30,200,40,5,28,7,119"]);

export function ownedBalances(tx, wallet) {
  const totals = balances => {
    const result = new Map();
    for (const b of balances ?? []) {
      if (b.owner === wallet && b.mint !== SOL) {
        result.set(b.mint, (result.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      }
    }
    return result;
  };
  const pre = totals(tx.meta.preTokenBalances), post = totals(tx.meta.postTokenBalances);
  return [...new Set([...pre.keys(), ...post.keys()])].map(mint => ({
    mint, pre: pre.get(mint) ?? 0n, post: post.get(mint) ?? 0n
  })).filter(b => b.pre !== b.post);
}

export function inspectTrade(tx, wallet, signature) {
  if (!tx?.meta || tx.meta.err) return [];
  if (!tx.transaction.message.accountKeys.some(k => k.pubkey === wallet && k.signer)) return [];
  const balances = ownedBalances(tx, wallet);
  const signal = parseConfirmedPumpLogSignal(tx, wallet, signature);
  const instructions = [...tx.transaction.message.instructions,...(tx.meta.innerInstructions??[]).flatMap(g=>g.instructions)];
  const created = new Set();
  for (const i of instructions) {
    if (i.programId!==PUMP || !i.data) continue;
    if (CREATES.has(bs58.decode(i.data).subarray(0,8).join(","))) created.add(i.accounts[0]);
  }
  const tokenQuoted = [];
  for (const {line,program} of authenticatedProgramData(tx.meta.logMessages)) {
    if (program!==PUMP) continue;
    const data=Buffer.from(line.slice("Program data: ".length),"base64");
    if (data.subarray(0,8).join(",")!=="189,219,127,211,78,230,97,238") continue;
    try {
      const e=PUMP_SDK.decodeTradeEventBc(data.subarray(8));
      const quote=e.quoteMint.toBase58();
      if (e.user.toBase58()===wallet && quote!==SYSTEM && quote!==SOL) tokenQuoted.push({
        mint:e.mint.toBase58(),side:e.isBuy?"BUY":"SELL",venue:"pump-curve",nonSol:true,quoteMint:quote
      });
    } catch { /* Unknown events cannot establish the quote currency. */ }
  }
  const rows = new Map();
  const all = [...signal.trades, ...tokenQuoted, ...parsePumpTrades(tx, wallet, signature)];
  for (const trade of all) {
    // PumpSwap logs carry the pool but omit its base mint.
    const poolDeltas = trade.pool ? ownedBalances(tx, trade.pool) : [];
    const matching = balances.filter(b =>
      (trade.side === "BUY" ? b.post > b.pre : b.post < b.pre) &&
      (trade.mint ? b.mint === trade.mint : poolDeltas.some(p => p.mint === b.mint &&
        (trade.side === "BUY" ? p.pre > p.post : p.pre < p.post))));
    const b = matching.length === 1 ? matching[0] : null;
    if (!b || rows.has(b.mint)) continue;
    const launch = trade.side==="BUY" && created.has(b.mint);
    const poolQuote = (tx.meta.postTokenBalances ?? []).find(a => a.owner === trade.pool && a.mint === SOL);
    const authenticated = signal.trades.includes(trade) || tokenQuoted.includes(trade);
    const quote = trade.nonSol || (trade.venue==="pumpswap" && poolDeltas.filter(d=>d.mint!==b.mint).length===1 && !poolQuote) ? "nonSOL"
      : authenticated && !trade.executionRoute && (trade.venue === "pump-curve" || poolQuote) ? "SOL" : "unknown";
    const eligible = authenticated && quote === "SOL" && !launch && signal.targetEventCount === 1 &&
      tokenQuoted.length===0 && balances.length === 1;
    rows.set(b.mint, { ...trade, ...b, eligible, quote, launch, authenticated,
      liquidityLamports:poolQuote?.uiTokenAmount.amount ?? trade.curveState?.realSolReservesRaw ?? null,
      blockTime: tx.blockTime, slot: tx.slot, signature });
  }
  return [...rows.values()];
}
