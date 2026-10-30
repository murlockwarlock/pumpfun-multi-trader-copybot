import { PublicKey } from "@solana/web3.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const POOL_BASE_MINT_OFFSET = 8 + 1 + 2 + 32;
const POOL_QUOTE_MINT_OFFSET = POOL_BASE_MINT_OFFSET + 32;

export class SolanaRpc {
  #nextId = 1;

  constructor(url, timeoutMs = 10_000) {
    this.urls = (Array.isArray(url) ? url : [url]).filter(Boolean);
    if (this.urls.length === 0) throw new Error("At least one RPC URL is required");
    this.timeoutMs = timeoutMs;
    this.poolCache = new Map();
    this.poolRequests = new Map();
  }

  async resolvePumpPool(poolAddress) {
    if (this.poolCache.has(poolAddress)) return this.poolCache.get(poolAddress);
    if (this.poolRequests.has(poolAddress)) return this.poolRequests.get(poolAddress);

    const request = (async () => {
      const result = await this.callWithRetry(
        "getAccountInfo",
        [poolAddress, { commitment: "processed", encoding: "base64" }],
        3
      );
      const value = result?.value;
      const encoded = Array.isArray(value?.data) ? value.data[0] : null;
      if (value?.owner !== PUMP_AMM_PROGRAM || typeof encoded !== "string") {
        throw new Error(`Invalid PumpSwap pool account: ${poolAddress}`);
      }
      const data = Buffer.from(encoded, "base64");
      if (
        data.length < POOL_QUOTE_MINT_OFFSET + 32 ||
        !data.subarray(0, 8).equals(POOL_DISCRIMINATOR)
      ) {
        throw new Error(`Invalid PumpSwap pool data: ${poolAddress}`);
      }
      const pool = Object.freeze({
        address: poolAddress,
        baseMint: new PublicKey(
          data.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32)
        ).toBase58(),
        quoteMint: new PublicKey(
          data.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32)
        ).toBase58()
      });
      this.poolCache.set(poolAddress, pool);
      return pool;
    })();
    this.poolRequests.set(poolAddress, request);
    try {
      return await request;
    } finally {
      this.poolRequests.delete(poolAddress);
    }
  }

  async resolveSolPumpPool(poolAddress) {
    const pool = await this.resolvePumpPool(poolAddress);
    if (pool.quoteMint !== WRAPPED_SOL_MINT) {
      throw new Error(`PumpSwap pool is not SOL-quoted: ${poolAddress}`);
    }
    return pool;
  }

  async call(method, params) {
    let lastError;
    for (const url of this.urls) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.#nextId++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
        return payload.result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async callWithRetry(method, params, attempts = 5) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.call(method, params);
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) await sleep(Math.min(5_000, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  async getTransactionWithRetry(signature, attempts = 8) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const tx = await this.call("getTransaction", [
          signature,
          {
            commitment: "confirmed",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 1
          }
        ]);
        if (tx) return tx;
      } catch (error) {
        if (attempt === attempts - 1) throw error;
      }
      await sleep(250 + attempt * 150);
    }
    return null;
  }

  async getRecentSignatures(address, limit = 1_000) {
    return this.callWithRetry("getSignaturesForAddress", [
      address,
      { commitment: "confirmed", limit }
    ]);
  }

  async getSignaturesSince(address, until = null, maxPages = 100) {
    const signatures = [];
    let before;

    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const options = { commitment: "confirmed", limit: 1_000 };
      if (until) options.until = until;
      if (before) options.before = before;
      const page = await this.callWithRetry("getSignaturesForAddress", [address, options]);
      signatures.push(...page);
      if (page.length < 1_000) return signatures;
      before = page.at(-1).signature;
    }

    throw new Error(`Backfill exceeded ${maxPages * 1_000} signatures`);
  }
}
