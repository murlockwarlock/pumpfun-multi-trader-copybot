import { PublicKey, SystemProgram } from "@solana/web3.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"
];

function apiKeyFromRpcUrl(rpcUrl) {
  try {
    return new URL(rpcUrl).searchParams.get("api-key") ?? "";
  } catch {
    return "";
  }
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function appendQuery(urlString, values) {
  const url = new URL(urlString);
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value !== false && value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function priorityMicroLamports(priorityFeeSol, computeUnitLimit) {
  const lamports = Math.floor(priorityFeeSol * LAMPORTS_PER_SOL);
  return Math.max(1, Math.floor((lamports * 1_000_000) / computeUnitLimit));
}

export class TransactionSender {
  constructor(config, connection) {
    this.config = config;
    this.connection = connection;
    this.jitoTipAccounts = null;
    this.heliusApiKey = config.heliusApiKey || apiKeyFromRpcUrl(config.rpcHttpUrl);
    this.tipLamports = Math.floor(config.liveTipSol * LAMPORTS_PER_SOL);
    this.#validate();
  }

  #validate() {
    const route = this.config.liveSendRoute;
    if (route === "helius-swqos" && this.tipLamports < 5_000) {
      throw new Error("helius-swqos requires LIVE_TIP_SOL >= 0.000005");
    }
    if (route === "helius-max" && this.tipLamports < 1_000_000) {
      throw new Error("helius-max requires LIVE_TIP_SOL >= 0.001");
    }
    if (route === "jito" && this.tipLamports < 1_000) {
      throw new Error("jito requires LIVE_TIP_SOL >= 0.000001");
    }
    if (route.startsWith("helius-") && !this.heliusApiKey) {
      throw new Error("Helius Sender needs HELIUS_API_KEY or api-key in RPC_HTTP_URL");
    }
  }

  async warmup() {
    if (this.config.liveSendRoute === "jito") await this.#fetchJitoTipAccounts();
    if (this.config.liveSendRoute.startsWith("helius-")) {
      const ping = this.config.heliusSenderUrl.replace(/\/fast\/?$/, "/ping");
      await fetch(ping, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    }
  }

  async #fetchJitoTipAccounts() {
    const endpoint = new URL("/api/v1/bundles", this.config.jitoUrl).toString();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`Jito getTipAccounts HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error || !Array.isArray(payload.result) || payload.result.length === 0) {
      throw new Error(`Jito getTipAccounts failed: ${payload.error?.message ?? "empty result"}`);
    }
    this.jitoTipAccounts = payload.result;
  }

  async tipInstruction(fromPubkey) {
    if (this.config.liveSendRoute === "rpc") return null;
    if (this.config.liveSendRoute === "jito" && !this.jitoTipAccounts) {
      await this.#fetchJitoTipAccounts();
    }
    const accounts = this.config.liveSendRoute === "jito"
      ? this.jitoTipAccounts
      : HELIUS_TIP_ACCOUNTS;
    return SystemProgram.transfer({
      fromPubkey,
      toPubkey: new PublicKey(randomItem(accounts)),
      lamports: this.tipLamports
    });
  }

  async submit(transaction) {
    const wire = transaction.serialize();
    if (this.config.liveSendRoute === "rpc") {
      return this.connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 });
    }

    const base64 = Buffer.from(wire).toString("base64");
    let endpoint;
    if (this.config.liveSendRoute === "jito") {
      endpoint = appendQuery(
        new URL("/api/v1/transactions", this.config.jitoUrl).toString(),
        { bundleOnly: "true" }
      );
    } else {
      endpoint = appendQuery(this.config.heliusSenderUrl, {
        "api-key": this.heliusApiKey,
        swqos_only: this.config.liveSendRoute === "helius-swqos" ? "true" : "",
        "mev-protect": this.config.liveMevProtect ? "true" : ""
      });
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "sendTransaction",
        params: [base64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`sendTransaction HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error || typeof payload.result !== "string") {
      throw new Error(`sendTransaction failed: ${payload.error?.message ?? "missing signature"}`);
    }
    return payload.result;
  }
}
