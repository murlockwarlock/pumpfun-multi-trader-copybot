# Copybot analytics

Generated 2026-11-12T10:26:04.163Z. Overall status **INVALID**.

## Data separation

| Scope | Trades | Net SOL | First | Last |
|---|---:|---:|---|---|
| allTime | 56 | 0.043805839 | 2026-10-30T20:25:59.783Z | 2026-11-10T08:56:57.256Z |
| last24h | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| currentService | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN |

Historical snapshot repeated: **yes**. Duplicate transaction groups: 0.

### Server read-only check

Checked 2026-11-12T10:20:14.300Z. systemd **active**, STOP_LIVE **present**, LIVE_TRADER_WALLETS **none**, real dispatches in window **0**.

### Strategy/source

| Source | Trades | Net SOL | First | Last |
|---|---:|---:|---|---|
| moonfishappeali | 19 | -0.056675601 | 2026-10-30T20:25:59.783Z | 2026-11-01T05:57:33.982Z |
| sniper_7ufmve | 6 | -0.003328151 | 2026-11-02T15:42:32.783Z | 2026-11-04T16:06:06.336Z |
| candidate_4rt | 17 | -0.001374331 | 2026-11-03T21:28:19.515Z | 2026-11-08T00:57:44.314Z |
| kaaox | 14 | 0.105183922 | 2026-11-06T15:08:40.891Z | 2026-11-10T08:56:57.256Z |
| sniper_launch_follow | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| ordinary_copy_shadow | 0 | UNKNOWN | UNKNOWN | UNKNOWN |
| independent_prospective_observer | 0 | UNKNOWN | UNKNOWN | UNKNOWN |

Observer run 15915ccb-07c5-4e38-813f-56dceb361511, rows 18606.

## Funnel

| Wallet | Scope | WS | Parsed | Confirmed | Eligible BUY | BUY quote | SELL quote | Closed | Status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | allTime | 0 | 0 | 0 | 0 | 0 | 0 | 0 | UNPROVEN |
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | currentRun | 0 | 0 | 0 | 0 | 0 | 0 | 0 | UNPROVEN |
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | last24h | 0 | 0 | 0 | 0 | 0 | 0 | 0 | UNPROVEN |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | allTime | 2421 | 3882 | 2206 | 2219 | 426 | 412 | 412 | INVALID |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | currentRun | 2421 | 3882 | 2206 | 2219 | 426 | 412 | 412 | INVALID |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | last24h | 1588 | 2566 | 1437 | 1445 | 294 | 283 | 283 | INVALID |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | allTime | 57 | 104 | 47 | 47 | 17 | 17 | 17 | INVALID |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | currentRun | 57 | 104 | 47 | 47 | 17 | 17 | 17 | INVALID |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | last24h | 51 | 83 | 41 | 41 | 15 | 15 | 15 | INVALID |

### Funnel latency

| Wallet | Scope | BUY p50/p95/p99 ms | SELL p50/p95/p99 ms | RPC p50/p95/p99 ms | Main reasons |
|---|---|---|---|---|---|
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | allTime | UNKNOWN/UNKNOWN/UNKNOWN | UNKNOWN/UNKNOWN/UNKNOWN | 205/793/1698 | none |
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | currentRun | UNKNOWN/UNKNOWN/UNKNOWN | UNKNOWN/UNKNOWN/UNKNOWN | 205/793/1698 | none |
| 3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG | last24h | UNKNOWN/UNKNOWN/UNKNOWN | UNKNOWN/UNKNOWN/UNKNOWN | 205/808/1657 | none |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | allTime | 1417/1816/2040 | 1449/2040/2386 | 205/793/1698 | DEADLINE_OR_CONTEXT_UNDISTINGUISHED=135, REPEAT_OPEN_POSITION=1432, OWN_RPC_BUDGET=606, RPC_ERROR=217, TARGET_SELL_NOT_SEEN=93, DEADLINE=1, POSITION_CAP=141, WS_GAP=78, OTHER=4, VERIFICATION_QUEUE=5, PRICE_LIMIT=2 |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | currentRun | 1417/1816/2040 | 1449/2040/2386 | 205/793/1698 | DEADLINE_OR_CONTEXT_UNDISTINGUISHED=135, REPEAT_OPEN_POSITION=1432, OWN_RPC_BUDGET=606, RPC_ERROR=217, TARGET_SELL_NOT_SEEN=93, DEADLINE=1, POSITION_CAP=141, WS_GAP=78, OTHER=4, VERIFICATION_QUEUE=5, PRICE_LIMIT=2 |
| sssssv2ivFNk1ogpBnEkcijSHzvib5vKfhiJMhRT2NT | last24h | 1417/1785/1982 | 1451/2032/2369 | 205/808/1657 | RPC_ERROR=160, REPEAT_OPEN_POSITION=880, DEADLINE_OR_CONTEXT_UNDISTINGUISHED=87, OWN_RPC_BUDGET=408, TARGET_SELL_NOT_SEEN=70, POSITION_CAP=117, WS_GAP=75, OTHER=4, VERIFICATION_QUEUE=5, PRICE_LIMIT=2 |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | allTime | 1197/2093/2093 | 1348/1668/2005 | 205/793/1698 | MARKET_OR_LIQUIDITY=7, OTHER=12, TARGET_SELL_NOT_SEEN=17, RPC_ERROR=5, DEADLINE_OR_CONTEXT_UNDISTINGUISHED=3, OWN_RPC_BUDGET=11, POSITION_CAP=14 |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | currentRun | 1197/2093/2093 | 1348/1668/2005 | 205/793/1698 | MARKET_OR_LIQUIDITY=7, OTHER=12, TARGET_SELL_NOT_SEEN=17, RPC_ERROR=5, DEADLINE_OR_CONTEXT_UNDISTINGUISHED=3, OWN_RPC_BUDGET=11, POSITION_CAP=14 |
| DGma4Uxm9JS6yLNdgYaxsZhwk2nxrRGMfMt5buXbiFCm | last24h | 1197/2093/2093 | 1348/1668/2005 | 205/808/1657 | DEADLINE_OR_CONTEXT_UNDISTINGUISHED=3, RPC_ERROR=4, MARKET_OR_LIQUIDITY=4, OWN_RPC_BUDGET=11, POSITION_CAP=14, TARGET_SELL_NOT_SEEN=15, OTHER=11 |

