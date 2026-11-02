import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveEngine } from "../src/live-engine.js";

// Load the actual PR baseline beside current code without starting either service.
const source = execFileSync("git", ["show", "49b0a58:src/live-engine.js"], { encoding: "utf8" })
  .replace(/from "([^"]+)"/g, (_, spec) => {
    const url = spec.startsWith(".") ? new URL("../src/" + spec, import.meta.url).href : import.meta.resolve(spec);
    return "from " + JSON.stringify(url);
  });
const baseline = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

function pool() {
  const slots = Array.from({ length: 4 }, () => Promise.resolve());
  let next = 0;
  return { prepare() {
    const i = next++ % slots.length;
    return slots[i] = slots[i].then(() => delay(3)).then(() => ({ venue: "mock" }));
  } };
}

for (const Engine of [baseline.LiveEngine, LiveEngine]) {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-load-"));
  try {
    const engine = new Engine({ liveStateFile: path.join(dir,"state"), liveLogFile: path.join(dir,"log"),
      shadowTradeSol: 0.005, fastMaxSignalAgeMs: 1500 }, () => {});
    engine.executor = pool();
    engine.probeExecutor = pool();
    const samples = [];
    let dropped = 0;
    const completedByWallet = Array(24).fill(0);
    for (let i = 0; i < 100; i++) {
      const signal = { side: "BUY", mint: "mock", observedAtMs: Date.now() };
      const probes = Array.from({ length: 24 }, (_, j) => engine.probeBuy({ ...signal, sourceWallet: 'wallet-' + ((i+j)%24) }).then(() => completedByWallet[(i+j)%24]++).catch(error => {
        if (!error.message.includes("busy")) throw error;
        dropped++;
      }));
      const start = performance.now();
      await engine.executor.prepare(i % 2 ? "BUY" : "SELL");
      await delay(2);
      samples.push(performance.now() - start);
      await Promise.all(probes);
    }
    assert.equal(completedByWallet.reduce((a,b) => a+b, 0) + dropped, 2400);
    console.log("Per wallet: 100 requested each; completed counts", completedByWallet);
    samples.sort((a,b) => a-b);
    console.log(Engine === LiveEngine ? "current" : "49b0a58", { requested: 2400, completed: 2400-dropped, dropped, reason: 'busy (fresh concurrent requests)',
      submitMs: [50,95,99].map(p => +samples[p-1].toFixed(2)) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
