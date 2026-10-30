import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { PumpExecutor } from "../src/pump-executor.js";

function closeExecutor({ rawBalance = 0n, accountInfo = { lamports: 2_039_280 } } = {}) {
  const wallet = Keypair.generate();
  const executor = Object.create(PumpExecutor.prototype);
  executor.config = {
    liveComputeUnitLimit: 400_000,
    livePriorityFeeSol: 0.0001,
    liveSimulate: false,
    liveConfirmationTimeoutMs: 1_000
  };
  executor.wallet = wallet;
  executor.tokenBalance = async () => rawBalance;
  executor.connection = {
    getAccountInfo: async () => accountInfo,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123
    }),
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: "confirmed" }]
    }),
    getBlockHeight: async () => 100
  };
  let submitted;
  executor.sender = {
    tipInstruction: async () => null,
    submit: async (transaction) => {
      submitted = transaction;
      return bs58.encode(transaction.signatures[0]);
    }
  };
  return { executor, wallet, submitted: () => submitted };
}

test("closes an empty associated token account and reports reclaimed rent", async () => {
  const { executor, wallet, submitted } = closeExecutor();
  const mint = Keypair.generate().publicKey;
  const expectedAta = getAssociatedTokenAddressSync(
    mint,
    wallet.publicKey,
    true,
    TOKEN_PROGRAM_ID
  );

  const result = await executor.closeEmptyTokenAccount(mint, TOKEN_PROGRAM_ID);

  assert.equal(result.status, "closed");
  assert.equal(result.tokenAccount, expectedAta.toBase58());
  assert.equal(result.reclaimedLamports, 2_039_280);
  assert.equal(result.confirmation, "confirmed");
  assert.ok(submitted());
  const keys = submitted().message.staticAccountKeys.map((key) => key.toBase58());
  assert.ok(keys.includes(expectedAta.toBase58()));
  assert.ok(keys.includes(TOKEN_PROGRAM_ID.toBase58()));
});

test("does not attempt to close a token account that still has a balance", async () => {
  const { executor, submitted } = closeExecutor({ rawBalance: 7n });
  const result = await executor.closeEmptyTokenAccount(
    new PublicKey(Keypair.generate().publicKey),
    TOKEN_PROGRAM_ID
  );

  assert.equal(result.status, "not_empty");
  assert.equal(result.rawBalance, "7");
  assert.equal(submitted(), undefined);
});
