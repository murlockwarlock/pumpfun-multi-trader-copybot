# sniper_launch_follow — UNPROVEN

1. **Can we buy immediately after the target creates a token?** The unsigned preparation path now exists: authenticated processed Pump CreateEvent + same-mint target BUY → isolated worker → current-state SDK quote and unsigned BUY instructions. No confirmation wait precedes the quote. Actual new-launch preparation latency is not established yet: **0 live launches observed at the initial checkpoint**, not 50. Nothing is signed or submitted by this strategy.
2. **How soon does the creator first sell?** Of 111 archived own-launch BUYs, 100 have a matched first SELL: **p50 2 seconds, p95 6 seconds, p99 8 seconds**. These are blockTime differences with second-level precision in an incomplete, selected archive, not local WebSocket latency. The earlier ~15-second holding figure concerned cycle completion, not the first partial sale.
3. **Does the later price rise enough after expenses?** Unknown. Historical 1/3/5/10/15-second executable quotes are unavailable. The old six shadow cycles lost **0.003328151 SOL**, or **0.003988151 SOL** with an additional modeled 0.00011 SOL CLOSE per cycle. None of those six entries was an own-launch BUY.
4. **Which exit rule wins?** Unknown for all six rules. No timer is selected on zero observations. The first 25 chronological launches are exploratory; the next 25 are a separate holdout, including skips and missing exits.
5. **Is this better than the old shadow copybot?** Not demonstrated. It changes the signal population and exits, but neither positive live-shadow PnL nor an independently validated advantage exists yet.

## Existing observations, with no new historical RPC reconstruction

Raw saved transactions authenticate the creation instruction's `user` and purchased mint. The dataset has **93 own-launch BUYs / 101 detected BUYs**, eight other BUYs, and zero missing raw BUY bodies after normalizing operation IDs to their underlying transaction signatures. Public transaction IDs and per-row classification are in [launch-follow-history.json](evidence/launch-follow-history.json).

| Previous own-launch entries | Count |
|---|---:|
| Target-relative price rejection | 47 |
| Explicit entry drift rejection | 4 |
| Unsupported non-SOL curve | 17 |
| Mint unavailable during probe | 24 |
| Curve unavailable during probe | 1 |
| Admitted old shadow entries | 0 |

Thus **0/6** old completed shadow entries belong to the new launch subgroup. Its realized/model return is **UNKNOWN (no admitted trades)**, not evidence of zero loss or profit. All six old fills were other BUYs. The analysis retains every prior detected BUY; it does not select only the profitable historical cycles.

Strategy A copies ordinary eligible target BUYs and follows target SELLs. Strategy B requires an authenticated own launch and models fixed-time exits as well as first-SELL following. The first observed SELL is necessarily after the creator's transaction; rule F never assumes front-running it. The existing price protections explain why changing the label alone does not establish an edge.

## Live-shadow checkpoint

Initial activation: **2026-11-08 09:29:48 UTC (14:29:48 Asia/Qyzylorda)**, existing systemd service, release `20261108T092931Z`. Initial snapshot: 09:32:25 UTC. See [launch-follow-live.json](evidence/launch-follow-live.json). This is an observation checkpoint, not the end of collection.

| Metric | Result at checkpoint |
|---|---:|
| Own launches detected | 0 |
| BUY admitted | 0 |
| Skipped for price / technical reason / creator already selling | 0 / 0 / 0 |
| Completed modeled exits | 0 |
| A: 1-second net PnL | UNKNOWN |
| B: 3-second net PnL | UNKNOWN |
| C: 5-second net PnL | UNKNOWN |
| D: 10-second net PnL | UNKNOWN |
| E: 15-second net PnL | UNKNOWN |
| F: first creator SELL net PnL | UNKNOWN |
| Best holdout rule | None selected |
| Live launch latency / drift p50/p95/p99 | No samples |
| Confidence in profitability | Insufficient |

The observer remains running to collect future launches. A target that does not launch during the checkpoint cannot be made into 50 observations by replaying old events with current prices.

## Execution and measurement contract

- `SNIPER_LAUNCH_FOLLOW=shadow` is opt-in. It uses the existing processed WebSockets; no new subscription/service/wallet is created. The worker receives only the existing wallet public address and a limited configuration subset, never its keyfile or secret key.
- The shared authenticated program-stack decoder checks Pump-emitted CreateEvent `user`, mint and same-transaction target BUY. Ordinary BUYs, other creators, different mints, failed notifications and forged non-Pump logs do not trigger entries. Multiple BUY legs for a launch mint are aggregated into one entry.
- Model spend is fixed at **0.005 SOL**. Fresh SDK state and normal target-relative minimum-out protection are used. Deployment retains **2500 bps drift cap, 1000 bps slippage and 1500 ms signal age**. There is no relaxed-price path to inflate the sample.
- `quoteShadow()` builds BUY instructions without a transaction, blockhash, simulation, signer or sender call. SELL quotes use the same SDK curve/AMM arithmetic; a shadow position does not need a real wallet ATA. Zero output, missing state, unsupported quote currency and insufficient reserves fail closed.
- Durable per-mint deduplication is reserved before asynchronous quotes. Creator SELLs seen before/during preparation cause a skip. Different mints can prepare independently; at most two launches are in preparation/open at once to bound background load.
- Record separate WS observation, worker queue/decode, quote start/state receipt, BUY-ready time, source slot/blockTime, creator amount/price, local quote price/drift and creator partial SELLs. Local durations never use `blockTime` as a clock substitute.
- A–E deadlines start at model BUY readiness. F starts at first observed creator SELL, using the shared processed mint resolver when necessary. Each exit requests current state separately, with its own PnL and deduplication. It cannot credit the creator's earlier sale price.
- Exit start more than 500 ms after deadline, or quote completion more than 1500 ms after deadline, is `UNKNOWN`. Accepted quotes retain exact lateness; they are not represented as precise historical prices at the deadline. F without a creator SELL in one hour is censored as `UNKNOWN`.
- Restart converts interrupted preparation and unobserved pending exits to explicit unknowns. Already quoted exits and all deduplication keys survive. No late current quote fills an observation gap. File writes/flush/rename and journal work occur in the worker, outside live execution.
- Confirmed source audit is asynchronous, reusing the existing audit. Summary PnL includes only launches with a successful confirmed source audit. Unverified/failed-source quotes are counted separately, not promoted into wins.
- Read-only RPC method allowlist blocks send/simulate calls; all SDK request fan-out shares a fail-fast budget of **8 requests/second, 120/minute**. HTTP 429 starts a 30-second cooldown; SDK automatic 429 retries are disabled for this worker. Skips/unknowns are recorded, never queued behind live execution. This bounds additional use of the shared Helius quota; it does not guarantee that the upstream provider gives execution requests priority.

