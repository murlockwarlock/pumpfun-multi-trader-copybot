import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { admitToCohort } from "./launch-cohort.js";
import { Worker } from "node:worker_threads";
import { authenticatedProgramData, parsePumpLogSignal } from "./parser.js";

export const LAUNCH_TARGET = "7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CREATE = Buffer.from([27,114,169,77,222,235,99,118]);
export const EXIT_SECONDS = { A: 1, B: 3, C: 5, D: 10, E: 15, F: null };
export const RESEARCH_PROTOCOL = "launch-follow-confirmed-v1";

export class LaunchFollowSupervisor {
  constructor(workerData, log, { timeoutMs=15000, restartMs=1000 }={}) {
    Object.assign(this,{workerData,log,timeoutMs,restartMs});
    this.pending=new Map(); this.sequence=0; this.status={state:"STARTING"}; this.closed=false;
    this.start();
    this.timer=setInterval(()=>{
      const oldest=this.pending.values().next().value;
      if(this.worker&&(Date.now()-this.lastReplyAt>timeoutMs || oldest&&Date.now()-oldest.queuedAt>timeoutMs)) {
        this.warn("worker_unresponsive"); void this.worker.terminate();
      }
    },Math.min(1000,timeoutMs/2));
    this.timer.unref();
  }
  warn(reason,details={}) {
    this.gapStart??=this.lastReplyAt??Date.now();
    this.status={...this.status,state:"DEGRADED",reason};
    this.log("launch_follow_warning",{reason,...details});
  }
  start() {
    if(this.closed)return;
    const worker=this.worker=new Worker(new URL("./launch-follow-worker.js",import.meta.url),{workerData:this.workerData});
    this.lastReplyAt=Date.now();
    worker.on("message",m=>{
      if(m.type==="ack"){this.pending.delete(m.id);return;}
      if(m.type==="fatal"){this.warn("worker_fatal",{message:m.message});return;}
      if(m.type==="ready") {
        this.failures=0;
        if(this.gapStart){worker.postMessage({kind:"gap",reason:"supervisor_outage",startMs:this.gapStart,endMs:Date.now()});this.gapStart=null;}
        for(const {message} of this.pending.values())worker.postMessage(message);
        this.status={state:"READY"};this.log("launch_follow_ready",m);
      }
      if(m.type==="heartbeat") {
        const issues=m.issues??[];
        if((m.rpc?.errors??0)>(this.status.rpc?.errors??0)) this.log("launch_follow_warning",{reason:"quote_rpc_errors",rpc:m.rpc});
        if(issues.join(",")!==(this.status.issues??[]).join(",")&&issues.length)this.warn("observer_coverage",{issues});
        this.status={...m,state:issues.length?"DEGRADED":"HEALTHY"};
      }
      this.lastReplyAt=Date.now();
    });
    worker.on("error",e=>this.warn("worker_error",{message:e.message}));
    worker.on("exit",code=>{
      if(this.worker===worker)this.worker=null;
      if(!this.closed){this.warn("worker_exit",{code});this.failures=(this.failures??0)+1;this.restartTimer=setTimeout(()=>this.start(),Math.min(60000,this.restartMs*2**Math.min(6,this.failures-1)));}
    });
  }
  post(message) {
    const id=++this.sequence;
    if(this.pending.size>=512) {
      this.pending.delete(this.pending.keys().next().value);this.warn("ipc_overflow");
      this.worker?.postMessage({kind:"gap",reason:"ipc_overflow"});
    }
    this.pending.set(id,{message:{...message,id},queuedAt:Date.now()});
    this.worker?.postMessage({...message,id});
  }
  health(){return {...this.status,lastReplyAtMs:this.lastReplyAt,pending:this.pending.size};}
  stop(){this.closed=true;clearInterval(this.timer);clearTimeout(this.restartTimer);return this.worker?.terminate();}
}

