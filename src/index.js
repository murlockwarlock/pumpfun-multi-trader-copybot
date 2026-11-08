import path from "node:path";
import { ExecutionLanes, ExecutionTimings } from "./execution-lanes.js";
import { Worker } from "node:worker_threads";
import { config } from "./config.js";
import { LAUNCH_TARGET, LaunchFollowSupervisor } from "./launch-follow.js";
import { compareFastTrades } from "./fast-verifier.js";
import { assessTargetHealth } from "./health.js";
import { IngestionState } from "./ingestion-state.js";
import { PaperEngine } from "./paper-engine.js";
import {
  parseConfirmedPumpLogSignal,
  parsePumpLogSignal,
  parsePumpTrades
} from "./parser.js";
import { SolanaRpc } from "./rpc.js";
import { resolvePumpCandidates } from "./route-resolver.js";
import { ShadowClient } from "./shadow-client.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import {

  formatLiveReport,
  formatShadowReport,
  utcDay
} from "./live-report.js";

const rpc = new SolanaRpc(
  [config.rpcHttpUrl, config.rpcFallbackHttpUrl],
  config.rpcTimeoutMs
);
let launchWorker;
function launchPost(target, message) {
  if (!launchWorker || target.wallet !== LAUNCH_TARGET) return;
  try { launchWorker.post(message); }
  catch (error) { log("launch_follow_error", { message: error.message }); }
}
function traderStateFile(file, wallet, index) {
  if (index === 0) return file;
  const extension = path.extname(file);
  const base = extension ? file.slice(0, -extension.length) : file;
  return `${base}.${wallet}${extension || ".json"}`;
}

const targetRuntimes = config.targetTraders.map((target, index) => ({
  ...target,
  liveEnabled: config.liveTraderWallets.includes(target.wallet),
  fastEnabled: config.fastTraderWallets.includes(target.wallet),
  ingestion: new IngestionState(
    traderStateFile(config.ingestionStateFile, target.wallet, index)
  ),
  pollRunning: false,
  lastSuccessfulPollAt: Date.now(),
  lastWsMessageAt: null
}));
let trader;
let shadowTrader;
let manualOrders;
const ingressLanes = new ExecutionLanes();
const liveLanes = new ExecutionLanes();
const shadowLanes = new ExecutionLanes();
const timings = new ExecutionTimings();
let stopped = false;
let fallbackActive = 0;
const fallbackWaiters = [];
const signatureTasks = new Map();
const signatureFailures = new Map();
const unhealthyTargets = new Set();
const latencySamples = [];
const fastMetrics = {
  detected: 0,
  verified: 0,
  mismatches: 0,
  verificationErrors: 0,
  resolutionFallbacks: 0
};
const telegram = new TelegramNotifier(config);
let maintenanceRunning = false;
const websocketChannels = [
  { name: "primary", url: config.rpcWsUrl },
  { name: "fallback", url: config.rpcFallbackWsUrl }
]
  .filter((channel) => channel.url)
  .filter((channel, index, channels) =>
    channels.findIndex((candidate) => candidate.url === channel.url) === index
  )
  .map((channel) => ({
    ...channel,
    reconnectAttempt: 0,
    connected: false,
    subscriptions: 0,
    socket: null
  }));

function log(event, details = {}) {
  if (event === "live_submitted") timings.add(details);
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
  setImmediate(() => telegram.handle(event, details).catch((error) => {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "telegram_notify_error",
      sourceEvent: event,
      message: error.message
    }));
  }));
}

async function sendAdminReport(title, day = utcDay()) {
  if (!telegram.enabled || config.tradingMode !== "live") return;
  const { report, shadowReport } = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./report-worker.js", import.meta.url), {
      workerData: { day, liveFile: config.liveLogFile, shadowFile: config.shadowLogFile,
        positions: [...trader.positions.values()], shadow: shadowTrader && [...shadowTrader.positions.values()] }
    });
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const snapshot = await trader.snapshot();
  const skipped = Object.values(report.skips).reduce((total, count) => total + count, 0);
  const shadowActivity = shadowReport
    ? shadowReport.buys + shadowReport.sells +
      Object.values(shadowReport.skips).reduce((total, count) => total + count, 0)
    : 0;
  if (
    title === "Промежуточный отчёт" &&
    report.buys === 0 && report.sells === 0 && report.failed === 0 &&
    report.unknown === 0 && skipped === 0 && snapshot.openPositions === 0 &&
    !snapshot.buyPauseActive && shadowActivity === 0
  ) return;
  const text = [
    formatLiveReport(report, title),
    "",
    `Баланс: ${snapshot.balanceSol.toFixed(9)} SOL`,
    `Потрачено сегодня: ${snapshot.dailySpendSol.toFixed(9)} SOL`,
    `PnL-счётчик риска: ${snapshot.dailyRealizedPnlSol >= 0 ? "+" : ""}${snapshot.dailyRealizedPnlSol.toFixed(9)} SOL`,
    `Убытков подряд: ${snapshot.consecutiveLosses}`,
    `Quarantine mint: ${snapshot.quarantinedMints} (без позиции: ${snapshot.quarantinedBuysWithoutPosition}, позиции: ${snapshot.quarantinedPositions})`,
    `Новые BUY: ${snapshot.buyPauseActive ? "на паузе" : "разрешены"}`,
    shadowReport ? "" : null,
    shadowReport ? formatShadowReport(shadowReport) : null
  ].filter((line) => line !== null).join("\n");
  await telegram.handle("admin_report", { text });
}

