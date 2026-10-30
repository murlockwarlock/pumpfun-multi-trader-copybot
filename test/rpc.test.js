import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SolanaRpc } from "../src/rpc.js";

test("uses the fallback RPC when the primary endpoint fails", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url === "https://primary.invalid") return { ok: false, status: 503 };
    return {
      ok: true,
      async json() {
        return { jsonrpc: "2.0", id: 2, result: 123 };
      }
    };
  };

  try {
    const rpc = new SolanaRpc(
      ["https://primary.invalid", "https://fallback.invalid"],
      1_000
    );
    assert.equal(await rpc.call("getSlot", []), 123);
    assert.deepEqual(calls, ["https://primary.invalid", "https://fallback.invalid"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolves and caches the base mint of a SOL PumpSwap pool", async () => {
  const originalFetch = globalThis.fetch;
  const baseMint = Keypair.generate().publicKey;
  const quoteMint = new PublicKey("So11111111111111111111111111111111111111112");
  const data = Buffer.alloc(107);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(data, 0);
  baseMint.toBuffer().copy(data, 43);
  quoteMint.toBuffer().copy(data, 75);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: {
              owner: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
              data: [data.toString("base64"), "base64"]
            }
          }
        };
      }
    };
  };

  try {
    const rpc = new SolanaRpc("https://rpc.invalid", 1_000);
    const first = await rpc.resolveSolPumpPool(Keypair.generate().publicKey.toBase58());
    const second = await rpc.resolveSolPumpPool(first.address);
    assert.equal(first.baseMint, baseMint.toBase58());
    assert.equal(first.quoteMint, quoteMint.toBase58());
    assert.equal(second, first);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
