# Multi-trader selection — incomplete evidence, 2026-11-06

| Trader | Current 7d realized PnL | Pump PnL | Closed positions / win rate | Pump BUY/SELL | Unknown cost | Verdict |
|---|---|---|---|---|---|---|
| candidate_4rt | Not recalculated | Not established | Not recalculated | Not recalculated | Unquantified | Preserve existing shadow |
| sniper_7ufmve | Not recalculated | Not established | Historical evidence below | Not recalculated | Unquantified | Preserve existing shadow; prioritize verification |
| Kaaox | Not established | Conditional subtotal only | See kaaox-pnl-analysis.md | See previous report | 40 weekly sales in previous window | Preserve existing shadow |
| decu | Not established | Not established | Not established | 0 own trades in 100-transaction sample | Unquantified | Not qualified for addition |
| trunoest | Not established | Not established | Not established | 0 own trades in 100-transaction sample | Unquantified | Not qualified for addition |
| Nyhrox | Not established | Not established | Not established | 0 own trades in 100-transaction sample | Unquantified | Not qualified for addition |

This is a partial selection report, not completion of the requested six-wallet profitability analysis. No candidate has been newly proven profitable. Missing values do not mean zero profit or inactivity. No new trader was added. Existing monitoring configuration was not changed.

## Verified server configuration

Read directly from `/opt/pr6spr-paper-copybot/shared/bot.env`; systemd was active:

- candidate_4rt: `4rtj38LLrKdfMLuqUtwPf76ZxxMaschfaD7pEv8UKTbG`
- sniper_7ufmve: `7ufmve7ZSFCzuNcKRunYrGtyb2Ka1MXzkWwf7jZhVsmL`
- kaaox: `3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG`
- `LIVE_TRADER_WALLETS=none`; FAST selection remains `sniper_7ufmve,kaaox`.

## New candidate attribution

All three supplied addresses decode as 32-byte Solana public keys. That does not prove ownership of the supplied names. RPC account queries returned System-owned, nonexecutable accounts.

The [shared failed transaction](https://solscan.io/tx/48sGLU5vXhei9hHGWDhAgKPRRxGWyV59LUpw11sgWUkfBxuiJrc6JgZpbZoa1F9gSdYH7uAFEiBrqxLTes2CHoDA) lists all three candidates as read-only non-signers. Its signer is `2KP9miexioqgNbjPwysggcbi3sKqhH8JsPaDmFxRPURD`. The invoked custom program failed. This transaction is not a trade by any of the candidates.

- decu: 100 latest finalized transactions spanning Unix times 1793967810–1793967812; 0 signed, 0 successful signed, 0 owned SPL balance changes, 98 failed.
- trunoest: 100 latest finalized transactions spanning Unix times 1793967930–1793967947; 0 signed, 0 successful signed, 0 owned SPL balance changes, 95 failed.
- Nyhrox: 100 latest finalized transactions spanning Unix times 1793968076–1793968080; 0 signed, 0 successful signed, 0 owned SPL balance changes, 97 failed.

These tiny time windows cannot establish 24h/7d activity, PnL, trading frequency or absence of trades. High mention frequency must not be interpreted as high trading frequency. Broad mention pagination was stopped; it had not reached the requested history boundary. Helius also returned `Too Many Requests` during this investigation. A filtered history query must be verified before attempting another broad backfill on the RPC used by the running bot.

## Historical ~$40,000 candidate

Local `work/candidate-7ufmve-entry-quality-15d.json`, generated 2026-11-01T14:54:15.970Z, records 94 completed cycles, 94 wins, subtotal +476.912416825 SOL, median entry 5 SOL, and median holding time 15 seconds for sniper_7ufmve. The report explicitly excludes potentially missing tips, transfers and other venues. It is historical, incomplete-cost evidence, not an audited current profit figure. It makes sniper_7ufmve a plausible match for the earlier discussion, but does not prove the exact $40,000 statement or the exchange rate/window behind it.

Local `work/candidate-4rt-fixed-size-summary.json`, generated 2026-11-01T13:36:17.361Z, records 5 closed cycles in its historical 7d window, 3 wins, +1.16548911 SOL trader subtotal. Its modeled 0.005 SOL copy result was negative (-0.0014447486 SOL), demonstrating why original-wallet profit cannot simply be scaled to our bot. Neither historical report replaces current RPC reconciliation.

## Reproduction and remaining work

`node scripts/candidate-sample.mjs` saves raw finalized transactions and sample summaries to ignored `data/candidate-sample/`. It never loads a signing key or imports an executor. `scripts/kaaox-pnl.mjs` now accepts an optional wallet as its third command-line argument and a common `ANALYSIS_END` Unix timestamp; the report script avoids overwriting the Kaaox document for other wallets. Its cost-model limitations still apply.

The required next work remains: obtain a manageable attributable history (including token-owner flows), recover prior cost, allocate transfers/fees, and calculate current six-wallet metrics. No new live latency or profitability samples are claimed. No merge, deployment, real order or wallet movement was performed.