function scheduleDailyAdminReport() {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 15
  );
  const timer = setTimeout(async () => {
    await sendAdminReport("Итог за сутки", utcDay(-1)).catch((error) => {
      log("telegram_report_error", { message: error.message });
    });
    scheduleDailyAdminReport();
  }, Math.max(1_000, next - Date.now()));
  timer.unref();
}

async function runLiveMaintenance() {
  if (maintenanceRunning || stopped || config.tradingMode !== "live") return;
  maintenanceRunning = true;
  try {
    const trades = await trader.maintenanceTrades();
    await Promise.all(trades.map(trade => enqueueTrade(trade, trade.signalSource)));
  } catch (error) {
    log("live_maintenance_error", { message: error.message });
  } finally {
    maintenanceRunning = false;
  }
}

function rememberLatency(value) {
  if (!Number.isFinite(value) || value < 0) return;
  latencySamples.push(value);
  if (latencySamples.length > 500) latencySamples.shift();
}

function latencySummary() {
  if (latencySamples.length === 0) return null;
  const sorted = latencySamples.toSorted((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * value)
  )];
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1)
  };
}

async function updateShadow(enriched, shadowBlockReason) {
  let shadowTrade = enriched;
  let measuredShadowBlockReason = shadowBlockReason;
  if (
    !shadowBlockReason && enriched.fastProfile && enriched.side === "BUY" &&
    !enriched.sourceLiveEnabled && config.fastShadowProbeEnabled &&
    typeof trader?.probeBuy === "function"
  ) {
    try {
      const executionQuote = await trader.probeBuy(enriched, config.shadowTradeSol);
      shadowTrade = { ...enriched, executionQuote };
      if (
        executionQuote.signalToPreparedMs === null ||
        executionQuote.signalToPreparedMs > config.fastMaxSignalAgeMs
      ) {
        measuredShadowBlockReason =
          `fast_quote_too_old_${executionQuote.signalToPreparedMs ?? "unknown"}ms`;
      } else if (
        executionQuote.entryDriftBps !== null &&
        executionQuote.entryDriftBps > config.fastMaxEntryDriftBps
      ) {
        measuredShadowBlockReason =
          `fast_entry_price_drift_${executionQuote.entryDriftBps}bps`;
      }
      log("fast_shadow_probe", {
        signature: enriched.signature,
        mint: enriched.mint,
        sourceWallet: enriched.sourceWallet,
        sourceName: enriched.sourceName,
        ...executionQuote
      });
    } catch (error) {
      measuredShadowBlockReason = `fast_shadow_probe_failed:${error.message}`;
      log("fast_shadow_probe_failed", {
        signature: enriched.signature,
        mint: enriched.mint,
        sourceWallet: enriched.sourceWallet,
        sourceName: enriched.sourceName,
        message: error.message,
        fallback: enriched.curveState ? "curve_post_event" : "target_price_penalty"
      });
    }
  }
  const shadowResult = await (measuredShadowBlockReason
    ? shadowTrader.blockTrade(shadowTrade, measuredShadowBlockReason)
    : shadowTrader.onTrade(shadowTrade));
  log("shadow_result", shadowResult);
}

