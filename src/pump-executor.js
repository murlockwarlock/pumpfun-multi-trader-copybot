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
  ExtensionType,
  getAccountLen,
  getAccountTypeOfMintType,
  getExtensionTypes,
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
  sellBaseInput as quotePumpAmmSell,
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  supportsTradeV2
} from "@pump-fun/pump-swap-sdk";
import { priorityMicroLamports, TransactionSender } from "./transaction-sender.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JUPITER_SOL_MINT = NATIVE_MINT.toBase58();

export function transactionMetadataCommitment(commitment) {
  // Transaction history RPC is confirmed/finalized only; processed metadata
  // must come from an explicit streaming provider, never this JSON-RPC call.
  return commitment === "finalized" ? "finalized" : "confirmed";
}

function isTokenProgram(program) {
  return program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID);
}

function compactSimulationLogs(logs) {
  return (logs ?? []).slice(-5).join(" | ").slice(0, 1_000);
}

function isRpcTransportError(error) {
  return /(?:429|too many requests|fetch failed|timed? ?out|timeout|econn|enotfound|socket|network|http 5(?:02|03|04)|failed to get|confirmed transaction unavailable)/i
    .test(error?.message ?? String(error));
}

function decimalFraction(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const [coefficient, exponentText = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent)) return null;
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;
  const scale = fraction.length - exponent;
  return scale >= 0
    ? { numerator: BigInt(digits), denominator: 10n ** BigInt(scale) }
    : { numerator: BigInt(digits) * 10n ** BigInt(-scale), denominator: 1n };
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

export function minimumTargetTokenOutRaw(
  rawQuoteLamports,
  tokenDecimals,
  targetAveragePriceSol,
  maxEntryDriftBps
) {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 18) return null;
  if (!Number.isInteger(maxEntryDriftBps) || maxEntryDriftBps < 0) return null;
  const price = decimalFraction(targetAveragePriceSol);
  if (!price?.numerator) return null;
  const numerator = BigInt(rawQuoteLamports) * price.denominator * 10_000n *
    10n ** BigInt(tokenDecimals);
  const denominator = 1_000_000_000n * price.numerator *
    BigInt(10_000 + maxEntryDriftBps);
  return ceilDiv(numerator, denominator);
}

function bnMax(left, right) {
  return left.gte(right) ? left : right;
}

