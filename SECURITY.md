# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature instead of opening
a public issue for security-sensitive findings.

## Key handling

- Use a dedicated low-balance trading wallet.
- Store the Solana JSON keypair outside the repository with mode `0600`.
- Keep RPC, Jupiter, Telegram, Jito, and deployment credentials out of `.env`
  whenever a file-based secret option is available.
- Never provide a seed phrase to this application.
- Rotate any credential that was printed, pasted into a chat, or committed.
- Run paper mode and a live allowlist audit before enabling real orders.

The application rejects symlinked or overly permissive secret files on Linux
and verifies that the configured public address matches the loaded keypair.
