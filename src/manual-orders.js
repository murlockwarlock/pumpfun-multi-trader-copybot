import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

export class ManualOrderQueue {
  constructor(directory, submit, log) {
    this.directory = directory;
    this.submit = submit;
    this.log = log;
    this.timer = null;
    this.polling = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref();
    void this.poll();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const files = fs.readdirSync(this.directory)
        .filter((name) => name.endsWith(".json") || name.endsWith(".processing"))
        .sort();
      for (const name of files) await this.#processFile(name);
    } catch (error) {
      this.log("manual_order_poll_error", { message: error.message });
    } finally {
      this.polling = false;
    }
  }

  async #processFile(name) {
    let file = path.join(this.directory, name);
    let order;
    try {
      order = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!order?.id || !["BUY", "SELL"].includes(order.side)) {
        throw new Error("manual order must contain id and BUY/SELL side");
      }
      const mint = new PublicKey(order.mint).toBase58();
      const executeAtMs = Date.parse(order.executeAt);
      if (!Number.isFinite(executeAtMs)) throw new Error("invalid executeAt");
      if (name.endsWith(".json") && executeAtMs > Date.now()) return;
      if (name.endsWith(".json")) {
        const claimed = file.replace(/\.json$/, ".processing");
        fs.renameSync(file, claimed);
        file = claimed;
      }
      const observedAtMs = Date.now();
      const trade = {
        side: order.side,
        mint,
        signature: `manual:${order.id}:${order.side}`,
        blockTime: Math.floor(observedAtMs / 1_000),
        observedAtMs,
        signalSource: "manual_test",
        executionRoute: order.executionRoute ?? null
      };
      this.log("manual_order_due", {
        id: order.id,
        side: order.side,
        mint,
        executeAt: order.executeAt
      });
      const result = await this.submit(trade, "manual_test");
      this.log("manual_order_result", { id: order.id, side: order.side, mint, ...result });
      fs.unlinkSync(file);
    } catch (error) {
      this.log("manual_order_failed", { file: path.basename(file), message: error.message });
      if (file.endsWith(".processing") && fs.existsSync(file)) {
        const retry = file.replace(/\.processing$/, ".json");
        if (!fs.existsSync(retry)) fs.renameSync(file, retry);
      }
    }
  }
}
