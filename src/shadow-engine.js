import path from "node:path";
import { PaperEngine } from "./paper-engine.js";

function stateFile(directory, index, wallet) {
  return path.join(directory, `${String(index + 1).padStart(2, "0")}-${wallet}.json`);
}

export class ShadowEngine {
  constructor(config) {
    this.config = config;
    this.engines = new Map();
    for (const [index, trader] of config.targetTraders.entries()) {
      this.engines.set(trader.wallet, new PaperEngine({
        logFile: config.shadowLogFile,
        stateFile: stateFile(config.shadowStateDir, index, trader.wallet),
        maxSignalAgeMs: config.maxSignalAgeMs,
        maxDailyLossSol: config.shadowMaxDailyLossSol,
        maxOpenPositions: config.shadowMaxOpenPositionsPerTrader,
        latencyPenaltyBps: config.shadowLatencyPenaltyBps,
        pumpFeeBps: config.pumpFeeBps,
        paperTradeSol: config.shadowTradeSol,
        paperFixedTxFeeSol: config.shadowTxFeeSol,
        paperRecordPrefix: "SHADOW"
      }));
    }
  }

  get positions() {
    const combined = new Map();
    for (const [wallet, engine] of this.engines) {
      for (const [key, position] of engine.positions) {
        combined.set(`${wallet}:${key}`, position);
      }
    }
    return combined;
  }

  onTrade(trade) {
    const engine = this.engines.get(trade.sourceWallet);
    if (!engine) throw new Error(`Unknown shadow trader: ${trade.sourceWallet ?? "missing"}`);
    return engine.onTrade(trade);
  }

  blockTrade(trade, reason) {
    const engine = this.engines.get(trade.sourceWallet);
    if (!engine) throw new Error(`Unknown shadow trader: ${trade.sourceWallet ?? "missing"}`);
    return engine.blockTrade(trade, reason);
  }
}
