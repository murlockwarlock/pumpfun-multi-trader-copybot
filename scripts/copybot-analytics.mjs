import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { observationReason } from "./next-copy-reasons.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const STAGES = ["wsNotification", "parsedSignal", "confirmed", "eligibleBuy", "buyQuote", "sellQuote", "closed"];

export function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

export function latencyStats(values) {
  return { count: values.filter(Number.isFinite).length, p50: percentile(values, .5), p95: percentile(values, .95), p99: percentile(values, .99) };
}

function eventTime(row) {
  const value = typeof row?.at === "number" ? row.at : Date.parse(row?.at ?? "");
  return Number.isFinite(value) ? value : null;
}

function inWindow(row, start, end) {
  const at = eventTime(row);
  return at !== null && at >= start && at <= end;
}

function addReason(map, reason) {
  const key = observationReason(reason);
  map[key] = (map[key] ?? 0) + 1;
}

function signalLatency(row) {
  return [row.signalToPreparedMs, row.latencyMs, row.quote?.quoteMs, row.quote?.rpcMs].find(Number.isFinite);
}

export function buildFunnel(rows, { start = -Infinity, end = Infinity, wallet = null } = {}) {
  const own = rows.filter(r => (!wallet || r.wallet === wallet) && inWindow(r, start, end));
  const signals = new Set(own.filter(r => r.type === "SIGNAL" && r.provisionalSides?.includes("BUY")).map(r => r.signature));
  const parsed = new Set(own.filter(r => r.type === "SIGNAL").map(r => r.signature));
  const finalized = new Map(rows.filter(r => r.type === "FINALIZED" && eventTime(r) <= end).map(r => [r.signature, r.slot]));
  const confirmed = new Set([...signals].filter(sig => finalized.has(sig)));
  const eligible = new Set(own.filter(r => r.type === "ELIGIBLE" && r.side === "BUY").map(r => r.signature));
  const buyQuotes = new Set(own.filter(r => r.type === "BUY_QUOTE").map(r => r.signature));
  const sellQuotes = new Set(own.filter(r => r.type === "SELL_QUOTE").map(r => r.signature));
  const closed = new Set(own.filter(r => r.type === "SELL_QUOTE" && r.netLamports != null).map(r => r.signature));
  const counts = {
    wsNotification: own.filter(r => r.type === "WS_SIGNAL" || r.type === "WS_NOTIFICATION").length,
    parsedSignal: parsed.size,
    confirmed: confirmed.size,
    eligibleBuy: eligible.size,
    buyQuote: buyQuotes.size,
    sellQuote: sellQuotes.size,
    closed: closed.size
  };
  // Older observer journals do not have a separate WS_NOTIFICATION record.
  // SIGNAL is the first persisted receipt and is therefore the lower-bound WS stage.
  if (!counts.wsNotification) counts.wsNotification = signals.size;
  const reasons = {};
  for (const r of own.filter(r => r.type === "UNKNOWN" || r.type === "INELIGIBLE" || r.type === "FINALITY_POLL_ERROR")) {
    addReason(reasons, r.reason ?? r.error ?? r.type);
  }
  const latencies = {
    signalToPrepared: latencyStats(own.filter(r => r.type === "BUY_QUOTE").map(signalLatency)),
    buyQuote: latencyStats(own.filter(r => r.type === "BUY_QUOTE").map(r => r.quote?.quoteMs ?? r.latencyMs)),
    sellQuote: latencyStats(own.filter(r => r.type === "SELL_QUOTE").map(r => r.quote?.quoteMs ?? r.latencyMs)),
    rpc: latencyStats(rows.filter(r => inWindow(r, start, end)).flatMap(r => Array.isArray(r.rpc?.latencyMs) ? r.rpc.latencyMs : []))
  };
  const gaps = own.filter(r => r.type === "WS_GAP" || r.type === "WS_ERROR");
  const missing = {};
  const title = value => value.charAt(0).toUpperCase() + value.slice(1);
  for (let i = 1; i < STAGES.length; i++) missing[`${STAGES[i - 1]}To${title(STAGES[i])}`] = Math.max(0, counts[STAGES[i - 1]] - counts[STAGES[i]]);
  const gapMs = gaps.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0);
  const status = gaps.length ? "DATA_GAP" : (counts.confirmed < counts.parsedSignal ? "INVALID" : "UNPROVEN");
  return { status, start: start === -Infinity ? null : start, end: end === Infinity ? null : end, counts, missing, reasons, latencies,
    ws: { gaps: gaps.length, gapMs, errors: own.filter(r => r.type === "WS_ERROR").length }, finalized: { available: finalized.size, coverage: confirmed.size === signals.size ? "PROVEN" : "INCOMPLETE" } };
}