function enqueueTrade(
  trade,
  source,
  { shadowEligible = false, shadowBlockReason = null, liveBlockReason = null } = {}
) {
  const queuedAtMs = Date.now();
  const task = liveLanes.run(trade.mint, async () => {
    const decisionStartedAtMs = Date.now();
    const enriched = {
      ...trade,
      signalSource: trade.signalSource ?? source,
      decisionStartedAtMs,
      queueDelayMs: (trade.ingressQueueMs ?? 0) + decisionStartedAtMs - queuedAtMs
    };
    log("target_trade", enriched);
    if (shadowTrader && (shadowEligible || shadowBlockReason)) {
      shadowLanes.run(trade.sourceWallet ?? "default", async () => {
        await new Promise(resolve => setImmediate(resolve));
        await updateShadow(enriched, shadowBlockReason);
      }).catch(error => log("shadow_error", { message: error.message }));
    }
    const result = liveBlockReason && config.tradingMode === "live"
      ? trader.blockTrade(enriched, liveBlockReason)
      : await (trader.executeInLane ? trader.executeInLane(enriched) : trader.onTrade(enriched));
    const completedAtMs = Date.now();
    const signalToResultMs = Number.isFinite(trade.observedAtMs)
      ? completedAtMs - trade.observedAtMs
      : null;
    if (["processed_logs", "verified_fast"].includes(enriched.signalSource)) {
      rememberLatency(signalToResultMs);
    }

    log(`${config.tradingMode}_result`, {
      ...result,
      signalSource: enriched.signalSource,
      signalToResultMs
    });
    return result;
  });
  task.catch((error) => {
    log("trade_processing_error", {
      signature: trade.signature,
      source,
      message: error.message
    });
  });
  return task;
}

function attributedTrade(trade, target) {
  return {
    ...trade,
    sourceWallet: target.wallet,
    sourceName: target.name,
    sourceLiveEnabled: target.liveEnabled,
    fastProfile: target.fastEnabled
  };
}

function signatureTaskKey(target, signature) {
  return `${target.wallet}:${signature}`;
}

async function processConfirmedSignature(target, signature, source, observedAtMs = null) {
  if (target.ingestion.has(signature)) return false;
  const tx = await rpc.getTransactionWithRetry(signature);
  if (!tx) throw new Error(`Transaction unavailable after retries: ${signature}`);
  launchPost(target, { kind: "confirmed", signature, tx });

  const confirmedSignal = parseConfirmedPumpLogSignal(
    tx, target.wallet, signature, { observedAtMs }
  );
  const resolution = confirmedSignal.trades.length > 0
    ? await resolvePumpCandidates(confirmedSignal.trades, rpc)
    : await resolvePumpCandidates(parsePumpTrades(tx, target.wallet, signature), rpc);
  const { trades, unsupportedTrades } = resolution;
  for (const trade of trades) if (trade.side === "SELL" && observedAtMs !== null && source.startsWith("websocket")) {
    launchPost(target, { kind: "resolvedSell", trade: { ...trade, observedAtMs } });
  }
  for (const unsupported of unsupportedTrades) {
    const trade = attributedTrade({
      ...unsupported.trade,
      observedAtMs,
      signalSource: "confirmed_unsupported_route"
    }, target);
    log("unsupported_trade_route", {
      signature,
      sourceWallet: target.wallet,
      sourceName: target.name,
      reason: unsupported.reason,
      pool: trade.unsupportedPool,
      quoteMint: trade.unsupportedQuoteMint,
      action: "skipped"
    });
    await enqueueTrade(trade, source, {
      shadowBlockReason: unsupported.reason,
      liveBlockReason: unsupported.reason
    });
  }
  await Promise.all(trades.map(original =>
    enqueueTrade(attributedTrade({
      ...original,
      observedAtMs,
      signalSource: "confirmed_transaction"
    }, target), source, { shadowEligible: true })));
  target.ingestion.markProcessed(signature);
  return true;
}

function finishSignatureTask(target, signature, source, task) {
  const key = signatureTaskKey(target, signature);
  task.catch((error) => {
    log("processing_error", {
      signature, source, sourceWallet: target.wallet, sourceName: target.name,
      message: error.message
    });
  }).finally(() => {
    if (signatureTasks.get(key) === task) signatureTasks.delete(key);
  });
  return task;
}

async function withFallbackSlot(operation) {
  if (fallbackActive >= config.fallbackConcurrency) {
    await new Promise((resolve) => fallbackWaiters.push(resolve));
  } else {
    fallbackActive += 1;
  }
  try {
    return await operation();
  } finally {
    const next = fallbackWaiters.shift();
    if (next) {
      next();
    } else {
      fallbackActive -= 1;
    }
  }
}

