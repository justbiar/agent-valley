#!/usr/bin/env node
// Collects the secrets the Phala deployment needs into app/.env.phala, without printing any value.
// Sources: app/.env.public, the NEAR operator key in ~/.near-credentials, the Cloudflare tunnel token, app/data/state.json.
// Run from the repository root: node app/scripts/phala-env.mjs   (the file stays local: .env.* is never committed)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const line of fs.readFileSync(path.join(app, ".env.public"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const network = env.NEAR_NETWORK || "testnet", contract = env.NEAR_CONTRACT;
const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials", network, `${contract}.json`), "utf8"));
env.NEAR_OPERATOR_KEY = cred.private_key || cred.secret_key;
env.TUNNEL_TOKEN = execFileSync("cloudflared", ["tunnel", "token", process.argv[2] || "agent-valley"], { encoding: "utf8" }).trim();
const state = path.join(app, "data", "state.json");
if (fs.existsSync(state)) env.STATE_SEED_B64 = fs.readFileSync(state).toString("base64");
const out = path.join(app, ".env.phala");
fs.writeFileSync(out, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log("Wrote", out, "with:", Object.keys(env).filter((k) => env[k]).join(", "));