function sourceKey(row) {
  if (row.sourceName) return row.sourceName;
  if (row.strategy) return row.strategy;
  if (row.signalSource === "confirmed_transaction") return "ordinary_copy_shadow";
  return "unknown_source";
}

export function analyzeShadow(rows, { now = Date.now(), windowMs = DAY_MS, serviceStart = null, oldSnapshot = null } = {}) {
  const sells = rows.filter(r => r.type === "SHADOW_SELL" && Number.isFinite(Number(r.pnlSol)));
  const groups = new Map();
  for (const row of sells) {
    const key = `${sourceKey(row)}:${row.targetSignature ?? row.entrySignature ?? row.signature ?? `${row.mint}:${row.at}`}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const unique = [...groups.values()].map(list => list.sort((a, b) => String(a.at).localeCompare(String(b.at)))[0]);
  const summarize = (list, label) => {
    const net = list.reduce((sum, row) => sum + Number(row.pnlSol), 0);
    const wins = list.filter(row => Number(row.pnlSol) > 0).length;
    return { label, trades: list.length, wins, losses: list.filter(row => Number(row.pnlSol) < 0).length,
      netSol: list.length ? net : null, sourceSignatures: [...new Set(list.map(row => row.targetSignature ?? row.signature).filter(Boolean))],
      firstAt: list.length ? list.map(row => row.at).sort()[0] : null, lastAt: list.length ? list.map(row => row.at).sort().at(-1) : null };
  };
  const bySource = {};
  for (const row of unique) (bySource[sourceKey(row)] ??= []).push(row);
  for (const known of ["sniper_7ufmve", "sniper_launch_follow", "ordinary_copy_shadow", "independent_prospective_observer"]) bySource[known] ??= [];
  const last24 = unique.filter(row => eventTime(row) >= now - windowMs && eventTime(row) <= now);
  const current = serviceStart == null ? null : unique.filter(row => eventTime(row) >= serviceStart && eventTime(row) <= now);
  const sniperNet = summarize(bySource.sniper_7ufmve ?? [], "sniper_7ufmve").netSol;
  const repeated = oldSnapshot && Number.isFinite(oldSnapshot.net) && sniperNet !== null && Math.abs(Number(oldSnapshot.net) - sniperNet) < 1e-12;
  return { allTime: summarize(unique, "allTime"), last24h: summarize(last24, "last24h"),
    currentService: serviceStart == null ? { status: "UNKNOWN", reason: "shadow journal has no service-start/run-id marker" } : summarize(current, "currentService"),
    bySource: Object.fromEntries(Object.entries(bySource).map(([key, list]) => [key, summarize(list, key)])),
    duplicates: [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, count: list.length, signatures: list.map(r => r.targetSignature ?? r.signature) })),
    repeatedHistoricalSnapshot: Boolean(repeated),
    sourceRows: rows.length, uniqueRows: unique.length };
}

function walkJson(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJson(file, out);
    else if (entry.name.endsWith(".json")) out.push(file);
  }
  return out;
}

export function screenCachedCandidates(workDir) {
  const files = fs.existsSync(workDir) ? fs.readdirSync(workDir).filter(name => /^entry-trades-cand_.*\.json$/.test(name)) : [];
  const candidates = [];
  for (const name of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(workDir, name), "utf8"));
      const trades = Array.isArray(data.trades) ? data.trades : [];
      const buys = trades.filter(t => t.side === "BUY");
      const sells = trades.filter(t => t.side === "SELL");
      const eligible = t => t.quoteKind === "SOL" && ["BUY", "SELL"].includes(t.side);
      const eligibleBuy = buys.filter(eligible).length;
      const eligibleSell = sells.filter(eligible).length;
      candidates.push({ name: data.trader?.name ?? name, wallet: data.trader?.wallet ?? null,
        listed: Array.isArray(data.signatures) ? data.signatures.length : 0, trades: trades.length,
        buys: buys.length, sells: sells.length, eligibleBuy, eligibleSell,
        unsupported: trades.filter(t => t.quoteKind == null || t.quoteKind === "UNKNOWN").length,
        nonSol: trades.filter(t => t.quoteKind != null && t.quoteKind !== "SOL").length,
        venues: trades.reduce((out, t) => (out[t.venue] = (out[t.venue] ?? 0) + 1, out), {}),
        score: eligibleBuy * 3 + eligibleSell * 2 });
    } catch { /* a partial cache file is excluded, never treated as a loss */ }
  }
  const rawSigners = new Set();
  for (const file of walkJson(workDir)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const key of value?.transaction?.message?.accountKeys ?? []) if (key.signer && key.pubkey) rawSigners.add(key.pubkey);
    } catch { /* keep the cached screen read-only */ }
  }
  const wallets = new Set(candidates.map(c => c.wallet).filter(Boolean));
  return { target: 100, cachedFiles: files.length, screenedCandidates: candidates.length, authenticatedSigners: rawSigners.size,
    missingToTarget: Math.max(0, 100 - rawSigners.size), status: rawSigners.size >= 100 ? "UNPROVEN" : "UNPROVEN_INSUFFICIENT_CACHED_ADDRESSES",
    excludedForInsufficientCoverage: candidates.filter(c => c.eligibleBuy === 0 || c.eligibleSell === 0).map(c => c.wallet),
    top: candidates.sort((a, b) => b.score - a.score || b.eligibleBuy - a.eligibleBuy).slice(0, 5), overlapWithRawSigners: [...wallets].filter(w => rawSigners.has(w)).length };
}

export function sizeStudySnapshot(file) {
  if (!file || !fs.existsSync(file)) return { status: "UNKNOWN", reason: "size smoke evidence not found" };
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const scenarios = (data.scenarios ?? []).map(s => ({ id: s.id, inputLamports: s.inputLamports,
    venue: s.buy?.venue ?? null, marketContextSlot: s.buy?.marketContextSlot ?? null,
    commitment: s.buy?.marketCommitment ?? null, contextVerified: s.buy?.contextVerified === true,
    rpcCalls: (s.buy?.rpcCalls ?? 0) + (s.sell?.rpcCalls ?? 0), buyRpcCalls: s.buy?.rpcCalls ?? null, sellRpcCalls: s.sell?.rpcCalls ?? null,
    rpcMs: s.buy?.rpcMs ?? null, quoteMs: s.buy?.quoteMs ?? null, sellQuoteMs: s.sell?.quoteMs ?? null,
    priceImpactBps: s.buy?.priceImpactBps ?? null, sellImpactBps: s.sell?.priceImpactBps ?? null, rentSol: s.buy?.rentSol ?? null,
    netSol: s.netLamports == null ? null : Number(s.netLamports) / 1e9,
    netWithoutRentSol: s.netWithoutRentRecoveryLamports == null ? null : Number(s.netWithoutRentRecoveryLamports) / 1e9,
    sellAvailable: Boolean(s.sell),
    independent: true }));
  const oneExitRpcCalls = scenarios.reduce((n, s) => n + s.rpcCalls, 0);
  const fourExitRpcCalls = (data.scenarios ?? []).reduce((n, s) => n + (s.buy?.rpcCalls ?? 0) + 4 * (s.sell?.rpcCalls ?? 0), 0);
  return { status: "UNPROVEN", reason: "single-mint smoke, no common prospective source signature and no paired trader exits", fx: data.fx,
    scenarios, comparableProspectivePairs: 0, rpcCalls: oneExitRpcCalls,
    rpcBudget: { oneBuyPlusOneSell: oneExitRpcCalls, oneBuyPlusFourSells: fourExitRpcCalls, perObserverAccountBudgetPerMinute: 45, verificationBudgetPerMinute: 18,
      conclusion: fourExitRpcCalls > 45 ? "single observer budget is insufficient for five sizes at one signal; shared WS can reduce duplicate verification but quote reads still need a separate pool or a staged research run" : "within observed account budget" },
    requiredBudgetNote: "five independent quotes use separate account reads; this smoke has one BUY and one SELL only, so no 10s/30s/120s/target comparison exists" };
}

export function buildReport({ combinedRows, shadowRows, now = Date.now(), oldSnapshot = null, sizeFile = null, candidateDir = null, serverStatus = null }) {
  const start = combinedRows.find(r => r.type === "START")?.at ?? null;
  const wallets = combinedRows.find(r => r.type === "START")?.wallets ?? [];
  const currentRun = combinedRows.find(r => r.type === "START")?.run ?? null;
  const currentRows = currentRun ? combinedRows.filter(r => r.run === currentRun) : combinedRows;
  const funnel = Object.fromEntries(wallets.map(wallet => {
    const all = buildFunnel(combinedRows, { wallet });
    const run = buildFunnel(currentRows, { wallet });
    const last24 = buildFunnel(combinedRows, { wallet, start: now - DAY_MS, end: now });
    return [wallet, { allTime: all, currentRun: run, last24h: last24 }];
  }));
  const shadow = analyzeShadow(shadowRows, { now, oldSnapshot });
  const candidates = candidateDir ? screenCachedCandidates(candidateDir) : null;
  const sizeStudy = sizeStudySnapshot(sizeFile);
  const status = Object.values(funnel).some(x => x.allTime.status === "DATA_GAP" || x.allTime.status === "INVALID") ? "INVALID" : "UNPROVEN";
  return { generatedAt: new Date(now).toISOString(), status, observerRuns: [...new Set(combinedRows.map(r => r.run).filter(Boolean))],
    observer: { start, end: combinedRows.map(eventTime).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), start ?? 0), wallets, rows: combinedRows.length, currentRun },
    funnel, shadow, sizeStudy, candidates, serverStatus,
    decisions: { sniper_7ufmve: shadow.bySource.sniper_7ufmve?.trades ? "UNPROVEN_HISTORICAL_ONLY" : "UNPROVEN_NO_CURRENT_TRADES",
      fiveSize: "UNPROVEN_NO_COMMON_PROSPECTIVE_PAIRS", candidateSearch: candidates?.screenedCandidates >= 100 ? "UNPROVEN" : "UNPROVEN_INSUFFICIENT_CACHE" },
    limitations: ["shadow PnL is modelled and is not real profit", "current service run-id is absent from archived shadow-trades.jsonl", "finalized backfill validates signal coverage only and never supplies a quote price", "the five-size smoke uses one mint and cannot select a strategy winner"] };
}

function money(value, digits = 9) { return value == null ? "UNKNOWN" : Number(value).toFixed(digits); }

export function renderMarkdown(report) {
  const rows = ["# Copybot analytics", "", `Generated ${report.generatedAt}. Overall status **${report.status}**.`, "", "## Data separation", "", "| Scope | Trades | Net SOL | First | Last |", "|---|---:|---:|---|---|"];
  for (const item of [report.shadow.allTime, report.shadow.last24h, report.shadow.currentService]) rows.push(`| ${item.label ?? "currentService"} | ${item.trades ?? "UNKNOWN"} | ${money(item.netSol)} | ${item.firstAt ?? "UNKNOWN"} | ${item.lastAt ?? "UNKNOWN"} |`);
  rows.push("", `Historical snapshot repeated: **${report.shadow.repeatedHistoricalSnapshot ? "yes" : "no"}**. Duplicate transaction groups: ${report.shadow.duplicates.length}.`, "", "### Server read-only check", "", report.serverStatus ? `Checked ${report.serverStatus.checkedAt}. systemd **${report.serverStatus.systemd}**, STOP_LIVE **${report.serverStatus.stopLive ? "present" : "not confirmed"}**, LIVE_TRADER_WALLETS **${report.serverStatus.liveTraderWallets}**, real dispatches in window **${report.serverStatus.liveDispatchOrSettlement24h?.LIVE_SUBMITTED ?? "UNKNOWN"}**.` : "Server status UNKNOWN.", "", "### Strategy/source", "", "| Source | Trades | Net SOL | First | Last |", "|---|---:|---:|---|---|");
  for (const item of Object.values(report.shadow.bySource)) rows.push(`| ${item.label} | ${item.trades} | ${money(item.netSol)} | ${item.firstAt ?? "UNKNOWN"} | ${item.lastAt ?? "UNKNOWN"} |`);
  rows.push("", `Observer run ${report.observer.currentRun ?? "UNKNOWN"}, rows ${report.observer.rows}.`, "", "## Funnel", "", "| Wallet | Scope | WS | Parsed | Confirmed | Eligible BUY | BUY quote | SELL quote | Closed | Status |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const [wallet, scopes] of Object.entries(report.funnel)) for (const [scope, f] of Object.entries(scopes)) rows.push(`| ${wallet} | ${scope} | ${f.counts.wsNotification} | ${f.counts.parsedSignal} | ${f.counts.confirmed} | ${f.counts.eligibleBuy} | ${f.counts.buyQuote} | ${f.counts.sellQuote} | ${f.counts.closed} | ${f.status} |`);
  rows.push("", "### Funnel latency", "", "| Wallet | Scope | BUY p50/p95/p99 ms | SELL p50/p95/p99 ms | RPC p50/p95/p99 ms | Main reasons |", "|---|---|---|---|---|---|");
  for (const [wallet, scopes] of Object.entries(report.funnel)) for (const [scope, f] of Object.entries(scopes)) {
    const fmt = x => [x.p50, x.p95, x.p99].map(v => v == null ? "UNKNOWN" : Math.round(v)).join("/");
    rows.push(`| ${wallet} | ${scope} | ${fmt(f.latencies.buyQuote)} | ${fmt(f.latencies.sellQuote)} | ${fmt(f.latencies.rpc)} | ${Object.entries(f.reasons).map(([k, v]) => `${k}=${v}`).join(", ") || "none"} |`);
  }
  rows.push("", "## Five-size study", "", `Status **${report.sizeStudy.status}**. ${report.sizeStudy.reason}.`, "", "| Scenario | Input lamports | Venue | Confirmed | BUY+SELL RPC | BUY impact bps | SELL impact bps | BUY ms | SELL ms | Net SOL | No rent SOL |", "|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of report.sizeStudy.scenarios ?? []) rows.push(`| ${s.id} | ${s.inputLamports} | ${s.venue ?? "UNKNOWN"} | ${s.contextVerified ? "yes" : "no"} | ${s.rpcCalls ?? "UNKNOWN"} | ${s.priceImpactBps ?? "UNKNOWN"} | ${s.sellImpactBps ?? "UNKNOWN"} | ${s.quoteMs ?? "UNKNOWN"} | ${s.sellQuoteMs ?? "UNKNOWN"} | ${s.netSol ?? "UNKNOWN"} | ${s.netWithoutRentSol ?? "UNKNOWN"} |`);
  rows.push("", `Observed RPC budget for one BUY plus one SELL is ${report.sizeStudy.rpcBudget?.oneBuyPlusOneSell ?? "UNKNOWN"} calls. A four-exit five-size run estimates ${report.sizeStudy.rpcBudget?.oneBuyPlusFourSells ?? "UNKNOWN"} account reads against a ${report.sizeStudy.rpcBudget?.perObserverAccountBudgetPerMinute ?? "UNKNOWN"}/minute observer budget. ${report.sizeStudy.rpcBudget?.conclusion ?? "UNKNOWN"}.`, "", "No prospective pair is counted as profitable until all sizes share the same source signature, source slot, exit horizon and confirmed market context.", "", "## Candidate screen", "", `Cached candidate files ${report.candidates?.cachedFiles ?? "UNKNOWN"}, authenticated signers ${report.candidates?.authenticatedSigners ?? "UNKNOWN"} of target 100. Status **${report.candidates?.status ?? "UNKNOWN"}**.`, "", "| Candidate | Wallet | Eligible BUY | Eligible SELL | Unsupported | Non-SOL |", "|---|---|---:|---:|---:|---:|");
  for (const c of report.candidates?.top ?? []) rows.push(`| ${c.name} | ${c.wallet} | ${c.eligibleBuy} | ${c.eligibleSell} | ${c.unsupported} | ${c.nonSol} |`);
  rows.push("", "## Decision", "", "No strategy or size is selected as a winner. Current results are **UNPROVEN** because the server shadow journal lacks a service run-id, the five-size evidence has no common prospective pairs, and the cached historical screen contains fewer than 100 authenticated addresses. The next step is to let observer PID 8032 finish unchanged, then run a read-only report over the closed window and keep data with missing finality or coverage as UNKNOWN.", "");
  return rows.join("\n");
}

async function main(args) {
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
  const combined = value("--combined");
  const shadow = value("--shadow");
  const output = value("--output");
  if (!combined || !shadow || !output) throw Error("Usage: copybot-analytics.mjs --combined FILE --shadow FILE --output PREFIX [--size FILE] [--candidate-dir DIR] [--server FILE] [--now ISO]");
  const nowValue = value("--now");
  const now = nowValue ? Date.parse(nowValue) : Date.now();
  if (!Number.isFinite(now)) throw Error("Invalid --now");
  let oldSnapshot = null;
  const old = value("--old-snapshot");
  if (old && fs.existsSync(old)) { try { const data = JSON.parse(fs.readFileSync(old, "utf8")); oldSnapshot = { net: data.net }; } catch {} }
  let serverStatus = null;
  const server = value("--server");
  if (server && fs.existsSync(server)) serverStatus = JSON.parse(fs.readFileSync(server, "utf8"));
  const report = buildReport({ combinedRows: readJsonl(combined), shadowRows: readJsonl(shadow), now, oldSnapshot, sizeFile: value("--size"), candidateDir: value("--candidate-dir"), serverStatus });
  fs.writeFileSync(`${output}.json`, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(`${output}.md`, renderMarkdown(report));
  console.log(JSON.stringify({ output, status: report.status, observerRuns: report.observerRuns, shadow: report.shadow.allTime, candidateCount: report.candidates?.authenticatedSigners ?? null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