export function confirmedLaunches(tx, signature, observedAtMs) {
  if (!tx?.meta || tx.meta.err !== null || !tx.transaction?.signatures?.includes(signature)) return [];
  const keys = tx.transaction.message.accountKeys ?? [];
  const key = x => typeof x === "number" ? key(keys[x]) : typeof x === "string" ? x : x?.pubkey;
  if (!keys.some(k => key(k) === LAUNCH_TARGET && k.signer === true)) return [];
  const inner=new Map((tx.meta.innerInstructions??[]).map(group=>[group.index,group.instructions]));
  const instructions=(tx.transaction.message.instructions??[]).flatMap((instruction,index)=>[instruction,...(inner.get(index)??[])]);
  const pumpInstructions=instructions.flatMap(i=>{
    if (key(i.programId ?? i.programIdIndex) !== PUMP || !i.data) return [];
    try {
      const d=bs58.decode(i.data).subarray(0,8).join(",");
      const accounts=i.accounts.map(key);
      if(d==="214,144,76,236,95,139,49,180"||d==="24,30,200,40,5,28,7,119") {
        return [{kind:"create",mint:accounts[0],curve:accounts[2],user:accounts[d.startsWith("214")?5:7]}];
      }
      if(d==="225,247,80,30,213,179,132,136"||d==="7,5,29,196,245,23,101,80") {
        return [{kind:"buy_v3",mint:accounts[1],quoteMint:accounts[2],curve:accounts[5],user:accounts[8]}];
      }
    } catch { /* Unknown instruction is not evidence. */ }
    return [];
  });
  const sameLaunch=(a,b)=>a.mint===b.mint&&a.curve===b.curve&&a.user===b.user;
  const logged=launchSignals({signature, logs:tx.meta.logMessages},tx.slot,observedAtMs)
    .filter(s=>pumpInstructions.some(i=>i.kind==="create"&&sameLaunch(i,s)));
  const output=[...logged];
  for(const [index,creation] of pumpInstructions.entries()) {
    if(creation.kind!=="create"||creation.user!==LAUNCH_TARGET||output.some(s=>s.mint===creation.mint))continue;
    const buy=pumpInstructions.slice(index+1).find(i=>i.kind==="buy_v3"&&sameLaunch(i,creation)&&
      i.quoteMint&&!["11111111111111111111111111111111","So11111111111111111111111111111111111111112"].includes(i.quoteMint));
    if(!buy)continue;
    const balance=rows=>(rows??[]).filter(r=>r.owner===LAUNCH_TARGET&&r.mint===creation.mint)
      .reduce((n,r)=>n+BigInt(r.uiTokenAmount.amount),0n);
    const delta=balance(tx.meta.postTokenBalances)-balance(tx.meta.preTokenBalances);
    if(delta<=0n)continue;
    // Preserve observed launches without allowing the SOL pricing path to
    // interpret a different quote asset or a wallet SOL delta as its price.
    output.push({...creation,signature,slot:tx.slot,blockTime:tx.blockTime,observedAtMs,quoteMint:buy.quoteMint,
      tokenAmountRaw:String(delta),unsupportedReason:"unsupported_non_sol_curve",solAmount:null,averagePriceSol:null});
  }
  return output;
}

