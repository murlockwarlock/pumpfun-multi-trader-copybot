# sniper_7ufmve copy profitability

A. Exact trader net profit is not established. The saved historical algorithm reproduces the subtotal below, but omits unmatched sales, open positions and potentially transfers/tips; it is not full-wallet net PnL.
B. Actual live-triggered shadow result at 0.005 SOL: -0.003328151 SOL across 6 closed modeled trades. These are quotes/models, not executed returns. The sample does not demonstrate profitable copying.

Classification: **SHADOW ONLY**. Negative observed shadow economics and incomplete coverage do not support a live canary. They do not prove every future trade loses.

## Historical selection audit

Saved source: 2026-11-01T14:54:28.526Z; historical original report window 2026-10-17T14:54:15Z to 2026-11-01T14:54:15Z.
```json
{
  "buys": 153,
  "sells": 1314,
  "duplicates": 0,
  "complete": 94,
  "otherClosed": 7,
  "unmatchedSells": 506,
  "open": 17,
  "subtotal": 476.912416825,
  "walletFlowSelected": 447.65435698900006,
  "top10Share": 0.16283045571341317
}
```
The old code has no explicit positive-profit filter in cycle completion. It requires an observed BUY, near-zero post-SELL balance, matching token quantities and positive quote totals. Thus 94/94 is a conditional win rate over matched complete cycles, not all trading outcomes. Nontrade flows and missing venues can invalidate inventory provenance. Reproduction from saved decoded rows is not independent RPC verification of every cycle. Wallet flow on selected transactions is not profit either: it includes rent/other transfers.

## Live observations

Snapshot spans 2026-11-01T16:29:42.120Z through 2026-11-06T12:37:07.628Z.
```json
{
  "records": 1166,
  "detectedBuy": 101,
  "detectedSell": 1065,
  "buys": 6,
  "sells": 6,
  "wins": 1,
  "net": -0.0033281509999999997,
  "mean": -0.0005546918333333333,
  "median": -0.000575694,
  "holds": {
    "n": 6,
    "p50": 0.932,
    "p95": 6573.349,
    "p99": 6573.349
  },
  "prepare": {
    "n": 6,
    "p50": 98,
    "p95": 209,
    "p99": 209
  },
  "drift": {
    "n": 6,
    "p50": 78,
    "p95": 1346,
    "p99": 1346
  },
  "decode": {
    "n": 484,
    "p50": 0.23614799976348877,
    "p95": 0.43167300010100007,
    "p99": 3.1401479989290237
  },
  "resolve": {
    "n": 484,
    "p50": 0.0060430001467466354,
    "p95": 0.01552999997511506,
    "p99": 0.06155899167060852
  },
  "queue": {
    "n": 1166,
    "p50": 0,
    "p95": 0.068359375,
    "p99": 0.11083984375
  },
  "reasons": {
    "fast_shadow_probe_failed:Only SOL-quoted Pump bonding curves are supported": 19,
    "no_paper_position": 1059,
    "fast_entry_price_drift_BPS": 4,
    "fast_shadow_probe_failed:Pump quote exceeds the target-relative entry price limit": 47,
    "fast_shadow_probe_failed:Mint account not found": 24,
    "fast_shadow_probe_failed:Bonding curve account not found for mint: 9n12upnTYRRKE87Ao7eg64VGsMwuKRwJRjgpNewcpump": 1
  },
  "feeOnlyLosses": 1
}
```
Prepare/drift samples are successful accepted BUY probes only; they are selection-biased. Decode/resolve/queue are local measured stages. BlockTime has second resolution and does not give an accurate subsecond network-detection latency. None of these measurements proves landing or SELL execution latency. Curve exits use post-event reserve modeling; PumpSwap exit uses target-price penalty. CLOSE cost and failed actual executions are absent from these paper results.

