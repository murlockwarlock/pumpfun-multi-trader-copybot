import path from "node:path";
import { config } from "./config.js";
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
import { ShadowEngine } from "./shadow-engine.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import {
  buildLiveReport,
  buildShadowReport,
  formatLiveReport,
  formatShadowReport,
  utcDay
} from "./live-report.js";

const rpc = new SolanaRpc(
  [config.rpcHttpUrl, config.rpcFallbackHttpUrl],
  config.rpcTimeoutMs
);
function traderStateFile(file, wallet, index) {
  if (index === 0) return file;
  const extension = path.extname(file);
  const base = extension ? file.slice(0, -extension.length) : file;
  return `${base}.${wallet}${extension || ".json"}`;
}

const targetRuntimes = config.targetTraders.map((target, index) => ({
  ...target,
  liveEnabled: config.liveTraderWallets.includes(target.wallet),
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
let tradeQueue = Promise.resolve();
let reconnectAttempt = 0;
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

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
  telegram.handle(event, details).catch((error) => {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "telegram_notify_error",
      sourceEvent: event,
      message: error.message
    }));
  });
}

async function sendAdminReport(title, day = utcDay()) {
  if (!telegram.enabled || config.tradingMode !== "live") return;
  const report = buildLiveReport(config.liveLogFile, day, [...trader.positions.values()]);
  const shadowReport = shadowTrader
    ? buildShadowReport(config.shadowLogFile, day, [...shadowTrader.positions.values()])
    : null;
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
    for (const trade of trades) await enqueueTrade(trade, trade.signalSource);
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

function enqueueTrade(
  trade,
  source,
  { shadowEligible = false, shadowBlockReason = null, liveBlockReason = null } = {}
) {
  const queuedAtMs = Date.now();
  const task = tradeQueue.then(async () => {
    const decisionStartedAtMs = Date.now();
    const enriched = {
      ...trade,
      signalSource: trade.signalSource ?? source,
      decisionStartedAtMs,
      queueDelayMs: decisionStartedAtMs - queuedAtMs
    };
    log("target_trade", enriched);
    if (shadowTrader && (shadowEligible || shadowBlockReason)) {
      const shadowResult = shadowBlockReason
        ? shadowTrader.blockTrade(enriched, shadowBlockReason)
        : shadowTrader.onTrade(enriched);
      log("shadow_result", shadowResult);
    }
    const result = liveBlockReason && config.tradingMode === "live"
      ? trader.blockTrade(enriched, liveBlockReason)
      : await trader.onTrade(enriched);
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
  tradeQueue = task.catch((error) => {
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
    sourceLiveEnabled: target.liveEnabled
  };
}

function signatureTaskKey(target, signature) {
  return `${target.wallet}:${signature}`;
}

async function processConfirmedSignature(target, signature, source, observedAtMs = null) {
  if (target.ingestion.has(signature)) return false;
  const tx = await rpc.getTransactionWithRetry(signature);
  if (!tx) throw new Error(`Transaction unavailable after retries: ${signature}`);

  const confirmedSignal = parseConfirmedPumpLogSignal(
    tx, target.wallet, signature, { observedAtMs }
  );
  const resolution = confirmedSignal.trades.length > 0
    ? await resolvePumpCandidates(confirmedSignal.trades, rpc)
    : { trades: parsePumpTrades(tx, target.wallet, signature), unsupportedTrades: [] };
  const { trades, unsupportedTrades } = resolution;
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
  for (const original of trades) {
    await enqueueTrade(attributedTrade({
      ...original,
      observedAtMs,
      signalSource: "confirmed_transaction"
    }, target), source, { shadowEligible: true });
  }
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

    const signal = parsePumpLogSignal(
      value.logs,
      target.wallet,
      signature,
      { slot, observedAtMs }
    );
    const candidates = signal.trades;
    if (candidates.length === 0) {
      return withFallbackSlot(
        () => processConfirmedSignature(target, signature, "websocket_fallback", observedAtMs)
      );
    }

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
    const { trades, unsupportedTrades } = fastResolution;
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
      for (const trade of confirmedTrades) {
        await enqueueTrade(attributedTrade({
          ...trade,
          observedAtMs,
          signalSource: "verified_fast"
        }, target), "websocket_verified_fast", { shadowEligible: true });
      }
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
      for (const trade of safeShadowTrades) {
        await enqueueTrade(attributedTrade({
          ...trade,
          observedAtMs,
          signalSource: "confirmed_mismatch"
        }, target), "websocket_fast_mismatch", {
          shadowEligible: confirmedTrades.length > 0,
          liveBlockReason: "fast_signal_mismatch"
        });
      }
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

function scheduleReconnect() {
  if (stopped) return;
  const delayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt++);
  log("websocket_closed", { reconnectInMs: delayMs });
  setTimeout(connect, delayMs);
}

function connect() {
  if (stopped) return;
  let ws;
  const requestTargets = new Map();
  const subscriptionTargets = new Map();
  try {
    ws = new WebSocket(config.rpcWsUrl);
  } catch (error) {
    log("websocket_open_error", { message: error.message });
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
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
      traders: targetRuntimes.map(({ name, wallet, liveEnabled }) => ({
        name, wallet, liveEnabled
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
      log("subscribed", {
        subscriptionId: payload.result,
        sourceWallet: requestedTarget.wallet,
        sourceName: requestedTarget.name,
        liveEnabled: requestedTarget.liveEnabled
      });
      return;
    }
    if (requestedTarget && payload.error) {
      log("subscription_error", {
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
    processWebsocketSignature(target, value, result?.context?.slot ?? null, observedAtMs);
  });

  ws.addEventListener("error", () => ws.close());
  ws.addEventListener("close", scheduleReconnect);
}

function stop() {
  if (stopped) return;
  stopped = true;
  manualOrders?.stop();
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
  traders: targetRuntimes.map(({ name, wallet, liveEnabled }) => ({
    name, wallet, liveEnabled
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
    const telegramIdentity = await telegram.verify();
    if (telegramIdentity.enabled) log("telegram_ready", { username: telegramIdentity.username });
    const { LiveEngine } = await import("./live-engine.js");
    trader = new LiveEngine(config, log);
    await trader.initialize();
    if (config.shadowEnabled) {
      shadowTrader = new ShadowEngine(config);
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
  await initializeIngestions();
  if (!(await pollBackfill(true))) throw new Error("Initial HTTP backfill check failed");
  connect();
  setInterval(pollBackfill, config.pollIntervalMs);
  setTimeout(pollBackfill, 1_000);
  setInterval(() => {
    const {
      targetHealth, staleTargets, allTargetsStale, rpcSilenceMs
    } = assessTargetHealth(targetRuntimes, config.maxRpcSilenceMs);
    log("health", {
      rpcSilenceMs,
      targetHealth,
      tradingMode: config.tradingMode,
      openPositions: trader.positions.size,
      shadowOpenPositions: shadowTrader?.positions.size ?? 0,
      fallbackActive,
      fallbackQueued: fallbackWaiters.length,
      signaturesInFlight: signatureTasks.size,
      fastLatency: latencySummary(),
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
