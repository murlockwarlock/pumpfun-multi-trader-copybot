import fs from "node:fs";
import path from "node:path";

export class IngestionState {
  constructor(file, maxRemembered = 10_000) {
    this.file = file;
    this.maxRemembered = maxRemembered;
    this.initialized = false;
    this.cursor = null;
    this.processed = new Set();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (
      state.version !== 1 ||
      typeof state.initialized !== "boolean" ||
      (state.cursor !== null && typeof state.cursor !== "string") ||
      !Array.isArray(state.processed)
    ) {
      throw new Error("Unsupported ingestion state format");
    }
    this.initialized = state.initialized;
    this.cursor = state.cursor;
    for (const signature of state.processed.slice(-this.maxRemembered)) {
      if (typeof signature === "string") this.processed.add(signature);
    }
  }

  #save() {
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      initialized: this.initialized,
      cursor: this.cursor,
      processed: [...this.processed]
    };
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  has(signature) {
    return this.processed.has(signature);
  }

  markProcessed(signature) {
    if (this.processed.has(signature)) return;
    this.processed.add(signature);
    while (this.processed.size > this.maxRemembered) {
      this.processed.delete(this.processed.values().next().value);
    }
    this.#save();
  }

  checkpoint(cursor) {
    this.initialized = true;
    this.cursor = cursor;
    this.#save();
  }
}
