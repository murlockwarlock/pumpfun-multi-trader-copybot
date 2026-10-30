import { config } from "./config.js";
import { parsePumpTrades } from "./parser.js";
import { SolanaRpc } from "./rpc.js";

const signature = process.argv[2];
if (!signature) {
  console.error("Usage: npm run inspect -- <transaction-signature>");
  process.exit(1);
}

const rpc = new SolanaRpc(config.rpcHttpUrl);
const tx = await rpc.getTransactionWithRetry(signature, 2);
if (!tx) {
  console.error("Transaction not found");
  process.exit(2);
}

const matches = config.targetTraders.flatMap((target) =>
  parsePumpTrades(tx, target.wallet, signature).map((trade) => ({
    ...trade, sourceName: target.name, sourceWallet: target.wallet
  }))
);
console.log(JSON.stringify(matches, null, 2));
