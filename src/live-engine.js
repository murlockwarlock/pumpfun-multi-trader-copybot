import { ExecutionLanes } from "./execution-lanes.js";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { loadLiveWallet } from "./live-wallet.js";
import { LiveState, UNRESOLVED_SELL_STATUSES } from "./live-state.js";
import { PumpExecutor } from "./pump-executor.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const LIVE_CONFIRMATION = "I_UNDERSTAND_REAL_FUNDS";
const ACTIVE_SIGNAL_STATUSES = new Set([
  "reserved", "submitted", "processed", "confirmation_unknown", "submit_failed",
  "reconcile_unavailable", "sell_proceeds_unknown", "confirmed_pending_close", "sell_pnl_pending",
  // A quarantined BUY still occupies its mint and capital reservation.  It is
  // deliberately handled as an active exposure, not as a terminal signal.
  "position_quarantined"
]);
const RECOVERABLE_EXIT_STATUSES = new Set(["expired_no_balance_change", "legacy_exit_unknown"]);

const solToLamports = (sol) => BigInt(Math.round(sol * LAMPORTS_PER_SOL));
const bigintMin = (left, right) => left < right ? left : right;
const toBigIntOrNull = (value) => {
  if (value === null || value === undefined) return null;
  try { return BigInt(value); } catch { return null; }
};
const errorMessage = (error) => error?.message ?? String(error);

export class LiveEngine {
  constructor(config, log, lanes = new ExecutionLanes()) {
    this.lanes = lanes;
    this.config = config;
    this.log = log;
    this.state = new LiveState(config.liveStateFile);
    this.wallet = null;
    this.executor = null;
    this.settlements = new Map();
    this.preparingBuys = new Map();
    this.pendingExits = new Map();
    this.submitting = new Set();
    fs.mkdirSync(path.dirname(config.liveLogFile), { recursive: true });
  }

  get positions() {
    return this.state.positions;
  }

