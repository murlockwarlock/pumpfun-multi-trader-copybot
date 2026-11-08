import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { PublicKey } from "@solana/web3.js";
import { PumpExecutor } from "./pump-executor.js";
import { LaunchFollow, launchSignals, LAUNCH_TARGET } from "./launch-follow.js";
import { parsePumpLogSignal } from "./parser.js";
import { readOnlyBudgetFetch } from "./shadow-rpc-budget.js";

const { config, publicKey, directory } = workerData;
fs.mkdirSync(directory, { recursive: true });
const stateFile = path.join(directory, "state.json");
const journal = path.join(directory, "events.jsonl");
const emit = row => fs.appendFileSync(journal, JSON.stringify(row) + "\n");
const save = state => {
  const tmp = stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state), { flush: true });
  fs.renameSync(tmp, stateFile);
};
const executor = new PumpExecutor({ ...config, rpcWsUrl: undefined, rpcFallbackHttpUrl: "",
  shadowReadOnlyFetch: readOnlyBudgetFetch() }, { publicKey: new PublicKey(publicKey) }, { enableFallback: false });
// No keyfile, wallet secret, initialize(), prepare() or send capability is used.
const engine = new LaunchFollow({
  quote: (...args) => executor.quoteShadow(...args), emit, save,
  state: fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {},
  maxAgeMs: config.fastMaxSignalAgeMs, maxDriftBps: config.fastMaxEntryDriftBps,
  slippageBps: config.liveSlippageBps, prioritySol: config.livePriorityFeeSol, tipSol: config.liveTipSol
});
parentPort.on("message", message => {
  try {
    if (message.kind === "verified") {
      for (const p of Object.values(engine.state.launches)) {
        if (p.signature === message.signature) p.confirmed = message.success;
      }
      engine.record("VERIFICATION", { signature: message.signature, success: message.success });
      return;
    }
    if (message.kind === "resolvedSell") { engine.creatorSell(message.trade); return; }
    const { value, slot, observedAtMs } = message;
    if (value.err) return;
    const decodeStartedAtMs = Date.now();
    const { trades } = parsePumpLogSignal(value.logs, LAUNCH_TARGET, value.signature, { slot, observedAtMs });
    for (const t of trades) if (t.side === "SELL" && t.mint) engine.creatorSell(t);
    for (const s of launchSignals(value, slot, observedAtMs)) void engine.launch({ ...s,
      workerQueueMs: decodeStartedAtMs - observedAtMs, decodeMs: Date.now() - decodeStartedAtMs });
  } catch(e) { emit({ type: "ERROR", atMs: Date.now(), message: e.message }); }
});
parentPort.postMessage({ ready: true, recovered: Object.keys(engine.state.launches).length });
