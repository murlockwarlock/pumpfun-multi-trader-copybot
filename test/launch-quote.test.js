import assert from "node:assert/strict";
import test from "node:test";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PumpExecutor } from "../src/pump-executor.js";
import { LAUNCH_TARGET } from "../src/launch-follow.js";

function fixture() {
  const mint = new PublicKey("Pw9Nvk8rMoZF4dYuhzdJeMAuFm3f3CSUy3nQhcUpump");
  // Deliberately no secret key: any signing attempt must fail the test.
  const executor = new PumpExecutor({ rpcHttpUrl:"https://rpc.invalid", liveSendRoute:"rpc",
    liveTipSol:0, liveSlippageBps:1500 }, { publicKey:new PublicKey(LAUNCH_TARGET) });
  const data=Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,
    decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default },data);
  executor.connection={getAccountInfo:async key=>key.equals(mint)?{data,owner:TOKEN_PROGRAM_ID}:null,
    getMinimumBalanceForRentExemption:async()=>2039280};
  executor.pumpParameters={global:{feeBasisPoints:new BN(100),creatorFeeBasisPoints:new BN(25),buybackBasisPoints:new BN(0)},feeConfig:null,fetchedAtMs:Date.now()};
  const curve={ virtualTokenReserves:new BN("900000000000000"), virtualQuoteReserves:new BN("35000000000"),
    realTokenReserves:new BN("600000000000000"),realQuoteReserves:new BN("5000000000"),
    creator:new PublicKey(LAUNCH_TARGET),quoteMint:PublicKey.default,creatorFeeBps:new BN(0),
    complete:false,isMayhemMode:false,isCashbackCoin:false };
  executor.pump={fetchBuyState:async()=>({bondingCurve:curve,quoteMint:NATIVE_MINT,
    quoteTokenProgram:TOKEN_PROGRAM_ID,quoteTransferFee:null,associatedUserAccountInfo:null,
    curveBaseTokenBalance:curve.realTokenReserves}),fetchSellState:async()=>{throw Error("real ATA read is forbidden");}};
  executor.prepare=()=>{throw Error("signed preparation is forbidden");};
  executor.sender=new Proxy({}, {get(){throw Error("sender access forbidden");}});
  return {executor,mint,curve};
}
test("unsigned SDK BUY then SELL works without an actual token account or signer",async()=>{
  const {executor,mint}=fixture();
  const buy=await executor.quoteShadow("BUY",mint.toBase58(),"5000000",{
    targetAveragePriceSol:35/900000000,maxEntryDriftBps:2500,venueHint:"pump-curve"});
  assert.ok(BigInt(buy.expectedTokenOutRaw)>0n);assert.ok(buy.unsignedInstructionCount>0);
  assert.equal(buy.rentSol,.00203928);assert.ok(buy.priceImpactBps>0);
  const sell=await executor.quoteShadow("SELL",mint.toBase58(),buy.expectedTokenOutRaw);
  assert.ok(BigInt(sell.expectedSolOutRaw)>0n);assert.ok(BigInt(sell.tradingFeeRaw)>0n);
  assert.equal(sell.reserves.realSolRaw,"5000000000");assert.ok(sell.priceImpactBps>0);
});
test("unsigned BUY requires drift cap and rejects a quote over it",async()=>{
  const {executor,mint}=fixture();
  await assert.rejects(executor.quoteShadow("BUY",mint.toBase58(),"5000000"),/price protection/);
  await assert.rejects(executor.quoteShadow("BUY",mint.toBase58(),"5000000",{
    targetAveragePriceSol:1e-12,maxEntryDriftBps:2500}),/price limit/);
});
test("hypothetical SELL cannot quote more than actual real reserves",async()=>{
  const {executor,mint,curve}=fixture();curve.realQuoteReserves=new BN(1);
  await assert.rejects(executor.quoteShadow("SELL",mint.toBase58(),"1000000000"),/Insufficient real/);
});
test("shadow RPC enforces source minContextSlot and rejects an older returned bank",async()=>{
  const requests=[];
  const executor=new PumpExecutor({rpcHttpUrl:"https://rpc.invalid",liveSendRoute:"rpc",liveTipSol:0,
    shadowReadOnlyFetch:async(_url,options)=>{
      const body=JSON.parse(options.body);requests.push(body);
      return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{context:{slot:99},value:null}}),{status:200});
    }},{publicKey:new PublicKey(LAUNCH_TARGET)});
  await assert.rejects(executor.quoteShadow("BUY","Pw9Nvk8rMoZF4dYuhzdJeMAuFm3f3CSUy3nQhcUpump","5000000",{minContextSlot:100}),/slot_unproven/);
  assert.ok(requests.length>0);
  for(const r of requests)assert.equal(r.params[1].minContextSlot,100);
});