  get unresolvedExitCount() {
    return this.state.handledSignals.filter(signal =>
      signal.side === "SELL" && UNRESOLVED_SELL_STATUSES.has(signal.status)).length;
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
      openPositions: this.state.positions.size,
      unresolvedExits: this.unresolvedExitCount,
      ...this.inventoryHealth()
    };
  }

  inventoryHealth() {
    const quarantinedPositions = [...this.state.positions.values()]
      .filter(position => position.ownershipStatus === "quarantined").length;
    const quarantinedBuysWithoutPosition = [...this.state.quarantines.values()]
      .filter(quarantine => !this.state.positions.has(quarantine.mint)).length;
    return {
      quarantinedMints: this.state.quarantines.size,
      quarantinedBuysWithoutPosition,
      quarantinedPositions,
      quarantines: [...this.state.quarantines.values()].map(quarantine => ({
        mint: quarantine.mint,
        reason: quarantine.reason,
        signature: quarantine.signature ?? null,
        targetSignature: quarantine.targetSignature ?? null,
        firstSeenAt: quarantine.firstSeenAt
      }))
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
    void this.reconcile().catch(error => this.log("reconcile_error", { message: errorMessage(error) }));

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

  releaseFailedBuyQuarantine(mint, options) {
    return this.state.releaseFailedBuyQuarantine(mint, options);
  }

  releaseClosedSellQuarantine(mint, options) {
    return this.state.releaseClosedSellQuarantine(mint, options);
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

  async #transactionWalletDeltaEvidence(signature) {
    if (typeof this.executor.transactionWalletDelta !== "function") {
      return { known: false, value: 0n, reason: "transaction_wallet_delta_unavailable" };
    }
    try {
      const result = await this.executor.transactionWalletDelta(signature);
      if (!/^-?\d+$/.test(String(result?.walletDeltaLamports ?? ""))) {
        return { known: false, value: 0n, reason: "transaction_wallet_delta_missing" };
      }
      return { known: true, value: BigInt(result.walletDeltaLamports), reason: null };
    } catch (error) {
      this.log("live_wallet_delta_unavailable", { signature, message: errorMessage(error) });
      return { known: false, value: 0n, reason: "transaction_wallet_delta_unavailable" };
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

  async #realizePosition(position, sellSignature, tokenAccountClose, settlement = null) {
    const entryDelta = await this.#entryDelta(position);
    const sellDelta = settlement
      ? BigInt(settlement.cumulativeSellWalletDeltaLamports ?? "0")
      : await this.#transactionDelta(sellSignature, 0n);
    if (settlement && settlement.sellWalletDeltaKnown !== true) {
      throw new Error("Cannot realize SELL before wallet proceeds are verified");
    }
    if (settlement?.closeRequired && settlement.closeStatus !== "closed") {
      throw new Error("Cannot realize SELL before token account close is verified");
    }
    const closeDelta = settlement
      ? BigInt(settlement.closeWalletDeltaLamports ?? "0")
      : /^-?\d+$/.test(tokenAccountClose?.walletDeltaLamports ?? "")
        ? BigInt(tokenAccountClose.walletDeltaLamports) : 0n;
    const realizedPnlLamports = entryDelta + sellDelta + closeDelta;
    const risk = settlement
      ? this.state.completeSellSettlement(settlement.targetSignature, {
          realizedPnlLamports,
          closeWalletDeltaLamports: closeDelta
        })
      : this.state.recordRealizedPnl(realizedPnlLamports);
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

  async #closeSoldTokenAccount(targetSignature, mint, tokenProgram, { settlementTargetSignature = null } = {}) {
    try {
      const result = await this.executor.closeEmptyTokenAccount(mint, tokenProgram);
      const closed = result?.status === "closed" || result?.status === "already_closed";
      if (settlementTargetSignature) {
        const closeStatus = closed ? "closed" : "failed";
        if (closeStatus === "closed") {
          this.state.setSellSettlementClose(settlementTargetSignature, {
            status: "closed", result
          });
        } else {
          this.state.setSellSettlementClose(settlementTargetSignature, {
            status: "failed", result, error: result?.status ?? "token_account_not_closed"
          });
        }
        this.state.updateSignal(targetSignature, {
          status: "confirmed_pending_close",
          tokenAccountClose: result,
          closeError: closeStatus === "closed" ? null : result?.status ?? "token_account_not_closed"
        });
      } else {
        this.state.updateSignal(targetSignature, {
          status: closed ? "confirmed" : "confirmed_pending_close",
          tokenAccountClose: result,
          closeError: closed ? null : result?.status ?? "token_account_not_closed"
        });
      }
      this.log("live_token_account_close", {
        mint: mint.toString(), status: result.status, signature: result.signature,
        reclaimedLamports: result.reclaimedLamports
      });
      return result;
    } catch (error) {
      if (settlementTargetSignature) {
        this.state.setSellSettlementClose(settlementTargetSignature, {
          status: "failed", error: errorMessage(error)
        });
      }
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
    const entry = this.state.handledSignals.find(s => s.targetSignature === position.targetEntrySignature);
    if (entry?.pendingExit) this.state.updateSignal(entry.targetSignature, { pendingExit: null });
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

  #quarantinePosition(position, reason, details = {}) {
    const quarantine = this.state.quarantineMint(position.mint, {
      kind: "position",
      reason,
      signature: position.entrySignature ?? null,
      targetSignature: position.targetEntrySignature ?? null,
      evidence: details
    });
    const updated = {
      ...position,
      ownershipStatus: "quarantined",
      ownershipReason: reason,
      ownershipEvidence: details,
      ownershipBlockedAt: position.ownershipBlockedAt ?? quarantine.record.firstSeenAt
    };
    this.state.setPosition(updated);
    if (quarantine.created) {
      this.log("live_position_quarantined", {
        mint: position.mint,
        entrySignature: position.entrySignature ?? null,
        reason,
        ...details
      });
    }
    return updated;
  }

  #quarantineBuy(signal, reason, details = {}) {
    const quarantine = this.state.quarantineMint(signal.mint, {
      kind: "buy",
      reason,
      signature: signal.signature ?? null,
      targetSignature: signal.targetSignature,
      evidence: details
    });
    this.state.updateSignal(signal.targetSignature, {
      status: "position_quarantined",
      ownershipStatus: "quarantined",
      ownershipReason: reason,
      ownershipEvidence: details,
      quarantineFirstSeenAt: quarantine.record.firstSeenAt
    });
    const position = this.state.positions.get(signal.mint);
    if (position && position.ownershipStatus !== "quarantined") {
      this.#quarantinePosition(position, reason, details);
    }
    if (quarantine.created) {
      this.log("live_position_quarantined", {
        mint: signal.mint,
        targetSignature: signal.targetSignature,
        signature: signal.signature ?? null,
        reason,
        ...details
      });
    }
  }

  #inventoryBaseline(position) {
    if (/^\d+$/.test(position.inventoryBaselineRaw ?? "")) {
      return BigInt(position.inventoryBaselineRaw);
    }
    const entry = this.state.handledSignals.find(signal =>
      signal.targetSignature === position.targetEntrySignature ||
      signal.signature === position.entrySignature
    );
    if (entry?.beforeTokenBalanceKnown === true && /^\d+$/.test(entry.beforeTokenBalance ?? "")) {
      return BigInt(entry.beforeTokenBalance);
    }
    return null;
  }

  #hasActiveSell(mint) {
    return this.state.handledSignals.some(
      (signal) => signal.mint === mint && signal.side === "SELL" &&
        ACTIVE_SIGNAL_STATUSES.has(signal.status)
    );
  }

  #hasUnresolvedExit(mint) {
    return this.state.handledSignals.some(signal =>
      signal.mint === mint && signal.side === "SELL" &&
      (RECOVERABLE_EXIT_STATUSES.has(signal.status) || signal.status === "confirmation_unknown")
    );
  }

  #sellWasSubmittedBeforeQuarantine(signal, position) {
    const quarantine = this.state.getQuarantine(signal.mint);
    const signalAt = Date.parse(signal.at ?? "");
    const quarantineAt = Date.parse(quarantine?.firstSeenAt ?? "");
    return signal.side === "SELL" && position?.ownershipStatus === "quarantined" &&
      signal.entrySignature && position.entrySignature === signal.entrySignature &&
      Number.isFinite(signalAt) && Number.isFinite(quarantineAt) && signalAt <= quarantineAt;
  }

  #isAmbiguousSubmitError(error) {
    const message = errorMessage(error);
    if (/timeout|timed out|network|socket|econn|aborted/i.test(message)) return true;
    // Only explicit rejection evidence releases the reservation immediately.
    return !/simulation failed|preflight failure|insufficient funds|signature verification fail|invalid transaction|blockhash not found|(?:sendTransaction|Jupiter execute) HTTP (?:400|401|403|413|422)\b/i.test(message);
  }

  async #finalizeFailedBuy(signal, status) {
    if (signal.side !== "BUY" || !["confirmed", "finalized"].includes(status?.confirmationStatus)) {
      return false;
    }
    let fee;
    try {
      fee = (await this.executor.transactionWalletDelta(signal.signature)).feeLamports;
    } catch (error) {
      this.log("live_buy_failure_pending", {
        mint: signal.mint, targetSignature: signal.targetSignature,
        signature: signal.signature, reason: "transaction_fee_unavailable",
        message: errorMessage(error)
      });
      return false;
    }
    if (!/^\d+$/.test(String(fee ?? ""))) {
      this.log("live_buy_failure_pending", {
        mint: signal.mint, targetSignature: signal.targetSignature,
        signature: signal.signature, reason: "transaction_fee_unavailable"
      });
      return false;
    }
    this.state.updateSignal(signal.targetSignature, {
      status: "failed_onchain", error: JSON.stringify(status.err),
      failedFeeLamports: String(fee), pendingExit: null
    });
    this.log("live_buy_failed_onchain", {
      mint: signal.mint, targetSignature: signal.targetSignature,
      signature: signal.signature, failedFeeLamports: String(fee)
    });
    return true;
  }

  #sellSettlementNeedsRecovery(settlement) {
    return Boolean(settlement && (
      settlement.sellWalletDeltaKnown !== true ||
      settlement.completed !== true ||
      settlement.pnlRecorded !== true ||
      (settlement.closeRequired === true && settlement.closeStatus !== "closed")
    ));
  }

  async #recoverSellSettlement(signal, initialSettlement) {
    let settlement = initialSettlement;
    if (settlement.sellWalletDeltaKnown !== true) {
      const evidence = await this.#transactionWalletDeltaEvidence(signal.signature);
      if (!evidence.known) {
        this.state.updateSignal(signal.targetSignature, {
          status: "sell_proceeds_unknown",
          recoveryEvidence: evidence.reason
        });
        return false;
      }
      settlement = this.state.resolveSellProceeds(
        settlement.targetSignature, evidence.value.toString()
      );
    }

    if (settlement.remainingRaw === "0" && settlement.closeRequired === true &&
        settlement.closeStatus !== "closed") {
      const tokenProgram = signal.tokenProgram ?? settlement.positionSnapshot?.tokenProgram;
      if (!signal.mint || !tokenProgram) {
        this.state.updateSignal(signal.targetSignature, {
          status: "reconcile_unavailable",
          recoveryEvidence: "token_program_unavailable_for_sell_account_close"
        });
        return false;
      }
      this.state.updateSignal(signal.targetSignature, {
        status: "confirmed_pending_close",
        recoveryEvidence: "sell_inventory_applied_close_pending"
      });
      await this.#closeSoldTokenAccount(
        signal.targetSignature,
        new PublicKey(signal.mint),
        new PublicKey(tokenProgram),
        { settlementTargetSignature: settlement.targetSignature }
      );
      settlement = this.state.getSellSettlement(settlement.targetSignature);
      if (settlement?.closeStatus !== "closed") return false;
    }

    if (settlement.remainingRaw === "0") {
      if (!settlement.pnlRecorded) {
        await this.#realizePosition(
          settlement.positionSnapshot,
          signal.signature,
          { walletDeltaLamports: settlement.closeWalletDeltaLamports ?? "0" },
          settlement
        );
      } else if (signal.status !== "reconciled_confirmed") {
        this.state.updateSignal(signal.targetSignature, {
          status: "reconciled_confirmed", settlementApplied: true
        });
      }
    } else if (!settlement.completed) {
      this.state.completeSellSettlement(signal.targetSignature, {
        status: "reconciled_confirmed"
      });
    }
    return true;
  }

  recoveryJobs = new Map();

  reconcile() {
    const mints = new Set(this.state.handledSignals.filter(s =>
      s.status === "confirmed_pending_close" || ACTIVE_SIGNAL_STATUSES.has(s.status) ||
      RECOVERABLE_EXIT_STATUSES.has(s.status)).map(s => s.mint));
    for (const settlement of this.state.sellSettlements.values()) {
      if (this.#sellSettlementNeedsRecovery(settlement)) mints.add(settlement.mint);
    }
    return Promise.all([...mints].map(mint => {
      if (!this.recoveryJobs.has(mint)) {
        const task = this.#reconcileMint(mint).finally(() => this.recoveryJobs.delete(mint));
        this.recoveryJobs.set(mint, task);
      }
      return this.recoveryJobs.get(mint);
    }));
  }

  async #reconcileMint(address) {
    // Quarantine is sticky for ownership and SELL authorization.  It must not
    // suspend the separate read-only transaction-status path: a confirmed
    // on-chain failure can still prove that reserved BUY capital was not
    // spent, and its fee must be accounted for exactly once.
    const orphan = this.#pendingBuys().find(s => s.mint === address && s.pendingExit);
    if (orphan && !this.positions.has(address) && !this.settlements.has(address) && !this.#hasActiveSell(address)) {
      const buyStatus = await this.executor.signatureStatus(orphan.signature).catch(() => null);
      if (buyStatus?.err) {
        if (["confirmed", "finalized"].includes(buyStatus.confirmationStatus)) {
          await this.#finalizeFailedBuy(orphan, buyStatus);
        } else {
          this.log("live_buy_failure_pending", {
            mint: orphan.mint, targetSignature: orphan.targetSignature,
            signature: orphan.signature, reason: "processed_error_not_final"
          });
        }
        return;
      }
      let executedDelta = null;
      if (["confirmed", "finalized"].includes(buyStatus?.confirmationStatus)) {
        executedDelta = typeof this.executor.transactionTokenDelta === "function"
          ? await this.executor.transactionTokenDelta(
              orphan.signature, address, this.wallet?.publicKey, "confirmed"
            ).catch(() => null)
          : null;
      } else if (buyStatus?.confirmationStatus === "processed" &&
        typeof this.executor.processedTokenDelta === "function") {
        executedDelta = await this.executor.processedTokenDelta(
          orphan.signature, address, this.wallet?.publicKey, orphan.tokenProgram
        ).catch(() => null);
      } else {
        this.log("live_buy_processed_deferred", {
          mint: orphan.mint, signature: orphan.signature,
          targetSignature: orphan.targetSignature,
          reason: "transaction_metadata_requires_confirmed"
        });
        return;
      }
      executedDelta = toBigIntOrNull(executedDelta);
      if (executedDelta === null || executedDelta <= 0n) return;
      const balanceCommitment = buyStatus.confirmationStatus === "processed"
        ? "processed" : "confirmed";
      const balance = await this.executor.tokenBalance(
        new PublicKey(address), new PublicKey(orphan.tokenProgram), balanceCommitment
      );
      const before = orphan.beforeTokenBalanceKnown === true && /^\d+$/.test(orphan.beforeTokenBalance ?? "")
        ? BigInt(orphan.beforeTokenBalance) : null;
      if (before === null) {
        this.#quarantineBuy(orphan, "inventory_baseline_unproven", {
          transactionTokenDelta: executedDelta.toString(),
          observedTokenBalance: balance.toString(),
          evidence: "post_buy_balance_cannot_reconstruct_pre_buy_inventory_or_intervening_flows"
        });
        return;
      }
      if (balance < before + executedDelta) {
        this.#quarantineBuy(orphan, "post_buy_inventory_ambiguous", {
          beforeTokenBalance: before.toString(),
          transactionTokenDelta: executedDelta.toString(),
          observedTokenBalance: balance.toString(),
          evidence: "confirmed_buy_delta_but_inventory_below_expected"
        });
        return;
      }
      const bought = executedDelta;
      if (bought > 0n && !this.positions.has(address)) {
        this.state.setPosition({
          mint: address, rawTokenAmount: bought.toString(), tokenProgram: orphan.tokenProgram,
          venue: orphan.venue, openedAt: orphan.at, entrySignature: orphan.signature,
          targetEntrySignature: orphan.targetSignature, costLamports: orphan.rawAmount,
          inventoryBaselineRaw: before.toString(),
          provisional: buyStatus.confirmationStatus === "processed",
          sourceWallet: orphan.sourceWallet, sourceName: orphan.sourceName
        });
        await this.onTrade(orphan.pendingExit);
      }
    }
    const pendingCloses = this.state.handledSignals.filter(s => s.mint === address && s.status === "confirmed_pending_close");
    for (const signal of pendingCloses) {
      if (!signal.mint || !signal.tokenProgram) continue;
      const settlement = signal.side === "SELL"
        ? this.state.getSellSettlement(signal.targetSignature) : null;
      if (settlement && settlement.signature === signal.signature &&
          this.#sellSettlementNeedsRecovery(settlement)) continue;
      await this.#closeSoldTokenAccount(
        signal.targetSignature,
        new PublicKey(signal.mint),
        new PublicKey(signal.tokenProgram)
      );
    }

    const pending = this.state.handledSignals.filter((signal) =>
      signal.mint === address && (ACTIVE_SIGNAL_STATUSES.has(signal.status) ||
        RECOVERABLE_EXIT_STATUSES.has(signal.status) ||
        (signal.side === "SELL" && this.#sellSettlementNeedsRecovery(
          this.state.getSellSettlement(signal.targetSignature)
        )))
    );
    for (const signal of pending) {
      const pendingSettlement = signal.side === "SELL"
        ? this.state.getSellSettlement(signal.targetSignature) : null;
      if (pendingSettlement && pendingSettlement.signature === signal.signature &&
          this.#sellSettlementNeedsRecovery(pendingSettlement)) {
        await this.#recoverSellSettlement(signal, pendingSettlement);
        continue;
      }
      if (this.settlements.has(signal.mint) || this.submitting.has(signal.targetSignature)) continue;
      if (
        !signal.signature || !signal.mint || !signal.tokenProgram ||
        !/^\d+$/.test(signal.beforeTokenBalance ?? "") ||
        !/^\d+$/.test(signal.rawAmount ?? "") ||
        !Number.isFinite(Number(signal.lastValidBlockHeight))
      ) {
        if (signal.side === "SELL" && RECOVERABLE_EXIT_STATUSES.has(signal.status)) {
          this.state.updateSignal(signal.targetSignature, {
            status: "legacy_exit_unknown", recoveryEvidence: "missing_transaction_evidence"
          });
          this.log("live_exit_recovery", {
            mint: signal.mint, targetSignature: signal.targetSignature,
            signature: signal.signature ?? null, status: "legacy_exit_unknown",
            recoveryEvidence: "missing_transaction_evidence"
          });
        } else {
          this.state.updateSignal(signal.targetSignature, { status: "reconcile_unavailable" });
          if (signal.side === "SELL") this.#scheduleExitRetry(signal.mint, "reconcile_unavailable");
        }
        continue;
      }
      const mint = new PublicKey(signal.mint);
      const tokenProgram = new PublicKey(signal.tokenProgram);
      const before = BigInt(signal.beforeTokenBalance);
      const status = await this.executor.signatureStatus(signal.signature);
      if (RECOVERABLE_EXIT_STATUSES.has(signal.status)) {
        if (status?.err) {
          this.state.updateSignal(signal.targetSignature, {
            status: "retry_safe", recoveryEvidence: "confirmed_transaction_error"
          });
          this.#scheduleExitRetry(signal.mint, "confirmed_transaction_error");
          this.log("live_exit_recovery", {
            mint: signal.mint, targetSignature: signal.targetSignature,
            signature: signal.signature, status: "retry_safe",
            recoveryEvidence: "confirmed_transaction_error"
          });
        } else if (["processed", "confirmed", "finalized"].includes(status?.confirmationStatus)) {
          this.state.updateSignal(signal.targetSignature, {
            status: "confirmation_unknown", recoveryEvidence: "transaction_exists"
          });
          this.log("live_exit_recovery", {
            mint: signal.mint, targetSignature: signal.targetSignature,
            signature: signal.signature, status: "confirmation_unknown",
            recoveryEvidence: "transaction_exists"
          });
        } else {
          this.state.updateSignal(signal.targetSignature, {
            status: "legacy_exit_unknown", recoveryEvidence: "signature_unresolved"
          });
          this.log("live_exit_recovery", {
            mint: signal.mint, targetSignature: signal.targetSignature,
            signature: signal.signature, status: "legacy_exit_unknown",
            recoveryEvidence: "signature_unresolved"
          });
        }
        continue;
      }
      if (!["confirmed","finalized"].includes(status?.confirmationStatus)) continue;
      if (status.err) {
        if (signal.side === "BUY") {
          await this.#finalizeFailedBuy(signal, status);
        } else {
          this.state.updateSignal(signal.targetSignature, {
            status: "failed_onchain", error: JSON.stringify(status.err)
          });
          this.#scheduleExitRetry(signal.mint, "failed_onchain");
        }
        continue;
      }
      const appliedSellSettlement = signal.side === "SELL"
        ? this.state.getSellSettlement(signal.targetSignature)
        : null;
      if (appliedSellSettlement && appliedSellSettlement.signature === signal.signature) {
        if (appliedSellSettlement.remainingRaw === "0" && !appliedSellSettlement.pnlRecorded) {
          await this.#realizePosition(
            appliedSellSettlement.positionSnapshot,
            signal.signature,
            { walletDeltaLamports: appliedSellSettlement.closeWalletDeltaLamports ?? "0" },
            appliedSellSettlement
          );
        } else {
          this.state.completeSellSettlement(signal.targetSignature, {
            confirmationStatus: status?.confirmationStatus ?? "confirmed"
          });
        }
        continue;
      }

      const after = await this.executor.tokenBalance(mint, tokenProgram);
      let executedTokenDelta = null;
      if (typeof this.executor.transactionTokenDelta === "function") {
        executedTokenDelta = toBigIntOrNull(await this.executor.transactionTokenDelta(
          signal.signature, signal.mint, this.wallet?.publicKey, "confirmed"
        ).catch(() => null));
      }
      let changed = signal.side === "BUY"
        ? executedTokenDelta !== null
          ? executedTokenDelta > 0n
          : typeof this.executor.transactionTokenDelta !== "function" &&
            signal.beforeTokenBalanceKnown === true && after > before
        : executedTokenDelta !== null
          ? executedTokenDelta < 0n
          : typeof this.executor.transactionTokenDelta !== "function" && after < before;
      if (!changed) {
        // A confirmed BUY can already have been fully exited on processed.
        const exited = signal.side === "BUY" && this.state.handledSignals.some(s =>
          s.side === "SELL" && s.entrySignature === signal.signature &&
          ["confirmed", "reconciled_confirmed"].includes(s.status));
        if (exited) this.state.updateSignal(signal.targetSignature, { status: "reconciled_confirmed" });
        else if (signal.side === "SELL") this.state.updateSignal(signal.targetSignature, {
          status: "confirmation_unknown", recoveryEvidence: "confirmed_transaction_no_token_delta"
        });
        continue;
      }
      let pnl = null;
      if (signal.side === "BUY") {
        const bought = executedTokenDelta !== null && executedTokenDelta > 0n
          ? executedTokenDelta : after - before;
        const exitedWhileConfirming = this.state.handledSignals.some(candidate =>
          candidate.side === "SELL" && candidate.entrySignature === signal.signature &&
          ["confirmed", "reconciled_confirmed", "confirmed_pending_close"].includes(candidate.status)
        );
        if (signal.beforeTokenBalanceKnown !== true && !exitedWhileConfirming) {
          this.#quarantineBuy(signal, "inventory_baseline_unproven", {
            transactionTokenDelta: executedTokenDelta?.toString() ?? null,
            observedTokenBalance: after.toString(),
            evidence: "post_buy_balance_cannot_reconstruct_pre_buy_inventory_or_intervening_flows"
          });
          continue;
        }
        if (executedTokenDelta !== null && signal.beforeTokenBalanceKnown === true &&
            after < before + executedTokenDelta && !exitedWhileConfirming) {
          this.#quarantineBuy(signal, "post_buy_inventory_ambiguous", {
            beforeTokenBalance: before.toString(),
            transactionTokenDelta: executedTokenDelta.toString(),
            observedTokenBalance: after.toString(),
            evidence: "confirmed_buy_delta_but_inventory_below_expected"
          });
          continue;
        }
        const entryDelta = await this.#transactionDelta(
          signal.signature,
          -BigInt(signal.rawAmount)
        );
        const existing = this.state.positions.get(signal.mint);
        if (this.state.isQuarantined(signal.mint) || existing?.ownershipStatus === "quarantined") {
          this.#quarantineBuy(signal, "inventory_quarantine_sticky", {
            transactionTokenDelta: executedTokenDelta?.toString() ?? null,
            observedTokenBalance: after.toString(),
            evidence: "existing_durable_inventory_quarantine"
          });
          continue;
        }
        const laterSellExists = this.state.handledSignals.some((candidate) =>
          candidate.mint === signal.mint && candidate.side === "SELL" &&
          Date.parse(candidate.at ?? "") >= Date.parse(signal.at ?? "") &&
          !["failed_onchain", "submit_rejected"].includes(
            candidate.status
          )
        );
        if (!existing && !laterSellExists) {
          this.state.setPosition({
            mint: signal.mint, rawTokenAmount: bought.toString(),
            tokenProgram: signal.tokenProgram, venue: signal.venue, openedAt: signal.at,
            entrySignature: signal.signature, targetEntrySignature: signal.targetSignature,
            costLamports: signal.rawAmount, entryWalletDeltaLamports: entryDelta.toString(),
            inventoryBaselineRaw: before.toString(),
            provisional: false,
            sourceWallet: signal.sourceWallet ?? null, sourceName: signal.sourceName ?? null
          });
        } else if (existing?.entrySignature === signal.signature) {
          this.state.setPosition({
            ...existing,
            rawTokenAmount: existing.exitRequest ? existing.rawTokenAmount : bought.toString(),
            inventoryBaselineRaw: existing.inventoryBaselineRaw ?? before.toString(),
            entryWalletDeltaLamports: entryDelta.toString(),
            provisional: false
          });
        }
      } else {
        const position = this.state.positions.get(signal.mint);
        if (position) {
          if (typeof this.executor.transactionTokenDelta === "function" &&
              (executedTokenDelta === null || executedTokenDelta >= 0n)) {
            this.state.updateSignal(signal.targetSignature, {
              status: "confirmation_unknown",
              recoveryEvidence: "confirmed_sell_token_delta_unavailable"
            });
            continue;
          }
          const sold = executedTokenDelta !== null && executedTokenDelta < 0n
            ? -executedTokenDelta : before - after;
          const quarantinedSell = this.#sellWasSubmittedBeforeQuarantine(signal, position);
          const walletEvidence = await this.#transactionWalletDeltaEvidence(signal.signature);
          const remaining = BigInt(position.rawTokenAmount) - sold;
          const settlement = this.state.applySellSettlement({
            mint: signal.mint, targetSignature: signal.targetSignature,
            signature: signal.signature, entrySignature: signal.entrySignature,
            rawSoldAmount: sold,
            sellWalletDeltaLamports: walletEvidence.value,
            sellWalletDeltaKnown: walletEvidence.known,
            closeRequired: remaining === 0n && after === 0n,
            allowQuarantined: quarantinedSell
          });
          if (!settlement) {
            this.state.updateSignal(signal.targetSignature, {
              status: "confirmation_unknown",
              recoveryEvidence: quarantinedSell
                ? "confirmed_sell_does_not_match_quarantined_position"
                : "confirmed_sell_position_close_failed"
            });
            continue;
          }
          if (!walletEvidence.known) {
            this.state.updateSignal(signal.targetSignature, {
              status: "sell_proceeds_unknown",
              recoveryEvidence: walletEvidence.reason
            });
            continue;
          }
          if (settlement.remainingRaw === "0") {
            let tokenAccountClose = null;
            if (after === 0n) {
              this.state.updateSignal(signal.targetSignature, {
                status: "confirmed_pending_close",
                confirmationStatus: status?.confirmationStatus ?? "balance_change"
              });
              tokenAccountClose = await this.#closeSoldTokenAccount(
                signal.targetSignature, mint, tokenProgram,
                { settlementTargetSignature: signal.targetSignature }
              );
              const afterClose = this.state.getSellSettlement(signal.targetSignature);
              if (afterClose?.closeStatus !== "closed") continue;
            }
            pnl = await this.#realizePosition(position, signal.signature, tokenAccountClose, settlement);
          } else {
            this.state.completeSellSettlement(signal.targetSignature, {
              confirmationStatus: status?.confirmationStatus ?? "confirmed"
            });
          }
        }
      }

      const currentSignal = this.state.handledSignals.find(
        (item) => item.targetSignature === signal.targetSignature
      );
      if (currentSignal && !UNRESOLVED_SELL_STATUSES.has(currentSignal.status) &&
          currentSignal.status !== "confirmed") {
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
    void this.reconcile().catch(error => this.log("reconcile_error", { message: errorMessage(error) }));
    const now = Date.now();
    const trades = [];
    for (const [mint, original] of this.state.positions) {
      if (this.settlements.has(mint) || this.pendingExits.has(mint) ||
        this.#hasActiveSell(mint) || this.#hasUnresolvedExit(mint)) continue;

      let position = original;
      const entry = this.state.handledSignals.find(s => s.targetSignature === position.targetEntrySignature);
      if (entry?.pendingExit && !position.exitRequest) {
        position = this.#requestExit(position, entry.pendingExit, "target_sell");
      }
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


  #pendingBuys() {
    return this.state.handledSignals.filter(signal =>
      signal.side === "BUY" && ACTIVE_SIGNAL_STATUSES.has(signal.status));
  }

  async #primeProcessedBuy(trade, rawAmount, prepared, signature, readiness) {
    try {
      // A balance increase is not transaction provenance. Only an explicitly
      // supplied processed attribution source may unlock an early SELL.
      if (typeof this.executor.processedTokenDelta !== "function") {
        readiness.error = "processed_token_attribution_unavailable";
        this.log("live_buy_processed_deferred", {
          mint: trade.mint, signature, targetSignature: trade.signature,
          reason: readiness.error,
          fallback: "wait_for_confirmed_transaction_metadata"
        });
        return { ready: false, deferred: true, error: readiness.error };
      }
      const delta = toBigIntOrNull(await this.executor.processedTokenDelta(
        signature, prepared.mint, this.wallet?.publicKey, prepared.tokenProgram
      ));
      if (delta === null || delta <= 0n) {
        readiness.error = "processed_transaction_has_no_token_delta";
        return { ready: false, error: readiness.error };
      }
      const afterTokenBalance = await this.executor.tokenBalance(
        prepared.mint, prepared.tokenProgram, "processed"
      );
      const before = prepared.beforeTokenBalanceKnown === true
        ? prepared.beforeTokenBalance : 0n;
      if (prepared.beforeTokenBalanceKnown !== true) {
        readiness.error = "inventory_baseline_unproven";
        this.#quarantineBuy(
          this.state.handledSignals.find(candidate => candidate.targetSignature === trade.signature) ?? {
            ...trade, targetSignature: trade.signature, signature
          },
          readiness.error,
          {
            processedTokenDelta: delta.toString(),
            observedTokenBalance: afterTokenBalance.toString(),
            evidence: "post_buy_balance_cannot_reconstruct_pre_buy_inventory_or_intervening_flows"
          }
        );
        return { ready: false, deferred: true, error: readiness.error };
      }
      if (afterTokenBalance < before + delta) {
        readiness.error = "processed_inventory_ambiguous";
        this.#quarantineBuy(this.state.handledSignals.find(
          candidate => candidate.targetSignature === trade.signature
        ) ?? { ...trade, targetSignature: trade.signature, signature }, readiness.error, {
          beforeTokenBalance: before.toString(),
          processedTokenDelta: delta.toString(),
          observedTokenBalance: afterTokenBalance.toString(),
          evidence: "confirmed_buy_delta_but_inventory_below_expected"
        });
        return { ready: false, deferred: true, error: readiness.error };
      }
      const bought = delta;
      readiness.processedEvidence = "processed_transaction_delta";
      const buySignal = this.state.handledSignals.find(s => s.targetSignature === trade.signature);
      if (!buySignal || !ACTIVE_SIGNAL_STATUSES.has(buySignal.status)) {
        return { ready: this.positions.get(trade.mint)?.entrySignature === signature };
      }
      if (bought <= 0n) {
        readiness.error = "processed_balance_not_increased";
        return { ready: false, error: readiness.error };
      }

      const existing = this.state.positions.get(trade.mint);
      if (this.state.isQuarantined(trade.mint) || existing?.ownershipStatus === "quarantined") {
        readiness.error = "inventory_quarantine_sticky";
        return { ready: false, deferred: true, error: readiness.error };
      }
      if (!existing) {
        readiness.created = true;
        this.state.setPosition({
          mint: trade.mint,
          rawTokenAmount: bought.toString(),
          tokenProgram: prepared.tokenProgram.toBase58(),
          venue: prepared.venue,
          openedAt: new Date().toISOString(),
          entrySignature: signature,
          targetEntrySignature: trade.signature,
          costLamports: rawAmount.toString(),
          inventoryBaselineRaw: before.toString(),
          provisional: true,
          sourceWallet: trade.sourceWallet ?? null,
          sourceName: trade.sourceName ?? null
        });
      } else if (existing.entrySignature !== signature) {
        throw new Error("processed buy conflicts with another live position");
      }

      readiness.ready = true;
      readiness.rawTokenAmount = bought;
      const signal = this.state.handledSignals.find(
        (candidate) => candidate.targetSignature === trade.signature
      );
      if (signal && !["confirmed", "reconciled_confirmed"].includes(signal.status)) {
        this.state.updateSignal(trade.signature, {
          status: "processed",
          processedTokenBalance: afterTokenBalance.toString(),
          processedTokenDelta: bought.toString(),
          processedEvidence: readiness.processedEvidence ?? "balance_baseline"
        });
      }
      this.log("live_buy_processed", {
        mint: trade.mint,
        signature,
        targetSignature: trade.signature,
        rawTokenAmount: bought.toString(),
        sourceWallet: trade.sourceWallet ?? null,
        sourceName: trade.sourceName ?? null
      });
      return { ready: true, rawTokenAmount: bought };
    } catch (error) {
      readiness.error = errorMessage(error);
      this.log("live_buy_processed_wait_failed", {
        mint: trade.mint,
        signature,
        targetSignature: trade.signature,
        message: readiness.error
      });
      return { ready: false, error: readiness.error };
    }
  }

  async #settleTrade(trade, rawAmount, prepared, signature, readiness = null) {
    let confirmation = "confirmed";
    let afterTokenBalance;
    try {
      confirmation = await this.executor.confirm(signature, prepared);
      afterTokenBalance = await this.executor.tokenBalance(prepared.mint, prepared.tokenProgram);
    } catch (error) {
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

    if (trade.side === "BUY") {
      let bought = null;
      let attribution = null;
      const executedTokenDelta = typeof this.executor.transactionTokenDelta === "function"
        ? toBigIntOrNull(await this.executor.transactionTokenDelta(
            signature, trade.mint, this.wallet?.publicKey, "confirmed"
          ).catch(() => null))
        : null;
      const buySignal = this.state.handledSignals.find(
        candidate => candidate.targetSignature === trade.signature
      );
      if (buySignal?.ownershipStatus === "quarantined" || this.state.isQuarantined(trade.mint)) {
        if (buySignal && buySignal.status !== "position_quarantined") {
          this.#quarantineBuy(buySignal, "inventory_quarantine_sticky", {
            observedTokenBalance: afterTokenBalance.toString(),
            evidence: "fresh_settlement_cannot_clear_existing_quarantine"
          });
        }
        return {
          type: "LIVE_UNKNOWN", at: new Date().toISOString(),
          targetSignature: trade.signature, signature, mint: trade.mint,
          side: trade.side, error: "BUY inventory remains quarantined"
        };
      }
      if (executedTokenDelta !== null && executedTokenDelta > 0n) {
        const exitedWhileConfirming = this.state.handledSignals.some(candidate =>
          candidate.side === "SELL" && candidate.entrySignature === signature &&
          ["confirmed", "reconciled_confirmed", "confirmed_pending_close"].includes(candidate.status)
        );
        if (prepared.beforeTokenBalanceKnown !== true && !exitedWhileConfirming) {
          this.#quarantineBuy(buySignal, "inventory_baseline_unproven", {
            transactionTokenDelta: executedTokenDelta.toString(),
            observedTokenBalance: afterTokenBalance.toString(),
            evidence: "post_buy_balance_cannot_reconstruct_pre_buy_inventory_or_intervening_flows"
          });
          return {
            type: "LIVE_UNKNOWN", at: new Date().toISOString(),
            targetSignature: trade.signature, signature, mint: trade.mint,
            side: trade.side, error: "confirmed BUY baseline is unproven"
          };
        }
        if (prepared.beforeTokenBalanceKnown === true &&
            afterTokenBalance < prepared.beforeTokenBalance + executedTokenDelta &&
            !exitedWhileConfirming) {
          this.#quarantineBuy(buySignal, "post_buy_inventory_ambiguous", {
            beforeTokenBalance: prepared.beforeTokenBalance.toString(),
            transactionTokenDelta: executedTokenDelta.toString(),
            observedTokenBalance: afterTokenBalance.toString(),
            evidence: "confirmed_buy_delta_but_inventory_below_expected"
          });
          return {
            type: "LIVE_UNKNOWN", at: new Date().toISOString(),
            targetSignature: trade.signature, signature, mint: trade.mint,
            side: trade.side, error: "confirmed BUY inventory attribution ambiguous",
            sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
          };
        }
        bought = executedTokenDelta;
        attribution = "confirmed_transaction_delta";
      } else if (readiness?.processedEvidence && readiness.rawTokenAmount > 0n &&
          prepared.beforeTokenBalanceKnown === true) {
        bought = readiness.rawTokenAmount;
        attribution = readiness.processedEvidence;
      } else if (typeof this.executor.transactionTokenDelta !== "function" &&
          prepared.beforeTokenBalanceKnown === true && afterTokenBalance > prepared.beforeTokenBalance) {
        // Compatibility for lightweight adapters without transaction metadata.
        // The production PumpExecutor always exposes transactionTokenDelta.
        bought = afterTokenBalance - prepared.beforeTokenBalance;
        attribution = "balance_baseline_legacy_adapter";
      } else {
        this.state.updateSignal(trade.signature, {
          status: "confirmation_unknown", signature,
          recoveryEvidence: "confirmed_buy_token_delta_unavailable"
        });
        const unknown = {
          type: "LIVE_UNKNOWN", at: new Date().toISOString(),
          targetSignature: trade.signature, signature, mint: trade.mint,
          side: trade.side, error: "confirmed BUY token attribution unavailable",
          sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
        };
        this.#write(unknown);
        return unknown;
      }
      if (bought <= 0n) {
        this.state.updateSignal(trade.signature, { status: "confirmed_no_tokens", signature });
        return this.#skip(trade, "confirmed_but_no_token_balance_increase");
      }
      const entryDelta = await this.#transactionDelta(signature, -rawAmount);
      const existing = this.state.positions.get(trade.mint);
      if (this.state.isQuarantined(trade.mint) || existing?.ownershipStatus === "quarantined") {
        this.#quarantineBuy(buySignal, "inventory_quarantine_sticky", {
          transactionTokenDelta: executedTokenDelta?.toString() ?? null,
          observedTokenBalance: afterTokenBalance.toString(),
          evidence: "settlement_refused_to_clear_durable_quarantine"
        });
        return {
          type: "LIVE_UNKNOWN", at: new Date().toISOString(),
          targetSignature: trade.signature, signature, mint: trade.mint,
          side: trade.side, error: "BUY inventory remains quarantined"
        };
      }
      const position = {
        ...(existing?.entrySignature === signature ? existing : {}),
        mint: trade.mint, rawTokenAmount: bought.toString(),
        tokenProgram: prepared.tokenProgram.toBase58(), venue: prepared.venue,
        openedAt: existing?.openedAt ?? new Date().toISOString(), entrySignature: signature,
        targetEntrySignature: trade.signature, costLamports: rawAmount.toString(),
        entryWalletDeltaLamports: entryDelta.toString(),
        inventoryBaselineRaw: existing?.inventoryBaselineRaw ??
          prepared.beforeTokenBalance.toString(),
        provisional: false,
        sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
      };
      if (existing?.exitRequest) {
        position.rawTokenAmount = existing.rawTokenAmount;
      }
      const closedWhileConfirming = !existing && readiness?.created;
      if (!closedWhileConfirming) this.state.setPosition(position);
      this.state.updateSignal(trade.signature, {
        status: "confirmed", signature, confirmation,
        entryWalletDeltaLamports: entryDelta.toString(),
        closedWhileConfirming, tokenAttribution: attribution
      });
      const record = {
        type: "LIVE_BUY", at: position.openedAt, mint: trade.mint,
        sourceWallet: position.sourceWallet, sourceName: position.sourceName,
        rawTokenAmount: bought.toString(), spendSol: Number(rawAmount) / LAMPORTS_PER_SOL,
        walletDeltaLamports: entryDelta.toString(), venue: prepared.venue,
        signature, targetSignature: trade.signature, confirmation, closedWhileConfirming
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
    if (this.state.isQuarantined(trade.mint) || position.ownershipStatus === "quarantined") {
      this.state.updateSignal(trade.signature, {
        status: "confirmation_unknown", signature,
        recoveryEvidence: "sell_settlement_blocked_by_inventory_quarantine"
      });
      const unknown = {
        type: "LIVE_UNKNOWN", at: new Date().toISOString(), targetSignature: trade.signature,
        signature, mint: trade.mint, side: trade.side,
        error: "SELL settlement blocked by inventory quarantine"
      };
      this.#write(unknown);
      return unknown;
    }
    let executedTokenDelta = null;
    if (typeof this.executor.transactionTokenDelta === "function") {
      executedTokenDelta = toBigIntOrNull(await this.executor.transactionTokenDelta(
        signature, trade.mint, this.wallet?.publicKey,
        confirmation === "finalized" ? "finalized" : "confirmed"
      ).catch(() => null));
    }
    let sold = executedTokenDelta !== null && executedTokenDelta < 0n
      ? -executedTokenDelta : typeof this.executor.transactionTokenDelta !== "function"
        ? prepared.beforeTokenBalance - afterTokenBalance : 0n;
    if (sold <= 0n) {
      this.state.updateSignal(trade.signature, {
        status: "confirmation_unknown", signature,
        recoveryEvidence: "confirmed_transaction_no_token_delta"
      });
      const unknown = {
        type: "LIVE_UNKNOWN", at: new Date().toISOString(), targetSignature: trade.signature,
        signature, mint: trade.mint, side: trade.side,
        error: "confirmed transaction has no observed token delta"
      };
      this.#write(unknown);
      return unknown;
    }
    if (sold > BigInt(position.rawTokenAmount)) {
      this.#quarantinePosition(position, "sell_delta_exceeds_owned_inventory", {
        ownedTokenAmount: position.rawTokenAmount,
        transactionTokenDelta: executedTokenDelta?.toString() ?? null,
        observedSoldAmount: sold.toString(),
        evidence: "transaction_specific_sell_exceeds_proven_strategy_inventory"
      });
      this.state.updateSignal(trade.signature, {
        status: "confirmation_unknown", signature,
        recoveryEvidence: "confirmed_sell_exceeds_proven_inventory"
      });
      const unknown = {
        type: "LIVE_UNKNOWN", at: new Date().toISOString(), targetSignature: trade.signature,
        signature, mint: trade.mint, side: trade.side,
        error: "confirmed SELL exceeded proven strategy inventory"
      };
      this.#write(unknown);
      return unknown;
    }
    const walletEvidence = await this.#transactionWalletDeltaEvidence(signature);
    const remaining = BigInt(position.rawTokenAmount) - sold;
    const settlement = this.state.applySellSettlement({
      mint: trade.mint, targetSignature: trade.signature, signature,
      entrySignature: position.entrySignature, rawSoldAmount: sold,
      sellWalletDeltaLamports: walletEvidence.value,
      sellWalletDeltaKnown: walletEvidence.known,
      closeRequired: remaining === 0n && afterTokenBalance === 0n
    });
    if (!settlement) {
      this.state.updateSignal(trade.signature, {
        status: "confirmation_unknown", signature,
        recoveryEvidence: "confirmed_sell_settlement_already_applied_or_invalid"
      });
      return this.#skip(trade, "confirmed_sell_settlement_unavailable");
    }
    if (!walletEvidence.known) {
      this.state.updateSignal(trade.signature, {
        status: "sell_proceeds_unknown", signature,
        recoveryEvidence: walletEvidence.reason
      });
      const unknown = {
        type: "LIVE_UNKNOWN", at: new Date().toISOString(), targetSignature: trade.signature,
        signature, mint: trade.mint, side: trade.side,
        error: "confirmed SELL proceeds metadata unavailable"
      };
      this.#write(unknown);
      return unknown;
    }
    const settledRemaining = BigInt(settlement.remainingRaw);
    let tokenAccountClose = { status: "not_attempted_position_remaining" };
    if (settledRemaining === 0n && afterTokenBalance === 0n) {
      this.state.updateSignal(trade.signature, {
        status: "confirmed_pending_close", signature, confirmation
      });
      tokenAccountClose = await this.#closeSoldTokenAccount(
        trade.signature, prepared.mint, prepared.tokenProgram,
        { settlementTargetSignature: trade.signature }
      );
      const afterClose = this.state.getSellSettlement(trade.signature);
      if (afterClose?.closeStatus !== "closed") {
        const unknown = {
          type: "LIVE_UNKNOWN", at: new Date().toISOString(), targetSignature: trade.signature,
          signature, mint: trade.mint, side: trade.side,
          error: "confirmed SELL token-account close pending"
        };
        this.#write(unknown);
        return unknown;
      }
    } else {
      if (settledRemaining > 0n) {
        this.state.completeSellSettlement(trade.signature, {
          status: "reconciled_confirmed", confirmationStatus: confirmation
        });
      }
    }
    const pnl = settledRemaining === 0n
      ? await this.#realizePosition(position, signature, tokenAccountClose, settlement) : {};
    const record = {
      type: "LIVE_SELL", at: new Date().toISOString(), mint: trade.mint,
      sourceWallet: position.sourceWallet ?? trade.sourceWallet ?? null,
      sourceName: position.sourceName ?? trade.sourceName ?? null,
      rawTokenAmountSold: sold.toString(), rawTokenAmountRemaining: settledRemaining.toString(),
      venue: prepared.venue, signature, targetSignature: trade.signature,
      entrySignature: position.entrySignature, confirmation, tokenAccountClose, ...pnl
    };
    this.#write(record);
    return record;
  }

  #startSettlement(trade, rawAmount, prepared, signature) {
    const readiness = { ready: false, created: false, error: null };
    const readyPromise = trade.side === "BUY"
      ? this.#primeProcessedBuy(trade, rawAmount, prepared, signature, readiness)
      : Promise.resolve({ ready: true });
    const promise = this.#settleTrade(trade, rawAmount, prepared, signature, readiness)
      .then((record) => {
        if (["LIVE_BUY", "LIVE_SELL"].includes(record.type)) {
          this.log("live_settled", {
            side: trade.side, mint: trade.mint, signature,
            resultType: record.type, realizedPnlSol: record.realizedPnlSol,
            sourceWallet: trade.sourceWallet ?? null,
            sourceName: trade.sourceName ?? null
          });
        }
        if (record.type === "LIVE_UNKNOWN") {
          this.log(record.side === "SELL" ? "live_sell_unknown" : "live_unknown", record);
          const timer = setTimeout(
            () => this.reconcile().catch((error) => {
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
          signature, mint: trade.mint, side: trade.side, error: errorMessage(error)
        };
      });
    const entry = { side: trade.side, promise, readyPromise, readiness, trade,
      pollProcessed: () => this.#primeProcessedBuy(trade, rawAmount, prepared, signature, readiness) };
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
        return {
          ...prepared,
          beforeTokenBalanceKnown: prepared.beforeTokenBalanceKnown ?? !(
            trade.side === "BUY" && prepareOptions.skipBeforeTokenBalance &&
            prepareOptions.executionRoute !== "jupiter"
          )
        };
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
    const wallet = trade.sourceWallet ?? "unattributed";
    this.probeCoverage ??= {};
    const stats = this.probeCoverage[wallet] ??= { requested: 0, completed: 0, busy: 0, stale: 0, failed: 0 };
    stats.requested++;
    const skip = Date.now() - trade.observedAtMs > this.config.fastMaxSignalAgeMs ? "stale" : this.probeActive ? "busy" : null;
    if (skip) {
      stats[skip]++;
      throw new Error("shadow probe " + skip);
    }
    this.probeActive = true;
    try {
      const result = await this.#quoteProbe(trade, spendSol);
      stats.completed++;
      return result;
    } catch (error) {
      stats.failed++;
      throw error;
    } finally {
      this.probeActive = false;
    }
  }

  async #quoteProbe(trade, spendSol) {
    const startedAtMs = Date.now();
    const rawAmount = solToLamports(spendSol);
    const maxEntryDriftBps = trade.fastProfile
      ? this.config.fastMaxEntryDriftBps ?? this.config.liveMaxEntryDriftBps ?? 500
      : this.config.liveMaxEntryDriftBps ?? 500;
    if (!this.probeExecutor) {
      this.probeExecutor = new PumpExecutor({
        ...this.config, rpcHttpUrl: this.config.analyticsRpcHttpUrl, rpcWsUrl: undefined,
        heliusApiKey: this.executor.sender.heliusApiKey,
        rpcFallbackHttpUrl: "", rpcFallbackWsUrl: ""
      }, this.wallet);
    }
    const prepared = await this.probeExecutor.prepare("BUY", trade.mint, rawAmount, {
      executionRoute: trade.executionRoute ?? null,
      venueHint: trade.venue ?? null,
      skipSimulation: true,
      skipBeforeTokenBalance: true,
      targetAveragePriceSol: trade.averagePriceSol ?? null,
      maxEntryDriftBps
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
      hardMinimumTokenOutRaw: prepared.hardMinimumTokenOutRaw ?? null,
      rpcSource: "analytics",
      tokenDecimals,
      copyPriceSol,
      entryDriftBps: this.#entryDriftBps(trade, prepared, rawAmount),
      prepareMs: preparedAtMs - startedAtMs,
      signalToPreparedMs: Number.isFinite(trade.observedAtMs)
        ? preparedAtMs - trade.observedAtMs : null,
      preparedAtMs
    };
  }

  async #dispatchPendingExit(trade, pending) {
    const readiness = await Promise.race([pending.readyPromise, pending.promise]);
    if (!readiness?.ready && !this.positions.has(trade.mint)) {
      const settled = await pending.promise;
      if (!this.positions.has(trade.mint) || !["LIVE_BUY"].includes(settled?.type)) return;
    }
    if (this.positions.has(trade.mint)) {
      await this.lanes.run(trade.mint, () => this.#execute(trade, {}, true));
    }
  }

  onTrade(trade) {
    return this.lanes.run(trade.mint, () => this.executeInLane(trade));
  }

  async executeInLane(trade) {
    if (trade.sourceWallet && !trade.signature.includes(":")) {
      const legacy = this.state.handledSignals.find(s => s.targetSignature === trade.signature && s.mint === trade.mint && s.side === trade.side);
      if (legacy) return this.#skip(trade, "signal_already_handled");
      trade = { ...trade, sourceSignature: trade.signature, signature: `${trade.signature}:${trade.sourceWallet}:${trade.side}:${trade.mint}` };
    }
    const reservation = { amount: 0n };
    try {
      return await this.#execute(trade, reservation);
    } finally {
      if (this.preparingBuys.get(trade.mint) === reservation) this.preparingBuys.delete(trade.mint);
    }
  }

  async #execute(trade, reservationToken, dispatchingExit = false) {
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
      if (this.state.isQuarantined(trade.mint) || ownedPosition?.ownershipStatus === "quarantined") {
        return this.#skip(trade, "position_ownership_quarantined");
      }
      if (ownedPosition && !this.#samePositionSource(ownedPosition, trade)) {
        return this.#skip(trade, "position_owned_by_other_trader");
      }
    }
    if (this.state.hasHandled(trade.signature)) return this.#skip(trade, "signal_already_handled");

    if (trade.side === "SELL" && ((this.pendingExits.has(trade.mint) && !dispatchingExit) ||
      this.#hasActiveSell(trade.mint) || this.#hasUnresolvedExit(trade.mint))) {
      return this.#skip(trade, "exit_already_pending");
    }
    const pending = this.settlements.get(trade.mint);
    if (!pending && trade.side === "SELL") {
      const unresolved = this.#pendingBuys().find(signal => signal.mint === trade.mint);
      if (unresolved && !this.positions.has(trade.mint)) {
        if (!this.#samePositionSource(unresolved, trade)) return this.#skip(trade, "position_owned_by_other_trader");
        this.state.updateSignal(unresolved.targetSignature, { pendingExit: trade });
        return { type: "LIVE_EXIT_PENDING", mint: trade.mint, targetSignature: trade.signature };
      }
    }
    if (pending) {
      if (trade.side === "SELL" && pending.side === "BUY") {
        if (!this.#samePositionSource(pending.trade, trade)) return this.#skip(trade, "position_owned_by_other_trader");
        if (!this.positions.has(trade.mint)) {
          this.state.updateSignal(pending.trade.signature, { pendingExit: trade });
          const task = this.#dispatchPendingExit(trade, pending)
            .catch(error => this.log("pending_exit_error", { mint: trade.mint, message: errorMessage(error) }))
            .finally(() => this.pendingExits.delete(trade.mint));
          this.pendingExits.set(trade.mint, task);
          return { type: "LIVE_EXIT_PENDING", mint: trade.mint, targetSignature: trade.signature };
        }
      } else if (trade.side === "BUY" && pending.side === "BUY") {
        return this.#skip(trade, "position_already_open");
      } else {
        await pending.promise;
      }
    }

    const signalAgeMs = trade.signalSource === "processed_logs" && Number.isFinite(trade.observedAtMs)
      ? Math.max(0, Date.now() - trade.observedAtMs)
      : trade.blockTime ? Math.max(0, Date.now() - trade.blockTime * 1_000) : null;
    const maxSignalAgeMs = trade.fastProfile
      ? this.config.fastMaxSignalAgeMs ?? this.config.maxSignalAgeMs
      : this.config.maxSignalAgeMs;
    const startPrewarm = () => this.executor.prewarm(trade.mint, {
      venueHint: trade.venue ?? null
    }).catch(() => null);
    let prewarm;
    let rawAmount;
    let balanceCommitment = "confirmed";

    if (trade.side === "BUY") {
      if (this.state.isQuarantined(trade.mint)) {
        return this.#skip(trade, "mint_inventory_quarantined");
      }
      this.#enforceRiskLimits();
      if (this.#buyPauseActive()) return this.#skip(trade, "buy_pause_active");
      if (signalAgeMs === null || signalAgeMs > maxSignalAgeMs) {
        return this.#skip(trade, `signal_too_old_${signalAgeMs ?? "unknown"}ms`);
      }
      if (this.state.positions.has(trade.mint)) return this.#skip(trade, "position_already_open");
      const pendingBuys = this.#pendingBuys();
      const occupied = new Set([...this.state.positions.keys(), ...this.preparingBuys.keys(),
        ...pendingBuys.map(signal => signal.mint), ...this.state.quarantines.keys()]);
      if (occupied.has(trade.mint)) return this.#skip(trade, "position_already_open");
      if (occupied.size >= this.config.maxOpenPositions) {
        return this.#skip(trade, "max_open_positions");
      }
      const tradeLamports = solToLamports(this.config.liveTradeSol);
      const dailyCap = solToLamports(this.config.liveMaxDailySpendSol);
      const reserved = [...this.preparingBuys.values()].reduce((sum, slot) => sum + slot.amount, 0n);
      if (this.state.dailySpendLamports + reserved + tradeLamports > dailyCap) {
        return this.#skip(trade, "daily_spend_limit");
      }
      reservationToken.amount = tradeLamports;
      const fee = solToLamports(this.config.livePriorityFeeSol) + solToLamports(this.config.liveTipSol);
      const otherExposure = reserved + BigInt(this.preparingBuys.size) * fee +
        pendingBuys.reduce((sum, signal) => sum + BigInt(signal.rawAmount) + fee, 0n);
      this.preparingBuys.set(trade.mint, reservationToken);
      prewarm = startPrewarm();
      const balance = BigInt(await this.executor.balanceLamports());
      const minimumAfterTrade = solToLamports(this.config.liveMinReserveSol) + tradeLamports +
        solToLamports(this.config.livePriorityFeeSol) + solToLamports(this.config.liveTipSol);
      if (balance < minimumAfterTrade + otherExposure) return this.#skip(trade, "insufficient_balance_reserve");
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
      balanceCommitment = position.provisional ? "processed" : "confirmed";
      prewarm = startPrewarm();
      let current;
      try {
        current = await this.executor.tokenBalance(
          new PublicKey(position.mint),
          new PublicKey(position.tokenProgram),
          position.provisional ? "processed" : "confirmed"
        );
      } catch (error) {
        this.#scheduleExitRetry(trade.mint, `balance_unavailable:${errorMessage(error)}`);
        return this.#skip(trade, "sell_balance_unavailable");
      }
      if (current === 0n) {
        this.#quarantinePosition(position, "out_of_band_inventory_change", {
          ownedTokenAmount: position.rawTokenAmount,
          observedTokenBalance: "0",
          evidence: "open_position_balance_zero_without_transaction_specific_sell"
        });
        return this.#skip(trade, "position_inventory_disappeared");
      }
      const inventoryBaseline = this.#inventoryBaseline(position);
      if (inventoryBaseline === null) {
        this.#quarantinePosition(position, "inventory_provenance_missing", {
          ownedTokenAmount: position.rawTokenAmount,
          observedTokenBalance: current.toString(),
          evidence: "position_has_no_durable_inventory_baseline"
        });
        return this.#skip(trade, "position_ownership_quarantined");
      }
      const requiredInventory = inventoryBaseline + BigInt(position.rawTokenAmount);
      if (current < requiredInventory) {
        this.#quarantinePosition(position, "sell_inventory_below_owned_amount", {
          ownedTokenAmount: position.rawTokenAmount,
          inventoryBaselineRaw: inventoryBaseline.toString(),
          requiredInventory: requiredInventory.toString(),
          observedTokenBalance: current.toString(),
          evidence: "post_buy_inventory_flow_unproven"
        });
        return this.#skip(trade, "position_ownership_quarantined");
      }
      rawAmount = bigintMin(BigInt(position.rawTokenAmount), current);
    }

    await prewarm;
    let prepared;
    let preparedAtMs;
    let entryDriftBps = null;
    const maxEntryDriftBps = trade.side === "BUY"
      ? trade.fastProfile
        ? this.config.fastMaxEntryDriftBps ?? this.config.liveMaxEntryDriftBps ?? 500
        : this.config.liveMaxEntryDriftBps ?? 500
      : null;
    const prepareStartedAtMs = Date.now();
    try {
      prepared = await this.#prepareWithFallback(trade, rawAmount, {
        venueHint: trade.venue ?? null,
        skipSimulation: Boolean(trade.fastProfile && this.config.fastSkipSimulation),
        skipBeforeTokenBalance: Boolean(trade.fastProfile && trade.side === "BUY"),
        balanceCommitment,
        targetAveragePriceSol: trade.side === "BUY" ? trade.averagePriceSol ?? null : null,
        maxEntryDriftBps
      });
      preparedAtMs = Date.now();
    } catch (error) {
      const message = errorMessage(error);
      if (trade.side === "SELL") this.#scheduleExitRetry(trade.mint, `prepare_failed:${message}`);
      const record = this.#skip(trade, `prepare_failed:${message}`);
      this.log("live_prepare_failed", { side: trade.side, mint: trade.mint, message });
      return record;
    }

    // The normal PumpExecutor deliberately skips the pre-BUY token-balance RPC
    // for FAST BUY.  That is safe for quote latency but cannot prove which
    // tokens remain sellable after the BUY.  Refuse the order before reserving
    // capital or broadcasting when the executor did not provide an explicit
    // baseline/isolated-inventory proof.  A verified executor may opt in by
    // returning beforeTokenBalanceKnown=true; no confirmation wait is added.
    if (trade.side === "BUY" && trade.fastProfile &&
        this.config.fastRequireInventoryBaseline !== false &&
        prepared.beforeTokenBalanceKnown !== true) {
      const record = this.#skip(trade, "fast_buy_inventory_baseline_unavailable");
      this.log("live_fast_buy_blocked", {
        mint: trade.mint,
        targetSignature: trade.signature,
        reason: "fast_buy_inventory_baseline_unavailable",
        evidence: "prepare_did_not_provide_before_token_balance_or_isolated_inventory_proof"
      });
      return record;
    }

    if (trade.side === "BUY") {
      const currentAge = Number.isFinite(trade.observedAtMs)
        ? Date.now() - trade.observedAtMs : signalAgeMs;
      if (currentAge === null || currentAge > maxSignalAgeMs) {
        return this.#skip(trade, `signal_too_old_after_prepare_${currentAge ?? "unknown"}ms`);
      }
      entryDriftBps = this.#entryDriftBps(trade, prepared, rawAmount);
      if (entryDriftBps !== null && entryDriftBps > maxEntryDriftBps) {
        return this.#skip(trade, `entry_price_drift_${entryDriftBps}bps`);
      }
    }

    if (trade.side === "SELL") {
      const position = this.state.positions.get(trade.mint);
      if (this.state.isQuarantined(trade.mint) || position?.ownershipStatus === "quarantined") {
        return this.#skip(trade, "position_ownership_quarantined");
      }
      const sellable = bigintMin(BigInt(position.rawTokenAmount), prepared.beforeTokenBalance);
      if (sellable === 0n) {
        this.#quarantinePosition(position, "out_of_band_inventory_change", {
          ownedTokenAmount: position.rawTokenAmount,
          observedTokenBalance: prepared.beforeTokenBalance.toString(),
          evidence: "prepared_sell_balance_zero_without_transaction_specific_sell"
        });
        return this.#skip(trade, "position_inventory_disappeared");
      }
      const inventoryBaseline = this.#inventoryBaseline(position);
      if (inventoryBaseline === null) {
        this.#quarantinePosition(position, "inventory_provenance_missing", {
          ownedTokenAmount: position.rawTokenAmount,
          observedTokenBalance: prepared.beforeTokenBalance.toString(),
          evidence: "position_has_no_durable_inventory_baseline"
        });
        return this.#skip(trade, "position_ownership_quarantined");
      }
      if (prepared.beforeTokenBalance < inventoryBaseline + BigInt(position.rawTokenAmount)) {
        this.#quarantinePosition(position, "sell_inventory_below_owned_amount", {
          ownedTokenAmount: position.rawTokenAmount,
          inventoryBaselineRaw: inventoryBaseline.toString(),
          requiredInventory: (inventoryBaseline + BigInt(position.rawTokenAmount)).toString(),
          observedTokenBalance: prepared.beforeTokenBalance.toString(),
          evidence: "post_prepare_inventory_flow_unproven"
        });
        return this.#skip(trade, "position_ownership_quarantined");
      }
      if (sellable !== rawAmount) {
        try {
          prepared = await this.#prepareWithFallback(trade, sellable, {
            balanceCommitment
          });
          preparedAtMs = Date.now();
          rawAmount = sellable;
        } catch (error) {
          const message = errorMessage(error);
          this.#scheduleExitRetry(trade.mint, `prepare_adjusted_sell_failed:${message}`);
          return this.#skip(trade, `prepare_adjusted_sell_failed:${message}`);
        }
      }
    }

    const reservation = {
      sourceSignature: trade.sourceSignature ?? trade.signature,
      entrySignature: trade.side === "SELL" ? this.positions.get(trade.mint)?.entrySignature : undefined,
      venue: prepared.venue, signature: prepared.expectedSignature,
      tokenProgram: prepared.tokenProgram.toBase58(),
      beforeTokenBalance: prepared.beforeTokenBalance.toString(),
      beforeTokenBalanceKnown: prepared.beforeTokenBalanceKnown === true,
      rawAmount: rawAmount.toString(), lastValidBlockHeight: prepared.lastValidBlockHeight,
      hardMinimumTokenOutRaw: prepared.hardMinimumTokenOutRaw ?? null,
      rpcSource: prepared.rpcSource ?? "primary",
      sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
    };
    if (!this.state.reserveSignal(trade, reservation, trade.side === "BUY" ? rawAmount : 0n)) {
      return this.#skip(trade, "signal_already_handled");
    }

    if (trade.side === "BUY") this.preparingBuys.delete(trade.mint);
    this.submitting.add(trade.signature);
    const submitStartedAtMs = Date.now();
    let signature;
    let submittedAtMs;
    try {
      signature = await this.executor.submit(prepared);
      submittedAtMs = Date.now();
      this.state.updateSignal(trade.signature, { status: "submitted", signature });
    } catch (error) {
      const message = errorMessage(error);
      if (this.#isAmbiguousSubmitError(error)) {
        const expectedSignature = prepared.expectedSignature;
        this.state.updateSignal(trade.signature, {
          status: "confirmation_unknown",
          signature: expectedSignature,
          submitError: message
        });
        const record = {
          type: "LIVE_SUBMIT_UNKNOWN", stage: "submit", at: new Date().toISOString(),
          targetSignature: trade.signature, signature: expectedSignature,
          mint: trade.mint, side: trade.side, error: message,
          sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
        };
        this.#write(record);
        this.log("live_submit_unknown", record);
        this.#startSettlement(trade, rawAmount, prepared, expectedSignature);
        return record;
      }
      this.state.updateSignal(trade.signature, {
        status: "submit_rejected", signature: prepared.expectedSignature, error: message
      });
      if (trade.side === "SELL") this.#scheduleExitRetry(trade.mint, `submit_failed:${message}`);
      const record = {
        type: "LIVE_FAILED", stage: "submit", at: new Date().toISOString(),
        targetSignature: trade.signature, mint: trade.mint, side: trade.side, error: message,
        sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null
      };
      this.#write(record);
      return record;
    } finally {
      this.submitting.delete(trade.signature);
    }

    const submittedRecord = {
      type: "LIVE_SUBMITTED", at: new Date(submittedAtMs).toISOString(),
      targetSignature: trade.signature, signature, mint: trade.mint, side: trade.side,
      venue: prepared.venue, signalSource: trade.signalSource ?? "unknown",
      fastProfile: Boolean(trade.fastProfile),
      sourceWallet: trade.sourceWallet ?? null, sourceName: trade.sourceName ?? null,
      entryDriftBps,
      hardMinimumTokenOutRaw: prepared.hardMinimumTokenOutRaw ?? null,
      rpcSource: prepared.rpcSource ?? "primary",
      decodeMs: trade.decodeMs ?? null, resolveMs: trade.resolveMs ?? null,
      queueDelayMs: trade.queueDelayMs ?? null, submitMs: submittedAtMs - submitStartedAtMs,
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