## Economics and limits of the model

SDK BUY output and SELL SOL output already include dynamic trading fees; the model does not deduct a fixed 125-bps fee a second time. SELL records the gross/net fee difference; exact BUY fee split is explicitly unknown when the SDK does not expose it. Curve price impact is recorded separately where the constant-product expression applies; crossing/missing diagnostics remain null.

Each variant independently accounts for one BUY, one SELL and one CLOSE: nominal base **0.000005 SOL**, configured priority cap **0.0001 SOL**, tip **0.000005 SOL** per operation. Total modeled fixed expense is **0.00033 SOL (6.6% of 0.005 SOL)**. It is a cost assumption, not observed chain fees. The report retains a SELL slippage-floor PnL alongside quote PnL; a quote cannot guarantee landing, realized slippage or that an order executes at all.

Rent is quoted from RPC using the required token-account extensions, with a new ATA assumption. The same rent is returned on modeled successful CLOSE, so net rent is zero, but temporary capital needs include it. Additional persistent account rent, retries, failed transaction fees and actual CLOSE success are not proved by an unsigned quote. The observer never books a claimed realized return on the real wallet.

A bounded mainnet smoke check used current state of the old mint `G1QSTpJYVoq1WCVm3R6hwGNWX5kRzPsfkwzM6q6ppump`: unsigned BUY instructions were built, but SELL was unavailable because the curve had only 50 lamports of real SOL reserves. This is a technical check, **not a historical replay, new launch observation or successful round trip**. It demonstrates why unknown exits must remain unknown.

## Validation and operation

`node --test`: **156 passed, 0 failed**, including 13 new launch/unsigned-quote regressions. Tests cover real archived creation logs, creator/mint authentication, duplicate WebSockets, restart gaps, creator selling during preparation, all six exit portfolios, duplicate exit races, missing/late quotes, drift/staleness, independent mints, read-only RPC limits/429, unsigned SDK BUY/SELL with no ATA/signer, and insufficient real reserves. Existing live/recovery tests remain passing. `git diff --check` passes.

`node bench/shadow-load.mjs`: local mocked submit p50/p95/p99 **6.19/9.64/12.17 ms** with the existing worker versus **31.09/46.00/46.58 ms** inline; worker event-loop delay **1.53/3.91/6.74 ms**. This benchmark measures the existing shadow accounting workload, not real network landing or the new strategy's live RPC latency.

The focused hot-path comparison uses `BENCH_BASE_REF=c26e666 node bench/hot-path.mjs`, alternating isolated before/after runs under identical 5-second monitor-probe and 40-ms prepare + 10-ms submit delays. Baseline p50/p95/p99: **63/72/72 ms**; current: **62/63/63 ms**, six simulated orders per revision. See [benchmark evidence](evidence/launch-follow-hot-path.json). The fixture does not exercise a real WebSocket-to-worker RPC quote; small simulated samples are not a Solana execution SLA.

Runtime files on the existing server:

```text
/opt/pr6spr-paper-copybot/shared/data/sniper-launch-follow/state.json
/opt/pr6spr-paper-copybot/shared/data/sniper-launch-follow/events.jsonl
```

Reproduce historical classification: `node scripts/launch-follow-analysis.mjs` (uses the existing ignored raw cache and snapshots; no RPC requests). Refresh the runtime report: `node scripts/launch-follow-summary.mjs /path/to/state.json`. Technical RPC check: `node scripts/launch-quote-smoke.mjs MINT TARGET_PRICE_SOL EXISTING_WALLET_PUBLIC_KEY`; this never counts as a live strategy sample.

Deployment uses `deploy/deploy.ps1` with the existing server environment plus the shadow opt-in. Both local/remote rollout gates require `LIVE_TRADER_WALLETS=none`; the existing STOP_LIVE and wallet are preserved. Environment backups are saved as `shared/bot.env.before-RELEASE_ID`. Failed health checks restore the previous release and environment. Startup checks use the current systemd invocation and require `launch_follow_ready` in addition to subscriptions/backfill. Manual rollback restores that env backup and the prior `current` release, then restarts the same service.

**Verdict: UNPROVEN.** Continue shadow collection. No live canary, actual BUY/SELL, wallet change or merge is authorized by these observations. Choosing a best timer or claiming profitable launch-follow requires fresh, independent, sufficiently complete observations that do not yet exist.