## Five-size study

Status **UNPROVEN**. single-mint smoke, no common prospective source signature and no paired trader exits.

| Scenario | Input lamports | Venue | Confirmed | BUY+SELL RPC | BUY impact bps | SELL impact bps | BUY ms | SELL ms | Net SOL | Net USD | ROI | No rent SOL |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| control | 5000000 | pumpswap | yes | 15 | 0.7073067059426563 | 0.6986131479769231 | 964 | 689 | -0.000551174 | -0.046315151219999996 | -11.02% | -0.002065014 |
| usd5 | 59502558 | pumpswap | yes | 14 | 8.393380227911251 | 8.295584283395385 | 678 | 649 | -0.003048911 | -0.25619999133 | -5.12% | -0.004562751 |
| usd10 | 119005117 | pumpswap | yes | 14 | 16.78650543467386 | 16.563297642794296 | 623 | 599 | -0.005956871 | -0.50055587013 | -5.01% | -0.007470711 |
| usd20 | 238010234 | pumpswap | yes | 14 | 33.57288352236587 | 33.0165602101018 | 618 | 606 | -0.012336189 | -1.03660996167 | -5.18% | -0.013850029 |
| usd30 | 357015351 | pumpswap | yes | 14 | 50.6460944531395 | 49.63932517643044 | 678 | 658 | -0.019479585 | -1.63686952755 | -5.46% | -0.020993425 |

Observed RPC budget for one BUY plus one SELL is 71 calls. A four-exit five-size run estimates 176 account reads against a 45/minute observer budget. single observer budget is insufficient for five sizes at one signal; shared WS can reduce duplicate verification but quote reads still need a separate pool or a staged research run.

No prospective pair is counted as profitable until all sizes share the same source signature, source slot, exit horizon and confirmed market context.

## Candidate screen

Cached candidate files 36, authenticated signers 39 of target 100. Status **UNPROVEN_INSUFFICIENT_CACHED_ADDRESSES**.

| Candidate | Wallet | Eligible BUY | Eligible SELL | Unsupported | Non-SOL |
|---|---|---:|---:|---:|---:|
| cand_j45 | J45JdaaqLniscYrf5QRLSbhumkyos5de8j5veoddeHCx | 901 | 1199 | 0 | 0 |
| cand_7ufmve | 7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL | 153 | 1314 | 0 | 0 |
| cand_2jxpmu | 2JxPmU9UU5KhSQ7h5v8PfhgbxPQhHNyBqNrhPAjPiWCu | 431 | 868 | 0 | 0 |
| cand_grok1r | grok1r9rhYXqniD79L3eeBB6bBLd8ytGrhDRa6kgRNt | 157 | 738 | 0 | 0 |
| cand_8zp | 8zpZdVXdBcybJCNwxhgTqMTA2tNo9FqLm5VM8N6E1ixx | 497 | 168 | 0 | 0 |

## Decision

No strategy or size is selected as a winner. Current results are **UNPROVEN** because the server shadow journal lacks a service run-id, the five-size evidence has no common prospective pairs, and the cached historical screen contains fewer than 100 authenticated addresses. The next step is to let observer PID 8032 finish unchanged, then run a read-only report over the closed window and keep data with missing finality or coverage as UNKNOWN.
