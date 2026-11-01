import BN from "bn.js";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint
} from "@solana/spl-token";
import {
  canonicalPumpPoolPdaWithQuote,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  isBondingCurveMigrated,
  OnlinePumpSdk,
  PUMP_SDK
} from "@pump-fun/pump-sdk";
import {
  buyQuoteInput as quotePumpAmmBuy,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  supportsTradeV2
} from "@pump-fun/pump-swap-sdk";
import { priorityMicroLamports, TransactionSender } from "./transaction-sender.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JUPITER_SOL_MINT = NATIVE_MINT.toBase58();

function isTokenProgram(program) {
  return program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID);
}

function compactSimulationLogs(logs) {
  return (logs ?? []).slice(-5).join(" | ").slice(0, 1_000);
}

export class PumpExecutor {
  constructor(config, wallet) {
    this.config = config;
    this.wallet = wallet;
    this.connection = new Connection(config.rpcHttpUrl, {
      // Quote/build against the same processed bank that emitted the target
      // event. Safety balances and final reconciliation still use confirmed.
      commitment: "processed",
      wsEndpoint: config.rpcWsUrl,
      confirmTransactionInitialTimeout: config.liveConfirmationTimeoutMs
    });
    this.pump = new OnlinePumpSdk(this.connection);
    this.amm = new OnlinePumpAmmSdk(this.connection);
    this.sender = new TransactionSender(config, this.connection);
    this.marketCache = new Map();
    this.marketRequests = new Map();
    this.latestBlockhash = null;
    this.pumpParameters = null;
  }

  async initialize() {
    await Promise.all([
      this.sender.warmup(),
      this._refreshBlockhash(),
      this._refreshPumpParameters()
    ]);
    const timer = setInterval(
      () => this._refreshBlockhash().catch(() => {}),
      this.config.liveBlockhashRefreshMs
    );
    timer.unref();
    const parameterTimer = setInterval(
      () => this._refreshPumpParameters().catch(() => {}),
      60_000
    );
    parameterTimer.unref();
  }

  async _refreshPumpParameters() {
    const [global, feeConfig] = await Promise.all([
      this.pump.fetchGlobal(),
      this.pump.fetchFeeConfig()
    ]);
    this.pumpParameters = { global, feeConfig, fetchedAtMs: Date.now() };
    return this.pumpParameters;
  }

  async _refreshBlockhash() {
    const value = await this.connection.getLatestBlockhash("confirmed");
    this.latestBlockhash = { ...value, fetchedAtMs: Date.now() };
    return this.latestBlockhash;
  }

  async _recentBlockhash() {
    if (
      !this.latestBlockhash ||
      Date.now() - this.latestBlockhash.fetchedAtMs >
        Math.max(10_000, this.config.liveBlockhashRefreshMs * 3)
    ) {
      return this._refreshBlockhash();
    }
    return this.latestBlockhash;
  }

  async balanceLamports() {
    return this.connection.getBalance(this.wallet.publicKey, "confirmed");
  }

