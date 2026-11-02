const TELEGRAM_MAX_TEXT = 4_096;

function short(value, length = 8) {
  const text = String(value ?? "");
  return text.length <= length * 2 + 3
    ? text
    : `${text.slice(0, length)}…${text.slice(-length)}`;
}

function number(value, digits = 6) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "n/a";
}

export class TelegramNotifier {
  constructor({ telegramBotToken, telegramAdminChatId }) {
    this.token = telegramBotToken;
    this.chatId = telegramAdminChatId;
    this.enabled = Boolean(this.token && this.chatId);
    this.queue = Promise.resolve();
    this.lastMessages = new Map();
  }

  async verify() {
    if (!this.enabled) return { enabled: false };
    const response = await fetch(`https://api.telegram.org/bot${this.token}/getMe`, {
      signal: AbortSignal.timeout(10_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram getMe failed: ${payload.description ?? response.status}`);
    }
    return { enabled: true, username: payload.result?.username ?? null };
  }

  send(text, { dedupeKey = null, dedupeMs = 0 } = {}) {
    if (!this.enabled) return Promise.resolve(false);
    if (dedupeKey && dedupeMs > 0) {
      const previous = this.lastMessages.get(dedupeKey) ?? 0;
      if (Date.now() - previous < dedupeMs) return Promise.resolve(false);
      this.lastMessages.set(dedupeKey, Date.now());
    }
    const task = this.queue.then(() => this.#send(String(text).slice(0, TELEGRAM_MAX_TEXT)));
    this.queue = task.catch(() => {});
    return task;
  }

  async #send(text) {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            disable_web_page_preview: true
          })
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && payload.ok) return true;
        const retryAfter = Number(payload.parameters?.retry_after ?? 0);
        if (retryAfter > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1_000));
          continue;
        }
        throw new Error(payload.description ?? `HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
    }
    throw new Error(`Telegram send failed: ${lastError?.message ?? "unknown error"}`);
  }

  handle(event, details = {}) {
    let text = null;
    let options = {};
    if (event === "health_failed") {
      text = `🚨 ${event}: ${details.message ?? JSON.stringify(details)}`;
      options = { dedupeKey: event, dedupeMs: 300_000 };
    } else if (event === "target_health_failed") {
      text = [
        "⚠️ Один отслеживаемый кошелёк временно отстал",
        details.sourceName || details.name ? `Трейдер: ${details.sourceName ?? details.name}` : null,
        `HTTP-пауза: ${Math.round(Number(details.rpcSilenceMs ?? 0) / 1_000)} сек`,
        "Остальные кошельки и live-торговля продолжают работать."
      ].filter(Boolean).join("\n");
      options = { dedupeKey: `target-health:${details.wallet}`, dedupeMs: 1_800_000 };
    } else if (event === "signature_quarantined") {
      text = [
        "⚠️ Одна транзакция изолирована после повторных ошибок",
        details.sourceName ? `Трейдер: ${details.sourceName}` : null,
        `Tx: https://solscan.io/tx/${details.signature}`,
        `Ошибка: ${details.message ?? "unknown"}`,
        "Курсор продвинут; остальные сделки продолжают обрабатываться."
      ].filter(Boolean).join("\n");
      options = { dedupeKey: `quarantine:${details.signature}`, dedupeMs: 86_400_000 };
    } else if (event === "live_settled") {
      const pnl = details.realizedPnlSol === undefined
        ? null
        : `PnL: ${Number(details.realizedPnlSol) >= 0 ? "+" : ""}${number(details.realizedPnlSol)} SOL`;
      text = [
        `${details.side === "BUY" ? "✅ Покупка подтверждена" : "💰 Продажа подтверждена"}`,
        details.sourceName ? `Трейдер: ${details.sourceName}` : null,
        `Mint: ${short(details.mint, 10)}`,
        `Результат: ${details.resultType}`,
        pnl,
        details.signature ? `Tx: https://solscan.io/tx/${details.signature}` : null
      ].filter(Boolean).join("\n");
    } else if (
      event === "live_result" && details.type === "LIVE_FAILED" && details.side === "SELL"
    ) {
      text = [
        `🚨 ${details.side ?? "TRADE"} не отправлен`,
        details.sourceName ? `Трейдер: ${details.sourceName}` : null,
        `Mint: ${short(details.mint, 10)}`,
        `Этап: ${details.stage ?? "unknown"}`,
        `Ошибка: ${details.error ?? "unknown"}`
      ].join("\n");
    } else if ([
      "live_settlement_error",
      "trade_processing_error",
      "unhandled_rejection",
      "startup_failed",
      "live_maintenance_error",
      "telegram_report_error"
    ].includes(event)) {
      text = `🚨 ${event}\n${details.message ?? details.error ?? JSON.stringify(details)}`;
      options = { dedupeKey: `${event}:${details.mint ?? "global"}`, dedupeMs: 300_000 };
    } else if (event === "live_prepare_failed" && details.side === "SELL") {
      text = `🚨 Не удалось подготовить SELL\nMint: ${short(details.mint, 10)}\n${details.message}`;
      options = { dedupeKey: `sell-prepare:${details.mint}`, dedupeMs: 300_000 };
    } else if (event === "live_risk_pause") {
      text = [
        "🛑 Новые BUY автоматически остановлены",
        `Причина: ${details.reason}`,
        `Дневной PnL: ${number(details.dailyRealizedPnlSol)} SOL`,
        `Убытков подряд: ${details.consecutiveLosses}`,
        "SELL и аварийные выходы продолжают работать."
      ].join("\n");
    } else if (event === "live_exit_retry") {
      if (Number(details.attempt) < 3) return Promise.resolve(false);
      text = [
        "🚨 SELL не удаётся выполнить автоматически",
        `Mint: ${short(details.mint, 10)}`,
        `Попытка: ${details.attempt}`,
        `Причина: ${details.reason}`,
        "Проверьте кошелёк и при необходимости продайте вручную."
      ].join("\n");
      options = { dedupeKey: `exit-retry:${details.mint}`, dedupeMs: 300_000 };
    } else if (
      event === "live_exit_recovery" &&
      ["confirmation_unknown", "legacy_exit_unknown"].includes(details.status)
    ) {
      text = [
        "🚨 Статус SELL не определён",
        `Mint: ${short(details.mint, 10)}`,
        `Tx: ${details.signature ? `https://solscan.io/tx/${details.signature}` : "нет сигнатуры"}`,
        `Доказательство: ${details.recoveryEvidence ?? "unknown"}`,
        "Новая продажа заблокирована до проверки транзакции; при необходимости вмешайтесь вручную."
      ].join("\n");
      options = { dedupeKey: `exit-unknown:${details.signature ?? details.targetSignature ?? details.mint}`, dedupeMs: 300_000 };
    } else if (event === "live_sell_unknown") {
      text = [
        "🚨 SELL подтверждён, но изменение токенов не найдено",
        `Mint: ${short(details.mint, 10)}`,
        details.signature ? `Tx: https://solscan.io/tx/${details.signature}` : null,
        "Повторная отправка остановлена до проверки on-chain состояния."
      ].filter(Boolean).join("\n");
      options = { dedupeKey: `sell-unknown:${details.signature ?? details.mint}`, dedupeMs: 300_000 };
    } else if (event === "admin_report") {
      text = details.text;
    }
    if (!text) return Promise.resolve(false);
    return this.send(text, options);
  }
}
