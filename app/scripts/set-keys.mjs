#!/usr/bin/env node
// Writes the platform's keys into app/.env.public without showing them on screen.
// Secrets are typed hidden; press Enter on any line to keep what is already there.
// Run from the app folder: npm run keys   (or: npm run keys -- PINGPAY_API_KEY for just one)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = process.env.ENV_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.public");
const FIELDS = [
  { key: "PINGPAY_API_KEY", label: "PingPay API anahtarı (pay.pingpay.io/dashboard > API Keys)", secret: true },
  { key: "PINGPAY_PLATFORM_ACCOUNT", label: "Vergilerin geleceği NEAR hesabın (örn. agentvalley.near)", secret: false },
  { key: "NEARAI_API_KEY", label: "NEAR AI Cloud API anahtarı (cloud.near.ai > API Keys)", secret: true },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API anahtarı (isteğe bağlı)", secret: true },
  { key: "REVIEW_PROVIDER", label: "Fikir inceleme sağlayıcısı (nearai / openrouter, boş = elle inceleme)", secret: false },
  { key: "REVIEW_MODEL", label: "Fikir inceleme modeli (örn. z-ai/glm-5.3-flash)", secret: false },
  { key: "TAX_BPS", label: "Aylık kâr vergisi, baz puan (200 = %2)", secret: false },
];

const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
const current = Object.fromEntries(lines.map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));

// Reads one line; with hide, keystrokes show as *. Characters after a line end (a paste of several lines)
// wait in a buffer for the next question instead of being dropped.
const stdin = process.stdin;
stdin.setEncoding("utf8");
let buffered = "", waiting = null;
stdin.on("data", (chunk) => { buffered += chunk; pump(); });
function pump() {
  if (!waiting) return;
  while (buffered) {
    const c = buffered[0]; buffered = buffered.slice(1);
    if (c === "\r" || c === "\n") {
      if (c === "\r" && buffered[0] === "\n") buffered = buffered.slice(1);
      const w = waiting; waiting = null; process.stdout.write("\n"); return w.resolve(w.value.trim());
    }
    if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
    if (c === "\u007f" || c === "\b") { if (waiting.value) { waiting.value = waiting.value.slice(0, -1); process.stdout.write("\b \b"); } continue; }
    waiting.value += c;
    process.stdout.write(waiting.hide ? "*" : c);
  }
}
function ask(question, hide) {
  return new Promise((resolve) => { process.stdout.write(question); waiting = { resolve, hide, value: "" }; pump(); });
}
stdin.setRawMode?.(true);
stdin.resume();

console.log("\nAgent Valley anahtarları → .env.public");
console.log("Gizli alanlar ekranda * olarak görünür. Boş geçersen mevcut değer korunur.\n");
// npm run keys -- PINGPAY_API_KEY  asks only for the settings named on the command line.
const only = process.argv.slice(2).map((s) => s.toUpperCase());
for (const f of FIELDS.filter((x) => !only.length || only.includes(x.key))) {
  const has = current[f.key] ? (f.secret ? " [kayıtlı]" : ` [${current[f.key]}]`) : "";
  const v = await ask(`${f.label}${has}: `, f.secret);
  if (v) current[f.key] = v;
}
// Public-mode defaults stay in place if the file did not have them yet.
for (const [k, v] of Object.entries({ ALLOW_SIM_PURCHASE: "0", TRUST_PROXY: "1" })) if (!(k in current)) current[k] = v;

stdin.setRawMode?.(false);
stdin.pause();
fs.writeFileSync(file, Object.entries(current).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`\nKaydedildi (${Object.keys(current).length} ayar, dosya sadece senin okuyabileceğin izinle). Sunucuyu yeniden başlatınca devreye girer.`);
