# Kaaox: RPC cash-flow and cost-basis reconciliation

UTC end: 2026-11-06T12:02:03.000Z; 7d start: 2026-10-30T12:02:03.000Z; 24h start: 2026-11-05T12:02:03.000Z.
Fetched 963 finalized transactions across 14 days; missing RPC bodies: 0.

## Status: total realized trading PnL not established

The figures below are a conditional weighted-average-cost reconstruction, NOT a fully verified trading PnL. Native wallet changes plus lamport changes in token accounts explicitly owned by the wallet neutralize observed account rent and include WSOL. Fees and any tips are already included in this cash flow; network fees must not be subtracted twice. However side transfers, temporary accounts absent from token balance metadata, and router payments have not all been independently allocated. Failed-attempt fees are listed for the wallet but not allocated to positions. Account-local pre-balances do not prove total wallet inventory. These limitations prohibit labeling the reconstructed subtotal as exact confirmed profit.

Buy cost is capitalized; SELL releases average cost using BigInt integer division. Unknown opening inventory and nontrade token movements invalidate cost attribution. This is conservative coverage, not proof that historical cost cannot be recovered from older history. No unrealized valuation or SOL/USD conversion is supplied. No server configuration was changed and no transactions were sent.

| Metric | 24h | 7d |
|---|---:|---:|
| Accepted BUY | 13 | 44 |
| Accepted SELL | 12 | 64 |
| SELL with reconstructed cost | 9 | 24 |
| SELL without reconstructed cost | 3 | 40 |
| Reconstructed complete cycles | 4 | 18 |
| Winning reconstructed cycles | 0 | 1 |
| Conditional subtotal SOL | -2.789096528 | -25.189826771 |
| Unknown-cost sales net receipts SOL | 11.525010046 | 173.062405897 |
| Wallet network fees incl. priority SOL | 0.187626150 | 1.284239997 |
| Native SOL wallet change (NOT PnL) | -17.932184654 | 8.237242942 |
| Exact realized PnL / unrealized PnL | Not established | Not established |

## Venue (7d)

Venue is the set of invoked supported programs, not a claim that each invocation executed a swap. Mixed routes are kept separate. Costs carry across venues; realized results are assigned once to the SELL transaction venue. A zero subtotal with unknown-cost sales is not zero economic profit.

| Venue | BUY | SELL | Conditional subtotal SOL |
|---|---:|---:|---:|
| PumpSwap | 16 | 17 | -15.124574344 |
| Orca | 3 | 2 | 0.000000000 |
| Pump curve | 20 | 8 | -5.048996674 |
| Pump curve+PumpSwap | 0 | 1 | 0.000000000 |
| Raydium CPMM | 3 | 33 | 0.000000000 |
| Pump curve+Orca | 1 | 1 | -0.561351248 |
| PumpSwap+Raydium AMM | 0 | 1 | 0.000000000 |
| PumpSwap+Orca | 1 | 1 | -4.454904505 |

## Largest observed SELL receipts (7d)