function enqueueSignature(target, signature, source, observedAtMs = null) {
  const key = signatureTaskKey(target, signature);
  if (target.ingestion.has(signature)) return Promise.resolve(false);
  if (signatureTasks.has(key)) return signatureTasks.get(key);

  const task = withFallbackSlot(
    () => processConfirmedSignature(target, signature, source, observedAtMs)
  );
  signatureTasks.set(key, task);
  finishSignatureTask(target, signature, source, task);
  return task;
}

async function auditFastTrade(target, signature, trades, observedAtMs) {
  try {
    const tx = await rpc.getTransactionWithRetry(signature);
    if (!tx) throw new Error("confirmed transaction unavailable");
    launchPost(target, { kind: "confirmed", signature, tx });
    const confirmedSignal = parseConfirmedPumpLogSignal(
      tx, target.wallet, signature, { observedAtMs }
    );
    const confirmedResolution = await resolvePumpCandidates(confirmedSignal.trades, rpc);
    for (const trade of confirmedResolution.trades) if (trade.side === "SELL") {
      launchPost(target, { kind: "resolvedSell", trade: { ...trade, observedAtMs, resolvedAtMs: Date.now() } });
    }
    const comparison = compareFastTrades(trades, confirmedResolution.trades);
    const verificationMs = Date.now() - observedAtMs;
    if (comparison.matches) {
      fastMetrics.verified += 1;
      log("fast_signal_verified", {
        signature,
        sourceWallet: target.wallet,
        sourceName: target.name,
        fast: comparison.fast,
        confirmed: comparison.confirmed,
        verificationMs,
        executionTiming: "processed_before_confirmation"
      });
    } else {
      fastMetrics.mismatches += 1;
      if (target.liveEnabled && typeof trader?.pauseBuys === "function") {
        trader.pauseBuys(`fast_signal_mismatch:${signature}`);
      }
      log("fast_signal_mismatch", {
        signature,
        sourceWallet: target.wallet,
        sourceName: target.name,
        fast: comparison.fast,
        confirmed: comparison.confirmed,
        verificationMs,
        action: target.liveEnabled ? "auto_pause_new_buys" : "shadow_alert"
      });
    }
  } catch (error) {
    fastMetrics.verificationErrors += 1;
    launchPost(target, {kind:"rpc_error",message:error.message});
    log("fast_verification_error", {
      signature,
      sourceWallet: target.wallet,
      sourceName: target.name,
      message: error.message,
      action: "signal_already_dispatched"
    });
  }
}

