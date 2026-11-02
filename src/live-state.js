import fs from "node:fs";
import path from "node:path";

// These statuses mean that a SELL still has unresolved ownership or settlement
// evidence.  Keep this classification in one place so quarantine release does
// not accidentally treat an old recovery state as terminal.
export const UNRESOLVED_SELL_STATUSES = new Set([
  "reserved", "submitted", "processed", "confirmation_unknown", "submit_failed",
  "position_quarantined", "retry_safe", "legacy_exit_unknown",
  "expired_no_balance_change", "reconcile_unavailable",
  "sell_proceeds_unknown", "confirmed_pending_close", "sell_pnl_pending"
]);
export const UNRESOLVED_BUY_STATUSES = new Set([
  "reserved", "submitted", "processed", "confirmation_unknown",
  "submit_failed", "position_quarantined", "reconcile_unavailable",
  "retry_safe", "expired_no_balance_change"
]);

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function settlementNeedsDurableHistory(settlement) {
  return settlement?.sellWalletDeltaKnown !== true ||
    settlement?.completed !== true ||
    (settlement?.remainingRaw === "0" && settlement?.pnlRecorded !== true) ||
    (settlement?.closeRequired === true && settlement?.closeStatus !== "closed");
}

function signalNeedsDurableHistory(signal, quarantines = null) {
  if (signal?.side === "BUY") {
    if (UNRESOLVED_BUY_STATUSES.has(signal.status)) return true;
    if (signal.status === "failed_onchain" &&
        !/^\d+$/.test(String(signal.failedFeeLamports ?? ""))) return true;
    const reservedSpend = String(signal.reservedSpend ?? "0");
    if (signal.status === "submit_rejected" &&
        (/^\d+$/.test(reservedSpend) ? BigInt(reservedSpend) > 0n : true)) return true;
    const quarantine = quarantines?.get(signal.mint);
    if (quarantine && (
      (quarantine.targetSignature && quarantine.targetSignature === signal.targetSignature) ||
      (quarantine.signature && quarantine.signature === signal.signature)
    )) return true;
  }
  return signal?.side === "SELL" && UNRESOLVED_SELL_STATUSES.has(signal.status);
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
    // A quarantine is keyed by mint rather than by a signal.  Handled signals
    // are intentionally bounded, while an ownership ambiguity must survive
    // pruning and every restart until an explicit audited resolution.
    this.quarantines = new Map();
    this.quarantineAudit = [];
    // A transaction-specific SELL settlement is persisted independently of
    // the signal status so a restart cannot apply the same token delta twice.
    this.sellSettlements = new Map();
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
    const quarantines = Array.isArray(state.quarantines) ? state.quarantines : [];
    for (const quarantine of quarantines) {
      if (!quarantine?.mint || quarantine.status !== "quarantined") continue;
      this.quarantines.set(quarantine.mint, quarantine);
    }
    this.quarantineAudit = Array.isArray(state.quarantineAudit) ? state.quarantineAudit : [];
    const sellSettlements = Array.isArray(state.sellSettlements) ? state.sellSettlements : [];
    for (const settlement of sellSettlements) {
      if (!settlement?.targetSignature || !settlement.signature || !settlement.mint) continue;
      const priorCumulative = settlement.priorCumulativeSellWalletDeltaLamports ??
        (/^-?\d+$/.test(String(settlement.cumulativeSellWalletDeltaLamports ?? "")) &&
          /^-?\d+$/.test(String(settlement.sellWalletDeltaLamports ?? ""))
          ? (BigInt(settlement.cumulativeSellWalletDeltaLamports) -
            BigInt(settlement.sellWalletDeltaLamports)).toString()
          : "0");
      this.sellSettlements.set(settlement.targetSignature, {
        ...settlement,
        sellWalletDeltaKnown: settlement.sellWalletDeltaKnown === true,
        proceedsStatus: settlement.proceedsStatus ??
          (settlement.sellWalletDeltaKnown === true ? "verified" : "unknown"),
        priorCumulativeSellWalletDeltaLamports: priorCumulative,
        closeRequired: settlement.closeRequired === true,
        closeStatus: settlement.closeStatus ??
          (settlement.closeRequired === true ? "pending" : "not_required"),
        closeWalletDeltaLamports: settlement.closeWalletDeltaLamports ?? null,
        closeBroadcastStatus: settlement.closeBroadcastStatus ??
          (settlement.closeRequired === true ? "not_prepared" : "not_required"),
        closeLastValidBlockHeight: settlement.closeLastValidBlockHeight ?? null,
        closeRecentBlockhash: settlement.closeRecentBlockhash ?? null
      });
    }
    this.handledSignals = state.handledSignals.filter(
      (signal) => typeof signal?.targetSignature === "string"
    );
    // Migrate the previous PR's signal/position-only quarantine records into
    // the mint-scoped durable map before any occupancy decision is made.
    for (const signal of this.handledSignals) {
      if (signal.status !== "position_quarantined" && signal.ownershipStatus !== "quarantined") continue;
      if (this.quarantines.has(signal.mint)) continue;
      const firstSeenAt = signal.quarantineFirstSeenAt ?? signal.updatedAt ?? signal.at ?? new Date().toISOString();
      this.quarantines.set(signal.mint, {
        mint: signal.mint,
        status: "quarantined",
        kind: "buy",
        reason: signal.ownershipReason ?? "legacy_position_quarantined",
        signature: signal.signature ?? null,
        targetSignature: signal.targetSignature ?? null,
        firstSeenAt,
        updatedAt: signal.updatedAt ?? firstSeenAt,
        lastReason: signal.ownershipReason ?? "legacy_position_quarantined",
        evidence: signal.ownershipEvidence ?? {}
      });
    }
    for (const position of this.positions.values()) {
      if (position.ownershipStatus !== "quarantined" || this.quarantines.has(position.mint)) continue;
      const firstSeenAt = position.ownershipBlockedAt ?? position.openedAt ?? new Date().toISOString();
      this.quarantines.set(position.mint, {
        mint: position.mint,
        status: "quarantined",
        kind: "position",
        reason: position.ownershipReason ?? "legacy_position_quarantined",
        signature: position.entrySignature ?? null,
        targetSignature: position.targetEntrySignature ?? null,
        firstSeenAt,
        updatedAt: firstSeenAt,
        lastReason: position.ownershipReason ?? "legacy_position_quarantined",
        evidence: position.ownershipEvidence ?? {}
      });
    }
  }

  #save() {
    const settlements = [...this.sellSettlements.values()];
    const retainedSettlements = settlements.filter(settlement =>
      settlementNeedsDurableHistory(settlement) || this.quarantines.has(settlement.mint)
    );
    const retainedTargets = new Set(
      retainedSettlements.map(settlement => settlement.targetSignature)
    );
    const persistedSettlements = [
      ...retainedSettlements,
      ...settlements.filter(settlement => !retainedTargets.has(settlement.targetSignature))
        .slice(-this.handledLimit)
    ];
    this.sellSettlements = new Map(
      persistedSettlements.map(settlement => [settlement.targetSignature, settlement])
    );
    const preservedSignals = this.handledSignals.filter(signal =>
      retainedTargets.has(signal.targetSignature) || signalNeedsDurableHistory(signal, this.quarantines)
    );
    const recentSignals = this.handledSignals.slice(-this.handledLimit);
    const persistedTargets = new Set([
      ...preservedSignals.map(signal => signal.targetSignature),
      ...recentSignals.map(signal => signal.targetSignature)
    ]);
    const persistedSignals = this.handledSignals.filter(signal =>
      persistedTargets.has(signal.targetSignature)
    );
    this.handledSignals = persistedSignals;
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      day: this.day,
      dailySpendLamports: this.dailySpendLamports.toString(),
      dailyRealizedPnlLamports: this.dailyRealizedPnlLamports.toString(),
      consecutiveLosses: this.consecutiveLosses,
      positions: [...this.positions.values()],
      quarantines: [...this.quarantines.values()],
      quarantineAudit: this.quarantineAudit.slice(-200),
      sellSettlements: persistedSettlements,
      handledSignals: persistedSignals
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
    this.#save();
    return true;
  }

  updateSignal(targetSignature, patch) {
    const signal = this.handledSignals.find(
      (candidate) => candidate.targetSignature === targetSignature
    );
    if (!signal) throw new Error(`Unknown live signal: ${targetSignature}`);
    if (((patch.status === "submit_rejected" && signal.status === "reserved") ||
        (patch.status === "failed_onchain" && patch.failedFeeLamports != null)) &&
        BigInt(signal.reservedSpend ?? 0) > 0n &&
        signal.side === "BUY" && signal.spendDay === this.day) {
      this.dailySpendLamports -= BigInt(signal.reservedSpend);
      this.dailySpendLamports += BigInt(patch.failedFeeLamports ?? 0);
      signal.reservedSpend = "0";
    }
    const quarantine = this.quarantines.get(signal.mint);
    if (quarantine && signal.side === "BUY" && patch.status !== "submit_rejected" &&
        patch.status !== "failed_onchain") {
      // Never let a later balance snapshot or settlement status overwrite a
      // durable ownership quarantine.  Only an explicit resolution operation
      // may remove this mint from the quarantine map.
      patch = {
        ...patch,
        status: "position_quarantined",
        ownershipStatus: "quarantined",
        ownershipReason: signal.ownershipReason ?? quarantine.reason,
        ownershipEvidence: signal.ownershipEvidence ?? quarantine.evidence
      };
    }
    if (patch.status === "failed_onchain" && signal.side === "BUY" &&
        this.positions.get(signal.mint)?.entrySignature === signal.signature &&
        this.positions.get(signal.mint)?.ownershipStatus !== "quarantined") this.positions.delete(signal.mint);
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
    const quarantine = this.quarantines.get(position.mint);
    const stored = quarantine
      ? {
          ...position,
          ownershipStatus: "quarantined",
          ownershipReason: position.ownershipReason ?? quarantine.reason,
          ownershipEvidence: position.ownershipEvidence ?? quarantine.evidence,
          ownershipBlockedAt: position.ownershipBlockedAt ?? quarantine.firstSeenAt
        }
      : position;
    this.positions.set(position.mint, stored);
    this.#save();
  }

  deletePosition(mint, { allowQuarantined = false } = {}) {
    if (!allowQuarantined && this.positions.get(mint)?.ownershipStatus === "quarantined") {
      return false;
    }
    this.positions.delete(mint);
    this.#save();
    return true;
  }

  getSellSettlement(targetSignature) {
    return this.sellSettlements.get(targetSignature) ?? null;
  }

  applySellSettlement({
    mint, targetSignature, signature, entrySignature, rawSoldAmount,
    sellWalletDeltaLamports = "0", sellWalletDeltaKnown = true,
    closeRequired = false, allowQuarantined = false
  }) {
    const existing = this.sellSettlements.get(targetSignature);
    if (existing) return existing.signature === signature ? { ...existing, alreadyApplied: true } : null;
    const position = this.positions.get(mint);
    if (!position || (entrySignature && position.entrySignature !== entrySignature)) return null;
    if (this.quarantines.has(mint) && !allowQuarantined) return null;
    let sold;
    let sellWalletDelta = 0n;
    try {
      sold = BigInt(rawSoldAmount);
      if (sellWalletDeltaKnown) sellWalletDelta = BigInt(sellWalletDeltaLamports);
    } catch { return null; }
    const owned = BigInt(position.rawTokenAmount);
    if (sold <= 0n || sold > owned) return null;
    const priorCumulative = BigInt(position.cumulativeSellWalletDeltaLamports ?? "0");
    const cumulative = priorCumulative + (sellWalletDeltaKnown ? sellWalletDelta : 0n);
    const remaining = owned - sold;
    const record = {
      targetSignature, signature, mint,
      entrySignature: position.entrySignature ?? entrySignature ?? null,
      rawSoldAmount: sold.toString(), remainingRaw: remaining.toString(),
      sellWalletDeltaLamports: sellWalletDelta.toString(),
      sellWalletDeltaKnown: sellWalletDeltaKnown === true,
      proceedsStatus: sellWalletDeltaKnown === true ? "verified" : "unknown",
      priorCumulativeSellWalletDeltaLamports: priorCumulative.toString(),
      cumulativeSellWalletDeltaLamports: cumulative.toString(),
      positionSnapshot: { ...position },
      appliedAt: new Date().toISOString(),
      closeRequired: closeRequired === true,
      closeStatus: closeRequired === true ? "pending" : "not_required",
      closeWalletDeltaLamports: null,
      closeBroadcastStatus: closeRequired === true ? "not_prepared" : "not_required",
      closeLastValidBlockHeight: null,
      closeRecentBlockhash: null,
      closeError: null,
      completed: false, pnlRecorded: false
    };
    if (remaining === 0n) this.positions.delete(mint);
    else this.positions.set(mint, {
      ...position,
      rawTokenAmount: remaining.toString(),
      cumulativeSellWalletDeltaLamports: cumulative.toString(),
      exitRequest: { ...position.exitRequest, nextAttemptAt: new Date().toISOString() }
    });
    this.sellSettlements.set(targetSignature, record);
    this.#save();
    return record;
  }

  resolveSellProceeds(targetSignature, sellWalletDeltaLamports) {
    const settlement = this.sellSettlements.get(targetSignature);
    if (!settlement) throw new Error(`Unknown SELL settlement: ${targetSignature}`);
    let value;
    try { value = BigInt(sellWalletDeltaLamports); } catch {
      throw new Error("SELL proceeds evidence must contain a numeric wallet delta");
    }
    if (settlement.sellWalletDeltaKnown === true) return { ...settlement, alreadyKnown: true };
    const prior = BigInt(
      settlement.priorCumulativeSellWalletDeltaLamports ??
      (BigInt(settlement.cumulativeSellWalletDeltaLamports ?? "0") -
        BigInt(settlement.sellWalletDeltaLamports ?? "0")).toString()
    );
    const cumulative = prior + value;
    settlement.sellWalletDeltaLamports = value.toString();
    settlement.sellWalletDeltaKnown = true;
    settlement.proceedsStatus = "verified";
    settlement.cumulativeSellWalletDeltaLamports = cumulative.toString();
    settlement.proceedsResolvedAt = new Date().toISOString();
    const position = this.positions.get(settlement.mint);
    if (position && BigInt(settlement.remainingRaw ?? "0") > 0n) {
      this.positions.set(settlement.mint, {
        ...position,
        cumulativeSellWalletDeltaLamports: cumulative.toString()
      });
    }
    this.#save();
    return { ...settlement };
  }

  setSellSettlementClose(targetSignature, { status, result = null, error = null } = {}) {
    const settlement = this.sellSettlements.get(targetSignature);
    if (!settlement) throw new Error(`Unknown SELL settlement: ${targetSignature}`);
    if (!["pending", "delta_pending", "closed", "failed"].includes(status)) {
      throw new Error(`Invalid SELL close status: ${status}`);
    }
    if (status === "closed") {
      const resultStatus = result?.status;
      const alreadyClosed = resultStatus === "already_closed";
      const walletDelta = result?.walletDeltaLamports;
      if (!alreadyClosed && !/^-?\d+$/.test(String(walletDelta ?? ""))) {
        throw new Error("Closed token account is missing verified wallet delta");
      }
      settlement.closeStatus = "closed";
      settlement.closeWalletDeltaLamports = alreadyClosed ? "0" : String(walletDelta);
      settlement.closeSignature = result?.signature ?? null;
      settlement.tokenAccountClose = result ?? null;
      settlement.closeBroadcastStatus = "confirmed";
      settlement.closeError = null;
    } else if (status === "delta_pending") {
      if (!result?.signature) {
        throw new Error("Close delta pending state requires a close signature");
      }
      settlement.closeStatus = "delta_pending";
      settlement.closeWalletDeltaLamports = null;
      settlement.closeSignature = result.signature;
      settlement.tokenAccountClose = result;
      settlement.closeBroadcastStatus = "confirmed";
      settlement.closeError = error ? String(error) : "close_wallet_delta_unavailable";
    } else {
      settlement.closeStatus = status;
      settlement.closeWalletDeltaLamports = null;
      settlement.closeError = error ? String(error) : null;
    }
    settlement.closeUpdatedAt = new Date().toISOString();
    this.#save();
    return { ...settlement };
  }

  persistSellSettlementCloseIntent(targetSignature, { signature, result = null } = {}) {
    const settlement = this.sellSettlements.get(targetSignature);
    if (!settlement) throw new Error(`Unknown SELL settlement: ${targetSignature}`);
    if (settlement.closeStatus === "closed") return { ...settlement, alreadyClosed: true };
    if (typeof signature !== "string" || signature.length === 0) {
      throw new Error("SELL close intent requires a transaction signature");
    }
    if (settlement.closeSignature && settlement.closeSignature !== signature &&
        settlement.closeStatus !== "failed") {
      throw new Error("SELL settlement already has a different close intent");
    }
    settlement.closeStatus = "pending";
    settlement.closeSignature = signature;
    settlement.tokenAccountClose = result ?? settlement.tokenAccountClose ?? null;
    settlement.closeBroadcastStatus = "prepared";
    if (Number.isSafeInteger(Number(result?.lastValidBlockHeight))) {
      settlement.closeLastValidBlockHeight = Number(result.lastValidBlockHeight);
    }
    if (typeof result?.recentBlockhash === "string" && result.recentBlockhash.length > 0) {
      settlement.closeRecentBlockhash = result.recentBlockhash;
    }
    settlement.closeWalletDeltaLamports = null;
    settlement.closeError = null;
    settlement.closeIntentAt = new Date().toISOString();
    settlement.closeUpdatedAt = new Date().toISOString();
    this.#save();
    return { ...settlement };
  }

  resolveSellSettlementCloseDelta(targetSignature, closeWalletDeltaLamports) {
    const settlement = this.sellSettlements.get(targetSignature);
    if (!settlement) throw new Error(`Unknown SELL settlement: ${targetSignature}`);
    let value;
    try { value = BigInt(closeWalletDeltaLamports); } catch {
      throw new Error("SELL close evidence must contain a numeric wallet delta");
    }
    if (settlement.closeStatus === "closed") return { ...settlement, alreadyKnown: true };
    if (settlement.closeStatus !== "delta_pending") {
      throw new Error("SELL close delta is not pending");
    }
    settlement.closeStatus = "closed";
    settlement.closeWalletDeltaLamports = value.toString();
    settlement.closeError = null;
    settlement.closeDeltaResolvedAt = new Date().toISOString();
    this.#save();
    return { ...settlement };
  }

  completeSellSettlement(targetSignature, {
    status = "reconciled_confirmed", confirmationStatus = null,
    realizedPnlLamports = null, closeWalletDeltaLamports = "0"
  } = {}) {
    const settlement = this.sellSettlements.get(targetSignature);
    if (!settlement) throw new Error(`Unknown SELL settlement: ${targetSignature}`);
    const signal = this.handledSignals.find(candidate =>
      candidate.targetSignature === targetSignature
    );
    const fullSell = settlement.remainingRaw === "0";
    const hasPnl = realizedPnlLamports != null;
    if (!hasPnl && settlement.sellWalletDeltaKnown !== true) {
      if (signal) Object.assign(signal, {
        status: "sell_proceeds_unknown",
        settlementApplied: false,
        recoveryEvidence: "sell_wallet_delta_unavailable",
        updatedAt: new Date().toISOString()
      });
      this.#save();
      return {
        dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
        consecutiveLosses: this.consecutiveLosses,
        realizedPnlLamports: settlement.realizedPnlLamports ?? null,
        pnlRecorded: settlement.pnlRecorded,
        settlement
      };
    }
    if (fullSell && !hasPnl) {
      if (signal) Object.assign(signal, {
        status: settlement.closeRequired && settlement.closeStatus !== "closed"
          ? "confirmed_pending_close" : "sell_pnl_pending",
        settlementApplied: false,
        updatedAt: new Date().toISOString()
      });
      this.#save();
      return {
        dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
        consecutiveLosses: this.consecutiveLosses,
        realizedPnlLamports: settlement.realizedPnlLamports ?? null,
        pnlRecorded: settlement.pnlRecorded,
        settlement
      };
    }
    if (hasPnl && settlement.sellWalletDeltaKnown !== true) {
      if (signal) Object.assign(signal, {
        status: "sell_proceeds_unknown",
        settlementApplied: false,
        recoveryEvidence: "sell_wallet_delta_unavailable",
        updatedAt: new Date().toISOString()
      });
      this.#save();
      return {
        dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
        consecutiveLosses: this.consecutiveLosses,
        realizedPnlLamports: settlement.realizedPnlLamports ?? null,
        pnlRecorded: settlement.pnlRecorded,
        settlement
      };
    }
    if (hasPnl && settlement.closeRequired && settlement.closeStatus !== "closed") {
      if (signal) Object.assign(signal, {
        status: "confirmed_pending_close",
        settlementApplied: false,
        updatedAt: new Date().toISOString()
      });
      this.#save();
      return {
        dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
        consecutiveLosses: this.consecutiveLosses,
        realizedPnlLamports: settlement.realizedPnlLamports ?? null,
        pnlRecorded: settlement.pnlRecorded,
        settlement
      };
    }
    if (realizedPnlLamports != null && !settlement.pnlRecorded) {
      const value = BigInt(realizedPnlLamports);
      this.dailyRealizedPnlLamports += value;
      if (value < 0n) this.consecutiveLosses += 1;
      else if (value > 0n) this.consecutiveLosses = 0;
      settlement.realizedPnlLamports = value.toString();
      settlement.closeWalletDeltaLamports = String(closeWalletDeltaLamports);
      settlement.pnlRecorded = true;
    }
    settlement.completed = true;
    settlement.completedAt = settlement.completedAt ?? new Date().toISOString();
    if (signal && status) {
      Object.assign(signal, {
        status,
        ...(confirmationStatus ? { confirmationStatus } : {}),
        settlementApplied: true,
        updatedAt: new Date().toISOString()
      });
    }
    this.#save();
    return {
      dailyRealizedPnlLamports: this.dailyRealizedPnlLamports,
      consecutiveLosses: this.consecutiveLosses,
      realizedPnlLamports: settlement.realizedPnlLamports ?? null,
      pnlRecorded: settlement.pnlRecorded,
      settlement
    };
  }

  quarantineMint(mint, details = {}) {
    const now = new Date().toISOString();
    const existing = this.quarantines.get(mint);
    const record = {
      ...(existing ?? {}),
      mint,
      status: "quarantined",
      kind: existing?.kind ?? details.kind ?? "inventory",
      reason: existing?.reason ?? details.reason ?? "unknown",
      signature: existing?.signature ?? details.signature ?? null,
      targetSignature: existing?.targetSignature ?? details.targetSignature ?? null,
      firstSeenAt: existing?.firstSeenAt ?? details.firstSeenAt ?? now,
      updatedAt: now,
      lastReason: details.reason ?? existing?.lastReason ?? null,
      evidence: { ...(existing?.evidence ?? {}), ...(details.evidence ?? {}) }
    };
    this.quarantines.set(mint, record);
    this.#save();
    return { created: !existing, record };
  }

  getQuarantine(mint) {
    return this.quarantines.get(mint) ?? null;
  }

  isQuarantined(mint) {
    return this.quarantines.has(mint);
  }

  clearQuarantine(mint, options) {
    if (!options || typeof options !== "object" ||
        typeof options.resolution !== "string" || !options.resolution.trim() ||
        !options.evidence || typeof options.evidence !== "object" ||
        Array.isArray(options.evidence) || Object.keys(options.evidence).length === 0 ||
        !options.position) {
      throw new Error(
        "Quarantine resolution must include audit evidence and a restored position"
      );
    }
    const existing = this.quarantines.get(mint);
    if (!existing) return false;
    const suppliedPosition = options.position;
    if (!suppliedPosition || suppliedPosition.mint !== mint ||
        !/^\d+$/.test(suppliedPosition.rawTokenAmount ?? "") ||
        BigInt(suppliedPosition.rawTokenAmount) <= 0n ||
        !/^\d+$/.test(suppliedPosition.inventoryBaselineRaw ?? "") ||
        !suppliedPosition.tokenProgram || !suppliedPosition.entrySignature ||
        !suppliedPosition.targetEntrySignature ||
        (existing.signature && suppliedPosition.entrySignature !== existing.signature &&
          suppliedPosition.targetEntrySignature !== existing.targetSignature)) {
      throw new Error(
        "Quarantine resolution must restore a coherent evidence-backed position"
      );
    }
    const restoredPosition = { ...suppliedPosition };
    delete restoredPosition.ownershipStatus;
    delete restoredPosition.ownershipReason;
    delete restoredPosition.ownershipEvidence;
    delete restoredPosition.ownershipBlockedAt;
    if (options.pendingExit) {
      restoredPosition.exitRequest = {
        ...(restoredPosition.exitRequest ?? {}),
        ...options.pendingExit
      };
    }
    this.quarantineAudit.push({
      mint, resolution: options.resolution.trim(), at: new Date().toISOString(),
      reason: existing.reason,
      signature: existing.signature ?? null,
      targetSignature: existing.targetSignature ?? null,
      evidence: options.evidence ?? null,
      restoredPosition: {
        rawTokenAmount: restoredPosition.rawTokenAmount,
        inventoryBaselineRaw: restoredPosition.inventoryBaselineRaw,
        entrySignature: restoredPosition.entrySignature,
        targetEntrySignature: restoredPosition.targetEntrySignature,
        pendingExit: restoredPosition.exitRequest ?? null
      }
    });
    this.positions.set(mint, restoredPosition);
    for (const signal of this.handledSignals.filter(candidate => candidate.mint === mint &&
        candidate.status === "position_quarantined")) {
      signal.status = "quarantine_resolved";
      signal.ownershipStatus = "resolved";
      signal.ownershipResolution = options.resolution.trim();
      signal.updatedAt = new Date().toISOString();
    }
    this.quarantines.delete(mint);
    this.#save();
    return true;
  }

  releaseFailedBuyQuarantine(mint, options) {
    if (!options || typeof options !== "object" ||
        typeof options.resolution !== "string" || !options.resolution.trim() ||
        !options.evidence || typeof options.evidence !== "object" ||
        Array.isArray(options.evidence) || Object.keys(options.evidence).length === 0 ||
        typeof options.signature !== "string" || !/^\d+$/.test(options.failedFeeLamports ?? "")) {
      throw new Error(
        "Failed BUY quarantine release must include signature, fee, and audit evidence"
      );
    }
    const existing = this.quarantines.get(mint);
    if (!existing) return false;
    if (this.positions.has(mint)) {
      throw new Error("Failed BUY quarantine release cannot discard an existing position");
    }
    const signal = this.handledSignals.find(candidate =>
      candidate.mint === mint && candidate.side === "BUY" &&
      candidate.status === "failed_onchain" && candidate.signature === options.signature &&
      String(candidate.failedFeeLamports ?? "") === String(options.failedFeeLamports)
    );
    if (!signal || (existing.signature && existing.signature !== options.signature)) {
      throw new Error(
        "Failed BUY quarantine release requires matching confirmed failure evidence"
      );
    }
    this.quarantineAudit.push({
      mint, resolution: options.resolution.trim(), at: new Date().toISOString(),
      reason: existing.reason,
      signature: options.signature,
      targetSignature: signal.targetSignature,
      disposition: "failed_buy_no_inventory",
      failedFeeLamports: String(options.failedFeeLamports),
      evidence: options.evidence
    });
    signal.quarantineResolution = options.resolution.trim();
    signal.quarantineDisposition = "failed_buy_no_inventory";
    signal.ownershipStatus = "resolved";
    signal.ownershipReason = "failed_buy_no_inventory";
    signal.ownershipEvidence = options.evidence;
    signal.updatedAt = new Date().toISOString();
    this.quarantines.delete(mint);
    this.#save();
    return true;
  }

  releaseClosedSellQuarantine(mint, options) {
    if (!options || typeof options !== "object" ||
        typeof options.resolution !== "string" || !options.resolution.trim() ||
        !options.evidence || typeof options.evidence !== "object" ||
        Array.isArray(options.evidence) || Object.keys(options.evidence).length === 0 ||
        typeof options.signature !== "string" ||
        typeof options.targetSignature !== "string" ||
        !/^\d+$/.test(options.rawSoldAmount ?? "")) {
      throw new Error(
        "Closed SELL quarantine release must include signature, delta, and audit evidence"
      );
    }
    const existing = this.quarantines.get(mint);
    if (!existing) return false;
    if (this.positions.has(mint)) {
      throw new Error("Closed SELL quarantine release requires zero remaining position");
    }
    const settlement = this.sellSettlements.get(options.targetSignature);
    if (!settlement || settlement.mint !== mint || settlement.signature !== options.signature ||
        settlement.rawSoldAmount !== String(options.rawSoldAmount) ||
        settlement.remainingRaw !== "0" || !settlement.completed || !settlement.pnlRecorded ||
        settlement.sellWalletDeltaKnown !== true ||
        (settlement.closeRequired === true && settlement.closeStatus !== "closed")) {
      throw new Error(
        "Closed SELL quarantine release requires a completed full SELL settlement"
      );
    }
    const unresolved = this.handledSignals.some(signal =>
      signal.mint === mint && signal.targetSignature !== options.targetSignature &&
      UNRESOLVED_SELL_STATUSES.has(signal.status) &&
      !(signal.status === "position_quarantined" &&
        signal.signature === settlement.entrySignature)
    );
    if (unresolved) {
      throw new Error("Closed SELL quarantine release requires no unresolved mint transactions");
    }
    this.quarantineAudit.push({
      mint, resolution: options.resolution.trim(), at: new Date().toISOString(),
      reason: existing.reason,
      signature: options.signature,
      targetSignature: options.targetSignature,
      disposition: "full_sell_no_remaining_inventory",
      rawSoldAmount: String(options.rawSoldAmount),
      evidence: options.evidence
    });
    for (const signal of this.handledSignals.filter(candidate =>
      candidate.mint === mint &&
      (candidate.status === "position_quarantined" || candidate.ownershipStatus === "quarantined")
    )) {
      signal.status = signal.side === "BUY" && signal.status === "position_quarantined"
        ? "quarantine_resolved" : signal.status;
      signal.ownershipStatus = "resolved";
      signal.ownershipResolution = options.resolution.trim();
      signal.quarantineDisposition = "full_sell_no_remaining_inventory";
      signal.updatedAt = new Date().toISOString();
    }
    this.quarantines.delete(mint);
    this.#save();
    return true;
  }
}