  async tokenBalance(mint, tokenProgram) {
    const account = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      true,
      tokenProgram
    );
    const info = await this.connection.getAccountInfo(account, "confirmed");
    if (!info) return 0n;
    return BigInt(unpackAccount(account, info, tokenProgram).amount.toString());
  }

  async #loadMarket(mint, venueHint = null) {
    const pool = canonicalPumpPoolPdaWithQuote(mint, NATIVE_MINT);
    const [mintInfo, poolInfo] = await Promise.all([
      this.connection.getAccountInfo(mint, "processed"),
      venueHint === "pump-curve"
        ? Promise.resolve(null)
        : this.connection.getAccountInfo(pool, "processed")
    ]);
    if (!mintInfo) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    if (!isTokenProgram(mintInfo.owner)) {
      throw new Error(`Unsupported mint owner: ${mintInfo.owner.toBase58()}`);
    }
    const mintAccount = unpackMint(mint, mintInfo, mintInfo.owner);
    return {
      mint,
      mintSupply: new BN(mintAccount.supply.toString()),
      tokenDecimals: mintAccount.decimals,
      tokenProgram: mintInfo.owner,
      pool,
      hasPool: poolInfo !== null
    };
  }

  async #market(mint, venueHint = null) {
    const key = `${mint.toBase58()}:${venueHint ?? "auto"}`;
    const cached = this.marketCache.get(key);
    if (cached && Date.now() - cached.atMs <= this.config.liveMarketCacheMs) {
      return cached.value;
    }
    if (this.marketRequests.has(key)) return this.marketRequests.get(key);
    const request = this.#loadMarket(mint, venueHint);
    this.marketRequests.set(key, request);
    try {
      const value = await request;
      this.marketCache.set(key, { atMs: Date.now(), value });
      return value;
    } finally {
      this.marketRequests.delete(key);
    }
  }

  prewarm(mintAddress, { venueHint = null } = {}) {
    return this.#market(new PublicKey(mintAddress), venueHint);
  }

  #jupiterHeaders(json = false) {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.config.jupiterApiKey
        ? { "x-api-key": this.config.jupiterApiKey }
        : {})
    };
  }

  async #prepareJupiter(side, mint, rawAmount, market) {
    const inputMint = side === "BUY" ? JUPITER_SOL_MINT : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : JUPITER_SOL_MINT;
    const url = new URL(`${this.config.jupiterApiUrl.replace(/\/$/, "")}/order`);
    url.search = new URLSearchParams({
      inputMint,
      outputMint,
      amount: rawAmount.toString(),
      taker: this.wallet.publicKey.toBase58(),
      slippageBps: String(this.config.liveSlippageBps)
    });
    const [response, beforeTokenBalance] = await Promise.all([
      fetch(url, {
        headers: this.#jupiterHeaders(),
        signal: AbortSignal.timeout(this.config.jupiterTimeoutMs)
      }),
      this.tokenBalance(mint, market.tokenProgram)
    ]);
    if (!response.ok) {
      throw new Error(`Jupiter order HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const order = await response.json();
    if (!order.transaction) {
      throw new Error(
        `Jupiter order unavailable (${order.router ?? "unknown"}/${order.errorCode ?? "no-code"}): ${
          order.errorMessage ?? "no transaction returned"
        }`
      );
    }
    if (order.inAmount && BigInt(order.inAmount) !== rawAmount) {
      throw new Error(`Jupiter changed input amount from ${rawAmount} to ${order.inAmount}`);
    }
    if (!order.requestId) throw new Error("Jupiter order has no requestId");
    const lastValidBlockHeight = Number(order.lastValidBlockHeight);
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
      throw new Error("Jupiter order has no valid lastValidBlockHeight");
    }

    const transaction = VersionedTransaction.deserialize(
      Buffer.from(order.transaction, "base64")
    );
    const requiredSigners = transaction.message.staticAccountKeys.slice(
      0,
      transaction.message.header.numRequiredSignatures
    );
    const walletSignerIndex = requiredSigners.findIndex(
      (key) => key.equals(this.wallet.publicKey)
    );
    if (walletSignerIndex !== 0) {
      throw new Error("Jupiter transaction does not use the live wallet as its primary signer");
    }
    transaction.sign([this.wallet]);
    const expectedSignature = bs58.encode(transaction.signatures[0]);
    return {
      transaction,
      expectedSignature,
      mint,
      tokenProgram: market.tokenProgram,
      venue: "jupiter-multi-hop",
      beforeTokenBalance,
      lastValidBlockHeight,
      jupiterRequestId: order.requestId,
      jupiterRouter: order.router ?? "unknown",
      jupiterExpectedOut: order.outAmount ?? null,
      expectedTokenOutRaw: side === "BUY" ? order.outAmount ?? null : null,
      tokenDecimals: market.tokenDecimals
    };
  }

  async #tradeInstructions(side, mint, rawAmount, market = null) {
    market ??= await this.#market(mint);
    const slippage = this.config.liveSlippageBps / 100;

    if (market.hasPool) {
      const state = await this.amm.swapSolanaState(market.pool, this.wallet.publicKey);
      if (!state.pool.quoteMint.equals(NATIVE_MINT)) {
        throw new Error("Only SOL-quoted PumpSwap pools are supported");
      }
      let instructions;
      let expectedTokenOutRaw = null;
      if (side === "BUY" && supportsTradeV2(state.pool)) {
        const budget = new BN(rawAmount.toString());
        const quote = quotePumpAmmBuy({
          quote: budget,
          slippage: 0,
          quoteTransferFee: state.quoteTransferFee,
          tradeV2: true,
          baseReserve: state.poolBaseAmount,
          quoteReserve: state.poolQuoteAmount,
          virtualQuoteReserves: state.pool.virtualQuoteReserves,
          baseMintAccount: state.baseMintAccount,
          baseMint: state.baseMint,
          coinCreator: state.pool.coinCreator,
          creator: state.pool.creator,
          feeConfig: state.feeConfig,
          globalConfig: state.globalConfig,
          quoteMint: state.pool.quoteMint,
          isMayhemMode: state.pool.isMayhemMode,
          creatorFeeBps: state.pool.creatorFeeBps
        });
        const minBaseOut = quote.base
          .mul(new BN(10_000 - this.config.liveSlippageBps))
          .div(new BN(10_000));
        if (minBaseOut.isZero()) throw new Error("PumpSwap quote returned zero tokens");
        instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(
          state,
          budget,
          minBaseOut
        );
        expectedTokenOutRaw = quote.base.toString();
      } else if (side === "BUY") {
        // Legacy v1 pools have no exact-quote instruction. Reduce the quoted
        // input so the SDK's slippage-expanded max remains within the hard cap.
        const cappedQuote = new BN(rawAmount.toString())
          .mul(new BN(10_000))
          .div(new BN(10_000 + this.config.liveSlippageBps));
        instructions = await PUMP_AMM_SDK.buyQuoteInput(state, cappedQuote, slippage);
      } else {
        instructions = await PUMP_AMM_SDK.sellBaseInput(
          state,
          new BN(rawAmount.toString()),
          slippage,
          { v2: true }
        );
      }
      return {
        instructions,
        tokenProgram: market.tokenProgram,
        venue: "pumpswap",
        expectedTokenOutRaw
      };
    }

    const parameters = this.pumpParameters ?? await this._refreshPumpParameters();
    const state = side === "BUY"
      ? await this.pump.fetchBuyState(mint, this.wallet.publicKey, market.tokenProgram)
      : await this.pump.fetchSellState(mint, this.wallet.publicKey, market.tokenProgram);
    const { global, feeConfig } = parameters;
    if (!state.quoteMint.equals(NATIVE_MINT)) {
      throw new Error("Only SOL-quoted Pump bonding curves are supported");
    }
    if (isBondingCurveMigrated(state.bondingCurve)) {
      throw new Error("Bonding curve migrated but canonical PumpSwap pool is unavailable");
    }
    if (state.bondingCurve.isCashbackCoin) {
      throw new Error("Legacy cashback bonding curves are not supported for new live entries");
    }

    if (side === "BUY") {
      const quoteAmount = new BN(rawAmount.toString());
      const tokenAmount = getBuyV3TokenAmountFromQuoteAmount({
        global,
        feeConfig,
        mintSupply: market.mintSupply,
        bondingCurve: state.bondingCurve,
        amount: quoteAmount,
        curveBaseTokenBalance: state.curveBaseTokenBalance,
        quoteTransferFee: state.quoteTransferFee
      });
      if (tokenAmount.isZero()) throw new Error("Pump quote returned zero tokens");
      const instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
        bondingCurve: state.bondingCurve,
        associatedUserAccountInfo: state.associatedUserAccountInfo,
        mint,
        user: this.wallet.publicKey,
        amount: tokenAmount,
        quoteAmount,
        slippage,
        tokenProgram: market.tokenProgram,
        quoteTokenProgram: state.quoteTokenProgram,
        partialFill: true
      });
      return {
        instructions,
        tokenProgram: market.tokenProgram,
        venue: "pump-curve",
        expectedTokenOutRaw: tokenAmount.toString()
      };
    }

    const tokenAmount = new BN(rawAmount.toString());
    const quoteAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: market.mintSupply,
      bondingCurve: state.bondingCurve,
      amount: tokenAmount,
      quoteTransferFee: state.quoteTransferFee
    });
    if (quoteAmount.isZero()) throw new Error("Pump sell quote returned zero SOL");
    const instructions = await PUMP_SDK.sellV3Instructions({
      bondingCurve: state.bondingCurve,
      mint,
      user: this.wallet.publicKey,
      amount: tokenAmount,
      quoteAmount,
      slippage,
      tokenProgram: market.tokenProgram,
      quoteTokenProgram: state.quoteTokenProgram
    });
    return { instructions, tokenProgram: market.tokenProgram, venue: "pump-curve" };
  }

  async prepare(side, mintAddress, rawAmount, {
    executionRoute = null,
    venueHint = null,
    skipSimulation = false,
    skipBeforeTokenBalance = false
  } = {}) {
    const mint = new PublicKey(mintAddress);
    const market = await this.#market(mint, venueHint);
    if (executionRoute === "jupiter") {
      return this.#prepareJupiter(side, mint, BigInt(rawAmount), market);
    }
    const [trade, beforeTokenBalance, tip, latest] = await Promise.all([
      this.#tradeInstructions(side, mint, BigInt(rawAmount), market),
      skipBeforeTokenBalance
        ? Promise.resolve(0n)
        : this.tokenBalance(mint, market.tokenProgram),
      this.sender.tipInstruction(this.wallet.publicKey),
      this._recentBlockhash()
    ]);
    const priorityPrice = priorityMicroLamports(
      this.config.livePriorityFeeSol,
      this.config.liveComputeUnitLimit
    );
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.liveComputeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityPrice }),
      ...trade.instructions,
      ...(tip ? [tip] : [])
    ];
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: latest.blockhash,
        instructions
      }).compileToV0Message()
    );
    transaction.sign([this.wallet]);
    const expectedSignature = bs58.encode(transaction.signatures[0]);

    if (this.config.liveSimulate && !skipSimulation) {
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: "processed",
        sigVerify: true
      });
      if (simulation.value.err) {
        throw new Error(
          `Simulation failed: ${JSON.stringify(simulation.value.err)} ${compactSimulationLogs(
            simulation.value.logs
          )}`
        );
      }
    }

    return {
      transaction,
      expectedSignature,
      mint,
      tokenProgram: trade.tokenProgram,
      venue: trade.venue,
      beforeTokenBalance,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      expectedTokenOutRaw: trade.expectedTokenOutRaw ?? null,
      tokenDecimals: market.tokenDecimals
    };
  }

  async submit(prepared) {
    if (prepared.jupiterRequestId) {
      const response = await fetch(
        `${this.config.jupiterApiUrl.replace(/\/$/, "")}/execute`,
        {
          method: "POST",
          headers: this.#jupiterHeaders(true),
          signal: AbortSignal.timeout(this.config.jupiterTimeoutMs),
          body: JSON.stringify({
            signedTransaction: Buffer.from(prepared.transaction.serialize()).toString("base64"),
            requestId: prepared.jupiterRequestId,
            lastValidBlockHeight: prepared.lastValidBlockHeight
          })
        }
      );
      if (!response.ok) {
        throw new Error(
          `Jupiter execute HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`
        );
      }
      const result = await response.json();
      if (result.status !== "Success" || !result.signature) {
        throw new Error(
          `Jupiter execute failed (${result.code ?? "no-code"}): ${result.error ?? result.status ?? "unknown"}`
        );
      }
      if (result.signature !== prepared.expectedSignature) {
        throw new Error("Jupiter returned a signature that does not match the signed transaction");
      }
      return result.signature;
    }
    return this.sender.submit(prepared.transaction).then((signature) => {
      if (signature !== prepared.expectedSignature) {
        throw new Error("Sender returned a signature that does not match the signed transaction");
      }
      return signature;
    });
  }

  async closeEmptyTokenAccount(mintAddress, tokenProgramAddress) {
    const mint = mintAddress instanceof PublicKey ? mintAddress : new PublicKey(mintAddress);
    const tokenProgram = tokenProgramAddress instanceof PublicKey
      ? tokenProgramAddress
      : new PublicKey(tokenProgramAddress);
    if (!isTokenProgram(tokenProgram)) {
      throw new Error(`Unsupported token program for account close: ${tokenProgram.toBase58()}`);
    }

    const tokenAccount = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      true,
      tokenProgram
    );
    const accountInfo = await this.connection.getAccountInfo(tokenAccount, "confirmed");
    if (!accountInfo) {
      return { status: "already_closed", tokenAccount: tokenAccount.toBase58() };
    }

    const rawBalance = await this.tokenBalance(mint, tokenProgram);
    if (rawBalance !== 0n) {
      return {
        status: "not_empty",
        tokenAccount: tokenAccount.toBase58(),
        rawBalance: rawBalance.toString()
      };
    }

    const closeComputeUnitLimit = Math.min(this.config.liveComputeUnitLimit, 100_000);
    const priorityPrice = priorityMicroLamports(
      this.config.livePriorityFeeSol,
      closeComputeUnitLimit
    );
    const tip = await this.sender.tipInstruction(this.wallet.publicKey);
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: closeComputeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityPrice }),
      createCloseAccountInstruction(
        tokenAccount,
        this.wallet.publicKey,
        this.wallet.publicKey,
        [],
        tokenProgram
      ),
      ...(tip ? [tip] : [])
    ];
    const latest = await this._recentBlockhash();
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.wallet.publicKey,
        recentBlockhash: latest.blockhash,
        instructions
      }).compileToV0Message()
    );
    transaction.sign([this.wallet]);
    const prepared = {
      transaction,
      expectedSignature: bs58.encode(transaction.signatures[0]),
      lastValidBlockHeight: latest.lastValidBlockHeight
    };

    if (this.config.liveSimulate) {
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: "processed",
        sigVerify: true
      });
      if (simulation.value.err) {
        throw new Error(
          `Token-account close simulation failed: ${JSON.stringify(
            simulation.value.err
          )} ${compactSimulationLogs(simulation.value.logs)}`
        );
      }
    }

    const signature = await this.submit(prepared);
    let confirmation;
    try {
      confirmation = await this.confirm(signature, prepared);
    } catch (error) {
      const remaining = await this.connection.getAccountInfo(tokenAccount, "confirmed");
      if (remaining) throw error;
      confirmation = "account_closed_after_confirmation_error";
    }
    return {
      status: "closed",
      tokenAccount: tokenAccount.toBase58(),
      reclaimedLamports: accountInfo.lamports,
      signature,
      confirmation,
      ...(await this.transactionWalletDelta(signature).catch(() => ({})))
    };
  }

  async transactionWalletDelta(signature) {
    let transaction = null;
    for (let attempt = 0; attempt < 8 && !transaction; attempt += 1) {
      transaction = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (!transaction && attempt < 7) await sleep(250 * (attempt + 1));
    }
    if (!transaction?.meta) throw new Error(`Confirmed transaction unavailable: ${signature}`);
    const message = transaction.transaction.message;
    const accountKeys = message.staticAccountKeys ?? message.accountKeys ?? [];
    const walletIndex = accountKeys.findIndex((key) => {
      const value = key?.pubkey ?? key;
      return value?.equals
        ? value.equals(this.wallet.publicKey)
        : String(value) === this.wallet.publicKey.toBase58();
    });
    if (walletIndex < 0) throw new Error("Live wallet not found in confirmed transaction");
    const pre = BigInt(transaction.meta.preBalances?.[walletIndex] ?? 0);
    const post = BigInt(transaction.meta.postBalances?.[walletIndex] ?? 0);
    return {
      walletDeltaLamports: (post - pre).toString(),
      feeLamports: String(transaction.meta.fee ?? 0)
    };
  }

  async confirm(signature, prepared) {
    const deadline = Date.now() + this.config.liveConfirmationTimeoutMs;
    while (Date.now() < deadline) {
      const response = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true
      });
      const status = response.value[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return status.confirmationStatus;
      }
      const height = await this.connection.getBlockHeight("confirmed");
      if (height > prepared.lastValidBlockHeight) {
        throw new Error("Transaction blockhash expired before confirmation");
      }
      await sleep(400);
    }
    throw new Error(`Confirmation timed out after ${this.config.liveConfirmationTimeoutMs}ms`);
  }

  async signatureStatus(signature) {
    const response = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true
    });
    return response.value[0];
  }

  currentBlockHeight() {
    return this.connection.getBlockHeight("confirmed");
  }
}