function processWebsocketSignature(target, value, slot, observedAtMs) {
  const signature = value.signature;
  const key = signatureTaskKey(target, signature);
  if (target.ingestion.has(signature) || signatureTasks.has(key)) return;

  const task = (async () => {
    if (!config.fastSignalEnabled) {
      return withFallbackSlot(
        () => processConfirmedSignature(target, signature, "websocket", observedAtMs)
      );
    }

    const decodeStart = performance.now();
    const signal = parsePumpLogSignal(
      value.logs,
      target.wallet,
      signature,
      { slot, observedAtMs }
    );
    const decodeMs = performance.now() - decodeStart;
    const candidates = signal.trades;
    if (candidates.length === 0) {
      return withFallbackSlot(
        () => processConfirmedSignature(target, signature, "websocket_fallback", observedAtMs)
      );
    }

    if (target.fastEnabled) {
      const queued = performance.now();
      const outcomes = await Promise.allSettled(candidates.map(candidate => {
        const keys = [candidate.mint, candidate.pool, candidate.boundaryPool].filter(Boolean)
          .map(key => target.wallet + "/" + key);
        return ingressLanes.runMany(keys, async () => {
          const start = performance.now();
          const { trades } = await resolvePumpCandidates([candidate], rpc);
          const resolveMs = performance.now() - start;
          fastMetrics.detected += trades.length;
          for (const trade of trades) if (trade.side === "SELL") {
            launchPost(target, { kind: "resolvedSell", trade: { ...trade, observedAtMs, resolvedAtMs: Date.now() } });
          }
          await Promise.all(trades.map(trade => enqueueTrade(attributedTrade({
            ...trade, decodeMs, resolveMs, ingressQueueMs: start - queued, observedAtMs,
            signalSource: "processed_logs"
          }, target), "websocket_processed_fast", { shadowEligible: true })));
          return trades;
        });
      }));
      const failure = outcomes.find(result => result.status === "rejected");
      if (failure) throw failure.reason; // Preserve the cursor for backfill.
      const trades = outcomes.flatMap(result => result.value);
      target.ingestion.markProcessed(signature);
      log("fast_signal_dispatched", { signature, sourceWallet: target.wallet, sourceName: target.name,
        targetSlot: slot, trades: trades.map(t => t.side + ":" + t.mint), signalToResultMs: Date.now() - observedAtMs,
        liveEnabled: target.liveEnabled });
      setImmediate(() => auditFastTrade(target, signature, trades, observedAtMs));
      return true;
    }
    const keys = candidates.flatMap(candidate => [candidate.mint, candidate.pool, candidate.boundaryPool])
      .filter(Boolean).map(key => target.wallet + "/" + key);
    const ingressStart = performance.now();
    return ingressLanes.runMany(keys, async () => {
      const resolveStart = performance.now();
      const ingressQueueMs = resolveStart - ingressStart;
      let fastResolution;
      try {
        fastResolution = await resolvePumpCandidates(candidates, rpc);
      } catch (error) {
        fastMetrics.resolutionFallbacks += 1;
        log("fast_resolution_fallback", { signature, message: error.message });
        return withFallbackSlot(
          () => processConfirmedSignature(target, signature, "websocket_fallback", observedAtMs)
        );
      }
      const resolveMs = performance.now() - resolveStart;
      const { trades, unsupportedTrades } = fastResolution;
      for (const trade of trades) Object.assign(trade, { decodeMs, resolveMs, ingressQueueMs });
      for (const unsupported of unsupportedTrades) {
        const trade = attributedTrade({
          ...unsupported.trade,
          observedAtMs,
          signalSource: "processed_unsupported_route"
        }, target);
        log("unsupported_trade_route", {
          signature,
          sourceWallet: target.wallet,
          sourceName: target.name,
          reason: unsupported.reason,
          pool: trade.unsupportedPool,
          quoteMint: trade.unsupportedQuoteMint,
          action: "skipped"
        });
        await enqueueTrade(trade, "websocket_unsupported_route", {
          shadowBlockReason: unsupported.reason,
          liveBlockReason: unsupported.reason
        });
      }
      if (trades.length === 0) {
        target.ingestion.markProcessed(signature);
        log("signature_processed", {
          signature,
          source: "websocket_unsupported_route",
          sourceWallet: target.wallet,
          sourceName: target.name,
          targetSlot: slot,
          detectedInMs: Date.now() - observedAtMs
        });
        return true;
      }

      fastMetrics.detected += trades.length;
      let tx;
      let confirmedTrades;
      try {
        tx = await rpc.getTransactionWithRetry(signature);
        if (!tx) throw new Error("confirmed transaction unavailable");
        const confirmedSignal = parseConfirmedPumpLogSignal(
          tx, target.wallet, signature, { observedAtMs }
        );
        const confirmedResolution = await resolvePumpCandidates(confirmedSignal.trades, rpc);
        confirmedTrades = confirmedResolution.trades;
      } catch (error) {
        fastMetrics.verificationErrors += 1;
        log("fast_verification_error", {
          signature, sourceWallet: target.wallet, sourceName: target.name,
          message: error.message
        });
        throw error;
      }

      const comparison = compareFastTrades(trades, confirmedTrades);
      const verificationMs = Date.now() - observedAtMs;
      if (comparison.matches) {
        fastMetrics.verified += 1;
        log("fast_signal_verified", {
          signature,
          sourceWallet: target.wallet,
          sourceName: target.name,
          fast: comparison.fast,
          confirmed: comparison.confirmed,
          verificationMs
        });
        await Promise.all(confirmedTrades.map(trade =>
          enqueueTrade(attributedTrade({
            ...trade,
            observedAtMs,
            decodeMs, resolveMs, ingressQueueMs,
            signalSource: "verified_fast"
          }, target), "websocket_verified_fast", { shadowEligible: true })));
      } else {
        fastMetrics.mismatches += 1;
        log("fast_signal_mismatch", {
          signature,
          sourceWallet: target.wallet,
          sourceName: target.name,
          fast: comparison.fast,
          confirmed: comparison.confirmed,
          verificationMs,
          action: "live_blocked"
        });
        const safeShadowTrades = confirmedTrades.length > 0 ? confirmedTrades : trades;
        await Promise.all(safeShadowTrades.map(trade =>
          enqueueTrade(attributedTrade({
            ...trade,
            observedAtMs,
            signalSource: "confirmed_mismatch"
          }, target), "websocket_fast_mismatch", {
            shadowEligible: confirmedTrades.length > 0,
            liveBlockReason: "fast_signal_mismatch"
          })));
      }
      target.ingestion.markProcessed(signature);
      log("signature_processed", {
        signature,
        source: comparison.matches ? "websocket_verified_fast" : "websocket_fast_blocked",
        sourceWallet: target.wallet,
        sourceName: target.name,
        targetSlot: slot,
        detectedInMs: Date.now() - observedAtMs
      });
      return true;
    });
  })();
  signatureTasks.set(key, task);
  finishSignatureTask(target, signature, "websocket", task);
}

