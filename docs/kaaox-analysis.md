# Kaaox attribution and signal-source check

Checked 2026-11-06 UTC against the configured Helius JSON-RPC endpoint. This
report is read-only; no transaction was built, signed, or submitted.

Target wallet:

`3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG`

The RPC returned 10,000 signatures while paging backward. The analysis window
contained 209 signatures in the last 24 hours and 633 in the last seven days.
Each successful transaction was fetched with `getTransaction` using
`encoding=jsonParsed` and `maxSupportedTransactionVersion=1`, then checked for
the target signer, fee payer, program IDs, SOL delta, token-balance owners and
token deltas. A transaction was not attributed from `accountKeys` proximity.

## Attribution counts

Counts are transactions, not individual swap legs.

| Window | DIRECT TRADE | ATTRIBUTED TRADE | MENTION ONLY | UNRESOLVED |
|---|---:|---:|---:|---:|
| 24h | 24 | 0 | 184 | 1 |
| 7d | 106 | 0 | 485 | 42 |

`DIRECT TRADE` requires a successful transaction signed by Kaaox and a
confirmed Pump/PumpSwap/CPMM trade shape. `UNRESOLVED` is a failed trade-like
attempt or an unavailable/insufficient RPC result; it is never copied.

In the seven-day direct sample, the venue split was: Pump curve 30,
PumpSwap 36, Raydium CPMM 36, Raydium AMM 2 and Orca Whirlpool 2. The last
24-hour direct sample was Pump curve 8 and PumpSwap 16; no CPMM transaction was
in that shorter window.

## Confirmed examples

| Direction | Venue | Mint | Signature |
|---|---|---|---|
| BUY | PumpSwap | `APgbBfggjo79T7PdVqTQcEbVdQWBCif1kLTwjRwrxc8Z` | [5W7a…](https://solscan.io/tx/5W7aUQ9cvJtu5bG6WUXw9sxbkZmRc6jZJ8rhikZkaWi4NQyE23gYzP6WwHaWmyLgZooio4uD9y8Q3EAU85XeQuVx) |
| SELL | PumpSwap | `APgbBfggjo79T7PdVqTQcEbVdQWBCif1kLTwjRwrxc8Z` | [5Kux…](https://solscan.io/tx/5Kux1X5mbPWptHJZbd6ad3LMGxEUvHmAxSehsaJVZCYNeBAGpezen4omNQZqTStH6zDkL24PYc3NUnUhujLWSSQr) |
| BUY | Pump curve | `GNKV96CghmXbgSxR4HpYgbjxczZBouQ68wjU2xG4pump` | [2VH7…](https://solscan.io/tx/2VH7MX8Sqj4vpz5ycarTE4zyqXjuAeiTacmy2bv2jT7tYV83EqYqdv8MGY1xz6KuSKjybnxJP8Hs3Xi8pGCAJaJy) |
| SELL | Pump curve | `GNKV96CghmXbgSxR4HpYgbjxczZBouQ68wjU2xG4pump` | [3jvL…](https://solscan.io/tx/3jvL1bmxBzXTSFsS46FXrsEZ4tDngYZPpyYNJR6Pfk2NGKLPkmbqDT4fnFmT1YXN8sTLKf6HPVfyMGW3C4WSQiWq) |
| BUY | Raydium CPMM | `7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh` | [25Ei…](https://solscan.io/tx/25EiH9bR9d8oihdLn5o47G8ZUBRZ4FSy7fQpMZre1jSdfPtbHLZNHoeAXVDG7b4SrzXUvxfF6ivYWUdcsoDcG5kv) |
| SELL | Raydium CPMM | `7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh` | [Unjte…](https://solscan.io/tx/Unjte8jmbR5uArSv1PStP61mjE7qt4aTm5o5u6exALQqEVtqhYzXxbdHPk8xynqJvbpir5PkS16KvfdkCguaRRr) |

The CPMM instructions log `SwapBaseInput` and do not emit a Pump-compatible
Anchor trade event. Their direction and amount are recovered from the
confirmed signer transaction's target-owned token delta and SOL delta. For
example, `25Ei…` increases the target's `7ym…` balance by 4,397,620.017616 raw
tokens while the target SOL balance decreases by 11.978505010 SOL including
transaction fees.

As a negative control, `457VK6EQ2b8g6PpAEkvVHKq89khF255zYNvRdqgL4dsfykbUKZr2mNf1aYd6UGTp7GMc8uErsVm34CZA6B9eDahk`
mentions Kaaox but is signed by another wallet and contains no Kaaox-owned
trade delta. It is `MENTION ONLY` and produces no BUY signal.

## Source and execution policy

For shadow observation, monitor Kaaox itself with:

```dotenv
TARGET_WALLETS=kaaox:3j5c4aD1aznxQXJ3DWw1b7UD8kKuaqXVbpaVeWPR83TG
LIVE_TRADER_WALLETS=none
FAST_TRADER_WALLETS=none
SHADOW_ENABLED=true
```

Subscribe to `logsSubscribe` mentions for the target, but accept only
signer-authenticated Pump/PumpSwap events or the confirmed signer/balance
fallback. Ignore payout, router and account-maintenance transactions that only
mention the target. CPMM signals are decoded and recorded as
`venue=raydium-cpmm`, then explicitly marked
`unsupported_venue:raydium-cpmm`; the current executor never sends a CPMM
transaction.

The normal Pump/PumpSwap path can be observed from processed WebSocket logs.
CPMM currently uses the confirmed-transaction fallback because its processed
logs do not carry enough data to recover mint and amounts. No live WebSocket
Kaaox signal was forced for this check, so there is no fabricated live latency
number. Existing `target_trade`, `fast_signal_dispatched` and result records
remain the source of measured decode/prepare/submit timings when a real signal
arrives.

## Conclusion

Kaaox is a real, directly signing trader for the Pump/PumpSwap activity above,
but not every address mention is his trade. He is suitable for **shadow
observation** with the signer gate. He is **not approved for FAST live copying**:
36 of the seven-day direct transactions are Raydium CPMM, and that execution
route is deliberately unsupported until a separate CPMM executor and route
proof are audited. Kolscan's current server-rendered page did not expose a
reliable live PnL table, so its historical leaderboard figures are not used as
an expected return for this bot.
