import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const OBSERVER = new URL("./next-copy-observer.mjs", import.meta.url);
const RESTART_MS = 5000;

function journalPath() {
  const file = process.env.NEXT_COPY_JOURNAL;
  if (!file) throw new Error("NEXT_COPY_JOURNAL is required");
  return path.resolve(file);
}

function wallets() {
  const value = String(process.env.NEXT_COPY_WALLETS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!value.length || value.length > 5 || new Set(value).size !== value.length) throw new Error("NEXT_COPY_WALLETS must contain 1-5 unique public addresses");
  return value;
}

function latestRun(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").slice(-256 * 1024);
  const rows = text.split(/\r?\n/).filter(Boolean).reverse();
  for (const line of rows) {
    try {
      const row = JSON.parse(line);
      if (row.run) return row.run;
    } catch { /* partial tail is ignored */ }
  }
  return null;
}

function lastRecord(file) {
  if (!fs.existsSync(file)) return null;
  const rows = fs.readFileSync(file, "utf8").slice(-256 * 1024).split(/\r?\n/).filter(Boolean).reverse();
  for (const line of rows) {
    try { return JSON.parse(line); } catch { /* partial tail is ignored */ }
  }
  return null;
}

function appendGap(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({
    run: data.run ?? null,
    type: "DATA_GAP",
    at: Date.now(),
    reason: "observer_exit",
    supervisorRun: data.supervisorRun,
    exitCode: data.exitCode,
    signal: data.signal,
    restartIndex: data.restartIndex
  }) + "\n");
}

export function createSupervisor({ spawnImpl = spawn, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), env = process.env } = {}) {
  if (!env.NEXT_COPY_JOURNAL) throw new Error("NEXT_COPY_JOURNAL and NEXT_COPY_WALLETS are required");
  const file = path.resolve(env.NEXT_COPY_JOURNAL);
  const list = String(env.NEXT_COPY_WALLETS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!file || !list.length) throw new Error("NEXT_COPY_JOURNAL and NEXT_COPY_WALLETS are required");
  let child = null;
  let stopping = false;
  let restartIndex = 0;
  const supervisorRun = randomUUID();
  const stop = () => {
    stopping = true;
    if (child && !child.killed) child.kill("SIGTERM");
  };
  const run = async () => {
    while (!stopping) {
      const args = [file, ...list];
      if (env.NEXT_COPY_SIZE_SOL) args.push(`--size-sol=${env.NEXT_COPY_SIZE_SOL}`);
      child = spawnImpl(process.execPath, [fileURLPath(OBSERVER), ...args], { env, stdio: "inherit" });
      const result = await new Promise(resolve => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })));
      child = null;
      if (stopping) break;
      // The observer's bounded research window exits with a durable STOP. Do
      // not turn a completed run into an automatic new experiment.
      if (result.exitCode === 0 && lastRecord(file)?.type === "STOP") break;
      restartIndex++;
      appendGap(file, { run: latestRun(file), supervisorRun, ...result, restartIndex });
      await sleep(RESTART_MS);
    }
  };
  return { run, stop, get supervisorRun() { return supervisorRun; } };
}

function fileURLPath(url) { return fileURLToPath(url); }

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const supervisor = createSupervisor();
  process.on("SIGINT", supervisor.stop);
  process.on("SIGTERM", supervisor.stop);
  supervisor.run().catch(error => { console.error(error); process.exitCode = 1; });
}
