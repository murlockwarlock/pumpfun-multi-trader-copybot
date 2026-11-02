import fs from "node:fs";
import path from "node:path";

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

export class LiveState {
  constructor(file, handledLimit = 2_000) {
    this.file = file;
    this.handledLimit = handledLimit;
    this.day = utcDay();
    this.dailySpendLamports = 0n;
    this.dailyRealizedPnlLamports = 0n;
    this.consecutiveLosses = 0;
    this.positions = new Map();
    this.handledSignals = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (state.version !== 1 || !Array.isArray(state.positions) || !Array.isArray(state.handledSignals)) {
      throw new Error("Unsupported live state format");
    }
    this.day = typeof state.day === "string" ? state.day : utcDay();
    this.dailySpendLamports = BigInt(state.dailySpendLamports ?? "0");
    this.dailyRealizedPnlLamports = BigInt(state.dailyRealizedPnlLamports ?? "0");
    this.consecutiveLosses = Number.isSafeInteger(state.consecutiveLosses)
      ? Math.max(0, state.consecutiveLosses)
      : 0;
    for (const position of state.positions) {
      if (!position?.mint || !/^\d+$/.test(position.rawTokenAmount ?? "")) {
        throw new Error("Invalid position in live state");
      }
      this.positions.set(position.mint, position);
    }
    this.handledSignals = state.handledSignals.filter(
      (signal) => typeof signal?.targetSignature === "string"
    );
  }

  #save() {
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      day: this.day,
      dailySpendLamports: this.dailySpendLamports.toString(),
      dailyRealizedPnlLamports: this.dailyRealizedPnlLamports.toString(),
      consecutiveLosses: this.consecutiveLosses,
      positions: [...this.positions.values()],
      handledSignals: this.handledSignals.slice(-this.handledLimit)
    };
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  resetDayIfNeeded() {
    if (this.day === utcDay()) return false;
    this.day = utcDay();
    this.dailySpendLamports = 0n;
    this.dailyRealizedPnlLamports = 0n;
    this.consecutiveLosses = 0;
    this.#save();
    return true;
  }

  hasHandled(targetSignature) {
    return this.handledSignals.some((signal) => signal.targetSignature === targetSignature);
  }

  reserveSignal(trade, details = {}, dailySpendLamports = 0n) {
    if (this.hasHandled(trade.signature)) return false;
    this.handledSignals.push({
      targetSignature: trade.signature,
      side: trade.side,
      mint: trade.mint,
      status: "reserved",
      at: new Date().toISOString(),
      ...details,
      spendDay: this.day,
      reservedSpend: dailySpendLamports.toString()
    });
    this.dailySpendLamports += BigInt(dailySpendLamports);
    this.handledSignals = this.handledSignals.slice(-this.handledLimit);
    this.#save();
    return true;
  }

  updateSignal(targetSignature, patch) {
    const signal = this.handledSignals.find(
      (candidate) => candidate.targetSignature === targetSignature
    );
    if (!signal) throw new Error(`Unknown live signal: ${targetSignature}`);
    if (patch.status === "submit_rejected" && signal.status === "reserved" &&
        signal.side === "BUY" && signal.spendDay === this.day) {
      this.dailySpendLamports -= BigInt(signal.reservedSpend);
      signal.reservedSpend = "0";
    }
    Object.assign(signal, patch, { updatedAt: new Date().toISOString() });
    this.#save();
  }

  addDailySpend(lamports) {
    this.dailySpendLamports += BigInt(lamports);
    this.#save();
  }

  recordRealizedPnl(lamports) {
    const value = BigInt(lamports);
    this.dailyRealizedPnlLamports += value;
    if (value < 0n) this.consecutiveLosses += 1;
    else if (value > 0n) this.consecutiveLosses = 0;
    this.#save();
    return {
      dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
      consecutiveLosses: this.consecutiveLosses
    };
  }

  setPosition(position) {
    this.positions.set(position.mint, position);
    this.#save();
  }

  deletePosition(mint) {
    this.positions.delete(mint);
    this.#save();
  }
}
