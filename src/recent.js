import { config } from "./config.js";
import { parsePumpTrades } from "./parser.js";
import { SolanaRpc } from "./rpc.js";

const rpc = new SolanaRpc(config.rpcHttpUrl);
const limit = Math.min(100, Math.max(1, Number(process.argv[2] ?? 30)));
let found = 0;
let sampled = 0;
for (const target of config.targetTraders) {
  const signatures = await rpc.call("getSignaturesForAddress", [
    target.wallet,
    { limit, commitment: "confirmed" }
  ]);
  sampled += signatures.length;
  for (const item of signatures) {
    if (item.err) continue;
    try {
      const tx = await rpc.getTransactionWithRetry(item.signature, 2);
      for (const trade of parsePumpTrades(tx, target.wallet, item.signature)) {
        console.log(JSON.stringify({
          ...trade, sourceName: target.name, sourceWallet: target.wallet
        }));
        found += 1;
      }
    } catch (error) {
      console.error(JSON.stringify({
        sourceName: target.name, signature: item.signature, error: error.message
      }));
    }
  }
}

console.error(`Found ${found} Pump/PumpSwap trades in ${sampled} recent transactions.`);
