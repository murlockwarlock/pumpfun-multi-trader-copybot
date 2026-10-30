import fs from "node:fs";
import path from "node:path";

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function round(value, digits = 9) {
  return Number(value.toFixed(digits));
}

function positionKey({ sourceWallet, mint }) {
  return sourceWallet ? `${sourceWallet}:${mint}` : mint;
}

export class PaperEngine {
  constructor(config) {
    this.config = config;
    this.recordPrefix = config.paperRecordPrefix ?? "PAPER";
    this.fixedTxFeeSol = config.paperFixedTxFeeSol ?? 0;
    this.positions = new Map();
    this.day = utcDay();
    this.dailyRealizedPnlSol = 0;
    fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
    fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
    this.#loadState();
  }

  #loadState() {
    if (!fs.existsSync(this.config.stateFile)) return;
    const state = JSON.parse(fs.readFileSync(this.config.stateFile, "utf8"));
    if (state.version !== 1 || !Array.isArray(state.positions)) {
      throw new Error("Unsupported paper state format");
    }
    this.day = typeof state.day === "string" ? state.day : utcDay();
    this.dailyRealizedPnlSol = Number(state.dailyRealizedPnlSol ?? 0);
    if (!Number.isFinite(this.dailyRealizedPnlSol)) {
      throw new Error("Invalid daily PnL in paper state");
    }
    for (const position of state.positions) {
      if (!position?.mint || !Number.isFinite(position.tokenAmount) || !Number.isFinite(position.costSol)) {
        throw new Error("Invalid position in paper state");
      }
      this.positions.set(positionKey(position), position);
    }
  }

  #saveState() {
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      day: this.day,
      dailyRealizedPnlSol: this.dailyRealizedPnlSol,
      positions: [...this.positions.values()]
    };
    const temporary = `${this.config.stateFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.config.stateFile);
  }

  #resetDailyCounterIfNeeded() {
    if (this.day === utcDay()) return;
    this.day = utcDay();
    this.dailyRealizedPnlSol = 0;
    this.#saveState();
  }

  #write(record) {
    fs.appendFileSync(this.config.logFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  #skip(trade, reason) {
    const record = {
      type: `${this.recordPrefix}_SKIP`, reason, at: new Date().toISOString(), ...trade
    };
    this.#write(record);
    return record;
  }

  onTrade(trade) {
    this.#resetDailyCounterIfNeeded();

    const signalAgeMs = trade.signalSource === "processed_logs" &&
      Number.isFinite(trade.observedAtMs)
      ? Math.max(0, Date.now() - trade.observedAtMs)
      : trade.blockTime
        ? Math.max(0, Date.now() - trade.blockTime * 1000)
        : null;

    if (trade.side === "BUY") {
      if (signalAgeMs !== null && signalAgeMs > this.config.maxSignalAgeMs) {
        return this.#skip(trade, `signal_too_old_${signalAgeMs}ms`);
      }
      if (this.dailyRealizedPnlSol <= -this.config.maxDailyLossSol) {
        return this.#skip(trade, "daily_loss_limit");
      }
      const key = positionKey(trade);
      if (this.positions.has(key)) return this.#skip(trade, "position_already_open");
      if (this.positions.size >= this.config.maxOpenPositions) {
        return this.#skip(trade, "max_open_positions");
      }

      const penalty = 1 + this.config.latencyPenaltyBps / 10_000;
      const feeRate = this.config.pumpFeeBps / 10_000;
      const entryPriceSol = trade.averagePriceSol * penalty;
      const spendSol = this.config.paperTradeSol;
      const pumpFeeSol = spendSol * feeRate;
      const fixedFeeSol = this.fixedTxFeeSol;
      const tokenAmount = (spendSol - pumpFeeSol) / entryPriceSol;
      const position = {
        mint: trade.mint,
        sourceWallet: trade.sourceWallet ?? null,
        sourceName: trade.sourceName ?? null,
        tokenAmount,
        costSol: spendSol + fixedFeeSol,
        entryPriceSol,
        openedAt: new Date().toISOString(),
        entrySignature: trade.signature
      };
      this.positions.set(key, position);
      this.#saveState();

      const record = {
        type: `${this.recordPrefix}_BUY`,
        at: position.openedAt,
        signalAgeMs,
        signalSource: trade.signalSource ?? "unknown",
        targetSlot: trade.slot ?? null,
        mint: trade.mint,
        sourceWallet: position.sourceWallet,
        sourceName: position.sourceName,
        spendSol: round(spendSol),
        pumpFeeSol: round(pumpFeeSol),
        fixedFeeSol: round(fixedFeeSol),
        totalCostSol: round(position.costSol),
        tokenAmount: round(tokenAmount, 6),
        entryPriceSol,
        targetSignature: trade.signature
      };
      this.#write(record);
      return record;
    }

    const key = positionKey(trade);
    const position = this.positions.get(key);
    if (!position) return this.#skip(trade, "no_paper_position");

    const penalty = Math.max(0, 1 - this.config.latencyPenaltyBps / 10_000);
    const feeRate = this.config.pumpFeeBps / 10_000;
    const exitPriceSol = trade.averagePriceSol * penalty;
    const grossSol = position.tokenAmount * exitPriceSol;
    const pumpFeeSol = grossSol * feeRate;
    const fixedFeeSol = this.fixedTxFeeSol;
    const proceedsSol = grossSol - pumpFeeSol - fixedFeeSol;
    const pnlSol = proceedsSol - position.costSol;
    this.dailyRealizedPnlSol += pnlSol;
    this.positions.delete(key);
    this.#saveState();

    const record = {
      type: `${this.recordPrefix}_SELL`,
      at: new Date().toISOString(),
      signalAgeMs,
      signalSource: trade.signalSource ?? "unknown",
      targetSlot: trade.slot ?? null,
      mint: trade.mint,
      sourceWallet: position.sourceWallet,
      sourceName: position.sourceName,
      proceedsSol: round(proceedsSol),
      pumpFeeSol: round(pumpFeeSol),
      fixedFeeSol: round(fixedFeeSol),
      pnlSol: round(pnlSol),
      dailyRealizedPnlSol: round(this.dailyRealizedPnlSol),
      exitPriceSol,
      targetSignature: trade.signature,
      entrySignature: position.entrySignature
    };
    this.#write(record);
    return record;
  }
}