export class PumpExecutor {
  constructor(config, wallet, { enableFallback = true } = {}) {
    this.config = config;
    this.wallet = wallet;
    this.connection = new Connection(config.rpcHttpUrl, {
      ...(config.shadowReadOnlyFetch ? { disableRetryOnRateLimit: true } : {}),
      // Quote/build against the same processed bank that emitted the target
      // event. Safety balances and final reconciliation still use confirmed.
      commitment: "processed",
      wsEndpoint: config.rpcWsUrl,
      fetch: (url, options = {}) => {
        const deadline = AbortSignal.timeout(config.rpcTimeoutMs ?? 10000);
        return (config.shadowReadOnlyFetch ?? fetch)(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline });
      },
      confirmTransactionInitialTimeout: config.liveConfirmationTimeoutMs
    });
    this.pump = new OnlinePumpSdk(this.connection);
    this.amm = new OnlinePumpAmmSdk(this.connection);
    this.sender = new TransactionSender(config, this.connection);
    this.marketCache = new Map();
    this.marketRequests = new Map();
    this.latestBlockhash = null;
    this.pumpParameters = null;
    this.rpcSource = enableFallback ? "primary" : "fallback";
    this.fallbackExecutor = enableFallback && config.rpcFallbackHttpUrl
      ? new PumpExecutor({
          ...config,
          rpcHttpUrl: config.rpcFallbackHttpUrl,
          rpcWsUrl: config.rpcFallbackWsUrl || config.rpcWsUrl,
          rpcFallbackHttpUrl: "",
          rpcFallbackWsUrl: "",
          heliusApiKey: ""
        }, wallet, { enableFallback: false })
      : null;
  }

  async initialize() {
    const primary = this.#initializeLocal();
    if (!this.fallbackExecutor) return primary;
    const [primaryResult, fallbackResult] = await Promise.allSettled([
      primary,
      this.fallbackExecutor.initialize()
    ]);
    if (primaryResult.status === "rejected" && fallbackResult.status === "rejected") {
      throw new Error(
        `Both execution RPCs failed initialization: ${primaryResult.reason?.message ?? primaryResult.reason} | ` +
        `${fallbackResult.reason?.message ?? fallbackResult.reason}`
      );
    }
  }

  async #initializeLocal() {
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
    try {
      return await this.connection.getBalance(this.wallet.publicKey, "confirmed");
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.balanceLamports();
    }
  }

  async tokenBalance(mint, tokenProgram, commitment = "confirmed") {
    const account = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      true,
      tokenProgram
    );
    let info;
    try {
      info = await this.connection.getAccountInfo(account, commitment);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.tokenBalance(mint, tokenProgram, commitment);
    }
    if (!info) return 0n;
    return BigInt(unpackAccount(account, info, tokenProgram).amount.toString());
  }

  async tokenBalanceContext(mint, tokenProgram, commitment = "confirmed") {
    const account = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      true,
      tokenProgram
    );
    let result;
    try {
      if (typeof this.connection.getAccountInfoAndContext !== "function") {
        throw new Error("token balance RPC does not provide context slots");
      }
      result = await this.connection.getAccountInfoAndContext(account, commitment);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      if (typeof this.fallbackExecutor.tokenBalanceContext !== "function") {
        throw new Error("fallback token balance RPC does not provide context slots");
      }
      return this.fallbackExecutor.tokenBalanceContext(mint, tokenProgram, commitment);
    }
    const slot = Number(result?.context?.slot);
    if (!Number.isSafeInteger(slot) || slot <= 0) {
      throw new Error(`token balance RPC returned no valid ${commitment} context slot`);
    }
    const accountState = result.value ? unpackAccount(account, result.value, tokenProgram) : null;
    return {
      amount: accountState ? BigInt(accountState.amount.toString()) : 0n,
      slot,
      commitment,
      delegate: accountState?.delegate?.toBase58() ?? null,
      rpcSource: this.rpcSource
    };
  }

  // A single processed account read is not a provenance proof: that bank can
  // be rolled back.  FAST BUY captures the same ATA at processed, confirmed,
  // and finalized commitments in parallel, keeps the highest observed amount
  // (the conservative floor), and records the RPC context slots. A rooted
  // finalized observation is necessary but not sufficient: LiveEngine also
  // requires a dedicated-wallet flow-ledger proof before FAST can submit.
  async tokenBalanceEvidence(mint, tokenProgram) {
    const account = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      true,
      tokenProgram
    );
    const commitments = ["processed", "confirmed", "finalized"];
    try {
      if (typeof this.connection.getAccountInfoAndContext !== "function") {
        throw new Error("token balance RPC does not provide context slots");
      }
      const observations = await Promise.all(commitments.map(async commitment => {
        const result = await this.connection.getAccountInfoAndContext(account, commitment);
        const slot = Number(result?.context?.slot);
        if (!Number.isSafeInteger(slot) || slot <= 0) {
          throw new Error(`token balance RPC returned no valid ${commitment} context slot`);
        }
        const accountState = result.value ? unpackAccount(account, result.value, tokenProgram) : null;
        const amount = accountState ? BigInt(accountState.amount.toString()) : 0n;
        return {
          commitment,
          slot,
          amount: amount.toString(),
          delegate: accountState?.delegate?.toBase58() ?? null
        };
      }));
      const amount = observations.reduce(
        (highest, observation) => BigInt(observation.amount) > highest
          ? BigInt(observation.amount) : highest,
        0n
      );
      return {
        amount,
        proof: {
          kind: "multi_commitment_account_context",
          rooted: true,
          noDelegate: observations.every(observation => observation.delegate === null),
          observations,
          rpcSource: this.rpcSource
        }
      };
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.tokenBalanceEvidence(mint, tokenProgram);
    }
  }

  async waitForTokenBalanceChange(
    mint,
    tokenProgram,
    before,
    side,
    { commitment = "processed", timeoutMs = 3_000, pollMs = 100 } = {}
  ) {
    const deadline = Date.now() + timeoutMs;
    let last = BigInt(before);
    while (Date.now() <= deadline) {
      last = await this.tokenBalance(mint, tokenProgram, commitment);
      if (side === "BUY" ? last > before : last < before) return last;
      await sleep(pollMs);
    }
    throw new Error(
      `${commitment} token balance did not ${side === "BUY" ? "increase" : "decrease"} ` +
      `within ${timeoutMs}ms (before=${before}, last=${last})`
    );
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
      mintAccount,
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
    return this.#market(new PublicKey(mintAddress), venueHint).catch((error) => {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.prewarm(mintAddress, { venueHint });
    });
  }

  // Read-only shadow capability. Never calls prepare(), initialize(), sender,
  // blockhash, simulation or signing. A public key alone is sufficient.
  async quoteShadow(side, mintAddress, rawAmount, options = {}) {
    if (!["BUY", "SELL"].includes(side) || BigInt(rawAmount) <= 0n) throw Error("Invalid shadow quote");
    const startedAtMs = Date.now();
    const mint = new PublicKey(mintAddress);
    // Do not cache pre-migration classification for a later exit.
    const market = await this.#loadMarket(mint, side === "BUY" ? options.venueHint : null);
    if (!this.pumpParameters || Date.now() - this.pumpParameters.fetchedAtMs > 60000) await this._refreshPumpParameters();
    if (side === "BUY") {
      const minimum = minimumTargetTokenOutRaw(rawAmount, market.tokenDecimals,
        options.targetAveragePriceSol, options.maxEntryDriftBps);
      if (minimum === null) throw Error("Shadow entry requires target-relative price protection");
      const built = await this.#tradeInstructions(side, mint, BigInt(rawAmount), market, minimum, true);
      const size = market.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
        ? getAccountLen([...getExtensionTypes(market.mintAccount.tlvData).map(getAccountTypeOfMintType)
          .filter(type => type !== ExtensionType.Uninitialized), ExtensionType.ImmutableOwner]) : 165;
      this.shadowRent ??= new Map();
      if (!this.shadowRent.has(size)) this.shadowRent.set(size, await this.connection.getMinimumBalanceForRentExemption(size));
      return { expectedTokenOutRaw: built.expectedTokenOutRaw, tokenDecimals: market.tokenDecimals,
        hardMinimumTokenOutRaw: built.hardMinimumTokenOutRaw, venue: built.venue,
        startedAtMs, stateReceivedAtMs: Date.now(), unsignedInstructionCount: built.instructions.length,
        tradingFees: "included_in_SDK_quote", ...built.shadowQuoteDetails,
        slippageBps: this.config.liveSlippageBps, rentSol: this.shadowRent.get(size) / 1e9,
        rentAssumption: "new_associated_token_account", tokenAccountSize: size };
    }
    let amount, reserves, gross, spot;
    if (market.hasPool) {
      const s = await this.amm.swapSolanaState(market.pool, this.wallet.publicKey);
      if (!s.pool.quoteMint.equals(NATIVE_MINT)) throw Error("Only SOL-quoted PumpSwap pools are supported");
      const q = quotePumpAmmSell({ base: new BN(rawAmount), slippage: 0,
        baseReserve: s.poolBaseAmount, quoteReserve: s.poolQuoteAmount,
        virtualQuoteReserves: s.pool.virtualQuoteReserves,
        feeBucketsTotal: s.pool.protocolFees.add(s.pool.creatorFees),
        globalConfig: s.globalConfig, baseMintAccount: s.baseMintAccount, baseMint: s.baseMint,
        coinCreator: s.pool.coinCreator, creator: s.pool.creator, feeConfig: s.feeConfig,
        quoteMint: s.pool.quoteMint, isMayhemMode: s.pool.isMayhemMode,
        creatorFeeBps: s.pool.creatorFeeBps, quoteTransferFee: s.quoteTransferFee });
      amount = q.uiQuote;
      gross = q.internalQuoteAmountOut;
      spot = Number(s.poolQuoteAmount.add(s.pool.virtualQuoteReserves ?? new BN(0)).toString()) / Number(s.poolBaseAmount.toString());
      reserves = { baseRaw: s.poolBaseAmount.toString(), quoteRaw: s.poolQuoteAmount.toString() };
    } else {
      // fetchSellState requires a real wallet ATA. A hypothetical shadow holding
      // has none: fetchBuyState reads the same curve without inventing an ATA.
      const s = await this.pump.fetchBuyState(mint, this.wallet.publicKey, market.tokenProgram);
      if (!s.quoteMint.equals(NATIVE_MINT) || isBondingCurveMigrated(s.bondingCurve)) throw Error("Curve unavailable or migrated");
      amount = getSellSolAmountFromTokenAmount({ ...this.pumpParameters,
        mintSupply: market.mintSupply, bondingCurve: s.bondingCurve,
        amount: new BN(rawAmount), quoteTransferFee: s.quoteTransferFee });
      gross = new BN(rawAmount).mul(s.bondingCurve.virtualQuoteReserves)
        .div(s.bondingCurve.virtualTokenReserves.add(new BN(rawAmount)));
      spot = Number(s.bondingCurve.virtualQuoteReserves.toString()) / Number(s.bondingCurve.virtualTokenReserves.toString());
      if (amount.gt(s.bondingCurve.realQuoteReserves)) throw Error("Insufficient real SOL reserves");
      reserves = { virtualSolRaw: s.bondingCurve.virtualQuoteReserves.toString(),
        virtualTokenRaw: s.bondingCurve.virtualTokenReserves.toString(), realSolRaw: s.bondingCurve.realQuoteReserves.toString() };
    }
    if (amount.lte(new BN(0))) throw Error("Zero sell quote");
    return { expectedSolOutRaw: amount.toString(), venue: market.hasPool ? "pumpswap" : "pump-curve",
      startedAtMs, stateReceivedAtMs: Date.now(), reserves, tradingFees: "included_in_SDK_quote",
      tradingFeeRaw: gross.sub(amount).toString(),
      priceImpactBps: (1 - Number(gross.toString()) / Number(rawAmount) / spot) * 10000,
      slippageBps: this.config.liveSlippageBps };
  }

  #jupiterHeaders(json = false) {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.config.jupiterApiKey
        ? { "x-api-key": this.config.jupiterApiKey }
        : {})
    };
  }

  async #prepareJupiter(
    side,
    mint,
    rawAmount,
    market,
    balanceCommitment = "confirmed",
    hardMinimumTokenOut = null,
    requireBaselineContext = false,
    requireBalanceContext = false,
    timing = null
  ) {
    const prepareStartedAt = performance.now();
    const inputMint = side === "BUY" ? JUPITER_SOL_MINT : mint.toBase58();
    const outputMint = side === "BUY" ? mint.toBase58() : JUPITER_SOL_MINT;
    const url = new URL(`${this.config.jupiterApiUrl.replace(/\/$/, "")}/order`);
    url.search = new URLSearchParams({
      inputMint,
      outputMint,
      amount: rawAmount.toString(),
      taker: this.wallet.publicKey.toBase58(),
      slippageBps: String(side === "BUY" && hardMinimumTokenOut !== null
        ? 0
        : this.config.liveSlippageBps)
    });
    const baselinePromise = requireBaselineContext
      ? this.tokenBalanceEvidence(mint, market.tokenProgram)
      : requireBalanceContext
        ? this.tokenBalanceContext(mint, market.tokenProgram, balanceCommitment)
          .then(context => ({ amount: context.amount, proof: null, context }))
      : this.tokenBalance(mint, market.tokenProgram, balanceCommitment)
        .then(amount => ({ amount, proof: null }));
    const quoteStartedAt = performance.now();
    const quotePromise = fetch(url, {
        headers: this.#jupiterHeaders(),
        signal: AbortSignal.timeout(this.config.jupiterTimeoutMs)
      }).then(response => {
        if (timing) timing.quoteMs = performance.now() - quoteStartedAt;
        return response;
      });
    const balanceStartedAt = performance.now();
    const measuredBaselinePromise = baselinePromise.then(value => {
      if (timing) timing.balanceMs = performance.now() - balanceStartedAt;
      return value;
    });
    const [response, baseline] = await Promise.all([quotePromise, measuredBaselinePromise]);
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
    if (
      side === "BUY" && hardMinimumTokenOut !== null &&
      (!/^\d+$/.test(order.outAmount ?? "") || BigInt(order.outAmount) < hardMinimumTokenOut)
    ) {
      throw new Error("Jupiter quote exceeds the target-relative entry price limit");
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
    const assembleStartedAt = performance.now();
    transaction.sign([this.wallet]);
    if (timing) {
      timing.assembleSignMs = performance.now() - assembleStartedAt;
      timing.blockhashMs = 0;
      timing.readyMs = performance.now() - prepareStartedAt;
      timing.prepareMs = timing.readyMs;
    }
    const expectedSignature = bs58.encode(transaction.signatures[0]);
    return {
      transaction,
      expectedSignature,
      mint,
      tokenProgram: market.tokenProgram,
      venue: "jupiter-multi-hop",
      beforeTokenBalance: baseline.amount,
      beforeTokenBalanceEvidence: baseline.proof,
      beforeTokenBalanceContextSlot: baseline.context?.slot ?? null,
      beforeTokenBalanceContextDelegate: baseline.context?.delegate ?? null,
      lastValidBlockHeight,
      jupiterRequestId: order.requestId,
      jupiterRouter: order.router ?? "unknown",
      jupiterExpectedOut: order.outAmount ?? null,
      expectedTokenOutRaw: side === "BUY" ? order.outAmount ?? null : null,
      hardMinimumTokenOutRaw: hardMinimumTokenOut?.toString() ?? null,
      beforeTokenBalanceKnown: !requireBaselineContext || baseline.proof?.rooted === true,
      tokenDecimals: market.tokenDecimals,
      rpcSource: this.rpcSource
    };
  }

  async #tradeInstructions(side, mint, rawAmount, market = null, hardMinimumTokenOut = null, shadowDetails = false) {
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
        const slippageMinimum = quote.base
          .mul(new BN(10_000 - this.config.liveSlippageBps))
          .div(new BN(10_000));
        const hardMinimum = hardMinimumTokenOut === null
          ? new BN(0)
          : new BN(hardMinimumTokenOut.toString());
        if (hardMinimum.gt(quote.base)) {
          throw new Error("PumpSwap quote exceeds the target-relative entry price limit");
        }
        const minBaseOut = bnMax(slippageMinimum, hardMinimum);
        if (minBaseOut.isZero()) throw new Error("PumpSwap quote returned zero tokens");
        instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(
          state,
          budget,
          minBaseOut
        );
        expectedTokenOutRaw = quote.base.toString();
      } else if (side === "BUY") {
        if (hardMinimumTokenOut !== null) {
          throw new Error(
            "Target-relative entry protection is unavailable for legacy PumpSwap v1"
          );
        }
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
        expectedTokenOutRaw,
        hardMinimumTokenOutRaw: hardMinimumTokenOut?.toString() ?? null
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
      const hardMinimum = hardMinimumTokenOut === null
        ? new BN(0)
        : new BN(hardMinimumTokenOut.toString());
      if (hardMinimum.gt(tokenAmount)) {
        throw new Error("Pump quote exceeds the target-relative entry price limit");
      }
      const instructionAmount = hardMinimum.isZero()
        ? tokenAmount
        : bnMax(
            tokenAmount,
            hardMinimum
              .mul(new BN(10_000))
              .add(new BN(10_000 - this.config.liveSlippageBps - 1))
              .div(new BN(10_000 - this.config.liveSlippageBps))
          );
      const instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
        bondingCurve: state.bondingCurve,
        associatedUserAccountInfo: state.associatedUserAccountInfo,
        mint,
        user: this.wallet.publicKey,
        amount: instructionAmount,
        quoteAmount,
        slippage,
        tokenProgram: market.tokenProgram,
        quoteTokenProgram: state.quoteTokenProgram,
        partialFill: hardMinimum.isZero()
      });
      return {
        instructions,
        tokenProgram: market.tokenProgram,
        venue: "pump-curve",
        expectedTokenOutRaw: tokenAmount.toString(),
        ...(shadowDetails ? { shadowQuoteDetails: {
          reserves: { virtualSolRaw: state.bondingCurve.virtualQuoteReserves.toString(),
            virtualTokenRaw: state.bondingCurve.virtualTokenReserves.toString(),
            realSolRaw: state.bondingCurve.realQuoteReserves.toString(),
            realTokenRaw: state.bondingCurve.realTokenReserves.toString() },
          // Constant-product curve price impact excludes fees. Crossing the
          // remaining curve supply cannot be represented by this expression.
          priceImpactBps: tokenAmount.lt(state.bondingCurve.realTokenReserves)
            ? Number(tokenAmount.toString()) / Number(state.bondingCurve.virtualTokenReserves.sub(tokenAmount).toString()) * 10000 : null,
          tradingFeeRaw: null,
          tradingFeeDetail: "SDK includes dynamic fees; exact BUY debit split not exposed"
        } } : {}),
        hardMinimumTokenOutRaw: hardMinimumTokenOut?.toString() ?? null
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

  async #prepareOnce(side, mintAddress, rawAmount, {
    executionRoute = null,
    venueHint = null,
    skipSimulation = false,
    skipBeforeTokenBalance = false,
    balanceCommitment = "confirmed",
    targetAveragePriceSol = null,
    maxEntryDriftBps = null,
    requireBaselineContext = false,
    requireBalanceContext = false,
    timing = null
  } = {}) {
    const mint = new PublicKey(mintAddress);
    const prepareStartedAt = performance.now();
    const marketStartedAt = performance.now();
    const market = await this.#market(mint, venueHint);
    if (timing) timing.marketRouteMs = performance.now() - marketStartedAt;
    const hardMinimumTokenOut = side === "BUY"
      ? minimumTargetTokenOutRaw(
          rawAmount,
          market.tokenDecimals,
          targetAveragePriceSol,
          maxEntryDriftBps
        )
      : null;
    if (executionRoute === "jupiter") {
      return this.#prepareJupiter(
        side,
        mint,
        BigInt(rawAmount),
        market,
        balanceCommitment,
        hardMinimumTokenOut,
        requireBaselineContext,
        requireBalanceContext,
        timing
      );
    }
    const baselinePromise = skipBeforeTokenBalance
      ? Promise.resolve({ amount: 0n, proof: null })
      : requireBaselineContext
        ? this.tokenBalanceEvidence(mint, market.tokenProgram)
        : requireBalanceContext
          ? this.tokenBalanceContext(mint, market.tokenProgram, balanceCommitment)
            .then(context => ({ amount: context.amount, proof: null, context }))
        : this.tokenBalance(mint, market.tokenProgram, balanceCommitment)
          .then(amount => ({ amount, proof: null }));
    const quoteStartedAt = performance.now();
    const tradePromise = this.#tradeInstructions(
        side,
        mint,
        BigInt(rawAmount),
        market,
        hardMinimumTokenOut
      ).then(value => {
        if (timing) timing.quoteMs = performance.now() - quoteStartedAt;
        return value;
      });
    const balanceStartedAt = performance.now();
    const measuredBaselinePromise = baselinePromise.then(value => {
      if (timing) timing.balanceMs = performance.now() - balanceStartedAt;
      return value;
    });
    const blockhashStartedAt = performance.now();
    const blockhashPromise = this._recentBlockhash().then(value => {
      if (timing) timing.blockhashMs = performance.now() - blockhashStartedAt;
      return value;
    });
    const [trade, baseline, tip, latest] = await Promise.all([
      tradePromise,
      measuredBaselinePromise,
      this.sender.tipInstruction(this.wallet.publicKey),
      blockhashPromise
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
    const assembleStartedAt = performance.now();
    transaction.sign([this.wallet]);
    if (timing) {
      timing.assembleSignMs = performance.now() - assembleStartedAt;
      timing.readyMs = performance.now() - prepareStartedAt;
      timing.prepareMs = timing.readyMs;
    }
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
      beforeTokenBalance: baseline.amount,
      beforeTokenBalanceEvidence: baseline.proof,
      beforeTokenBalanceContextSlot: baseline.context?.slot ?? null,
      beforeTokenBalanceContextDelegate: baseline.context?.delegate ?? null,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      expectedTokenOutRaw: trade.expectedTokenOutRaw ?? null,
      hardMinimumTokenOutRaw: trade.hardMinimumTokenOutRaw ?? null,
      beforeTokenBalanceKnown: !skipBeforeTokenBalance &&
        (!requireBaselineContext || baseline.proof?.rooted === true),
      tokenDecimals: market.tokenDecimals,
      rpcSource: this.rpcSource
    };
  }

  async prepare(side, mintAddress, rawAmount, options = {}) {
    try {
      return await this.#prepareOnce(side, mintAddress, rawAmount, options);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      const prepared = await this.fallbackExecutor.prepare(
        side,
        mintAddress,
        rawAmount,
        options
      );
      return { ...prepared, rpcSource: "fallback" };
    }
  }

  async submit(prepared) {
    if (prepared.rpcSource === "fallback" && this.fallbackExecutor) {
      return this.fallbackExecutor.submit(prepared);
    }
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

  async closeEmptyTokenAccount(mintAddress, tokenProgramAddress, { onPrepared = null } = {}) {
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

    await onPrepared?.(prepared.expectedSignature, {
      tokenAccount: tokenAccount.toBase58(),
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      recentBlockhash: latest.blockhash
    });
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

  async #transactionWalletDeltaOnce(signature) {
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

  async transactionWalletDelta(signature) {
    try {
      return await this.#transactionWalletDeltaOnce(signature);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.transactionWalletDelta(signature);
    }
  }

  async transactionTokenDelta(signature, mintAddress, ownerAddress, commitment = "confirmed") {
    const mint = mintAddress.toBase58 ? mintAddress.toBase58() : String(mintAddress);
    const owner = ownerAddress?.toBase58 ? ownerAddress.toBase58() : String(ownerAddress ?? "");
    const metadataCommitment = transactionMetadataCommitment(commitment);
    try {
      const transaction = await this.connection.getParsedTransaction(signature, {
        commitment: metadataCommitment, maxSupportedTransactionVersion: 0
      });
      return this.#tokenDeltaFromTransaction(transaction, signature, mint, owner);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.transactionTokenDelta(
        signature, mintAddress, ownerAddress, metadataCommitment
      );
    }
  }

  #tokenDeltaFromTransaction(transaction, signature, mint, owner) {
    if (!transaction?.meta) throw new Error(`Confirmed transaction unavailable: ${signature}`);
    const amount = (balances = []) => balances
      .filter(balance => balance.mint === mint && (!owner || balance.owner === owner))
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
    return amount(transaction.meta.postTokenBalances) - amount(transaction.meta.preTokenBalances);
  }

  async #confirmOnce(signature, prepared) {
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

  async confirm(signature, prepared) {
    try {
      return await this.#confirmOnce(signature, prepared);
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.confirm(signature, prepared);
    }
  }

  async signatureStatus(signature) {
    try {
      const response = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true
      });
      return response.value[0];
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.signatureStatus(signature);
    }
  }

  async currentBlockHeight() {
    try {
      return await this.connection.getBlockHeight("confirmed");
    } catch (error) {
      if (!this.fallbackExecutor || !isRpcTransportError(error)) throw error;
      return this.fallbackExecutor.currentBlockHeight();
    }
  }
}
