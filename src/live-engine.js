import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { loadLiveWallet } from "./live-wallet.js";
import { LiveState } from "./live-state.js";
import { PumpExecutor } from "./pump-executor.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const LIVE_CONFIRMATION = "I_UNDERSTAND_REAL_FUNDS";
const ACTIVE_SIGNAL_STATUSES = new Set([
  "reserved", "submitted", "confirmation_unknown", "submit_failed"
]);

const solToLamports = (sol) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
const bigintMin = (left, right) => left < right ? left : right;
const errorMessage = (error) => error?.message ?? String(error);

export class LiveEngine {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.state = new LiveState(config.liveStateFile);
    this.wallet = null;
    this.executor = null;
    this.settlements = new Map();
    fs.mkdirSync(path.dirname(config.liveLogFile), { recursive: true });
  }

  get positions() {
    return this.state.positions;
  }

  async snapshot() {
    const balance = this.executor
      ? BigInt(await this.executor.balanceLamports())
      : 0n;
    return {
      day: this.state.day,
      balanceSol: Number(balance) / LAMPORTS_PER_SOL,
      dailySpendSol: Number(this.state.dailySpendLamports) / LAMPORTS_PER_SOL,
      dailyRealizedPnlSol:
        Number(this.state.dailyRealizedPnlLamports) / LAMPORTS_PER_SOL,
      consecutiveLosses: this.state.consecutiveLosses,
      buyPauseActive: this.#buyPauseActive(),
      openPositions: this.state.positions.size
    };
  }

  async initialize() {
    if (this.config.tradingMode !== "live") {
      throw new Error("LiveEngine cannot start unless TRADING_MODE=live");
    }
    if (this.config.liveConfirmation !== LIVE_CONFIRMATION) {
      throw new Error(`LIVE_CONFIRMATION must equal ${LIVE_CONFIRMATION}`);
    }
    this.wallet = loadLiveWallet(this.config.liveWalletFile, this.config.liveWalletAddress);
    this.executor = new PumpExecutor(this.config, this.wallet);
    await this.executor.initialize();
    await this.#resetDailyRiskIfNeeded();
    await this.#reconcilePendingSignals();

    const balance = BigInt(await this.executor.balanceLamports());
    const required = solToLamports(this.config.liveMinReserveSol) +
      solToLamports(this.config.liveTradeSol) +
      solToLamports(this.config.livePriorityFeeSol) +
      solToLamports(this.config.liveTipSol);
    if (balance < required) {
      throw new Error(
        `Live wallet balance is below startup minimum (${Number(required) / LAMPORTS_PER_SOL} SOL)`
      );
    }
    this.log("live_executor_ready", {
      wallet: this.wallet.publicKey.toBase58(),
      balanceSol: Number(balance) / LAMPORTS_PER_SOL,
      sendRoute: this.config.liveSendRoute,
      simulate: this.config.liveSimulate,
      buyPauseActive: this.#buyPauseActive(),
      openPositions: this.state.positions.size
    });
  }

  #write(record) {
    fs.appendFileSync(this.config.liveLogFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  #skip(trade, reason) {
    const record = { type: "LIVE_SKIP", reason, at: new Date().toISOString(), ...trade };
    this.#write(record);
    return record;
  }

  blockTrade(trade, reason) {
    return this.#skip(trade, reason);
  }

  #liveTraderEnabled(trade) {
    if (!trade.sourceWallet) return true;
    const enabled = this.config.liveTraderWallets;
    return !Array.isArray(enabled) || enabled.includes(trade.sourceWallet);
  }

  #samePositionSource(position, trade) {
    return !position.sourceWallet || !trade.sourceWallet ||
      position.sourceWallet === trade.sourceWallet;
  }

  #buyPauseActive() {
    return fs.existsSync(this.config.liveKillSwitchFile) ||
      fs.existsSync(this.#autoPauseFile());
  }

  #autoPauseFile() {
    return this.config.liveAutoPauseFile ??
      path.join(path.dirname(this.config.liveStateFile), "AUTO_PAUSE_BUYS");
  }

  async #resetDailyRiskIfNeeded() {
    if (!this.state.resetDayIfNeeded()) return false;
    fs.rmSync(this.#autoPauseFile(), { force: true });
    this.log("live_daily_risk_reset", { day: this.state.day });
    return true;
  }

  #pauseBuys(reason) {
    const autoPauseFile = this.#autoPauseFile();
    fs.mkdirSync(path.dirname(autoPauseFile), { recursive: true });
    const alreadyPaused = fs.existsSync(autoPauseFile);
    if (!alreadyPaused) {
      fs.writeFileSync(
        autoPauseFile,
        `${JSON.stringify({ at: new Date().toISOString(), reason })}\n`,
        { mode: 0o600 }
      );
    }
    const details = {
      reason,
      dailyRealizedPnlSol: Number(this.state.dailyRealizedPnlLamports) / LAMPORTS_PER_SOL,
      consecutiveLosses: this.state.consecutiveLosses
    };
    if (!alreadyPaused) this.log("live_risk_pause", details);
    return details;
  }

  pauseBuys(reason) {
    return this.#pauseBuys(reason);
  }

  #enforceRiskLimits() {
    const lossLimit = solToLamports(
      this.config.liveMaxDailyLossSol ?? this.config.maxDailyLossSol ?? 0.02
    );
    if (this.state.dailyRealizedPnlLamports <= -lossLimit) {
      return this.#pauseBuys("daily_realized_loss_limit");
    }
    if (this.state.consecutiveLosses >= (this.config.liveMaxConsecutiveLosses ?? 3)) {
      return this.#pauseBuys("consecutive_loss_limit");
    }
    return null;
  }

  async #transactionDelta(signature, fallback = 0n) {
    if (typeof this.executor.transactionWalletDelta !== "function") return BigInt(fallback);
    try {
      const result = await this.executor.transactionWalletDelta(signature);
      return BigInt(result.walletDeltaLamports);
    } catch (error) {
      this.log("live_wallet_delta_unavailable", { signature, message: errorMessage(error) });
      return BigInt(fallback);
    }
  }

  async #entryDelta(position) {
    if (/^-?\d+$/.test(position.entryWalletDeltaLamports ?? "")) {
      return BigInt(position.entryWalletDeltaLamports);
    }
    if (position.entrySignature) {
      return this.#transactionDelta(
        position.entrySignature,
        -BigInt(position.costLamports ?? "0")
      );
    }
    return -BigInt(position.costLamports ?? "0");
  }

  async #realizePosition(position, sellSignature, tokenAccountClose) {
    const entryDelta = await this.#entryDelta(position);
    const sellDelta = await this.#transactionDelta(sellSignature, 0n);
    const closeDelta = /^-?\d+$/.test(tokenAccountClose?.walletDeltaLamports ?? "")
      ? BigInt(tokenAccountClose.walletDeltaLamports)
      : 0n;
    const realizedPnlLamports = entryDelta + sellDelta + closeDelta;
    const risk = this.state.recordRealizedPnl(realizedPnlLamports);
    this.#enforceRiskLimits();
    return {
      entryWalletDeltaLamports: entryDelta.toString(),
      sellWalletDeltaLamports: sellDelta.toString(),
      closeWalletDeltaLamports: closeDelta.toString(),
      realizedPnlLamports: realizedPnlLamports.toString(),
      realizedPnlSol: Number(realizedPnlLamports) / LAMPORTS_PER_SOL,
      dailyRealizedPnlSol: Number(risk.dailyRealizedPnlLamports) / LAMPORTS_PER_SOL,
      consecutiveLosses: risk.consecutiveLosses
    };
  }

  async #closeSoldTokenAccount(targetSignature, mint, tokenProgram) {
    try {
      const result = await this.executor.closeEmptyTokenAccount(mint, tokenProgram);
      this.state.updateSignal(targetSignature, {
        status: "confirmed", tokenAccountClose: result, closeError: null
      });
      this.log("live_token_account_close", {
        mint: mint.toString(), status: result.status, signature: result.signature,
        reclaimedLamports: result.reclaimedLamports
      });
      return result;
    } catch (error) {
      this.state.updateSignal(targetSignature, {
        status: "confirmed_pending_close", closeError: errorMessage(error)
      });
      this.log("live_token_account_close_failed", {
        mint: mint.toString(), message: errorMessage(error)
      });
      return { status: "failed", error: errorMessage(error) };
    }
  }

  #requestExit(position, trade, reason = "target_sell") {
    const existing = position.exitRequest ?? {};
    const updated = {
      ...position,
      exitRequest: {
        requestedAt: existing.requestedAt ?? new Date().toISOString(),
        targetSignature: existing.targetSignature ?? trade.signature,
        executionRoute: trade.executionRoute ?? existing.executionRoute ?? null,
        reason: existing.reason ?? reason,
        attempts: existing.attempts ?? 0,
        nextAttemptAt: existing.nextAttemptAt ?? new Date().toISOString(),
        lastError: existing.lastError ?? null
      }
    };
    this.state.setPosition(updated);
    return updated;
  }

  #scheduleExitRetry(mint, reason) {
    const position = this.state.positions.get(mint);
    if (!position) return;
    const current = position.exitRequest ?? {
      requestedAt: new Date().toISOString(), targetSignature: null,
      executionRoute: null, reason: "exit_retry", attempts: 0
    };
    const attempts = Number(current.attempts ?? 0) + 1;
    const base = this.config.liveExitRetryBaseMs ?? 5_000;
    const maximum = this.config.liveExitRetryMaxMs ?? 60_000;
    const delayMs = Math.min(maximum, base * 2 ** Math.min(attempts - 1, 12));
    this.state.setPosition({
      ...position,
      exitRequest: {
        ...current, attempts, lastError: reason,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString()
      }
    });
    this.log("live_exit_retry", { mint, attempt: attempts, reason, retryInMs: delayMs });
  }

  #hasActiveSell(mint) {
    return this.state.handledSignals.some(
      (signal) => signal.mint === mint && signal.side === "SELL" &&
        ACTIVE_SIGNAL_STATUSES.has(signal.status)
    );
  }

  async #reconcilePendingSignals() {
    const pendingCloses = this.state.handledSignals.filter(
      (signal) => signal.status === "confirmed_pending_close"
    );
    for (const signal of pendingCloses) {
      if (!signal.mint || !signal.tokenProgram) continue;
      await this.#closeSoldTokenAccount(
        signal.targetSignature,
        new PublicKey(signal.mint),
        new PublicKey(signal.tokenProgram)
      );
    }

    const pending = this.state.handledSignals.filter((signal) =>
      ACTIVE_SIGNAL_STATUSES.has(signal.status)
    );
    for (const signal of pending) {
      if (
        !signal.signature || !signal.mint || !signal.tokenProgram ||
        !/^\d+$/.test(signal.beforeTokenBalance ?? "") ||
        !/^\d+$/.test(signal.rawAmount ?? "") ||
        !Number.isFinite(Number(signal.lastValidBlockHeight))
      ) {
        this.state.updateSignal(signal.targetSignature, { status: "reconcile_unavailable" });
        if (signal.side === "SELL") this.#scheduleExitRetry(signal.mint, "reconcile_unavailable");
        continue;
      }
      const mint = new PublicKey(signal.mint);
      const tokenProgram = new PublicKey(signal.tokenProgram);
      const before = BigInt(signal.beforeTokenBalance);
      let status = await this.executor.signatureStatus(signal.signature).catch(() => null);
      if (status?.err) {
        this.state.updateSignal(signal.targetSignature, {
          status: "failed_onchain", error: JSON.stringify(status.err)
        });
        if (signal.side === "SELL") this.#scheduleExitRetry(signal.mint, "failed_onchain");
        continue;
      }
      let height = await this.executor.currentBlockHeight();
      if (
        !["confirmed", "finalized"].includes(status?.confirmationStatus) &&
        height <= Number(signal.lastValidBlockHeight)
      ) {
        await this.executor.confirm(signal.signature, {
          lastValidBlockHeight: Number(signal.lastValidBlockHeight)
        }).catch(() => null);
        status = await this.executor.signatureStatus(signal.signature).catch(() => null);
        height = await this.executor.currentBlockHeight();
      }

      const after = await this.executor.tokenBalance(mint, tokenProgram);
      const changed = signal.side === "BUY" ? after > before : after < before;
      if (!changed) {
        const nextStatus = status?.err ? "failed_onchain" :
          height > Number(signal.lastValidBlockHeight)
            ? "expired_no_balance_change" : "confirmation_unknown";
        this.state.updateSignal(signal.targetSignature, { status: nextStatus });
        if (signal.side === "SELL" && nextStatus !== "confirmation_unknown") {
          this.#scheduleExitRetry(signal.mint, nextStatus);
        }
        continue;
      }

      let pnl = null;
      if (signal.side === "BUY") {
        const bought = after - before;
        if (!this.state.positions.has(signal.mint)) {
          const entryDelta = await this.#transactionDelta(signal.signature, -BigInt(signal.rawAmount));
          this.state.setPosition({
            mint: signal.mint, rawTokenAmount: bought.toString(),
            tokenProgram: signal.tokenProgram, venue: signal.venue, openedAt: signal.at,
            entrySignature: signal.signature, targetEntrySignature: signal.targetSignature,
            costLamports: signal.rawAmount, entryWalletDeltaLamports: entryDelta.toString(),
            sourceWallet: signal.sourceWallet ?? null, sourceName: signal.sourceName ?? null
          });
        }
      } else {
        const position = this.state.positions.get(signal.mint);
        if (position) {
          const sold = before - after;
          const remaining = BigInt(position.rawTokenAmount) > sold
            ? BigInt(position.rawTokenAmount) - sold : 0n;
          if (remaining === 0n) {
            this.state.deletePosition(signal.mint);
            let tokenAccountClose = null;
            if (after === 0n) {
              this.state.updateSignal(signal.targetSignature, {
                status: "confirmed_pending_close",
                confirmationStatus: status?.confirmationStatus ?? "balance_change"
              });
              tokenAccountClose = await this.#closeSoldTokenAccount(
                signal.targetSignature, mint, tokenProgram
              );
            }
            pnl = await this.#realizePosition(position, signal.signature, tokenAccountClose);
          } else {
            this.state.setPosition({
              ...position, rawTokenAmount: remaining.toString(),
              exitRequest: { ...position.exitRequest, nextAttemptAt: new Date().toISOString() }
            });
          }
        }
      }

      const currentSignal = this.state.handledSignals.find(
        (item) => item.targetSignature === signal.targetSignature
      );
      if (currentSignal?.status !== "confirmed") {
        this.state.updateSignal(signal.targetSignature, {
          status: "reconciled_confirmed",
          confirmationStatus: status?.confirmationStatus ?? "balance_change",
          ...(pnl ?? {})
        });
      }
      this.log("live_reconciled", {
        side: signal.side, mint: signal.mint, signature: signal.signature, ...(pnl ?? {})
      });
    }
  }

  async maintenanceTrades() {
    await this.#resetDailyRiskIfNeeded();
    await this.#reconcilePendingSignals();
    const now = Date.now();
    const trades = [];
    for (const [mint, original] of this.state.positions) {
      if (this.settlements.has(mint) || this.#hasActiveSell(mint)) continue;
      let position = original;
      const openedAt = Date.parse(position.openedAt ?? "");
      if (
        !position.exitRequest && Number.isFinite(openedAt) &&
        now - openedAt >= (this.config.liveMaxHoldMs ?? 3_600_000)
      ) {
        position = this.#requestExit(
          position,
          { signature: `max-hold:${mint}:${position.openedAt}`, executionRoute: null },
          "max_hold"
        );
        position = {
          ...position,
          exitRequest: { ...position.exitRequest, nextAttemptAt: new Date(now).toISOString() }
        };
        this.state.setPosition(position);
      }
      const exit = position.exitRequest;
      if (!exit || Date.parse(exit.nextAttemptAt ?? "") > now) continue;
      const attempt = Number(exit.attempts ?? 0) + 1;
      this.state.setPosition({
        ...position,
        exitRequest: {
          ...exit,
          nextAttemptAt: new Date(now + (this.config.liveExitRetryBaseMs ?? 5_000)).toISOString()
        }
      });
      trades.push({
        signature: `exit:${mint}:${attempt}:${now}`, side: "SELL", mint,
        blockTime: Math.floor(now / 1_000), observedAtMs: now,
        signalSource: exit.reason === "max_hold" ? "max_hold" : "exit_retry",
        executionRoute: exit.executionRoute ?? null,
        sourceWallet: position.sourceWallet ?? null,
        sourceName: position.sourceName ?? null
      });
    }
    return trades;
  }

  async #recoverConfirmation(side, prepared) {
    const after = await this.executor.tokenBalance(prepared.mint, prepared.tokenProgram);
    return {
      changed: side === "BUY" ? after > prepared.beforeTokenBalance : after < prepared.beforeTokenBalance,
      after
    };
  }

  #pendingBuyCount() {
    return [...this.settlements.values()].filter((entry) => entry.side === "BUY").length;
  }

  async #settleTrade(trade, rawAmount, prepared, signature) {
    let confirmation = "confirmed";
    let afterTokenBalance;
    try {
      confirmation = await this.executor.confirm(signature, prepared);
      afterTokenBalance = await this.executor.tokenBalance(prepared.mint, prepared.tokenProgram);
    } catch (error) {
      const recovery = await this.#recoverConfirmation(trade.side, prepared).catch(() => ({
        changed: false, after: prepared.beforeTokenBalance
      }));
      if (!recovery.changed) {
        this.state.updateSignal(trade.signature, {
          status: "confirmation_unknown", signature, error: errorMessage(error)
        });
        if (trade.side === "SELL") {
          this.#scheduleExitRetry(trade.mint, `confirmation_unknown:${errorMessage(error)}`);
        }
        const record = {
          type: "LIVE_UNKNOWN", at: new Date().toISOString(),
          targetSignature: trade.signature, signature, mint: trade.mint,
          side: trade.side, error: errorMessage(error),
          sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
        };
        this.#write(record);
        return record;
      }
      confirmation = "balance_change_after_confirmation_error";
      afterTokenBalance = recovery.after;
    }

    if (trade.side === "BUY") {
      const bought = afterTokenBalance - prepared.beforeTokenBalance;
      if (bought <= 0n) {
        this.state.updateSignal(trade.signature, { status: "confirmed_no_tokens", signature });
        return this.#skip(trade, "confirmed_but_no_token_balance_increase");
      }
      const entryDelta = await this.#transactionDelta(signature, -rawAmount);
      const position = {
        mint: trade.mint, rawTokenAmount: bought.toString(),
        tokenProgram: prepared.tokenProgram.toBase58(), venue: prepared.venue,
        openedAt: new Date().toISOString(), entrySignature: signature,
        targetEntrySignature: trade.signature, costLamports: rawAmount.toString(),
        entryWalletDeltaLamports: entryDelta.toString(),
        sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
      };
      this.state.setPosition(position);
      this.state.updateSignal(trade.signature, {
        status: "confirmed", signature, confirmation,
        entryWalletDeltaLamports: entryDelta.toString()
      });
      const record = {
        type: "LIVE_BUY", at: position.openedAt, mint: trade.mint,
        sourceWallet: position.sourceWallet, sourceName: position.sourceName,
        rawTokenAmount: bought.toString(), spendSol: Number(rawAmount) / LAMPORTS_PER_SOL,
        walletDeltaLamports: entryDelta.toString(), venue: prepared.venue,
        signature, targetSignature: trade.signature, confirmation
      };
      this.#write(record);
      return record;
    }

    const position = this.state.positions.get(trade.mint);
    if (!position) {
      this.state.updateSignal(trade.signature, {
        status: "confirmation_unknown", signature,
        error: "position_missing_during_sell_settlement"
      });
      return this.#skip(trade, "position_missing_during_sell_settlement");
    }
    const sold = prepared.beforeTokenBalance - afterTokenBalance;
    if (sold <= 0n) {
      this.#scheduleExitRetry(trade.mint, "confirmed_but_no_token_balance_decrease");
      return this.#skip(trade, "confirmed_but_no_token_balance_decrease");
    }
    const remaining = BigInt(position.rawTokenAmount) > sold
      ? BigInt(position.rawTokenAmount) - sold : 0n;
    if (remaining === 0n) this.state.deletePosition(trade.mint);
    else {
      this.state.setPosition({
        ...position, rawTokenAmount: remaining.toString(),
        exitRequest: { ...position.exitRequest, nextAttemptAt: new Date().toISOString() }
      });
    }
    let tokenAccountClose = { status: "not_attempted_position_remaining" };
    if (remaining === 0n && afterTokenBalance === 0n) {
      this.state.updateSignal(trade.signature, {
        status: "confirmed_pending_close", signature, confirmation
      });
      tokenAccountClose = await this.#closeSoldTokenAccount(
        trade.signature, prepared.mint, prepared.tokenProgram
      );
    } else {
      this.state.updateSignal(trade.signature, { status: "confirmed", signature, confirmation });
    }
    const pnl = remaining === 0n
      ? await this.#realizePosition(position, signature, tokenAccountClose) : {};
    if (remaining === 0n) {
      this.state.updateSignal(trade.signature, { status: "confirmed", ...pnl });
    }
    const record = {
      type: "LIVE_SELL", at: new Date().toISOString(), mint: trade.mint,
      sourceWallet: position.sourceWallet ?? trade.sourceWallet ?? null,
      sourceName: position.sourceName ?? trade.sourceName ?? null,
      rawTokenAmountSold: sold.toString(), rawTokenAmountRemaining: remaining.toString(),
      venue: prepared.venue, signature, targetSignature: trade.signature,
      entrySignature: position.entrySignature, confirmation, tokenAccountClose, ...pnl
    };
    this.#write(record);
    return record;
  }

  #startSettlement(trade, rawAmount, prepared, signature) {
    const promise = this.#settleTrade(trade, rawAmount, prepared, signature)
      .then((record) => {
        this.log("live_settled", {
          side: trade.side, mint: trade.mint, signature,
          resultType: record.type, realizedPnlSol: record.realizedPnlSol,
          sourceWallet: trade.sourceWallet ?? null,
          sourceName: trade.sourceName ?? null
        });
        if (record.type === "LIVE_UNKNOWN") {
          const timer = setTimeout(
            () => this.#reconcilePendingSignals().catch((error) => {
              this.log("live_reconcile_retry_error", { message: errorMessage(error) });
            }),
            5_000
          );
          timer.unref();
        }
        return record;
      })
      .catch((error) => {
        this.state.updateSignal(trade.signature, {
          status: "confirmation_unknown", signature, settlementError: errorMessage(error)
        });
        if (trade.side === "SELL") {
          this.#scheduleExitRetry(trade.mint, `settlement_error:${errorMessage(error)}`);
        }
        this.log("live_settlement_error", {
          side: trade.side, mint: trade.mint, signature, message: errorMessage(error),
          sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
        });
        return {
          type: "LIVE_SETTLEMENT_ERROR", targetSignature: trade.signature,
          signature, error: errorMessage(error)
        };
      });
    const entry = { side: trade.side, promise };
    this.settlements.set(trade.mint, entry);
    const cleanup = () => {
      if (this.settlements.get(trade.mint) === entry) this.settlements.delete(trade.mint);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async #prepareWithFallback(trade, rawAmount, prepareOptions = {}) {
    const requested = trade.executionRoute ?? null;
    const routes = trade.side === "SELL"
      ? requested === "jupiter" ? ["jupiter", null] : [requested, "jupiter"]
      : [requested];
    let firstError;
    for (let index = 0; index < routes.length; index += 1) {
      try {
        const prepared = await this.executor.prepare(trade.side, trade.mint, rawAmount, {
          ...prepareOptions,
          executionRoute: routes[index]
        });
        if (index > 0) {
          this.log("live_route_fallback", {
            side: trade.side, mint: trade.mint, route: routes[index] ?? "direct",
            firstError: errorMessage(firstError)
          });
        }
        return prepared;
      } catch (error) {
        firstError ??= error;
        if (index === routes.length - 1) {
          throw new Error(
            routes.length > 1
              ? `all_exit_routes_failed:${errorMessage(firstError)} | ${errorMessage(error)}`
              : errorMessage(error)
          );
        }
      }
    }
    throw firstError;
  }

  #entryDriftBps(trade, prepared, rawAmount) {
    if (
      trade.side !== "BUY" || !Number.isFinite(trade.averagePriceSol) ||
      trade.averagePriceSol <= 0 || !/^\d+$/.test(prepared.expectedTokenOutRaw ?? "") ||
      !Number.isInteger(prepared.tokenDecimals)
    ) return null;
    const expectedTokens = Number(prepared.expectedTokenOutRaw) / 10 ** prepared.tokenDecimals;
    if (!Number.isFinite(expectedTokens) || expectedTokens <= 0) return null;
    const copyPrice = (Number(rawAmount) / LAMPORTS_PER_SOL) / expectedTokens;
    return Math.round((copyPrice / trade.averagePriceSol - 1) * 10_000);
  }

  async probeBuy(trade, spendSol = this.config.shadowTradeSol ?? this.config.liveTradeSol) {
    if (trade.side !== "BUY") throw new Error("Only BUY signals can be probed");
    const startedAtMs = Date.now();
    const rawAmount = solToLamports(spendSol);
    const prepared = await this.#prepareWithFallback(trade, rawAmount, {
      venueHint: trade.venue ?? null,
      skipSimulation: true,
      skipBeforeTokenBalance: true
    });
    const preparedAtMs = Date.now();
    const expectedTokenOutRaw = prepared.expectedTokenOutRaw ?? null;
    const tokenDecimals = prepared.tokenDecimals ?? null;
    const expectedTokens = /^\d+$/.test(expectedTokenOutRaw ?? "") &&
      Number.isInteger(tokenDecimals)
      ? Number(expectedTokenOutRaw) / 10 ** tokenDecimals
      : null;
    const copyPriceSol = Number.isFinite(expectedTokens) && expectedTokens > 0
      ? spendSol / expectedTokens
      : null;
    return {
      venue: prepared.venue,
      expectedTokenOutRaw,
      tokenDecimals,
      copyPriceSol,
      entryDriftBps: this.#entryDriftBps(trade, prepared, rawAmount),
      prepareMs: preparedAtMs - startedAtMs,
      signalToPreparedMs: Number.isFinite(trade.observedAtMs)
        ? preparedAtMs - trade.observedAtMs : null,
      preparedAtMs
    };
  }

  async onTrade(trade) {
    await this.#resetDailyRiskIfNeeded();
    if (!this.#liveTraderEnabled(trade)) {
      const ownedPosition = trade.side === "SELL"
        ? this.state.positions.get(trade.mint) : null;
      if (!ownedPosition || ownedPosition.sourceWallet !== trade.sourceWallet) {
        return this.#skip(trade, "trader_monitor_only");
      }
    }
    if (trade.side === "SELL") {
      const ownedPosition = this.state.positions.get(trade.mint);
      if (ownedPosition && !this.#samePositionSource(ownedPosition, trade)) {
        return this.#skip(trade, "position_owned_by_other_trader");
      }
    }
    if (this.state.hasHandled(trade.signature)) return this.#skip(trade, "signal_already_handled");

    const pending = this.settlements.get(trade.mint);
    if (pending) await pending.promise;

    const signalAgeMs = trade.signalSource === "processed_logs" && Number.isFinite(trade.observedAtMs)
      ? Math.max(0, Date.now() - trade.observedAtMs)
      : trade.blockTime ? Math.max(0, Date.now() - trade.blockTime * 1_000) : null;
    const maxSignalAgeMs = trade.fastProfile
      ? this.config.fastMaxSignalAgeMs ?? this.config.maxSignalAgeMs
      : this.config.maxSignalAgeMs;
    const prewarm = this.executor.prewarm(trade.mint, {
      venueHint: trade.venue ?? null
    }).catch(() => null);
    let rawAmount;

    if (trade.side === "BUY") {
      this.#enforceRiskLimits();
      if (this.#buyPauseActive()) return this.#skip(trade, "buy_pause_active");
      if (signalAgeMs === null || signalAgeMs > maxSignalAgeMs) {
        return this.#skip(trade, `signal_too_old_${signalAgeMs ?? "unknown"}ms`);
      }
      if (this.state.positions.has(trade.mint)) return this.#skip(trade, "position_already_open");
      if (this.state.positions.size + this.#pendingBuyCount() >= this.config.maxOpenPositions) {
        return this.#skip(trade, "max_open_positions");
      }
      const tradeLamports = solToLamports(this.config.liveTradeSol);
      const dailyCap = solToLamports(this.config.liveMaxDailySpendSol);
      if (this.state.dailySpendLamports + tradeLamports > dailyCap) {
        return this.#skip(trade, "daily_spend_limit");
      }
      const balance = BigInt(await this.executor.balanceLamports());
      const minimumAfterTrade = solToLamports(this.config.liveMinReserveSol) + tradeLamports +
        solToLamports(this.config.livePriorityFeeSol) + solToLamports(this.config.liveTipSol);
      if (balance < minimumAfterTrade) return this.#skip(trade, "insufficient_balance_reserve");
      rawAmount = tradeLamports;
    } else {
      const existing = this.state.positions.get(trade.mint);
      if (!existing) return this.#skip(trade, "no_live_position");
      if (!this.#samePositionSource(existing, trade)) {
        return this.#skip(trade, "position_owned_by_other_trader");
      }
      const position = this.#requestExit(
        existing, trade, trade.signalSource === "max_hold" ? "max_hold" : "target_sell"
      );
      const current = await this.executor.tokenBalance(
        new PublicKey(position.mint), new PublicKey(position.tokenProgram)
      );
      if (current === 0n) {
        this.state.deletePosition(trade.mint);
        return this.#skip(trade, "position_balance_already_zero");
      }
      rawAmount = bigintMin(BigInt(position.rawTokenAmount), current);
    }

    await prewarm;
    let prepared;
    let preparedAtMs;
    let entryDriftBps = null;
    const prepareStartedAtMs = Date.now();
    try {
      prepared = await this.#prepareWithFallback(trade, rawAmount, {
        venueHint: trade.venue ?? null,
        skipSimulation: Boolean(trade.fastProfile && this.config.fastSkipSimulation),
        skipBeforeTokenBalance: Boolean(trade.fastProfile && trade.side === "BUY")
      });
      preparedAtMs = Date.now();
    } catch (error) {
      const message = errorMessage(error);
      if (trade.side === "SELL") this.#scheduleExitRetry(trade.mint, `prepare_failed:${message}`);
      const record = this.#skip(trade, `prepare_failed:${message}`);
      this.log("live_prepare_failed", { side: trade.side, mint: trade.mint, message });
      return record;
    }

    if (trade.side === "BUY") {
      const currentAge = Number.isFinite(trade.observedAtMs)
        ? Date.now() - trade.observedAtMs : signalAgeMs;
      if (currentAge === null || currentAge > maxSignalAgeMs) {
        return this.#skip(trade, `signal_too_old_after_prepare_${currentAge ?? "unknown"}ms`);
      }
      entryDriftBps = this.#entryDriftBps(trade, prepared, rawAmount);
      const maxEntryDriftBps = trade.fastProfile
        ? this.config.fastMaxEntryDriftBps ?? this.config.liveMaxEntryDriftBps ?? 500
        : this.config.liveMaxEntryDriftBps ?? 500;
      if (entryDriftBps !== null && entryDriftBps > maxEntryDriftBps) {
        return this.#skip(trade, `entry_price_drift_${entryDriftBps}bps`);
      }
    }

    if (trade.side === "SELL") {
      const position = this.state.positions.get(trade.mint);
      const sellable = bigintMin(BigInt(position.rawTokenAmount), prepared.beforeTokenBalance);
      if (sellable === 0n) {
        this.state.deletePosition(trade.mint);
        return this.#skip(trade, "position_balance_already_zero");
      }
      if (sellable !== rawAmount) {
        try {
          prepared = await this.#prepareWithFallback(trade, sellable);
          rawAmount = sellable;
        } catch (error) {
          const message = errorMessage(error);
          this.#scheduleExitRetry(trade.mint, `prepare_adjusted_sell_failed:${message}`);
          return this.#skip(trade, `prepare_adjusted_sell_failed:${message}`);
        }
      }
    }

    const reservation = {
      venue: prepared.venue, signature: prepared.expectedSignature,
      tokenProgram: prepared.tokenProgram.toBase58(),
      beforeTokenBalance: prepared.beforeTokenBalance.toString(),
      rawAmount: rawAmount.toString(), lastValidBlockHeight: prepared.lastValidBlockHeight,
      sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
    };
    if (!this.state.reserveSignal(trade, reservation, trade.side === "BUY" ? rawAmount : 0n)) {
      return this.#skip(trade, "signal_already_handled");
    }

    let signature;
    try {
      signature = await this.executor.submit(prepared);
      this.state.updateSignal(trade.signature, { status: "submitted", signature });
    } catch (error) {
      const message = errorMessage(error);
      this.state.updateSignal(trade.signature, {
        status: "submit_failed", signature: prepared.expectedSignature, error: message
      });
      if (trade.side === "SELL") this.#scheduleExitRetry(trade.mint, `submit_failed:${message}`);
      const record = {
        type: "LIVE_FAILED", stage: "submit", at: new Date().toISOString(),
        targetSignature: trade.signature, mint: trade.mint, side: trade.side, error: message,
        sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
      };
      this.#write(record);
      return record;
    }

    const submittedAtMs = Date.now();
    const submittedRecord = {
      type: "LIVE_SUBMITTED", at: new Date(submittedAtMs).toISOString(),
      targetSignature: trade.signature, signature, mint: trade.mint, side: trade.side,
      venue: prepared.venue, signalSource: trade.signalSource ?? "unknown",
      fastProfile: Boolean(trade.fastProfile),
      sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null,
      entryDriftBps,
      prepareMs: preparedAtMs - prepareStartedAtMs,
      signalToPreparedMs: Number.isFinite(trade.observedAtMs)
        ? preparedAtMs - trade.observedAtMs : null,
      signalToSubmitMs: Number.isFinite(trade.observedAtMs)
        ? submittedAtMs - trade.observedAtMs : null
    };
    this.#write(submittedRecord);
    this.log("live_submitted", submittedRecord);
    this.#startSettlement(trade, rawAmount, prepared, signature);
    return submittedRecord;
  }
}