async function initializeTargetIngestion(target) {
  if (target.ingestion.initialized) return;
  const signatures = await rpc.getRecentSignatures(target.wallet);
  const cutoff = Date.now() - config.startupBackfillMs;
  const recent = signatures
    .filter((item) => !item.err && item.blockTime && item.blockTime * 1_000 >= cutoff)
    .reverse();

  for (const item of recent) {
    try {
      await processConfirmedSignature(target, item.signature, "startup_backfill");
    } catch (error) {
      // getTransactionWithRetry has already exhausted its RPC retries. A stale
      // historical signature must never make systemd boot-loop the service.
      target.ingestion.markProcessed(item.signature);
      log("signature_quarantined", {
        signature: item.signature,
        source: "startup_backfill",
        sourceWallet: target.wallet,
        sourceName: target.name,
        attempts: 1,
        message: error.message,
        action: "skipped_after_rpc_retries"
      });
    }
  }
  target.ingestion.checkpoint(signatures[0]?.signature ?? null);
  log("ingestion_initialized", {
    sourceWallet: target.wallet,
    sourceName: target.name,
    liveEnabled: target.liveEnabled,
    cursor: target.ingestion.cursor,
    recentSignaturesProcessed: recent.length,
    startupBackfillMs: config.startupBackfillMs
  });
}

async function initializeIngestions() {
  for (const target of targetRuntimes) await initializeTargetIngestion(target);
}

async function pollTargetBackfill(target, forceLog = false) {
  if (stopped || target.pollRunning) return false;
  target.pollRunning = true;
  try {
    const signatures = await rpc.getSignaturesSince(target.wallet, target.ingestion.cursor);
    launchPost(target, {kind:"catalog",signatures});
    let processed = 0;
    let quarantined = 0;
    for (const item of signatures.toReversed()) {
      if (item.err) {
        target.ingestion.markProcessed(item.signature);
        continue;
      }
      const failureKey = signatureTaskKey(target, item.signature);
      try {
        if (await enqueueSignature(target, item.signature, "backfill")) processed += 1;
        signatureFailures.delete(failureKey);
      } catch (error) {
        const failure = signatureFailures.get(failureKey) ?? { attempts: 0 };
        failure.attempts += 1;
        failure.message = error.message;
        signatureFailures.set(failureKey, failure);
        if (failure.attempts < 3) throw error;

        target.ingestion.markProcessed(item.signature);
        signatureFailures.delete(failureKey);
        quarantined += 1;
        log("signature_quarantined", {
          signature: item.signature,
          source: "backfill",
          sourceWallet: target.wallet,
          sourceName: target.name,
          attempts: failure.attempts,
          message: failure.message,
          action: "cursor_advanced"
        });
      }
    }
    if (signatures.length > 0) target.ingestion.checkpoint(signatures[0].signature);
    target.lastSuccessfulPollAt = Date.now();
    if (forceLog || signatures.length > 0) {
      log("backfill_ok", {
        sourceWallet: target.wallet,
        sourceName: target.name,
        signaturesFound: signatures.length,
        signaturesProcessed: processed,
        signaturesQuarantined: quarantined,
        cursor: target.ingestion.cursor
      });
    }
    return true;
  } catch (error) {
    log("backfill_error", {
      sourceWallet: target.wallet, sourceName: target.name, message: error.message
    });
    launchPost(target,{kind:"rpc_error",message:error.message});
    return false;
  } finally {
    target.pollRunning = false;
  }
}

async function pollBackfill(forceLog = false) {
  const results = await Promise.all(
    targetRuntimes.map((target) => pollTargetBackfill(target, forceLog))
  );
  return results.some(Boolean);
}

function scheduleReconnect(channel) {
  if (stopped) return;
  channel.connected = false;
  channel.subscriptions = 0;
  channel.socket = null;
  if(launchWorker) {
    log("launch_follow_warning",{reason:"ws_channel_lost",channel:channel.name});
    launchWorker.post({kind:"ws_error",channel:channel.name});
    if(!websocketChannels.some(c=>c.connected&&c.subscriptions>0)) launchWorker.post({kind:"gap",reason:"ws_unavailable"});
  }
  const delayMs = Math.min(30_000, 1_000 * 2 ** channel.reconnectAttempt++);
  log("websocket_closed", { websocketSource: channel.name, reconnectInMs: delayMs });
  const timer = setTimeout(() => connect(channel), delayMs);
  timer.unref();
}

