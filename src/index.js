import path from "node:path";
import { config } from "./config.js";
import { IngestionState } from "./ingestion-state.js";
import { PaperEngine } from "./paper-engine.js";
import { parsePumpLogSignal, parsePumpTrades } from "./parser.js";
import { SolanaRpc } from "./rpc.js";
import { TelegramNotifier } from "./telegram-notifier.js";
import { buildLiveReport, formatLiveReport, utcDay } from "./live-report.js";

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
let manualOrders;
let tradeQueue = Promise.resolve();
let reconnectAttempt = 0;
let stopped = false;
let fallbackActive = 0;
const fallbackWaiters = [];
const signatureTasks = new Map();
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
  const snapshot = await trader.snapshot();
  const skipped = Object.values(report.skips).reduce((total, count) => total + count, 0);
  if (
    title === "Промежуточный отчёт" &&
    report.buys === 0 && report.sells === 0 && report.failed === 0 &&
    report.unknown === 0 && skipped === 0 && snapshot.openPositions === 0 &&
    !snapshot.buyPauseActive
  ) return;
  const text = [
    formatLiveReport(report, title),
    "",
    `Баланс: ${snapshot.balanceSol.toFixed(9)} SOL`,
    `Потрачено сегодня: ${snapshot.dailySpendSol.toFixed(9)} SOL`,
    `PnL-счётчик риска: ${snapshot.dailyRealizedPnlSol >= 0 ? "+" : ""}${snapshot.dailyRealizedPnlSol.toFixed(9)} SOL`,
    `Убытков подряд: ${snapshot.consecutiveLosses}`,
    `Новые BUY: ${snapshot.buyPauseActive ? "на паузе" : "разрешены"}`
  ].join("\n");
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

function enqueueTrade(trade, source) {
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
    const result = await trader.onTrade(enriched);
    const completedAtMs = Date.now();
    const signalToResultMs = Number.isFinite(trade.observedAtMs)
      ? completedAtMs - trade.observedAtMs
      : null;
    if (trade.signalSource === "processed_logs") rememberLatency(signalToResultMs);
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

  const trades = parsePumpTrades(tx, target.wallet, signature);
  for (const original of trades) {
    await enqueueTrade(attributedTrade({
      ...original,
      observedAtMs,
      signalSource: "confirmed_transaction"
    }, target), source);
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

async function resolveFastTrades(candidates) {
  const resolved = [];
  for (const candidate of candidates) {
    if (candidate.boundaryPool) {
      await rpc.resolveSolPumpPool(candidate.boundaryPool);
      resolved.push(candidate);
      continue;
    }
    if (!candidate.pool) {
      resolved.push(candidate);
      continue;
    }
    const pool = await rpc.resolveSolPumpPool(candidate.pool);
    resolved.push({ ...candidate, mint: pool.baseMint });
  }
  return resolved;
}

function tradeKeys(trades) {
  return trades.map((trade) => `${trade.side}:${trade.mint}`).sort();
}

function scheduleFastVerification(target, signature, fastTrades) {
  const timer = setTimeout(async () => {
    try {
      const tx = await rpc.getTransactionWithRetry(signature);
      if (!tx) throw new Error("confirmed transaction unavailable");
      const confirmed = parsePumpTrades(tx, target.wallet, signature);
      const fastKeys = tradeKeys(fastTrades);
      const confirmedKeys = tradeKeys(confirmed);
      const matches = JSON.stringify(fastKeys) === JSON.stringify(confirmedKeys);
      if (matches) fastMetrics.verified += 1;
      else fastMetrics.mismatches += 1;
      log(matches ? "fast_signal_verified" : "fast_signal_mismatch", {
        signature,
        sourceWallet: target.wallet,
        sourceName: target.name,
        fast: fastKeys,
        confirmed: confirmedKeys
      });
    } catch (error) {
      fastMetrics.verificationErrors += 1;
      log("fast_verification_error", {
        signature, sourceWallet: target.wallet, sourceName: target.name,
        message: error.message
      });
    }
  }, 1_000);
  timer.unref();
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

    let trades;
    try {
      trades = await resolveFastTrades(candidates);
    } catch (error) {
      fastMetrics.resolutionFallbacks += 1;
      log("fast_resolution_fallback", { signature, message: error.message });
      return withFallbackSlot(
        () => processConfirmedSignature(target, signature, "websocket_fallback", observedAtMs)
      );
    }

    const attributed = trades.map((trade) => attributedTrade(trade, target));
    for (const trade of attributed) await enqueueTrade(trade, "websocket_fast");
    fastMetrics.detected += trades.length;
    target.ingestion.markProcessed(signature);
    log("signature_processed", {
      signature,
      source: "websocket_fast",
      sourceWallet: target.wallet,
      sourceName: target.name,
      targetSlot: slot,
      detectedInMs: Date.now() - observedAtMs
    });
    scheduleFastVerification(target, signature, attributed);
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
    await processConfirmedSignature(target, item.signature, "startup_backfill");
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
    for (const item of signatures.toReversed()) {
      if (item.err) {
        target.ingestion.markProcessed(item.signature);
        continue;
      }
      if (await enqueueSignature(target, item.signature, "backfill")) processed += 1;
    }
    if (signatures.length > 0) target.ingestion.checkpoint(signatures[0].signature);
    target.lastSuccessfulPollAt = Date.now();
    if (forceLog || signatures.length > 0) {
      log("backfill_ok", {
        sourceWallet: target.wallet,
        sourceName: target.name,
        signaturesFound: signatures.length,
        signaturesProcessed: processed,
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
  return results.every(Boolean);
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
    const targetHealth = targetRuntimes.map((target) => ({
      name: target.name,
      wallet: target.wallet,
      liveEnabled: target.liveEnabled,
      rpcSilenceMs: Date.now() - target.lastSuccessfulPollAt,
      lastWsMessageAt: target.lastWsMessageAt
        ? new Date(target.lastWsMessageAt).toISOString() : null,
      cursor: target.ingestion.cursor
    }));
    const rpcSilenceMs = Math.max(...targetHealth.map((target) => target.rpcSilenceMs));
    log("health", {
      rpcSilenceMs,
      targetHealth,
      tradingMode: config.tradingMode,
      openPositions: trader.positions.size,
      fallbackActive,
      fallbackQueued: fallbackWaiters.length,
      signaturesInFlight: signatureTasks.size,
      fastLatency: latencySummary(),
      fastMetrics
    });
    if (rpcSilenceMs > config.maxRpcSilenceMs) {
      log("health_failed", {
        rpcSilenceMs, targetHealth, action: "exit_for_systemd_restart"
      });
      process.exit(1);
    }
  }, 60_000);
} catch (error) {
  log("startup_failed", { message: error.message });
  process.exit(1);
}
