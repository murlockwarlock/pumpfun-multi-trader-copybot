# Launch-follow epoch signal audit

The 29 WebSocket signatures contain **two confirmed own CREATE+BUY transactions and zero eligible SOL-quoted launches**. The earlier observer missed both launch classifications. The confirmed audit found **1 ordinary BUY, 14 SELL, 12 other operations and zero unconfirmed WS records**.

The separately queried confirmed backfill returned 100 signatures and crossed the start of the existing epoch. Its 31 in-scope transactions comprise all 29 WS signatures and two failed transactions. All 29 WS signatures matched the transaction slots in the catalog. Both extra transactions have `InstructionError` custom code 6003 and produced no successful trade. The audit used 32 read-only calls through the configured fallback HTTP endpoint. Its host is the same Helius host as primary, which limits provider independence.

## Transaction classification

Signature prefixes below identify rows in the [complete evidence](evidence/launch-follow-epoch-signals.json). That file includes full signatures, source times and slots, program and instruction evidence, target balance deltas, and decoder results.

| Signature | Slot | Classification | Basis |
|---|---:|---|---|
| 2LW8brVe | 467283856 | OTHER | Transfer and memos, target not signer |
| bZ1CoKLr | 467283923 | OTHER | Target-signed non-Pump operation |
| 2ULZVghh | 467283931 | OTHER | System transfers, target not signer |
| 2qRoFsRV | 467283976 | OTHER | Target-signed non-Pump operation |
| jyFzACXg | 467284182 | OTHER | Target-signed non-Pump operation |
| 338N12eo | 467284279 | OTHER | Target-signed non-Pump operation |
| ZkTr1fmT | 467284410 | OTHER | Target-signed non-Pump operation |
| 5Cwrc4UN | 467353977 | CREATE+BUY | Own create_v2 and token-quoted buy_exact_quote_in_v3 |
| RPaTiPhx | 467353981 | OTHER | System transfer |
| psXKPZ2L | 467353987 | SELL | Pump SellV2 and target balance changes |
| 2Fbene2Y | 467353992 | SELL | Pump SellV2 and target balance changes |
| 3RYwoQgQ | 467353996 | SELL | Pump SellV2 and target balance changes |
| ryPzJWLW | 467354006 | SELL | Pump SellV2 and target balance changes |
| PHnDExZP | 467354016 | SELL | Pump SellV2 and target balance changes |
| 2ucRqwuJ | 467354023 | SELL | Pump SellV2 and target balance changes |
| 2pASupc5 | 467354031 | SELL | Pump SellV2 and target balance changes |
| 3Mf3hyPV | 467354155 | OTHER | Token transfer, target not signer |
| UVWYuBVD | 467354184 | OTHER | System transfer, target not signer |
| PWfLcDyh | 467357688 | BUY | Non-Pump swap acquires the next launch's quote token |
| 26B5v8Uu | 467357688 | CREATE+BUY | Own create_v2 and token-quoted buy_exact_quote_in_v3 |
| 44rtLmjt | 467357690 | OTHER | System transfer |
| 4dJ2g6iu | 467357697 | SELL | Pump SellV2 and target balance changes |
| 3Ho1cLxg | 467357702 | SELL | Pump SellV2 and target balance changes |
| 3grnY9DN | 467357706 | SELL | Pump SellV2 and target balance changes |
| 2c3TZUiN | 467357716 | SELL | Pump SellV2 and target balance changes |
| yXmt8wQX | 467357725 | SELL | Pump SellV2 and target balance changes |
| 5d1iKsGx | 467357735 | SELL | Pump SellV2 and target balance changes |
| dB6HzCsa | 467357744 | SELL | Pump SellV2 and target balance changes |
| 597HBwUQ | 467360534 | OTHER | Another signer buys on PumpSwap |

## Real launch traces and eligibility

Both source transactions were signed by the target. Independent instruction decoding matched CREATE and BUY by user, mint and bonding curve and found a positive target token delta. The original launch decoder returned zero on replay of both confirmed log sets. It treated the SOL-only pricing filter as a launch detector. The fix records authenticated non-SOL launches as `unsupported_non_sol_curve` without preparing a quote.

| Source | Recorded WS arrival, Asia/Qyzylorda | Slot | Quote mint |
|---|---|---:|---|
| 5Cwrc4UN | 9 Nov 19:38:31.130 | 467353977 | `98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g` |
| 26B5v8Uu | 9 Nov 19:51:46.643 | 467357688 | `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` |

The available trace ends at source observation and confirmed instruction evidence. The old observer did not attempt pricing these launches. IPC latency, first market-account readiness, SDK quote latency, entry drift, six executable exit quotes and copy costs are therefore unavailable for these events. The target's wallet SOL delta includes other activity in the transaction and cannot stand in for the token-quoted BUY price. **PnL remains UNKNOWN, and launch-follow remains UNPROVEN.**

On startup with this patch, the targeted epoch reconciliation requires matching saved WS timestamps before admitting the two records. It preserves the existing epoch and frozen cohort rules. The [trimmed confirmed records](evidence/launch-follow-nonsol-confirmed.json) also drive regression tests. Reconciliation submits no pricing requests.

## Server WebSocket and FAST observations

The deployed `694ab57` observation window ran from 20:35:18 to 21:04:06 Asia/Qyzylorda on 9 November. Both channels kept all three subscriptions after startup. For sniper, both channels covered 1,697.202 s, one channel covered 29.980 s during staggered startup, and neither covered the first 0.753 s. The evidence file breaks out all three targets. Primary and fallback received 38 and 37 pongs with p50/p95/p99 RTT of 16/17/17 and 15/16/16 ms. Both had zero closes, heartbeat timeouts and reconnects in this window, so there is no new recovery-latency sample. The earlier close-to-ACK median was 1.062 s on each channel.

The backfill comparison found no successful unmatched transaction in the audited epoch. The common upstream and finite observation window limit any uptime or no-loss conclusion. The 28-minute window was quiet for the target after the release. There are no post-release FAST dispatch latency samples in that window. The preceding epoch log has 11 dispatch samples at p50/p95/p99 4/36/36 ms. The fix runs only on confirmed observation bookkeeping. The FAST path is covered by the existing execution regressions.

Reproduce from a bounded confirmed capture and journal using `node scripts/audit-launch-epoch.mjs RAW_CAPTURE.json RESULT.json`. The capture includes an independent signature page, parsed transaction bodies, observed WS timestamps and the relevant journal events. The published evidence omits RPC credentials.
