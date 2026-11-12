import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import WebSocket from "ws";
import { PumpExecutor } from "../src/pump-executor.js";
import { parsePumpLogSignal } from "../src/parser.js";
import { readOnlyBudgetFetch } from "../src/shadow-rpc-budget.js";
import { inspectTrade } from "./copy-candidate-trade.mjs";
import { observerBudget } from "./next-copy-budget.mjs";
import { quoteFailure } from "./next-copy-reasons.mjs";
import { wsDiagnostics } from "./next-copy-ws-diagnostics.mjs";
import { CONTROL_INPUT, FIXED_FEE, SLIPPAGE_BPS, discount, modelNet, parseSizeSol } from "./next-copy-economics.mjs";

export { modelNet };
const DEADLINE = 2500;
const HORIZONS = [10, 30, 120];
const HOLD_LIMIT = 900;

export function modelBuyQuantity(quote) {
  const expected = BigInt(quote.expectedTokenOutRaw);
  const floor = BigInt(quote.hardMinimumTokenOutRaw);
  return discount(expected) > floor ? discount(expected) : floor;
}

export function timely(quote, sourceSlot, dueAt, now) {
  return quoteFailure(quote,sourceSlot,dueAt,now,DEADLINE)===null;
}

function start(file, wallets, input) {
  if (!file || !wallets.length || wallets.length > 5 || new Set(wallets).size !== wallets.length) {
    throw Error("Usage: next-copy-observer.mjs JOURNAL.jsonl WALLET [up to four more] [--size-sol=0.06]");
  }
  wallets.forEach(w => new PublicKey(w));
  const http = process.env.COPY_OBSERVER_RPC ?? "https://api.mainnet-beta.solana.com";
  const ws = process.env.COPY_OBSERVER_WS ?? "wss://api.mainnet-beta.solana.com";
  const study = process.env.COPY_OBSERVER_STUDY ? JSON.parse(process.env.COPY_OBSERVER_STUDY) : undefined;
  const run = randomUUID();
  const out = fs.openSync(file, "a");
  const emit = (type, data = {}) => fs.writeSync(out,
    JSON.stringify({run, type, at:Date.now(), ...data}) + "\n");
  const marketBudget=observerBudget({wallets,limit:45,unit:9,maxActive:1,phaseReserves:{BUY:9,SELL:9}});
  const verifyBudget=observerBudget({wallets,limit:18,unit:1,phaseReserves:{SOURCE:1,FINALITY:3}});
  let providerCooldown=0;
  function checkProvider() {
    if (Date.now()<providerCooldown) throw Error("rpc_provider_cooldown");
  }
  async function request(url, options) {
    checkProvider();
    const response=await fetch(url,options);
    if (response.status===429) providerCooldown=Date.now()+30000;
    return response;
  }
  const quoteFetch = readOnlyBudgetFetch({perSecond:8,perMinute:45,request});
  const marketFetch=(url,options)=>{
    checkProvider();
    const body=JSON.parse(options.body);
    marketBudget.consume(Array.isArray(body)?body.length:1);
    return quoteFetch(url,options);
  };
  // A public, unfunded placeholder is used for PDA derivation only. No keypair is loaded.
  const executor = new PumpExecutor({rpcHttpUrl:http, rpcTimeoutMs:1900, liveSlippageBps:SLIPPAGE_BPS,
    shadowReadOnlyFetch:marketFetch}, {publicKey:new PublicKey("11111111111111111111111111111111")},
    {enableFallback:false,quoteOnly:true});
  const tracked = new Map(), seen = new Map(), timers = new Set(), finality = new Map(), ingress = new Map();
  const wsTrace=wsDiagnostics();
  let closed = false, generation = 0, verifyTimes = [];
  const verification={requests:0,errors:0,rateLimited:0};
  let socket, reconnectTimer, heartbeat, activeSubs = new Map(), lastPong = 0;
  const later = (fn, ms) => {
    const timer = setTimeout(() => {timers.delete(timer); fn();},Math.max(0,ms));
    timers.add(timer);
  };
  async function readRpc(method, params, wallet) {
    const now = Date.now();
    verifyTimes = verifyTimes.filter(t => t > now - 1000);
    if (verifyTimes.length>=3) throw Error("verification_budget");
    checkProvider();
    return verifyBudget.run(wallet,wallet?"SOURCE":"FINALITY",async()=>{
      verifyBudget.consume();
      verifyTimes.push(now);
      verification.requests++;
      try {
        const response = await request(http,{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(1900)});
        if (response.status===429) verification.rateLimited++;
        if (!response.ok) throw Error("verification_http_" + response.status);
        const body = await response.json();
        if (body.error) throw Error("verification_rpc_error_"+body.error.code);
        if (!body.result) throw Error("source_transaction_missing");
        return body.result;
      } catch(error) { verification.errors++;throw error; }
    });
  }
  const unknown = (phase, data, reason) => emit("UNKNOWN",{phase,...data,reason});
  const errorCode = error => String(error.message).replace(/https?:\/\/[^ ]+/g,"[endpoint]").slice(0,240);
  async function checkFinality() {
    for (const [signature, entry] of finality) {
      if (Date.now()-entry.at <= 180000) continue;
      emit("FINALITY_UNKNOWN",{signature,slot:entry.slot});
      finality.delete(signature);
    }
    const signatures=[...finality.keys()].slice(0,64);
    if (!signatures.length) return;
    try {
      const response=await readRpc("getSignatureStatuses",[signatures]);
      response.value.forEach((status,i)=>{
        const signature=signatures[i];
        const entry=finality.get(signature);
        if (!entry || status?.confirmationStatus!=="finalized") return;
        emit(status.err || entry.slot!==status.slot?"FINALITY_MISMATCH":"FINALIZED",{signature,slot:status.slot});
        finality.delete(signature);
      });
    } catch(error) {emit("FINALITY_POLL_ERROR",{reason:errorCode(error)});}
  }
  async function quoteSell(pos, kind, dueAt, minSlot, signature = null, exitSlot = null) {
    const data = {...pos.ids,kind,dueAt,minSlot,exitSignature:signature,exitSlot,quantityRaw:pos.quantity.toString(),
      inputLamports:input.toString()};
    if (closed || Date.now()-dueAt > DEADLINE) return unknown("SELL",data,"deadline_before_quote");
    try {
      const quote = await marketBudget.run(pos.ids.wallet,"SELL",()=>executor.quoteShadow("SELL",pos.ids.mint,pos.quantity.toString(),{
        marketCommitment:"confirmed",minContextSlot:minSlot}));
      const ended = Date.now();
      const failure=quoteFailure(quote,minSlot,dueAt,ended,DEADLINE);
      if (failure) return unknown("SELL",{...data,latencyMs:ended-dueAt,
        marketContextSlot:quote.marketContextSlot,marketCommitment:quote.marketCommitment},failure);
      emit("SELL_QUOTE",{...data,quote,latencyMs:ended-dueAt,
        minOutRaw:discount(BigInt(quote.expectedSolOutRaw)).toString(),netLamports:modelNet(quote,input).toString(),
        netIfRentNotRecoveredLamports:modelNet(quote,input,pos.rent).toString(),
        networkFeeLamports:FIXED_FEE.toString(),closeFeeLamports:FIXED_FEE.toString()});
    } catch (error) { unknown("SELL",data,errorCode(error)); }
  }
  async function observe(base, parsed, gen) {
    const {wallet,signature,slot,observedAt}=base;
    let verified;
    try {
      if (Date.now()-observedAt>DEADLINE) throw Error("verification_queue_deadline");
      const tx = await readRpc("getTransaction",[signature,{
        encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0
      }],wallet);
      if (tx.slot !== slot || tx.transaction.signatures?.[0] !== signature) throw Error("source_transaction_mismatch");
      verified = inspectTrade(tx,wallet,signature);
    } catch (error) { return unknown("SOURCE",base,errorCode(error)); }
    const t = verified.length===1 ? verified[0] : null;
    // An authenticated sale can be a timing signal even if its route is not
    // available to the copy. The exit is still quoted in our own SOL market.
    const exitSignal = t?.side==="SELL" && t.authenticated && parsed.targetEventCount===1;
    if (!t || (!t.eligible && !exitSignal)) {
      emit("INELIGIBLE",{...base,trades:verified.map(t=>({side:t.side,venue:t.venue,quote:t.quote,launch:t.launch}))});
      return;
    }
    const ids = {...base,mint:t.mint};
    const matchesLog=parsed.trades.some(p => (p.mint===t.mint || (!p.mint && p.pool && p.pool===t.pool)) &&
      p.side===t.side && p.venue===t.venue);
    if (!matchesLog && !(exitSignal && t.nonSol && parsed.trades.length===0)) {
      return unknown("SOURCE",ids,"log_trade_mismatch");
    }
    finality.set(signature,{slot,at:Date.now()});
    emit(t.eligible?"ELIGIBLE":"TARGET_SELL_SIGNAL",{...ids,side:t.side,venue:t.venue,sourceBlockTime:t.blockTime,
      approximateSourceAgeMs:Number.isFinite(t.blockTime)?observedAt-t.blockTime*1000:null});
    const positionKey = wallet + ":" + t.mint;
    if (t.side === "SELL") {
      const p = tracked.get(positionKey);
      if (!p || p.triggered || slot < p.ids.slot) return;
      p.triggered = true;
      if (p.generation !== gen) return unknown("SELL",{...p.ids,kind:"target"},"subscription_gap");
      void p.entry.then(()=>{
        if (!p.quantity) return unknown("SELL",{...p.ids,kind:"target"},"no_timely_buy_quote");
        return quoteSell(p,"target",observedAt,Math.max(slot,p.marketSlot),signature,slot);
      }).catch(error=>emit("ERROR",{reason:errorCode(error)}));
      return;
    }
    if (tracked.has(positionKey) || tracked.size >= 12) {
      return unknown("BUY",ids,tracked.has(positionKey)?"overlapping_mint":"position_budget");
    }
    const p = {ids,generation:gen,quantity:null,triggered:false};
    tracked.set(positionKey,p);
    p.entry = (async () => {
      if (Date.now()-observedAt > DEADLINE) return unknown("BUY",ids,"verification_deadline");
      try {
        const quote = await marketBudget.run(wallet,"BUY",()=>executor.quoteShadow("BUY",t.mint,input.toString(),{
          marketCommitment:"confirmed",minContextSlot:slot,venueHint:t.venue,
          targetAveragePriceSol:t.averagePriceSol,maxEntryDriftBps:2500}));
        const ended = Date.now();
        const failure=quoteFailure(quote,slot,observedAt,ended,DEADLINE);
        if (failure) return unknown("BUY",{...ids,latencyMs:ended-observedAt,
          marketContextSlot:quote.marketContextSlot,marketCommitment:quote.marketCommitment},failure);
        const quantity = modelBuyQuantity(quote);
        if (quantity <= 0n || quantity > BigInt(quote.expectedTokenOutRaw)) return unknown("BUY",ids,"invalid_minimum");
        if (!Number.isFinite(quote.rentSol) || quote.rentSol<0) return unknown("BUY",ids,"rent_unknown");
        p.rent = BigInt(Math.round(quote.rentSol*1e9));
        p.quantity = quantity;
        p.marketSlot = quote.marketContextMaxSlot ?? quote.marketContextSlot;
        emit("BUY_QUOTE",{...ids,quote,inputLamports:input.toString(),quantityRaw:p.quantity.toString(),
          entryDriftBps:(Number(input)/1e9/(Number(quote.expectedTokenOutRaw)/10**quote.tokenDecimals)/
            t.averagePriceSol-1)*10000,
          minOutRaw:p.quantity.toString(),latencyMs:ended-observedAt,networkFeeLamports:FIXED_FEE.toString(),
          closeFeeLamports:FIXED_FEE.toString()});
        for (const horizon of HORIZONS) {
          const dueAt = observedAt + horizon*1000;
          later(()=>void quoteSell(p,horizon+"s",dueAt,p.marketSlot),dueAt-Date.now());
        }
      } catch (error) { unknown("BUY",ids,errorCode(error)); }
    })();
    void p.entry.then(()=>{
      if (!p.quantity) {tracked.delete(positionKey); return;}
      later(()=>{
        if (!p.triggered) unknown("SELL",{...p.ids,kind:"target"}, "no_verified_target_sell_within_900s");
        tracked.delete(positionKey);
      },observedAt+HOLD_LIMIT*1000-Date.now());
    }).catch(error=>emit("ERROR",{reason:errorCode(error)}));
  }
  function connect() {
    const subs = new Map();
    const gen = ++generation;
    socket = new WebSocket(ws,{handshakeTimeout:8000});
    const current = socket;
    lastPong = Date.now();
    current.on("pong",()=>{lastPong=Date.now();});
    current.on("open",()=>{
      lastPong=Date.now();
      wallets.forEach((wallet,i)=>current.send(JSON.stringify({jsonrpc:"2.0",id:i+1,method:"logsSubscribe",
        params:[{mentions:[wallet]},{commitment:"confirmed"}]})));
    });
    current.on("message",raw=>{
      const observedAt=Date.now();
      let msg;
      try {msg=JSON.parse(raw);} catch {return;}
      if (msg.id) {
        if (!Number.isSafeInteger(msg.result)) {emit("WS_SUBSCRIBE_ERROR",{wallet:wallets[msg.id-1],gen});current.terminate();return;}
        subs.set(msg.result,wallets[msg.id-1]);
        emit("SUBSCRIBED",{wallet:wallets[msg.id-1],gen});
      }
      if (msg.method!=="logsNotification") return;
      const wallet=subs.get(msg.params?.subscription), result=msg.params?.result;
      const filtered=wsTrace.receive(wallet);
      const value=result?.value, slot=result?.context?.slot;
      if (!wallet) return;
      if (!value||!Number.isSafeInteger(slot)) return filtered("invalid_notification",value,slot);
      if (value.err) return filtered("transaction_error",value,slot);
      const parsed=parsePumpLogSignal(value.logs,wallet,value.signature,{slot,observedAtMs:observedAt});
      if (!parsed.targetEventCount) return filtered("no_target_event",value,slot);
      const key=wallet+":"+value.signature;
      if (seen.has(key)) return filtered("duplicate",value,slot);
      seen.set(key,observedAt);
      if (seen.size>8192) seen.delete(seen.keys().next().value);
      const base={wallet,signature:value.signature,slot,observedAt};
      emit("SIGNAL",{...base,events:parsed.targetEventCount,provisionalSides:parsed.trades.map(t=>t.side)});
      const queue=ingress.get(wallet)??{tail:Promise.resolve(),pending:0};
      if (queue.pending>=4) return unknown("SOURCE",base,"verification_queue_full");
      queue.pending++;
      // Verify in arrival order. Market quotes remain independent.
      queue.tail=queue.tail.then(()=>observe(base,parsed,gen))
        .catch(error=>emit("ERROR",{reason:errorCode(error)}))
        .finally(()=>queue.pending--);
      ingress.set(wallet,queue);
    });
    current.on("error",()=>emit("WS_ERROR",{gen}));
    current.on("close",code=>{
      subs.clear();
      emit("WS_GAP",{gen,code});
      if (!closed) reconnectTimer=setTimeout(connect,15000);
    });
    heartbeat ??= setInterval(()=>{
      if (socket.readyState===WebSocket.OPEN) {
        if (Date.now()-lastPong>45000) socket.terminate();
        else socket.ping();
      }
      emit("HEALTH",{gen:generation,subscriptions:activeSubs.size,subscribedWallets:[...activeSubs.values()],
        lastPong,open:tracked.size,rpc:quoteFetch.stats(),verification,ws:wsTrace.flush()});
      void checkFinality();
    },20000);
    // Heartbeat reads the state of the currently connected socket.
    activeSubs=subs;
  }
  const shutdown=()=>{
    if (closed) return;
    closed=true;
    clearInterval(heartbeat);
    clearTimeout(reconnectTimer);
    for (const t of timers) clearTimeout(t);
    emit("STOP",{open:tracked.size,ws:wsTrace.flush()});
    socket?.terminate();
    process.exit(0);
  };
  process.on("SIGINT",shutdown);
  process.on("SIGTERM",shutdown);
  emit("START",{wallets,commitment:"confirmed",deadlineMs:DEADLINE,horizons:HORIZONS,holdLimitSeconds:HOLD_LIMIT,
    slippageBps:SLIPPAGE_BPS,inputLamports:input.toString(),budgetVersion:2,study,
    networkFeeComponentsLamports:{base:5000,priority:100000,tip:5000}});
  setTimeout(shutdown,48*3600*1000);
  connect();
}
if (process.argv[1] && import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [file,...args]=process.argv.slice(2);
  const sizes=args.filter(arg=>arg.startsWith("--size-sol="));
  if (sizes.length>1) throw Error("Specify only one size per run");
  const input=sizes.length?parseSizeSol(sizes[0].slice("--size-sol=".length)):CONTROL_INPUT;
  start(file,args.filter(arg=>!arg.startsWith("--size-sol=")),input);
}
