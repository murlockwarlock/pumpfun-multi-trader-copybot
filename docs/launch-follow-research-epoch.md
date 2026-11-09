# Launch-follow research epoch

The collector starts the epoch at the next whole second after its first healthy WS and backfill heartbeat. The epoch ID, timestamp, entry parameters, fee assumptions, and 25/25 protocol are saved before observations enter the cohort. Restart restores that boundary and records the outage. Earlier observations and outages remain in the audit.

The cohort uses source slot order with observation time and signature as tie breakers. The first 25 launches select a rule and the next 25 evaluate it. A backfill-discovered launch takes its source slot and stays in the denominator as UNKNOWN. Confirmed abstentions for price, creator exit, or capacity count as zero exposure. A cohort with incomplete exploratory exits cannot select a winner. The holdout decision uses the selected rule only and requires every observation for that rule to resolve.

An unresolved gap can invalidate cohort completeness. For quote inclusion, the gap must overlap the observation-to-exit interval for that specific exit. A WS interval can be cleared when a before/after backfill sweep and the available timestamped signatures establish an empty interval. The timestamp check includes a margin for blockTime granularity. Missing evidence leaves the interval unresolved.

New epoch account reads request confirmed commitment and enforce the source or exit context slot. The collector uses the original timing window for each quote, including the 1.5-second preparation limit and existing exit deadlines. A lagging confirmed bank can therefore leave an entry or exit UNKNOWN. Older processed-only prices remain diagnostic. Confirmed state can still roll back before finalization.

The report models net quote proceeds, three fixed operation charges and a successful rent refund. The adverse scenario applies approximate BUY and SELL haircuts and assumes the close fee is spent without recovering rent. Quote delay and deadline lateness are measured. Real execution delay, fill price and realized PnL remain unmeasured. The adverse approximation is a sensitivity check rather than a reprice of the historical market.

The Worker rotates event files at 4 MiB. It moves aged or excess terminal observations and signature metadata to a keyed SQLite archive. The commit precedes hot-state pruning. On recovery, an archived mint cannot open again and duplicate snapshot/archive records merge by key. Hot-state writes report p50/p95/p99. The report reads the adjacent archive automatically.

```sh
node scripts/launch-follow-summary.mjs /path/to/state.json /path/to/report
node scripts/launch-gap-audit.mjs SNAPSHOT FILTERED_JOURNAL OUTPUT_DIR
```

## Historical WS audit at the 9 November checkpoint

At 12:35:40 Asia/Qyzylorda, 188 intervals had been recorded. Their aggregate duration was 210.022 seconds. Duration p50/p95/p99 was **1.001/2.325/2.918 seconds**, with a maximum of 2.933 seconds. Both channels closed near every interval and both sniper subscriptions were observed to return. The historical logs omit WebSocket close codes, so the transport cause is unknown. The new release records close code and clean-close status.

There were zero logged sniper backfill successes inside those short intervals. The backfill logger suppresses routine empty polls, so the log does not establish whether a poll ran inside each interval. The reconciliation found zero target signatures in the timestamp margins and zero proven missed launches. With coarse block times and incomplete historical coverage, that is evidence of no observed opportunity in those intervals. It does not prove there were no opportunities. The per-interval audit includes the adjacent logged backfills, reconnection timestamps and signature matches.

The 24-hour window contained **120 verified fast signals**, including **15 BUY and 105 SELL**. There were **22 failed BUY probes**, with 15 attached to processed signals and seven attached to confirmed fallback trades. The failures were eight missing mint accounts, seven unsupported quote currencies, six entry-price-limit rejections and one missing bonding curve. Failure latency p50/p95/p99 was **110/902/1022 ms**. Successful probe count was zero.

The shorter window from the integrity deployment to the same checkpoint contained **88 sniper fast signals** and **14 failed BUY probes**. The 104 count previously shown by health covered all fast traders in that process. It was not a count of sniper BUY attempts.

[Per-interval audit and window breakdown](evidence/launch-follow-ws-audit.json)
