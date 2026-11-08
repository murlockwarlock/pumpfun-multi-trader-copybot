import { PublicKey } from "@solana/web3.js";
import { authenticatedProgramData, parsePumpLogSignal } from "./parser.js";

export const LAUNCH_TARGET = "7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE = Buffer.from([27,114,169,77,222,235,99,118]);
export const EXIT_SECONDS = { A: 1, B: 3, C: 5, D: 10, E: 15, F: null };

// Decode only the stable CreateEvent prefix. Program-stack authentication is
// shared with the trading parser; a router's forged Program data is not Pump.
export function launchSignals(value, slot, observedAtMs) {
  if (!value?.signature || value.err || !Number.isFinite(observedAtMs)) return [];
  const creations = new Map();
  for (const { program, line } of authenticatedProgramData(value.logs)) {
    if (program !== PUMP) continue;
    try {
      const b = Buffer.from(line.slice("Program data: ".length), "base64");
      if (!b.subarray(0, 8).equals(CREATE)) continue;
      let offset = 8;
      for (let n = 0; n < 3; n++) {
        const length = b.readUInt32LE(offset); offset += 4 + length;
        if (offset > b.length) throw Error("truncated creation");
      }
      if (offset + 96 > b.length) continue;
      const key = () => { const p = new PublicKey(b.subarray(offset, offset + 32)).toBase58(); offset += 32; return p; };
      const mint = key(), curve = key(), user = key();
      if (user === LAUNCH_TARGET) creations.set(mint, { curve, user });
    } catch { /* Unknown/truncated event fails closed. */ }
  }
  const { trades } = parsePumpLogSignal(value.logs, LAUNCH_TARGET, value.signature, { slot, observedAtMs });
  // One economic entry per mint, even if an atomic launch contains several BUYs.
  return [...creations].flatMap(([mint, creation]) => {
    const buys = trades.filter(t => t.mint === mint && t.side === "BUY" && t.venue === "pump-curve");
    if (!buys.length || trades.some(t => t.mint === mint && t.side === "SELL")) return [];
    const solAmount = buys.reduce((n,t) => n + t.solAmount, 0);
    const tokenAmount = buys.reduce((n,t) => n + t.tokenAmount, 0);
    return [{ ...buys.at(-1), ...creation, mint, solAmount, tokenAmount,
      averagePriceSol: solAmount / tokenAmount, observedAtMs, slot, signature: value.signature }];
  });
}

