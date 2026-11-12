import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditObserverRun } from "./copybot-analytics.mjs";

const input = process.argv[2] ?? "work/next-copy/combined.jsonl";
const output = process.argv[3] ?? "docs/evidence/observer-run-15915ccb-audit.json";
const report = auditObserverRun(input);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: report,
  sourcePreserved: true,
  note: "This audit is read-only; it does not rewrite or append to the observer journal."
}, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.exit(0);
