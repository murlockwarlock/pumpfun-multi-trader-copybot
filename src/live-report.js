import fs from "node:fs";

function dayBounds(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return { start, end: start + 86_400_000 };
}

export function buildLiveReport(logFile, day, positions = []) {
  const { start, end } = dayBounds(day);
  const stats = {
    day,
    buys: 0,
    sells: 0,
    submitted: 0,
    failed: 0,
    unknown: 0,
    skips: {},
    realizedPnlSol: 0,
    realizedPnlLamports: 0n,
    wins: 0,
    losses: 0,
    flat: 0,
    openPositions: positions.length,
    traders: {}
  };
  const traderSignals = new Map();
  const traderKey = (record) => record.sourceName ?? record.sourceWallet ?? "legacy";
  const traderStats = (record) => {
    const key = traderKey(record);
    stats.traders[key] ??= {
      name: record.sourceName ?? key,
      wallet: record.sourceWallet ?? null,
      signals: 0,
      buys: 0,
      sells: 0,
      skips: 0,
      realizedPnlLamports: 0n,
      realizedPnlSol: 0,
      openPositions: 0
    };
    return [key, stats.traders[key]];
  };
  for (const position of positions) {
    const [, trader] = traderStats(position);
    trader.openPositions += 1;
  }
  if (fs.existsSync(logFile)) {
    for (const line of fs.readFileSync(logFile, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(record.at);
      if (!Number.isFinite(at) || at < start || at >= end) continue;
      const [key, source] = traderStats(record);
      if (record.targetSignature) {
        traderSignals.set(key, traderSignals.get(key) ?? new Set());
        traderSignals.get(key).add(record.targetSignature);
      }
      if (record.type === "LIVE_BUY") {
        stats.buys += 1;
        source.buys += 1;
      }
      if (record.type === "LIVE_SELL") {
        stats.sells += 1;
        source.sells += 1;
        const legacyPnl = Number(record.realizedPnlSol);
        const pnlLamports = /^-?\d+$/.test(record.realizedPnlLamports ?? "")
          ? BigInt(record.realizedPnlLamports)
          : Number.isFinite(legacyPnl)
            ? BigInt(Math.round(legacyPnl * 1_000_000_000))
            : null;
        if (pnlLamports === null) continue;
        const pnl = Number(pnlLamports) / 1_000_000_000;
        if (Number.isFinite(pnl)) {
          stats.realizedPnlLamports += pnlLamports;
          source.realizedPnlLamports += pnlLamports;
          if (pnl > 0) stats.wins += 1;
          else if (pnl < 0) stats.losses += 1;
          else stats.flat += 1;
        }
      }
      if (record.type === "LIVE_PNL_ADJUSTMENT") {
        const pnlLamports = /^-?\d+$/.test(record.realizedPnlLamports ?? "")
          ? BigInt(record.realizedPnlLamports)
          : 0n;
        stats.realizedPnlLamports += pnlLamports;
      }
      if (record.type === "LIVE_SUBMITTED") stats.submitted += 1;
      if (record.type === "LIVE_FAILED") stats.failed += 1;
      if (record.type === "LIVE_UNKNOWN") stats.unknown += 1;
      if (record.type === "LIVE_SKIP") {
        stats.skips[record.reason] = (stats.skips[record.reason] ?? 0) + 1;
        source.skips += 1;
      }
    }
  }
  stats.realizedPnlSol = Number(stats.realizedPnlLamports) / 1_000_000_000;
  for (const [key, source] of Object.entries(stats.traders)) {
    source.signals = traderSignals.get(key)?.size ?? 0;
    source.realizedPnlSol = Number(source.realizedPnlLamports) / 1_000_000_000;
  }
  return stats;
}

export function formatLiveReport(report, title = "Дневной отчёт") {
  const skipLines = Object.entries(report.skips)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([reason, count]) => `• ${reason}: ${count}`);
  const traderLines = Object.values(report.traders ?? {})
    .sort((left, right) => right.signals - left.signals)
    .slice(0, 10)
    .map((trader) =>
      `• ${trader.name}: ${trader.signals} сигналов, ${trader.buys} BUY / ${trader.sells} SELL, ` +
      `${trader.skips} пропусков, PnL ${trader.realizedPnlSol >= 0 ? "+" : ""}` +
      `${trader.realizedPnlSol.toFixed(9)} SOL`
    );
  return [
    `📊 ${title} — ${report.day} UTC`,
    `BUY подтверждено: ${report.buys}`,
    `SELL подтверждено: ${report.sells}`,
    `Отправлено транзакций: ${report.submitted}`,
    `Ошибок отправки: ${report.failed}`,
    `Неопределённых подтверждений: ${report.unknown}`,
    `Результат: ${report.wins}W / ${report.losses}L / ${report.flat} flat`,
    `Чистый realized PnL: ${report.realizedPnlSol >= 0 ? "+" : ""}${report.realizedPnlSol.toFixed(9)} SOL`,
    `Открытых позиций: ${report.openPositions}`,
    traderLines.length ? "По трейдерам:" : null,
    ...traderLines,
    skipLines.length ? "Пропуски:" : null,
    ...skipLines
  ].filter(Boolean).join("\n");
}

export function utcDay(offset = 0) {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}
