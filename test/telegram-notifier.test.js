import assert from "node:assert/strict";
import test from "node:test";
import { TelegramNotifier } from "../src/telegram-notifier.js";

function captureNotifier() {
  const notifier = new TelegramNotifier({ telegramBotToken: "test-token", telegramAdminChatId: "1" });
  const messages = [];
  const dedupe = new Map();
  notifier.send = async (text, options) => {
    const { dedupeKey, dedupeMs } = options ?? {};
    if (dedupeKey && dedupeMs > 0 && dedupe.has(dedupeKey)) return false;
    if (dedupeKey && dedupeMs > 0) dedupe.set(dedupeKey, Date.now());
    messages.push({ text, options });
    return true;
  };
  return { notifier, messages };
}

test("unknown and settlement-error results never use confirmed-sale wording", async () => {
  const { notifier, messages } = captureNotifier();
  await notifier.handle("live_settled", {
    side: "SELL", mint: "mint-unknown", signature: "sig-unknown", resultType: "LIVE_UNKNOWN"
  });
  await notifier.handle("live_settled", {
    side: "SELL", mint: "mint-error", signature: "sig-error", resultType: "LIVE_SETTLEMENT_ERROR"
  });
  await notifier.handle("live_settled", {
    side: "SELL", mint: "mint-skip", signature: "sig-skip", resultType: "LIVE_SKIP"
  });
  assert.equal(messages.length, 0);

  await notifier.handle("live_sell_unknown", {
    mint: "mint-unknown", signature: "sig-unknown"
  });
  await notifier.handle("live_settlement_error", {
    mint: "mint-error", message: "confirmation timeout"
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /не найдено|Повторная отправка остановлена/);
  assert.doesNotMatch(messages[0].text, /Продажа подтверждена/);
  assert.match(messages[1].text, /live_settlement_error|confirmation timeout/);
});

test("generic LIVE_UNKNOWN result is actionable and deduplicated", async () => {
  const { notifier, messages } = captureNotifier();
  const details = { mint: "mint-buy", signature: "sig-buy", error: "token attribution unavailable" };
  await notifier.handle("live_unknown", details);
  await notifier.handle("live_unknown", details);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Результат live-транзакции не определён/);
  assert.match(messages[0].text, /token attribution unavailable/);
});