// This engine has no executor/signer interface: the injected capability is a
// read-only quote function. All six portfolios share a quote entry, not PnL.
export class LaunchFollow {
  constructor({ quote, save, emit, state = {}, now = Date.now, schedule = setTimeout,
    maxAgeMs = 1500, maxDriftBps = 2500, slippageBps = 1500,
    prioritySol = .0001, tipSol = .000005 }) {
    Object.assign(this, { quote, save, emit, now, schedule, maxAgeMs, maxDriftBps, slippageBps });
    this.fee = { baseSol: .000005, prioritySol, tipSol };
    this.state = { version: 1, launches: {}, sells: {}, ...state };
    this.busy = new Set();
    // Do not fill missed historical exits using prices observed after restart.
    for (const p of Object.values(this.state.launches)) {
      if (p.status === "PREPARING") p.status = "UNKNOWN_RESTART";
      if (p.status === "OPEN") {
        for (const variant of Object.keys(EXIT_SECONDS)) {
          if (!p.exits[variant]) p.exits[variant] = { status: "UNKNOWN", reason: "restart_observation_gap" };
        }
        p.status = "COMPLETE";
      }
    }
    this.save(this.state);
  }
  record(type, details) { this.save(this.state); this.emit({ strategy: "sniper_launch_follow", type, atMs: this.now(), ...details }); }
  async launch(signal) {
    if (this.state.launches[signal.mint]) return;
    const p = this.state.launches[signal.mint] = { ...signal, decodedAtMs: this.now(), status: "PREPARING", exits: {} };
    this.record("LAUNCH", p);
    const skip = reason => { p.status = "SKIP"; p.reason = reason; this.record("SKIP", p); };
    if (this.now() - signal.observedAtMs > this.maxAgeMs) return skip("stale_signal");
    if (this.state.sells[signal.mint]?.length) return skip("creator_sold_before_entry");
    if (Object.values(this.state.launches).filter(x => ["PREPARING", "OPEN"].includes(x.status)).length > 2) return skip("shadow_capacity");
    try {
      p.quoteStartedAtMs = this.now();
      const q = await this.quote("BUY", signal.mint, "5000000", { targetAveragePriceSol: signal.averagePriceSol, maxEntryDriftBps: this.maxDriftBps, venueHint: "pump-curve" });
      p.preparedAtMs = this.now();
      p.signalToPreparedMs = p.preparedAtMs - signal.observedAtMs;
      if (p.confirmed === false) return skip("source_transaction_failed");
      if (this.state.sells[signal.mint]?.length) return skip("creator_sold_during_preparation");
      if (p.signalToPreparedMs > this.maxAgeMs) return skip("quote_too_old");
      if (!q.expectedTokenOutRaw || BigInt(q.expectedTokenOutRaw) <= 0n) return skip("missing_quote");
      p.entry = q; p.entryPriceSol = .005 / (Number(q.expectedTokenOutRaw) / 10 ** q.tokenDecimals);
      p.entryDriftBps = (p.entryPriceSol / signal.averagePriceSol - 1) * 10000;
      if (!Number.isFinite(p.entryDriftBps) || p.entryDriftBps > this.maxDriftBps) return skip("entry_drift");
      p.accepted = true;
      p.status = "OPEN";
      this.record("BUY", p);
      for (const [variant, seconds] of Object.entries(EXIT_SECONDS)) {
        if (seconds !== null) this.schedule(() => void this.exit(p.mint, variant, p.preparedAtMs + seconds * 1000), seconds * 1000);
      }
      // F is censored, not marked profitable, if the first creator SELL is never observed.
      this.schedule(() => {
        if (!p.exits.F && !this.busy.has(`${p.mint}:F`)) {
          p.exits.F = { status: "UNKNOWN", reason: "no_creator_sell_within_1h" };
          this.record("EXIT_UNKNOWN", { mint: p.mint, variant: "F", ...p.exits.F });
          this.finish(p);
        }
      }, 3600000);
    } catch (e) { skip(/price limit|drift/.test(e.message) ? "entry_price_limit" : `quote_error:${e.message}`); }
  }
  creatorSell(t) {
    if (!t.mint) return;
    const sells = this.state.sells[t.mint] ??= [];
    if (sells.some(s => s.signature === t.signature)) return;
    sells.push({ signature: t.signature, observedAtMs: t.observedAtMs, slot: t.slot, tokenAmount: t.tokenAmount, blockTime: t.blockTime });
    const p = this.state.launches[t.mint];
    this.record("CREATOR_SELL", { mint: t.mint, ...sells.at(-1),
      sinceLaunchObservedMs: p ? t.observedAtMs - p.observedAtMs : null,
      sincePreparedMs: p?.preparedAtMs ? t.observedAtMs - p.preparedAtMs : null });
    if (p?.status === "OPEN" && !p.exits.F) void this.exit(t.mint, "F", sells[0].observedAtMs);
  }
  async exit(mint, variant, dueAtMs) {
    const p = this.state.launches[mint], key = `${mint}:${variant}`;
    if (p?.status !== "OPEN" || p.exits[variant] || this.busy.has(key)) return;
    this.busy.add(key);
    const start = this.now();
    let result;
    try {
      if (start - dueAtMs > 500) throw Error("missed_exit_deadline");
      const q = await this.quote("SELL", mint, p.entry.expectedTokenOutRaw, {});
      const end = this.now();
      if (!q.expectedSolOutRaw || end - dueAtMs > 1500) throw Error("exit_quote_missing_or_late");
      const proceedsSol = Number(q.expectedSolOutRaw) / 1e9;
      const sideFee = this.fee.baseSol + this.fee.prioritySol + this.fee.tipSol;
      result = { status: "QUOTED", dueAtMs, startedAtMs: start, preparedAtMs: end,
        latenessMs: end - dueAtMs, quote: q, proceedsSol,
        networkModel: { buy: this.fee, sell: this.fee, close: this.fee },
        fixedFeesSol: 3 * sideFee, tradingFees: "included_in_SDK_quote",
        rentDebitSol: p.entry.rentSol ?? null, rentRefundSol: p.entry.rentSol ?? null,
        rentNetSol: 0, closeAssumption: "full_refund_and_successful_close",
        netPnlSol: proceedsSol - .005 - 3 * sideFee,
        slippageBps: this.slippageBps,
        sellSlippageFloorPnlSol: proceedsSol * (1 - this.slippageBps / 10000) - .005 - 3 * sideFee };
    } catch(e) { result = { status: "UNKNOWN", dueAtMs, startedAtMs: start, reason: e.message }; }
    p.exits[variant] = result; this.busy.delete(key);
    this.record("EXIT", { mint, signature: p.signature, variant, ...result });
    this.finish(p);
  }
  finish(p) {
    if (Object.keys(p.exits).length === 6) { p.status = "COMPLETE"; this.record("COMPLETE", { mint: p.mint }); }
  }
}
