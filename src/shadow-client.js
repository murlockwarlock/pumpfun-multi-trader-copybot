import { Worker, parentPort, workerData, isMainThread } from "node:worker_threads";
import { ShadowEngine } from "./shadow-engine.js";

if (!isMainThread) {
  const engine = new ShadowEngine(workerData);
  parentPort.postMessage({ positions: [...engine.positions] });
  parentPort.on("message", ({ id, trade, reason }) => {
    try {
      const result = reason ? engine.blockTrade(trade, reason) : engine.onTrade(trade);
      parentPort.postMessage({ id, result, positions: [...engine.positions] });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    }
  });
}

export class ShadowClient {
  positions = new Map();
  pending = new Map();
  sequence = 0;
  static async open(config) {
    const client = new ShadowClient();
    const options = Object.fromEntries(Object.entries(config).filter(([key]) =>
      key.startsWith("shadow") || ["targetTraders","pumpFeeBps","maxSignalAgeMs"].includes(key)));
    client.worker = new Worker(new URL(import.meta.url), { workerData: options });
    const ready = Promise.withResolvers();
    const fail = error => {
      client.error = error;
      ready.reject(error);
      for (const request of client.pending.values()) request.reject(error);
      client.pending.clear();
    };
    client.worker.on("error", fail);
    client.worker.on("exit", code => fail(new Error(`shadow worker exited: ${code}`)));
    client.worker.on("message", ({ id, result, positions, error }) => {
      if (positions) client.positions = new Map(positions);
      if (!id) return ready.resolve();
      const request = client.pending.get(id);
      client.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    await ready.promise;
    return client;
  }
  onTrade(trade) { return this.blockTrade(trade, null); }
  blockTrade(trade, reason) {
    if (this.error) return Promise.reject(this.error);
    const id = ++this.sequence;
    const request = Promise.withResolvers();
    this.pending.set(id, request);
    this.worker.postMessage({ id, trade, reason });
    return request.promise;
  }
}
