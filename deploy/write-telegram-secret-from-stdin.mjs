import fs from "node:fs";
import path from "node:path";

const output = path.resolve(process.argv[2] ?? "./secrets/telegram-bot-token");
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
  throw new Error("Run this helper in an interactive terminal");
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
let token = "";
await new Promise((resolve, reject) => {
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("\u0003")) reject(new Error("Cancelled"));
    const end = chunk.search(/[\r\n]/);
    token += end >= 0 ? chunk.slice(0, end) : chunk;
    if (end >= 0) resolve();
  });
});
process.stdin.setRawMode(false);
process.stdin.pause();
token = token.trim();
if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
  throw new Error("Telegram bot token format is invalid");
}
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, `${token}\n`, { mode: 0o600 });
fs.chmodSync(output, 0o600);
console.log(`telegram_secret=written path=${output}`);
