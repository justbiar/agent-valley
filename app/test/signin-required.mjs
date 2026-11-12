// REQUIRE_SIGNIN=1: a visitor must sign in with a NEAR account before founding a company, and the company then
// belongs to that account. The admin is not affected. The wallet and the NEAR RPC are local stand-ins.
// Run: node test/signin-required.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { b58encode, nep413Hash } from "../src/auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = "admin-gate-token", RPC = 9962, PORT = 8933, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-gate-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };

// A wallet that signs the challenge the way a NEP-413 wallet does, and a chain that knows its key.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = "ed25519:" + b58encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const sign = (c) => ({ accountId: "founder.testnet", publicKey: pub, signature: crypto.sign(null, nep413Hash({ message: c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient }), privateKey).toString("base64") });
const rpc = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const p = JSON.parse(body).params, ok = p.account_id === "founder.testnet" && p.public_key === pub;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(ok ? { jsonrpc: "2.0", result: { nonce: 1, permission: "FullAccess" } } : { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } }));
  });
}).listen(RPC, "127.0.0.1");

function browser(ip) {
  const jar = {};
  const call = async (p, opt = {}) => {
    const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json", "cf-connecting-ip": ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); else delete jar[kv.slice(0, i)]; }
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { call, jar };
}

const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, REQUIRE_SIGNIN: "1", TRUST_PROXY: "1", ALLOW_SIM_PURCHASE: "0", OPENROUTER_API_KEY: "", NEARAI_API_KEY: "",
    OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", NEAR_CONTRACT: "", NEAR_NETWORK: "testnet", NEAR_AUTH_RPC: `http://127.0.0.1:${RPC}`, TICK_MS: "200" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const company = { name: "Gated Studio", sector: "research", provider: "mock", model: "mock/small", price: 1, seed: 2, payoutAccount: "gated.near" };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  const v = browser("203.0.113.70");

  await test("the console knows sign-in is required", async () => {
    const st = (await v.call("/api/status")).data;
    assert.equal(st.viewer.requireSignIn, true);
    assert.equal(st.viewer.account, null);
  });

  await test("a visitor without an account cannot found a company", async () => {
    const r = await v.call("/api/companies", { method: "POST", body: company });
    assert.equal(r.status, 401);
    assert.match(r.data.error, /Sign in with your NEAR account/);
  });

  await test("after signing in with NEAR the same visitor founds one, and it belongs to the account", async () => {
    const c = (await v.call("/api/auth/challenge", { method: "POST", body: {} })).data;
    assert.equal((await v.call("/api/auth/verify", { method: "POST", body: sign(c) })).data.account, "founder.testnet");
    const r = await v.call("/api/companies", { method: "POST", body: company });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const mine = (await v.call("/api/companies")).data;
    assert.deepEqual(mine.map((x) => x.name), ["Gated Studio"]);
  });

  await test("another visitor without an account sees none of it and still cannot found", async () => {
    const w = browser("203.0.113.71");
    assert.deepEqual((await w.call("/api/companies")).data, []);
    assert.equal((await w.call("/api/companies", { method: "POST", body: { ...company, name: "Other Studio" } })).status, 401);
  });

  await test("the market stays open to anyone, signed in or not", async () => {
    const w = browser("203.0.113.72");
    assert.equal((await w.call("/api/market")).status, 200);
  });
} finally {
  app.kill(); rpc.close();
}
for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
