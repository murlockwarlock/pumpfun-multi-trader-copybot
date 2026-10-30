import assert from "node:assert/strict";
import test from "node:test";
const WALLET_ONE = "11111111111111111111111111111111";
const WALLET_TWO = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
process.env.TARGET_WALLETS ||= `test:${WALLET_ONE}`;
const { parseLiveTraderWallets, parseTargetTraders } = await import("../src/config.js");

test("parses named target wallets and resolves the live allowlist", () => {
  const traders = parseTargetTraders(`alpha:${WALLET_ONE},beta:${WALLET_TWO}`);
  assert.deepEqual(traders, [
    { name: "alpha", wallet: WALLET_ONE },
    { name: "beta", wallet: WALLET_TWO }
  ]);
  assert.deepEqual(parseLiveTraderWallets("beta", traders), [WALLET_TWO]);
});

test("rejects duplicate target wallets and unknown live traders", () => {
  assert.throws(
    () => parseTargetTraders(`one:${WALLET_ONE},two:${WALLET_ONE}`),
    /Duplicate trader wallet/
  );
  const traders = parseTargetTraders(`alpha:${WALLET_ONE}`);
  assert.throws(() => parseLiveTraderWallets("unknown", traders), /unknown trader/);
});