| Mint | Venue | Raw sold | Net receipts SOL | Conditional realized SOL | TX |
|---|---|---:|---:|---:|---|
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 875625604599 | 16.731428912 | Unknown cost | [CZ1qq2q17J](https://solscan.io/tx/CZ1qq2q17JMoMTzGzHztJjfrZiSCTSJWwAsjB76tL1SJWHwAf61CiePkhVzuvnL6UK3xD6m9T5KU8ro9qEFZs5M) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 502929875913 | 15.541993397 | Unknown cost | [4sxCMXmVMi](https://solscan.io/tx/4sxCMXmVMizF6cm74QvAgyqS96LL3AHmAXf4ES6FoT8eG1LEyFbTqnLUoX8nvMBVrWGna73PohZsewyjXBzDAQ3F) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 788063044139 | 14.585315330 | Unknown cost | [3AaLmfWSLo](https://solscan.io/tx/3AaLmfWSLoGUjF5kjFRgKxq96q2F9spcNMcPXiXzFKEqvgdA8w2ADVHMUBbtrc1p4C4wCnrLVoCTaWnxT13yvZRK) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 709256739726 | 12.819346762 | Unknown cost | [3fp8eAd6RV](https://solscan.io/tx/3fp8eAd6RVTobSjKKU4HokB8EWq44VboJdM3PPX4d56x5s7Zzf3iqrbZv4pwyHW4PPRFZxTnLNKHoFnebpSpcZHa) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 638331065753 | 11.549407707 | Unknown cost | [GiuycGdpKc](https://solscan.io/tx/GiuycGdpKc3DiANGTZ1h6vAgVQiMksB4rNbrSqoGt5qdUqc6pAWTS8m1Rp4dhZwi2M7CEWpA2T3eoHab8wvVZQX) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 202295872905 | 7.682468251 | Unknown cost | [5DvP1gbJ8H](https://solscan.io/tx/5DvP1gbJ8Hacf1oj9iUrJCy6HMqVrohMkWvZ8VUhHP23Ur5isu8mfjLya8Acgwg2sAJwFdif3uGNoh7bcwKM2JXx) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 192181079260 | 7.382912456 | Unknown cost | [3w7qZRku7m](https://solscan.io/tx/3w7qZRku7mmxDrVKDwnk2kCNbs6E3fbTMyTcZmtdJDu1ok2AU5oookPFabT9yMeQdPetJN3Qznq1gVhUqhpjsS8T) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 272886530609 | 7.072765754 | Unknown cost | [7mxxu8u3pr](https://solscan.io/tx/7mxxu8u3prc1Xt2GhshF9GAYMSQwQjnqksz8viWbDpUNoLdEHzx6eruWdDpxB7dUdL5cMD7KX7PMumsoAZC2bPj) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 226318444161 | 6.852583754 | Unknown cost | [5LzwZvZHmV](https://solscan.io/tx/5LzwZvZHmVrTeLAXVC74DFQcNs8QhXrPKzKoMmPRAdixPkeaMQbtNeUkDZLTycKVhNSHBSJ3GR5joyRKSrV19BKF) |
| GoDSW31bTxfkoup9yA1qcGGx9RMXdTEWgApv3xzBmoA | PumpSwap | 3469982151719 | 6.434147318 | -8.735862754 | [5Jv2kUL8WK](https://solscan.io/tx/5Jv2kUL8WK4Se8xQGpQycvg8vjsUooiY7oqp5pNcbhAoCkULj3os3Kv9cvEdqWd1ZVq5sM2iDrD87ZaPFZm3Wuen) |
| 6d6J2kWJiimgqmxjLVTu31hxDyBFt2zBguYdjSripump | PumpSwap | 23654829938733 | 6.312350296 | 0.638436919 | [4knu84AbYp](https://solscan.io/tx/4knu84AbYp427DdNQfwESttF2rWr32Ra8LRiw8Yx9nTv9pddGpHPscjc69eHbfxZSuhHmLFG95feqX5hj7wWG7DD) |
| 7ymF66Z6VhgNiwadtVhjTtT6U7iQRpSxeiRrhfufhigh | Raydium CPMM | 287248979589 | 6.080599121 | Unknown cost | [3eLgzCFMiL](https://solscan.io/tx/3eLgzCFMiLyA2kCAWGhpWmUYqapcvB4C5TMFY96JnH1XCnzYkM7bwdDhMauoTMKePPNuS5FtkUHSdmbxa2gH3y4E) |
| APgbBfggjo79T7PdVqTQcEbVdQWBCif1kLTwjRwrxc8Z | PumpSwap+Orca | 6442215505395 | 5.655100561 | -4.454904505 | [5Kux1X5mbP](https://solscan.io/tx/5Kux1X5mbPWptHJZbd6ad3LMGxEUvHmAxSehsaJVZCYNeBAGpezen4omNQZqTStH6zDkL24PYc3NUnUhujLWSSQr) |
| G2apw4XQdSfTv9836JHWhRZGyqG43m93eMEF4zjnpump | PumpSwap | 11714206630794 | 4.723576639 | -0.454611581 | [48uEZUWmrH](https://solscan.io/tx/48uEZUWmrH46mYAeBa8zZrwnhfjhJuG8gQ5pKjTH3X3oLJNDoRPNnCXANmL6rsHG53cuG4d14sbAPGPrBVdpDDTV) |
| 2WBx8bdnKC2PrY1hvbCjDSkYy2JLhPMda5UemmuBWDEW | Pump curve | 25077457988503 | 4.416520751 | -0.755607959 | [3XofZqiYJS](https://solscan.io/tx/3XofZqiYJSTxkaVEWfFbr1kYQfZidqRaTtzVX5pXtcf5L5H1q14pjwMXEZBGdSh2yy4eL67NobRmbXJj8bCVC3iX) |

## Interpretation and reproducibility

The old Kolscan +118.42 SOL / +97.90 SOL values refer to unspecified historical windows and cannot be compared as the same interval. This report does not establish that Kolscan is wrong. The current calculation does not establish a profitable copying strategy. Retain shadow observation; do not enable live based on these incomplete profit figures. Winner concentration and full-strategy win rate remain unestablished because most weekly sales lack reconstructed basis.

Run `node scripts/kaaox-pnl.mjs` to collect a new window, then `node scripts/kaaox-pnl-report.mjs` to reproduce the ledger and this report. Evidence is stored under ignored `data/kaaox-pnl-evidence/` without RPC URLs or keys. `ledger.json` includes raw deltas, fees, transaction signatures and residual inventory; `summary.json` includes counts. The collection window is fixed at collection start. Native numeric RPC values are rejected when outside the safe integer range; all arithmetic thereafter uses BigInt. The classifier excludes failed swaps, non-signers and multiple non-WSOL delta transactions rather than inventing an allocation. Accordingly BUY/SELL counts are covered swaps, not a claim of complete economic activity.
