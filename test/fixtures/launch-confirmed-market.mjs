import fs from "node:fs";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MintLayout,NATIVE_MINT,TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { launchSignals,LAUNCH_TARGET } from "../../src/launch-follow.js";

const fixture=JSON.parse(fs.readFileSync(new URL("./launch-follow.json",import.meta.url)));
const signal=launchSignals(fixture,fixture.slot,Date.now())[0];
const mintData=Buffer.alloc(MintLayout.span);
MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,
  decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);
const account={data:[mintData.toString("base64"),"base64"],owner:TOKEN_PROGRAM_ID.toBase58(),
  executable:false,lamports:2039280,rentEpoch:0};
export const research=true;
export async function request(_url,options) {
  const req=JSON.parse(options.body);
  const [keys,config]=req.params;
  await new Promise(resolve=>setTimeout(resolve,4));
  const context={slot:(config?.minContextSlot??fixture.slot)+1};
  let result;
  if(req.method==="getAccountInfo") {
    if(config?.commitment!=="confirmed") throw Error("research quote must use confirmed");
    result={context,value:keys===signal.mint?account:null};
  } else if(req.method==="getMultipleAccounts") {
    if(config?.commitment!=="confirmed"&&keys.length!==2) throw Error("research quote must use confirmed");
    result={context,value:keys.map(()=>account)};
  } else if(req.method==="getMinimumBalanceForRentExemption") result=2039280;
  else throw Error("Unexpected test RPC method: "+req.method);
  return new Response(JSON.stringify({jsonrpc:"2.0",id:req.id,result}));
}
export function configure(executor) {
  const curve={
    virtualTokenReserves:new BN("900000000000000"),
    virtualQuoteReserves:new BN(String(Math.round(signal.averagePriceSol*900000000*1e9))),
    realTokenReserves:new BN("600000000000000"),realQuoteReserves:new BN("5000000000"),
    creator:new PublicKey(LAUNCH_TARGET),quoteMint:PublicKey.default,creatorFeeBps:new BN(0),
    complete:false,isMayhemMode:false,isCashbackCoin:false
  };
  executor.pump={
    fetchGlobal:async()=>({feeBasisPoints:new BN(100),creatorFeeBasisPoints:new BN(25),buybackBasisPoints:new BN(0)}),
    fetchFeeConfig:async()=>null,
    fetchBuyState:async()=>{
      await executor.connection.getMultipleAccountsInfo([new PublicKey(signal.curve)]);
      return {bondingCurve:curve,quoteMint:NATIVE_MINT,quoteTokenProgram:TOKEN_PROGRAM_ID,
        quoteTransferFee:null,associatedUserAccountInfo:null,curveBaseTokenBalance:curve.realTokenReserves};
    }
  };
  executor.sender=new Proxy({}, {get(){throw Error("Sender must not be accessed");}});
}