function connect(channel) {
  if (stopped) return;
  let ws;
  const requestTargets = new Map();
  const subscriptionTargets = new Map();
  try {
    ws = new WebSocket(channel.url);
    channel.socket = ws;
  } catch (error) {
    log("websocket_open_error", { websocketSource: channel.name, message: error.message });
    scheduleReconnect(channel);
    return;
  }

  ws.addEventListener("open", () => {
    channel.reconnectAttempt = 0;
    channel.connected = true;
    channel.subscriptions = 0;
    targetRuntimes.forEach((target, index) => {
      const id = index + 1;
      requestTargets.set(id, target);
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "logsSubscribe",
        params: [{ mentions: [target.wallet] }, { commitment: "processed" }]
      }));
    });
    log("subscribing", {
      websocketSource: channel.name,
      traders: targetRuntimes.map(({ name, wallet, liveEnabled }) => ({
        name,
        wallet,
        liveEnabled,
        fastEnabled: config.fastTraderWallets.includes(wallet)
      })),
      commitment: "processed",
      fastSignalEnabled: config.fastSignalEnabled
    });
  });

  ws.addEventListener("message", (event) => {
    const observedAtMs = Date.now();
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const requestedTarget = requestTargets.get(payload.id);
    if (requestedTarget && payload.result) {
      subscriptionTargets.set(payload.result, requestedTarget);
      channel.subscriptions = subscriptionTargets.size;
      log("subscribed", {
        websocketSource: channel.name,
        subscriptionId: payload.result,
        sourceWallet: requestedTarget.wallet,
        sourceName: requestedTarget.name,
        liveEnabled: requestedTarget.liveEnabled,
        fastEnabled: requestedTarget.fastEnabled
      });
      return;
    }
    if (requestedTarget && payload.error) {
      log("subscription_error", {
        websocketSource: channel.name,
        sourceWallet: requestedTarget.wallet,
        sourceName: requestedTarget.name,
        message: payload.error.message,
        code: payload.error.code
      });
      ws.close();
      return;
    }

    const result = payload?.params?.result;
    const value = result?.value;
    if (!value?.signature || value.err) return;
    const target = subscriptionTargets.get(payload?.params?.subscription);
    if (!target) return;
    target.lastWsMessageAt = observedAtMs;
    launchPost(target, { value, slot: result?.context?.slot ?? null, observedAtMs });
    processWebsocketSignature(target, value, result?.context?.slot ?? null, observedAtMs);
  });

  ws.addEventListener("error", () => ws.close());
  ws.addEventListener("close", () => scheduleReconnect(channel));
}

