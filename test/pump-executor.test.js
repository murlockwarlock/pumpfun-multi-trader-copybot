import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import {
  Keypair,
  PublicKey
} from "@solana/web3.js";
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  minimumTargetTokenOutRaw,
  PumpExecutor,
  transactionMetadataCommitment
} from "../src/pump-executor.js";

test("derives an exact atomic min-out from the target price cap", () => {
  assert.equal(
    minimumTargetTokenOutRaw(5_000_000n, 6, 0.00000004, 2_500),
    100_000_000_000n
  );
});

test("downgrades unsupported processed transaction metadata requests to confirmed", async () => {
  const wallet = Keypair.generate();
  const executor = new PumpExecutor({
    rpcHttpUrl: "https://rpc.invalid", rpcWsUrl: "wss://rpc.invalid",
    rpcFallbackHttpUrl: "", liveSendRoute: "rpc", liveTipSol: 0,
    liveComputeUnitLimit: 400_000, livePriorityFeeSol: 0.0001,
    liveSimulate: false, liveConfirmationTimeoutMs: 1_000
  }, wallet, { enableFallback: false });
  const mint = Keypair.generate().publicKey;
  const commitments = [];
  executor.connection = {
    getParsedTransaction: async (_signature, options) => {
      commitments.push(options.commitment);
      if (options.commitment === "processed") {
        throw new Error("Method does not support commitment below confirmed");
      }
      return {
        meta: {
          preTokenBalances: [{ mint: mint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: "50" } }],
          postTokenBalances: [{ mint: mint.toBase58(), owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: "150" } }]
        }
      };
    }
  };
  assert.equal(transactionMetadataCommitment("processed"), "confirmed");
  assert.equal(await executor.transactionTokenDelta("copy", mint, wallet.publicKey, "processed"), 100n);
  assert.deepEqual(commitments, ["confirmed"]);
});

test("uses the execution fallback RPC after a primary rate-limit error", async () => {
  const executor = Object.create(PumpExecutor.prototype);
  executor.wallet = Keypair.generate();
  executor.connection = {
    getBalance: async () => { throw new Error("429 Too Many Requests"); }
  };
  executor.fallbackExecutor = {
    balanceLamports: async () => 123_456_789
  };

  assert.equal(await executor.balanceLamports(), 123_456_789);
});

test("FAST baseline evidence takes the conservative maximum across RPC commitments", async () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const executor = Object.create(PumpExecutor.prototype);
  executor.wallet = wallet;
  executor.rpcSource = "primary";
  executor.connection = {
    getAccountInfoAndContext: async (_account, commitment) => {
      const amount = commitment === "processed" ? 0n : 200n;
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({
        mint,
        owner: wallet.publicKey,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default
      }, data);
      return {
        context: { slot: commitment === "processed" ? 300 : commitment === "confirmed" ? 200 : 100 },
        value: { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 1 }
      };
    }
  };

  const evidence = await executor.tokenBalanceEvidence(mint, TOKEN_PROGRAM_ID);
  assert.equal(evidence.amount, 200n);
  assert.equal(evidence.proof.rooted, true);
  assert.deepEqual(
    evidence.proof.observations.map(observation => observation.commitment),
    ["processed", "confirmed", "finalized"]
  );
});

test("token balance context exposes the slot used for a SELL baseline", async () => {
  const wallet = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const executor = Object.create(PumpExecutor.prototype);
  executor.wallet = wallet;
  executor.rpcSource = "primary";
  executor.connection = {
    getAccountInfoAndContext: async () => {
      const data = Buffer.alloc(AccountLayout.span);
      AccountLayout.encode({
        mint,
        owner: wallet.publicKey,
        amount: 100n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default
      }, data);
      return {
        context: { slot: 300 },
        value: { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 1 }
      };
    }
  };
  const context = await executor.tokenBalanceContext(mint, TOKEN_PROGRAM_ID, "confirmed");
  assert.equal(context.amount, 100n);
  assert.equal(context.slot, 300);
  assert.equal(context.commitment, "confirmed");
  assert.equal(context.delegate, null);
});

function closeExecutor({ rawBalance = 0n, accountInfo = { lamports: 2_039_280 } } = {}) {
  const wallet = Keypair.generate();
  const config = {
    rpcHttpUrl: "https://rpc.invalid",
    rpcWsUrl: "wss://rpc.invalid",
    rpcFallbackHttpUrl: "",
    liveSendRoute: "rpc",
    liveTipSol: 0,
    liveComputeUnitLimit: 400_000,
    livePriorityFeeSol: 0.0001,
    liveSimulate: false,
    liveConfirmationTimeoutMs: 1_000
  };
  const executor = new PumpExecutor(config, wallet, { enableFallback: false });
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
  const lifecycle = [];
  const originalSubmit = executor.sender.submit;
  executor.sender.submit = async transaction => {
    lifecycle.push("submitted");
    return originalSubmit(transaction);
  };

  const result = await executor.closeEmptyTokenAccount(mint, TOKEN_PROGRAM_ID, {
    onPrepared: async (signature, details) => {
      lifecycle.push("prepared");
      assert.equal(bs58.decode(signature).length, 64);
      assert.equal(details.tokenAccount, expectedAta.toBase58());
    }
  });

  assert.equal(result.status, "closed");
  assert.equal(result.tokenAccount, expectedAta.toBase58());
  assert.equal(result.reclaimedLamports, 2_039_280);
  assert.equal(result.confirmation, "confirmed");
  assert.ok(submitted());
  assert.deepEqual(lifecycle, ["prepared", "submitted"]);
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