export function quoteSlotValid(q, slot) {
  const required = Math.max(slot, q?.requiredContextSlot ?? slot);
  return Number.isSafeInteger(slot) && Number.isSafeInteger(required) &&
    Number.isSafeInteger(q?.marketContextSlot) && q.marketContextSlot >= required;
}
function researchQuoteValid(launch,quote) {
  return !launch.epochId || (quote.marketCommitment==="confirmed" && quote.contextVerified===true);
}

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
    prioritySol = .0001, tipSol = .000005, research = false, archived = () => false, archivedWsAt = () => undefined }) {
    Object.assign(this, { quote, save, emit, now, schedule, maxAgeMs, maxDriftBps, slippageBps, research, archived, archivedWsAt });
    this.fee = { baseSol: .000005, prioritySol, tipSol };
    this.state = { version: 1, launches: {}, sells: {}, ...state };
    if (this.state.epoch) {
      const epoch=this.state.epoch;
      this.maxAgeMs=epoch.maxAgeMs;
      this.maxDriftBps=epoch.maxDriftBps;
      this.slippageBps=epoch.slippageBps;
      this.fee=epoch.fees;
    }
    const previous = this.state.observation;
    this.state.observation ??= { startedAtMs:now(), ws:{}, confirmed:{}, gaps:[], counters:{}, lastHeartbeatAtMs:now() };
    if (previous) this.gap("worker_restart", previous.lastHeartbeatAtMs, now());
    else if (Object.keys(this.state.launches).length) this.gap("legacy_uninstrumented_state", null, now());
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
  gap(reason, startMs = this.now(), endMs = null) {
    const o=this.state.observation;
    if (endMs===null && o.gaps.some(g=>g.reason===reason&&g.endMs===null)) return;
    o.gaps.push({reason,startMs,endMs,backfillBeforeMs:o.coverage?.lastPollAtMs??null,
      beforeSweep:o.lastBackfillSweep??null});
    this.record("DATA_GAP", {reason,startMs,endMs});
  }
  observeWs(signature, atMs) {
    const o=this.state.observation; o.ws[signature] ??= atMs; o.lastWsAtMs=atMs;
    this.record("WS",{signature,observedAtMs:atMs});
  }
  confirm(tx, signature) {
    const o=this.state.observation;
    const observedAt=o.ws[signature]??this.archivedWsAt(signature);
    const at=observedAt??this.now();
    if(!tx?.meta||!Object.hasOwn(tx.meta,"err")||!tx.transaction?.signatures?.includes(signature)||!Number.isSafeInteger(tx.slot)) {
      this.gap("invalid_transaction_metadata",at,this.now());return;
    }
    const launches=confirmedLaunches(tx,signature,at);
    o.confirmed[signature]={atMs:this.now(),slot:tx?.slot,blockTime:tx.blockTime,successful:tx?.meta?.err===null};
    for (const s of launches) if (!this.state.launches[s.mint] && !this.archived(s.mint)) {
      const sourceAtMs = Number.isFinite(tx.blockTime) ? tx.blockTime * 1000 : null;
      const seen=observedAt!==undefined;
      this.state.launches[s.mint]={...s,sourceAtMs,epochId:this.epochFor(sourceAtMs??at),
        status:s.unsupportedReason&&seen?"SKIP":"MISSED",
        reason:!seen?"missing_ws":s.unsupportedReason??"missed_decoder",exits:{},confirmed:true,confirmedAtMs:this.now(),
        verification:s.unsupportedReason?"matched_create_buy_instructions":"matched_create_buy_v2"};
      this.registerCohort(this.state.launches[s.mint]);
      if(!s.unsupportedReason||!seen)this.gap("missed_opportunity",at,this.now());
    }
    for (const p of Object.values(this.state.launches).filter(p=>p.signature===signature)) {
      const s=launches.find(s=>s.mint===p.mint);
      p.confirmed=Boolean(s && ["user","curve","slot","solAmount","tokenAmount","quoteMint","tokenAmountRaw"].every(k=>s[k]===p[k]));
      p.verification=p.confirmed?(s.unsupportedReason?"matched_create_buy_instructions":"matched_create_buy_v2"):"source_mismatch";
      p.confirmedAtMs=this.now();
      if (!p.confirmed) { p.dataInvalid=true; this.gap("source_mismatch",p.observedAtMs,this.now()); }
    }
    this.record("VERIFICATION",{signature,launches:launches.length});
  }
  heartbeat(coverage, rpc) {
    const o=this.state.observation;
    o.lastHeartbeatAtMs=this.now(); o.coverage=coverage; o.rpc=rpc;
    const issues=[];
    if (coverage?.wsAvailable===false) issues.push("ws_unavailable");
    if (!coverage?.lastPollAtMs || this.now()-coverage.lastPollAtMs>60000) issues.push("backfill_unavailable");
    for (const reason of ["ws_unavailable","backfill_unavailable"]) {
      const open=o.gaps.find(g=>g.reason===reason&&g.endMs===null);
      if (issues.includes(reason) && !open) this.gap(reason);
      if (!issues.includes(reason) && open) {
        open.endMs=this.now();
        this.record("DATA_GAP_CLOSED",open);
      }
    }
    if (this.research && !this.state.epoch && coverage?.wsAvailable && !issues.length) {
      const startsAtMs=Math.ceil((this.now()+1)/1000)*1000;
      this.state.epoch={id:RESEARCH_PROTOCOL+":"+startsAtMs,protocol:RESEARCH_PROTOCOL,startsAtMs,
        exploratorySize:25,holdoutSize:25,marketCommitment:"confirmed",buySol:.005,
        slippageBps:this.slippageBps,maxAgeMs:this.maxAgeMs,maxDriftBps:this.maxDriftBps,fees:this.fee};
      this.record("EPOCH_STARTED",this.state.epoch);
    }
    const unresolved=Object.entries(o.ws).filter(([s,t])=>!o.confirmed[s]&&this.now()-t>60000).map(([s])=>s);
    o.unresolvedBackfill=Object.entries(o.catalog??{}).filter(([s,r])=>!r.err&&!o.confirmed[s]&&this.now()-r.atMs>60000).map(([s])=>s);
    if(o.unresolvedBackfill.length) issues.push("backfill_metadata_missing");
    o.unresolvedWs=unresolved;
    if(unresolved.length) issues.push("unverified_ws");
    if (unresolved.length && !o.gaps.some(g=>g.reason==="unverified_ws"&&g.endMs===null)) {
      this.gap("unverified_ws",Math.min(...unresolved.map(s=>o.ws[s])));
    }
    if (!unresolved.length) for (const g of o.gaps) if (g.reason==="unverified_ws"&&g.endMs===null) g.endMs=this.now();
    o.counters={...o.counters,wsSignatures:Object.keys(o.ws).length,confirmedSignatures:Object.keys(o.confirmed).length,
      launches:Object.keys(this.state.launches).length,missed:Object.values(this.state.launches).filter(p=>p.status==="MISSED").length};
    this.save(this.state);
    return {...o.counters,issues,unresolvedWs:unresolved.length,lastHeartbeatAtMs:o.lastHeartbeatAtMs,rpc,dataGapCount:o.gaps.length,
      activity:issues.length?"DEGRADED":o.lastWsAtMs&&this.now()-o.lastWsAtMs<60000?"ACTIVE":"IDLE_VERIFIED_BY_BACKFILL"};
  }
  epochFor(atMs) {
    const epoch=this.state.epoch;
    return epoch && atMs>=epoch.startsAtMs ? epoch.id : null;
  }
  registerCohort(launch) {
    if (!launch.epochId) return;
    this.state.cohort??={exploratory:[],holdout:[],breaches:0};
    admitToCohort(this.state.cohort,launch);
  }
  async launch(signal) {
    const prior=this.state.launches[signal.mint];
    if (prior || this.archived(signal.mint)) {
      const cohort=this.state.cohort;
      const pinned=cohort&&[...cohort.exploratory,...cohort.holdout].find(p=>p.mint===signal.mint);
      const identity=pinned??prior;
      if(identity&&(identity.signature!==signal.signature||identity.slot!==signal.slot)&&!prior?.dataInvalid) {
        if(prior)prior.dataInvalid=true;
        if(pinned) {
          cohort.reorgs??={};
          if(cohort.reorgs[signal.mint])return;
          cohort.reorgs[signal.mint]={signature:signal.signature,slot:signal.slot,observedAtMs:signal.observedAtMs};
          cohort.breaches=(cohort.breaches??0)+1;
        }
        this.record("SOURCE_IDENTITY_CONFLICT",{mint:signal.mint,expected:identity.signature,actual:signal.signature});
      }
      return;
    }
    const p = this.state.launches[signal.mint] = { ...signal, decodedAtMs: this.now(), status: "PREPARING", exits: {},
      epochId:this.epochFor(signal.observedAtMs) };
    this.registerCohort(p);
    this.record("LAUNCH", p);
    const skip = reason => { p.status = "SKIP"; p.reason = reason; p.decisionAtMs=this.now();
      p.quoteElapsedMs=p.quoteStartedAtMs?this.now()-p.quoteStartedAtMs:null; this.record("SKIP", p); };
    if (this.now() - signal.observedAtMs > this.maxAgeMs) return skip("stale_signal");
    if (this.state.sells[signal.mint]?.length) return skip("creator_sold_before_entry");
    if (Object.values(this.state.launches).filter(x => ["PREPARING", "OPEN"].includes(x.status)).length > 2) return skip("shadow_capacity");
    try {
      p.quoteStartedAtMs = this.now();
      const q = await this.quote("BUY", signal.mint, "5000000", { marketCommitment:p.epochId?"confirmed":"processed", minContextSlot:signal.slot, targetAveragePriceSol: signal.averagePriceSol, maxEntryDriftBps: this.maxDriftBps, venueHint: "pump-curve" });
      p.quoteElapsedMs=this.now()-p.quoteStartedAtMs;
      p.quoteRpcMs=q.rpcMs??null;
      p.quoteTelemetry={firstContextAtMs:q.firstContextAtMs,quoteMs:q.quoteMs,rpcMs:q.rpcMs,marketCommitment:q.marketCommitment};
      if (!researchQuoteValid(p,q)) return skip("confirmed_quote_unproven");
      if (!quoteSlotValid(q,signal.slot)) { p.dataInvalid=true; this.gap("stale_market_slot",this.now(),this.now()); return skip("stale_market_slot"); }
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
    } catch (e) {
      p.quoteTelemetry=e.shadowQuoteTelemetry??null;
      skip(/price limit|drift/.test(e.message) ? "entry_price_limit" : `quote_error:${e.message}`);
    }
  }
  creatorSell(t) {
    if (!t.mint || this.archived(t.mint)) return;
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
      const requiredSlot=Math.max(p.slot,p.entry.marketContextSlot,...(this.state.sells[mint]??[]).map(s=>s.slot??0));
      const q = await this.quote("SELL", mint, p.entry.expectedTokenOutRaw, {minContextSlot:requiredSlot,marketCommitment:p.epochId?"confirmed":"processed"});
      if (!researchQuoteValid(p,q)) throw Error("confirmed_quote_unproven");
      if (!quoteSlotValid(q,requiredSlot)) { p.dataInvalid=true; this.gap("stale_market_slot",this.now(),this.now()); throw Error("stale_market_slot"); }
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
