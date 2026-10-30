import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";

function loadDotEnv(file = ".env") {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) return;

  for (const originalLine of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function numberSetting(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function booleanSetting(name, fallback) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function enumSetting(name, fallback, allowed) {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalSecretFile(name) {
  const file = process.env[name];
  if (!file) return "";
  const fullPath = path.resolve(file);
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${name} must point to a regular file`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`${name} must not be readable by group or other users`);
  }
  return fs.readFileSync(fullPath, "utf8").trim();
}

function validWallet(value) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

export function parseTargetTraders(raw, fallbackWallet = "") {
  const source = String(raw ?? "").trim() || fallbackWallet;
  const entries = source.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 50) {
    throw new Error("TARGET_WALLETS must contain between 1 and 50 traders");
  }

  const wallets = new Set();
  const names = new Set();
  return entries.map((entry, index) => {
    const separator = entry.indexOf(":");
    const wallet = separator < 0 ? entry : entry.slice(separator + 1).trim();
    const name = separator < 0 ? `trader${index + 1}` : entry.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      throw new Error(`Invalid trader name in TARGET_WALLETS: ${name}`);
    }
    if (!validWallet(wallet)) {
      throw new Error(`Invalid Solana wallet in TARGET_WALLETS: ${wallet}`);
    }
    if (wallets.has(wallet)) throw new Error(`Duplicate trader wallet: ${wallet}`);
    if (names.has(name)) throw new Error(`Duplicate trader name: ${name}`);
    wallets.add(wallet);
    names.add(name);
    return Object.freeze({ name, wallet });
  });
}

export function parseLiveTraderWallets(raw, traders) {
  const source = String(raw ?? "").trim();
  const entries = source ? source.split(",").map((entry) => entry.trim()).filter(Boolean) : [
    traders[0].wallet
  ];
  if (entries.length === 1 && entries[0].toLowerCase() === "none") return Object.freeze([]);

  const enabled = new Set();
  for (const entry of entries) {
    const trader = traders.find(
      (candidate) => candidate.wallet === entry || candidate.name === entry
    );
    if (!trader) throw new Error(`LIVE_TRADER_WALLETS contains unknown trader: ${entry}`);
    enabled.add(trader.wallet);
  }
  return Object.freeze([...enabled]);
}

loadDotEnv();

const targetTraders = Object.freeze(parseTargetTraders(
  process.env.TARGET_WALLETS,
  process.env.TARGET_WALLET ?? ""
));
const liveTraderWallets = parseLiveTraderWallets(
  process.env.LIVE_TRADER_WALLETS,
  targetTraders
);

export const config = Object.freeze({
  tradingMode: enumSetting("TRADING_MODE", "paper", ["paper", "live"]),
  targetWallet: targetTraders[0].wallet,
  targetWallets: Object.freeze(targetTraders.map((trader) => trader.wallet)),
  targetTraders,
  liveTraderWallets,
  rpcHttpUrl: process.env.RPC_HTTP_URL ?? "https://api.mainnet-beta.solana.com",
  rpcFallbackHttpUrl: process.env.RPC_FALLBACK_HTTP_URL ?? "",
  rpcWsUrl: process.env.RPC_WS_URL ?? "wss://api.mainnet-beta.solana.com",
  paperTradeSol: numberSetting("PAPER_TRADE_SOL", 0.015, { min: 0.001, max: 1 }),
  maxOpenPositions: numberSetting("MAX_OPEN_POSITIONS", 1, { min: 1, max: 20 }),
  maxDailyLossSol: numberSetting("MAX_DAILY_LOSS_SOL", 0.02, { min: 0.001, max: 10 }),
  maxSignalAgeMs: numberSetting("MAX_SIGNAL_AGE_MS", 5000, { min: 500, max: 60000 }),
  latencyPenaltyBps: numberSetting("LATENCY_PENALTY_BPS", 300, { min: 0, max: 5000 }),
  pumpFeeBps: numberSetting("PUMP_FEE_BPS", 125, { min: 0, max: 1000 }),
  pollIntervalMs: numberSetting("POLL_INTERVAL_MS", 15_000, { min: 5_000, max: 300_000 }),
  rpcTimeoutMs: numberSetting("RPC_TIMEOUT_MS", 10_000, { min: 1_000, max: 60_000 }),
  maxRpcSilenceMs: numberSetting("MAX_RPC_SILENCE_MS", 300_000, {
    min: 60_000,
    max: 3_600_000
  }),
  startupBackfillMs: numberSetting("STARTUP_BACKFILL_MS", 120_000, {
    min: 0,
    max: 3_600_000
  }),
  fastSignalEnabled: booleanSetting("FAST_SIGNAL_ENABLED", true),
  fallbackConcurrency: numberSetting("FALLBACK_CONCURRENCY", 8, {
    min: 1,
    max: 32
  }),
  logFile: path.resolve(process.env.LOG_FILE ?? "./data/paper-trades.jsonl"),
  stateFile: path.resolve(process.env.STATE_FILE ?? "./data/paper-state.json"),
  ingestionStateFile: path.resolve(
    process.env.INGESTION_STATE_FILE ?? "./data/ingestion-state.json"
  ),

  // Live mode is fail-closed. All three switches are required: TRADING_MODE,
  // the exact confirmation phrase and a readable key file.
  liveConfirmation: process.env.LIVE_CONFIRMATION ?? "",
  liveWalletFile: path.resolve(process.env.LIVE_WALLET_FILE ?? "./secrets/live-wallet.json"),
  liveWalletAddress: process.env.LIVE_WALLET_ADDRESS ?? "",
  liveTradeSol: numberSetting("LIVE_TRADE_SOL", 0.005, { min: 0.001, max: 1 }),
  liveMaxDailySpendSol: numberSetting("LIVE_MAX_DAILY_SPEND_SOL", 0.03, {
    min: 0.001,
    max: 10
  }),
  liveMinReserveSol: numberSetting("LIVE_MIN_RESERVE_SOL", 0.02, {
    min: 0.005,
    max: 10
  }),
  liveSlippageBps: numberSetting("LIVE_SLIPPAGE_BPS", 1_500, {
    min: 1,
    max: 5_000
  }),
  liveComputeUnitLimit: numberSetting("LIVE_COMPUTE_UNIT_LIMIT", 400_000, {
    min: 100_000,
    max: 1_400_000
  }),
  livePriorityFeeSol: numberSetting("LIVE_PRIORITY_FEE_SOL", 0.0001, {
    min: 0.000001,
    max: 0.05
  }),
  liveTipSol: numberSetting("LIVE_TIP_SOL", 0.000005, {
    min: 0,
    max: 0.05
  }),
  liveSendRoute: enumSetting("LIVE_SEND_ROUTE", "helius-swqos", [
    "rpc",
    "jito",
    "helius-swqos",
    "helius-max"
  ]),
  liveSimulate: booleanSetting("LIVE_SIMULATE", true),
  liveMevProtect: booleanSetting("LIVE_MEV_PROTECT", true),
  liveConfirmationTimeoutMs: numberSetting("LIVE_CONFIRMATION_TIMEOUT_MS", 45_000, {
    min: 5_000,
    max: 120_000
  }),
  liveBlockhashRefreshMs: numberSetting("LIVE_BLOCKHASH_REFRESH_MS", 2_000, {
    min: 400,
    max: 10_000
  }),
  liveMarketCacheMs: numberSetting("LIVE_MARKET_CACHE_MS", 2_000, {
    min: 100,
    max: 10_000
  }),
  liveMaxDailyLossSol: numberSetting(
    "LIVE_MAX_DAILY_LOSS_SOL",
    numberSetting("MAX_DAILY_LOSS_SOL", 0.02, { min: 0.001, max: 10 }),
    { min: 0.001, max: 10 }
  ),
  liveMaxConsecutiveLosses: numberSetting("LIVE_MAX_CONSECUTIVE_LOSSES", 3, {
    min: 1,
    max: 100
  }),
  liveMaxHoldMs: numberSetting("LIVE_MAX_HOLD_MS", 3_600_000, {
    min: 60_000,
    max: 604_800_000
  }),
  liveMaxEntryDriftBps: numberSetting("LIVE_MAX_ENTRY_DRIFT_BPS", 500, {
    min: 0,
    max: 5_000
  }),
  liveExitRetryBaseMs: numberSetting("LIVE_EXIT_RETRY_BASE_MS", 5_000, {
    min: 1_000,
    max: 300_000
  }),
  liveExitRetryMaxMs: numberSetting("LIVE_EXIT_RETRY_MAX_MS", 60_000, {
    min: 5_000,
    max: 3_600_000
  }),
  liveMaintenanceIntervalMs: numberSetting("LIVE_MAINTENANCE_INTERVAL_MS", 5_000, {
    min: 1_000,
    max: 60_000
  }),
  heliusApiKey: process.env.HELIUS_API_KEY ?? "",
  heliusSenderUrl:
    process.env.HELIUS_SENDER_URL ?? "https://sender.helius-rpc.com/fast",
  jitoUrl: process.env.JITO_URL ?? "https://mainnet.block-engine.jito.wtf",
  jupiterApiUrl: process.env.JUPITER_API_URL ?? "https://api.jup.ag/swap/v2",
  jupiterApiKey: process.env.JUPITER_API_KEY ?? optionalSecretFile("JUPITER_API_KEY_FILE"),
  jupiterTimeoutMs: numberSetting("JUPITER_TIMEOUT_MS", 3_000, {
    min: 500,
    max: 15_000
  }),
  liveKillSwitchFile: path.resolve(
    process.env.LIVE_KILL_SWITCH_FILE ?? "./data/STOP_LIVE"
  ),
  liveAutoPauseFile: path.resolve(
    process.env.LIVE_AUTO_PAUSE_FILE ?? "./data/AUTO_PAUSE_BUYS"
  ),
  liveLogFile: path.resolve(process.env.LIVE_LOG_FILE ?? "./data/live-trades.jsonl"),
  liveStateFile: path.resolve(process.env.LIVE_STATE_FILE ?? "./data/live-state.json"),
  manualOrderDir: path.resolve(process.env.MANUAL_ORDER_DIR ?? "./data/manual-orders"),
  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN ?? optionalSecretFile("TELEGRAM_BOT_TOKEN_FILE"),
  telegramAdminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID ?? "",
  telegramStatusIntervalMs: numberSetting("TELEGRAM_STATUS_INTERVAL_MS", 21_600_000, {
    min: 300_000,
    max: 86_400_000
  })
});