| Mint | Shadow net SOL | BUY | SELL | Exit model |
|---|---:|---|---|---|
| 5iU3QwYwYNQVC8gY4GNc9EEYJFS69t5yXJgvJLAVpump | -0.002978536 | [5tg1ZHgZ](https://solscan.io/tx/5tg1ZHgZBuKX5byUaxKS511qu1bMSE9kAqR1W7FCDKHS6p4Fo9oGXGpidLjH7kVngMwfhwFCEp7R8irder4ovzhq) | [3FvNvw6t](https://solscan.io/tx/3FvNvw6tFG9LnyjBae4kGruKDt7LDuqQpYAmrHnd43FHmpLPU7eUMbodLNgyaaHPCWhVJqp9jsYVZ1XNuyMpbaje) | curve_post_event |
| G1QSTpJYVoq1WCVm3R6hwGNWX5kRzPsfkwzM6q6ppump | 0.001422417 | [dQ5PP9fc](https://solscan.io/tx/dQ5PP9fcnwWgeJDuvCF3ZSXzBJxF7ShKS1rAytJsKAHSt3wgmbJXvZHP1ZcectFTg7LfZXbxv84H9wEYYgP5bMQ) | [67nt11Gw](https://solscan.io/tx/67nt11GwW632fcxKz5cHqyAo67YtTtLouxBG96yPe277Jhu4mRSbvzwSrbGSvvjsxancLNbp1GYG6N9sy4Lr4ZwZ) | curve_post_event |
| 4bhYVkScUMVYvNUDsECf9rJxGpSLCzm1GEFEnNRopump | -0.000385839 | [5Qzdds53](https://solscan.io/tx/5Qzdds53y497f3YzGgdD5prv653fwZPGuNKnWazqV2LMW9ys3p68qUnUNxhgbATbAnZG1b3i6kTxJtMGD3yKkmoJ) | [5y2UMLx6](https://solscan.io/tx/5y2UMLx6NzV2sZgzyVqzxLygNvMNFs7MNdEUiZiMyd6eZWofmfz1wVadKdp2cKF1dY4U9pmm2ZKPAppV5oJDCevt) | curve_post_event |
| 4bhYVkScUMVYvNUDsECf9rJxGpSLCzm1GEFEnNRopump | -0.000600983 | [63pjbKCf](https://solscan.io/tx/63pjbKCfxF43FrMYd4VxaxSEzWXtgdZnYR1fZfYfArARnmxWxGzTiGW9668982jcsPrWneAdDFifsEqa7bxvoB29) | [56wdFgNw](https://solscan.io/tx/56wdFgNwe8DoiP11vgd15ZyomUD9ckGq3kz1zn3UoaCyk7jd7kgEwk3cAgfuMeFapYH6mv7Lia7iqAjm9h79g69n) | curve_post_event |
| Dy4SZ7u9waYm9LaSi9da5tiGuo8miUx1nwXzhWL4pump | -0.000209516 | [59AE6ZVJ](https://solscan.io/tx/59AE6ZVJtNxVGmgLruwn2YyagQ3ivHaBo99X69UZKr5MionWGmN1EFDG2WMhgN52QCBT7uTsFrjTiu3ZaydefN4g) | [62uKfB4y](https://solscan.io/tx/62uKfB4yzNp9Upnv5gGwz5sZmeMVMqNb6e3mcNLKBs5Ab2RWjNbrufFRCGeoHMtHKH1e7z6J14g5z2pgYBdZbPmZ) | curve_post_event |
| Dy4SZ7u9waYm9LaSi9da5tiGuo8miUx1nwXzhWL4pump | -0.000575694 | [4z61J8bb](https://solscan.io/tx/4z61J8bbFcS6acqzkALWkUsfAzZgRDYydZ5GZL17WX6chxrqWynPKHx6jUCaK4ag5VPQN22FZgWC5H7SGMi6aAYY) | [2aZwahAo](https://solscan.io/tx/2aZwahAoQdrEdrwzdzSTeW66u8VikcY8iA38sUeQWP4bs57WbrS31aJXqURjQuSwVScBtWeshKQtbMMUAsHkYx8k) | target_price_penalty |

## Fee and delay sensitivity

Shadow fixed fee is 0.00011 SOL per side: 0.00022 SOL per round trip, or 4.4% of 0.005 SOL and 2.2% of 0.01 SOL, before trading fees, slippage and CLOSE. Configured 125 bps each side implies break-even price ratio (1 + fixedCost / size) / (1 - 0.0125)^2: approximately 7.06% at 0.005 SOL and 4.80% at 0.01 SOL. These are assumptions, not actual measured average fees. Priority cap 0.0001 SOL and tip 0.000005 SOL are not universally the charged fee.
Removing the 0.00022 fixed round-trip charge changes 1 losing modeled trades into wins. Thus fees alone do not explain most losses. At 0.01 SOL, assuming identical token price/impact and fixed fees, the six-trade extrapolation is -0.005336302 SOL; this is not a fresh executable quote.
Rent is temporary capital while the account exists and must be credited back when closed; CLOSE transaction fees remain a cost. Without confirmed historical landing/pool states, assigning a price change to 100–1500 ms would fabricate returns.

| Assumed extra entry/exit delay | Accepted shadow holds longer than entry delay | PnL |
|---|---:|---|
| 100 / 100 ms | 6 / 6 | Unknown |
| 300 / 300 ms | 6 / 6 | Unknown |
| 750 / 750 ms | 4 / 6 | Unknown |
| 1500 / 1500 ms | 2 / 6 | Unknown |
Timing counts only compare accepted shadow holding intervals; they do not prove a BUY lands before source SELL.

## Historical top 10 matched gains

| Mint | Conditional SOL | Entry TX | Final exit TX |
|---|---:|---|---|
| 8QYz5w48JFgLyY8TWSee8vP6Rwn5a5SKEzK16vbPpump | 10.890983446 | [573esxtC](https://solscan.io/tx/573esxtCUmsSgsa3r5HAZzhPKuYfjESzpBv171QBCunrm9gHecPP9FMPAXzkJWFFTvmV8qrLEpKjWobCbox7BToh) | [4Vn3XafW](https://solscan.io/tx/4Vn3XafWyqNQfNpPpQc57ySWTiZ3B3zB5EsUorRWCuxwMV16C3fbFWxTKs4KqMpAVSWH6VZzKacFWnkDNZjKufWP) |
| knohVJ6pqQsjxhMRfXD9fuq9eYT1jJ7Eri62NYHpump | 9.460835433 | [ek5kK9vY](https://solscan.io/tx/ek5kK9vYyK1kuzHujAzqn3M4BXHXTmiM8gKTkX6BDhFfaq4SQKxVBHJ3TSWYTv6oqQAte2XtHTCABDGTQxNrU1d) | [5Dyo9DSq](https://solscan.io/tx/5Dyo9DSqqQp12RfLFpRaBy3jxwwbrEHeUTmBgBnDTLhkJq5E4aDgoeUohEdRFbmCyFgS5gU2toBKmSQiEgNjsFYy) |
| 9hGKVHm1W2jLkWMNRRhB4Rg8f15gFi9X81DaBCDypump | 9.024911814 | [3TBbwowf](https://solscan.io/tx/3TBbwowfR4i4FRfM4Zh8jkN4iXuKBVB1Gqys3wmMDzPEdGEfj2Jj5CfGqPxaoQF1BhDGrEhFmfJUbynrEcoidEP1) | [4UVDUT96](https://solscan.io/tx/4UVDUT96axGM4DsDcgxbbuKTPvMBkfb27vw96EWJBRdRuaRT4zvUjKtcKozxLNE96VgkK4cxbQodyYtmf81R64Rg) |
| 4ymmAf96PWiuwvqgYptuVzZHJgKbMFYvb3wsCo4Epump | 7.501715290 | [3oPJ8Eom](https://solscan.io/tx/3oPJ8EomYfrEvWdC9jQaDkucEM8A7dLyh6hUuDGTAjnXQtbpHiMNXoCpzbHesLAMNgG6jKMmCvinddTJMSgWdTUs) | [5W5XZHKQ](https://solscan.io/tx/5W5XZHKQD9wHWokTX5Z1WRsStcPH4pgf8pd6XpsKnkaZ8ZYr28z5RX4YqrA4q9WpAthtNuuB4rMshhH2WXdZk5w5) |
| qot6L2mun2NuFRFEbhm7y6B7iJoAH3vCDcYy4ATpump | 7.183696552 | [Vj7BTwwS](https://solscan.io/tx/Vj7BTwwS9Cnj48aVrgBv5sxEyZw8DDg1NztX2EPpAFdLkMRrUSBfR2WSVe7mPZDPW19yVYd7YdVTDxmiZpVVEYp) | [48iu1sRL](https://solscan.io/tx/48iu1sRLFN6b8eyMHwmHQM6KrgUU6YFZt1bXwEC7X3Esr8jQoUTQnVjuMi89sheF5rbNtJTzMWeWSW81KgNfZhPq) |
| J5t2YxemwNnioQT2Qi7mgxSuRzNt5s7MQ2Q6QafEpump | 6.885298606 | [55id2LMT](https://solscan.io/tx/55id2LMTqipWkQV7akcjUjSyuo3CWDgASd9m79XFXAcFPJFgQGpaDHG6R5Fih916kiBKrSLiiyJByQAT9MyvqKWd) | [3cExsi8T](https://solscan.io/tx/3cExsi8TChvSSRprSzFpC38RyAnr2tzSb3PJcRNJbSS87n3Ga4yiF4XJiA8MaBojR1jX5djqwLdtJ2UGNVCVezYU) |
| Pw9Nvk8rMoZF4dYuhzdJeMAuFm3f3CSUy3nQhcUpump | 6.846093533 | [4sEXHz7Z](https://solscan.io/tx/4sEXHz7ZE8SG7bQSf1RuQNFPxTYDZCXWcFjQRE4M68d1e3aAtXLyWX4bxenoXRS7sQM1X3BVhRgBKq2JBa5TSBi8) | [3Q1HtGkV](https://solscan.io/tx/3Q1HtGkV3Qwu7eFPm5NiF1vhVbEVi62Xhwxo7rMNACcb9RLptCSG9bQVPrgcmWwDW9LFcpvEDjmVoUufRxZHTJX1) |
| 7Kof76GaN6V2JJ5i2GpsZuCz5wACCpjRwqHbWZWdpump | 6.806651903 | [755exYyg](https://solscan.io/tx/755exYyg2PrWT62AoA2mDJN5hyqSo6j1H4N8EfF4CJAzmsDgiCYa1nfgRRE5kf6V8NiuSjYmgMYf1VxR4GpyRkP) | [5C3mrrFD](https://solscan.io/tx/5C3mrrFDmdEKBqmwGLVPfmm3pMibuj5NTvaWKWXFGRpUjAHunGvyaUzz4LndbHT2QEXjVCA27ivhSyHMDNMgGuFA) |
| BeQhiMsZ1PdTkBNg8rdXugukGAhwLnmn45n5vaBipump | 6.763026566 | [3QH3tSBW](https://solscan.io/tx/3QH3tSBWDLRJmZwGefKxd62VbVi1wLU8GRPf133ic2PbcZPQsobqFWe4NYR8SHkrSDYEbaYojK919Gc2n91GBeHx) | [2bzbB23J](https://solscan.io/tx/2bzbB23JA83GzHyEHTJ21mPRjsMTuRohxo3YCrdofPtXJyV87ZjSnWFgYY35fvqPTqH5grrV1EULLCbENrbHPF3j) |
| FcnqoPCg8r2uk94KG9f1npta3osZTtZ5UVdYQLuopump | 6.292653024 | [5DQeBhcd](https://solscan.io/tx/5DQeBhcdnDK9dZmthQYnHdAAAvdagTMU7ZmxzhAZpzSa1sjmERKVWc8rfCQRp593SQUsndxBDCzCZ5EBZMdQQT9C) | [EDv6Vvpn](https://solscan.io/tx/EDv6Vvpn6RunjQLfnHPw5bUnZLibvdi6mHxqaFth4erAFrPBDcwYG9mwUALpymY236n1rDrKdvKUETNFjTVgoqS) |
There are no losing complete cycles in this selected historical dataset; no fictional top-10 loss list is supplied. The shadow losses above are actual recorded models.

## Manual control and CLOSE costs

The November 4 manual PumpSwap pair recorded wallet deltas -0.007970040 SOL (BUY), +0.004489791 SOL (SELL), +0.001403840 SOL (CLOSE), totaling -0.002076409 SOL. This is realized wallet-delta accounting for that pair, not a universal trading fee. CLOSE records network fee 0.000105 SOL and reclaimed rent 0.001513840 SOL; the difference between reclaimed rent and net wallet credit is 0.000110 SOL. Do not subtract rent again. Adding a modeled 0.000110 SOL CLOSE to the six shadow cycles gives -0.003988151 SOL. At the same modeled prices, 0.01 SOL gives -0.005336302 SOL before CLOSE and -0.005996302 SOL with CLOSE. Full fixed-cost break-even with 0.000330 SOL per round trip and 125 bps per side is about 9.32% at 0.005 SOL and 5.93% at 0.01 SOL. Actual charged amounts and DEX fees may differ.
## Verification limits

Current 24h/7d trader PnL and per-venue full coverage are not established here. The separate current RPC collection is not interchangeable with the historical window. Raw historical transactions for all 94 cycles, complete token-owner flows, exact tips/rent allocation, and delayed pool/landing states are required to claim audited net returns. The saved report and server journal do not contain all these facts. No execution configuration changes or real transactions were made.
Reproduce with `node scripts/sniper-copy-analysis.mjs` using the saved local historical files and downloaded JSONL snapshots. Machine-readable cycle details, signatures and summary are in ignored `data/sniper-copy-analysis.json`.

## Prior real execution records (control only)
```json
[
  {
    "type": "LIVE_BUY",
    "at": "2026-10-30T09:34:51.688Z",
    "mint": "B8Aw6a4x6p1qWHpSYTChKutUwxcQBXHw5AE2Y6uGpump",
    "rawTokenAmount": "133572462971",
    "spendSol": 0.005,
    "venue": "pump-curve",
    "signature": "5Y7fNWjXjeWNT8ST3GWpFWmmJzKU6Qfct4fh8BVtA8H9ENrXGW4DYf8XpfVc1qgKmxsP5f8d8CdkuCrXBQgPgLkC",
    "targetSignature": "manual:70218f59-97e3-4b82-bd4d-f9863f3770dd-buy:BUY",
    "confirmation": "finalized"
  },
  {
    "type": "LIVE_SELL",
    "at": "2026-10-30T10:04:52.099Z",
    "mint": "B8Aw6a4x6p1qWHpSYTChKutUwxcQBXHw5AE2Y6uGpump",
    "rawTokenAmountSold": "133572462971",
    "rawTokenAmountRemaining": "0",
    "venue": "pump-curve",
    "signature": "4d7kyUTbZ4R2kMpWMyVFr8c5HBUup58b3usCrokxH5idQCE2e3AjQL7SPDr1bG74YzrkMhouaMwaVoaJedTEGXXM",
    "targetSignature": "manual:70218f59-97e3-4b82-bd4d-f9863f3770dd-sell:SELL",
    "entrySignature": "5Y7fNWjXjeWNT8ST3GWpFWmmJzKU6Qfct4fh8BVtA8H9ENrXGW4DYf8XpfVc1qgKmxsP5f8d8CdkuCrXBQgPgLkC",
    "confirmation": "finalized",
    "tokenAccountClose": {
      "status": "closed",
      "tokenAccount": "5ZrUySNcvV1tdV2tR3QGMPzeaPit3WRRNggfzk9KYt2C",
      "reclaimedLamports": 1513840,
      "signature": "1JjRdWcUiSyATQCKkzpHFY1Ja9WhGBxMkUgNZ6Feocdr37Zmi1QpF5oUbFwW4aWifgB8SMJdj1wHDkV9ujNAhLc",
      "confirmation": "finalized"
    }
  },
  {
    "type": "LIVE_BUY",
    "at": "2026-11-04T15:29:55.782Z",
    "mint": "4bhYVkScUMVYvNUDsECf9rJxGpSLCzm1GEFEnNRopump",
    "sourceWallet": null,
    "sourceName": null,
    "rawTokenAmount": "80925683560",
    "spendSol": 0.005,
    "walletDeltaLamports": "-7970040",
    "venue": "pumpswap",
    "signature": "5Kr7JGjZVLnw5CGGBuKbZ7bZNo44NgoWctR9aHzL4qTxqbDhnpgVXfa3Dto1i31o8EN1iTeCzHxpdkEJfnHq2bbg",
    "targetSignature": "manual:668e12fa-0c74-4ed4-9fe0-3c5007de9e6f:BUY",
    "confirmation": "finalized",
    "closedWhileConfirming": false
  },
  {
    "type": "LIVE_SELL",
    "at": "2026-11-04T15:31:59.655Z",
    "mint": "4bhYVkScUMVYvNUDsECf9rJxGpSLCzm1GEFEnNRopump",
    "sourceWallet": null,
    "sourceName": null,
    "rawTokenAmountSold": "80925683560",
    "rawTokenAmountRemaining": "0",
    "venue": "pumpswap",
    "signature": "3XJ4vqp3NTuiJoK82NAdsfzujqEbYyBy6Qb7QxVVZYRNrmoEmw4zqxWeqzsaFSdivUWSxDGV7fXhe1Afssy58xZw",
    "targetSignature": "manual:ea412b75-3733-4501-baf1-94e2cd862776:SELL",
    "entrySignature": "5Kr7JGjZVLnw5CGGBuKbZ7bZNo44NgoWctR9aHzL4qTxqbDhnpgVXfa3Dto1i31o8EN1iTeCzHxpdkEJfnHq2bbg",
    "confirmation": "finalized",
    "tokenAccountClose": {
      "status": "closed",
      "tokenAccount": "GCsDkKfhzoUTXJXVvbkPS5Fm2L3CJV8hKBwFSmnBksuW",
      "reclaimedLamports": 1513840,
      "signature": "DWKb7bBbrjcFvFbyQ1xdSKyZUVafduJGidgePmMWeTXAcEcXtdDfRNDS2aQGW52wpxW3B4cGseR6fumSjXuXZ9A",
      "confirmation": "finalized",
      "walletDeltaLamports": "1403840",
      "feeLamports": "105000"
    },
    "entryWalletDeltaLamports": "-7970040",
    "sellWalletDeltaLamports": "4489791",
    "closeWalletDeltaLamports": "1403840",
    "realizedPnlLamports": "-2076409",
    "realizedPnlSol": -0.002076409,
    "dailyRealizedPnlSol": -0.002076409,
    "consecutiveLosses": 1
  }
]
```
