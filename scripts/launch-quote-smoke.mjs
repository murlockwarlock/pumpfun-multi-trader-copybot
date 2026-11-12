// Read-only current-state smoke check. Not a replay or a strategy observation.
import { PublicKey } from "@solana/web3.js";
import { config } from "../src/config.js";
import { PumpExecutor } from "../src/pump-executor.js";
import { readOnlyBudgetFetch } from "../src/shadow-rpc-budget.js";
const [mint, price, walletAddress] = process.argv.slice(2);
if (!mint || !(Number(price)>0) || !walletAddress) throw Error("Usage: node scripts/launch-quote-smoke.mjs MINT TARGET_PRICE_SOL EXISTING_WALLET_PUBLIC_KEY");
const methods = [];
const request = (url, options) => {
  const body=JSON.parse(options.body);methods.push(...(Array.isArray(body)?body:[body]).map(x=>x.method));
  return fetch(url,options);
};
const executor = new PumpExecutor({...config, rpcFallbackHttpUrl:"", rpcWsUrl:undefined,
  shadowReadOnlyFetch:readOnlyBudgetFetch({request})}, {publicKey:new PublicKey(walletAddress)}, {enableFallback:false});
const startedAtMs=Date.now();
let buy;
try {
  buy=await executor.quoteShadow("BUY",mint,"5000000",{targetAveragePriceSol:Number(price),maxEntryDriftBps:config.fastMaxEntryDriftBps});
  // Separate request window: this check intentionally is not a timing replay.
  await new Promise(resolve=>setTimeout(resolve,1100));
  const sell=await executor.quoteShadow("SELL",mint,buy.expectedTokenOutRaw);
  console.log(JSON.stringify({kind:"current_state_smoke_not_strategy_sample",mint,startedAtMs,buy,sell,methods,signed:false,sent:false},null,2));
} catch(error) {
  console.log(JSON.stringify({kind:"current_state_smoke_not_strategy_sample",mint,startedAtMs,
    buy,error:error.message.replace(/https?:\/\/\S+/g,"[rpc]"),methods,signed:false,sent:false},null,2));
  process.exitCode=1;
}