function stop() {
  if (stopped) return;
  stopped = true;
  manualOrders?.stop();
  launchWorker?.stop();
  for (const channel of websocketChannels) channel.socket?.close();
  log("stopped");
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("unhandledRejection", (error) => {
  log("unhandled_rejection", { message: error?.message ?? String(error) });
});

log("starting", {
  tradingMode: config.tradingMode,
  traders: targetRuntimes.map(({ name, wallet, liveEnabled, fastEnabled }) => ({
    name, wallet, liveEnabled, fastEnabled
  })),
  tradeSol: config.tradingMode === "paper" ? config.paperTradeSol : config.liveTradeSol,
  maxOpenPositions: config.maxOpenPositions,
  fastSignalEnabled: config.fastSignalEnabled,
  fallbackConcurrency: config.fallbackConcurrency,
  logFile: config.tradingMode === "paper" ? config.logFile : config.liveLogFile,
  ingestionStateFile: config.ingestionStateFile
});

try {
  if (config.tradingMode === "live") {
    telegram.verify().then(identity => {
      if (identity.enabled) log("telegram_ready", { username: identity.username });
    }).catch(error => log("telegram_verify_error", { message: error.message }));
    const { LiveEngine } = await import("./live-engine.js");
    trader = new LiveEngine(config, log, liveLanes);
    await trader.initialize();
    if (config.shadowEnabled) {
      shadowTrader = await ShadowClient.open(config);
      log("shadow_executor_ready", {
        traders: config.targetTraders.length,
        tradeSol: config.shadowTradeSol,
        txFeeSol: config.shadowTxFeeSol,
        maxOpenPositionsPerTrader: config.shadowMaxOpenPositionsPerTrader,
        restoredPositions: shadowTrader.positions.size
      });
    }
    const { ManualOrderQueue } = await import("./manual-orders.js");
    manualOrders = new ManualOrderQueue(config.manualOrderDir, enqueueTrade, log);
    manualOrders.start();
    setInterval(runLiveMaintenance, config.liveMaintenanceIntervalMs);
    setTimeout(runLiveMaintenance, 1_000);
    setInterval(
      () => sendAdminReport("Промежуточный отчёт").catch((error) => {
        log("telegram_report_error", { message: error.message });
      }),
      config.telegramStatusIntervalMs
    );
    scheduleDailyAdminReport();
  } else {
    trader = new PaperEngine(config);
    log("paper_executor_ready", { paperTradeSol: config.paperTradeSol });
  }
  if (config.launchFollowEnabled) {
    const options = Object.fromEntries(Object.entries(config).filter(([key]) => [
      "rpcHttpUrl", "rpcTimeoutMs", "liveConfirmationTimeoutMs", "liveSendRoute",
      "liveTipSol", "livePriorityFeeSol", "liveSlippageBps", "liveMarketCacheMs",
      "fastMaxSignalAgeMs", "fastMaxEntryDriftBps"
    ].includes(key)));
    const publicKey = trader.wallet?.publicKey?.toBase58() || config.liveWalletAddress;
    if (!publicKey) throw Error("Launch-follow requires the existing wallet public address");
    launchWorker = new LaunchFollowSupervisor({config:options,publicKey,
      directory:path.join(path.dirname(config.stateFile),"sniper-launch-follow")},log);
    setInterval(()=>{
      const target=targetRuntimes.find(t=>t.wallet===LAUNCH_TARGET);
      launchWorker.post({kind:"coverage",coverage:{
        wsAvailable:websocketChannels.some(c=>c.connected&&c.subscriptions===targetRuntimes.length),
        lastPollAtMs:target?.lastSuccessfulPollAt??null}});
    },1000).unref();
  }
  await initializeIngestions();
  if (!(await pollBackfill(true))) throw new Error("Initial HTTP backfill check failed");
  websocketChannels.forEach((channel, index) => {
    if (index === 0 || config.rpcFallbackWsStaggerMs === 0) {
      connect(channel);
      return;
    }
    const timer = setTimeout(() => connect(channel), config.rpcFallbackWsStaggerMs);
    timer.unref();
  });
  setInterval(pollBackfill, config.pollIntervalMs);
  setTimeout(pollBackfill, 1_000);
  setInterval(() => {
    const {
      targetHealth, staleTargets, allTargetsStale, rpcSilenceMs
    } = assessTargetHealth(targetRuntimes, config.maxRpcSilenceMs);
    log("health", {
      rpcSilenceMs,
      launchFollow:launchWorker?.health()??null,
      targetHealth,
      tradingMode: config.tradingMode,
      openPositions: trader.positions.size,
      unresolvedExits: trader.unresolvedExitCount,
      ...trader.inventoryHealth(),
      shadowOpenPositions: shadowTrader?.positions.size ?? 0,
      fallbackActive,
      fallbackQueued: fallbackWaiters.length,
      signaturesInFlight: signatureTasks.size,
      websocketChannels: websocketChannels.map(({ name, connected, subscriptions }) => ({
        name, connected, subscriptions
      })),
      fastLatency: latencySummary(),
      shadowProbeCoverage: trader.probeCoverage,
      executionLatency: timings.report(),
      fastMetrics
    });
    const staleWallets = new Set(staleTargets.map((target) => target.wallet));
    for (const target of staleTargets) {
      if (unhealthyTargets.has(target.wallet)) continue;
      unhealthyTargets.add(target.wallet);
      log("target_health_failed", {
        ...target,
        action: allTargetsStale ? "await_global_health_check" : "continue_degraded"
      });
    }
    for (const wallet of [...unhealthyTargets]) {
      if (staleWallets.has(wallet)) continue;
      unhealthyTargets.delete(wallet);
      const target = targetHealth.find((item) => item.wallet === wallet);
      log("target_health_recovered", target ?? { wallet });
    }
    if (allTargetsStale) {
      log("health_failed", {
        rpcSilenceMs,
        targetHealth,
        message: "All target HTTP backfills are stale",
        action: "exit_for_systemd_restart"
      });
      process.exit(1);
    }
  }, 60_000);
} catch (error) {
  log("startup_failed", { message: error.message });
  process.exit(1);
}
