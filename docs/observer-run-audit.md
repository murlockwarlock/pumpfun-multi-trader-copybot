# Observer run audit (read-only)

This audit covers the existing `work/next-copy/combined.jsonl` only. The source journal was not rewritten, truncated, restarted, or appended to.

## Immutable evidence

- Lines: **18,606**; bytes: **9,576,173**.
- SHA-256: `fa6ecccf762b184da6a432d81e6e548ba2916805b37f84a5332c6325ef629f55`.
- Run ID: `15915ccb-07c5-4e38-813f-56dceb361511`.
- First record: `2026-11-11T06:53:21.276Z` (`START`).
- Last record: `2026-11-11T18:24:39.505Z` (`SUBSCRIBED`, generation 161).
- Observed duration: **41,478,229 ms** (11 h 31 m 18.229 s).
- Last heartbeat: `2026-11-11T18:24:39.363Z`; subscriptions 0; RPC requests 13,118; RPC errors 83; budget rejections 705; rate-limits 0.
- `STOP` record: **absent**.
- WS gaps: 160 (`code=1006`); WS errors: 158. Inferred gap durations use the next subscription record only; a gap is not assumed recovered unless all expected wallets resubscribed.

The machine shutdown is documented in [observer-run-15915ccb-audit.json](evidence/observer-run-15915ccb-audit.json). Windows Event Log showed Event 1074 at `2026-11-11T18:24:41Z` (RuntimeBroker initiated power-off for the interactive user), Kernel-Power Event 109 at `18:24:46Z`, Event 13 at `18:24:47.029Z`, and EventLog Event 6006 at `18:24:45Z`. This is strong evidence for host shutdown as the stop mechanism. Process parent termination and Node exit code remain **UNKNOWN**: Security 4688/4689 auditing had no matching records, and no matching Task Scheduler task was found.

## Confirmed subset

The corrected funnel uses the immutable key `run:wallet:signature` and only advances a stage when the previous stage exists for that same key. A finalized record validates source coverage; it never supplies a historical quote price. Modelled `SELL_QUOTE` rows are not real executions.

| Wallet | Parsed | Finalized-confirmed | Eligible BUY | BUY quote | SELL quote | Modelled closes | Status |
|---|---:|---:|---:|---:|---:|---:|---|
| `3j5c4a…` | 0 | 0 | 0 | 0 | 0 | 0 | DATA_GAP / UNPROVEN_NO_OBSERVATIONS |
| `sssssv2…` | 3,882 | 3,558 | 2,206 | 423 | 412 | 412 | DATA_GAP |
| `DGma4…` | 104 | 86 | 47 | 17 | 17 | 17 | DATA_GAP |

These are not profitability estimates. Because the run ended without `STOP` and contains WS gaps, the confirmed subset is suitable for loss accounting and coverage diagnostics only; it is **not** a complete prospective sample.

## Supervisor readiness

`scripts/next-copy-supervisor.mjs` and `deploy/systemd/pr6spr-next-copy-observer.service` are prepared but were not installed or started. The supervisor starts every observer process with a fresh observer-generated run ID, appends `DATA_GAP` on unexpected exit, and never stitches interrupted intervals. The systemd unit is read-only in scope (`quoteOnly`, no keypair), has a separate write path, and has bounded restart policy. Installing it requires an explicit operational decision and a server check of RPC budget/resources; this change does not restart the existing bot or observer.

## Five-size snapshot assessment

The existing five-size smoke used 71 RPC calls for one BUY+SELL per size (176 for four exits). The BUY account snapshots are not identical: the $30 scenario has different reserves and all scenarios have different context slots. Therefore the evidence does **not** prove a same-slot shared snapshot or an error bound. The corrected report exposes this as `sharedSnapshot.possible=false`, records a measured lower-bound of 8 RPC calls for one common snapshot versus 36 independent BUY reads, and leaves local fan-out accuracy **UNKNOWN** until a same-slot confirmed fixture is collected. No linear PnL scaling is used.

## Next-run readiness criteria

Do not start a new experiment until all are true:

1. A dedicated supervisor is approved and installed separately from the live bot.
2. The first heartbeat and subscription set are persisted, and unexpected exit produces a new run plus `DATA_GAP`.
3. RPC headroom covers the observer budget (45 market calls/min and 18 verification calls/min) with no sustained budget rejection.
4. Independent finalized backfill can audit coverage for every subscription; unresolved gaps remain `INVALID`/`UNKNOWN`.
5. A same-slot confirmed pool snapshot fixture validates local five-size integer quotes against the SDK before any economic conclusion.
6. `STOP_LIVE` remains active and `LIVE_TRADER_WALLETS=none`; no signed or sent transaction is permitted.
