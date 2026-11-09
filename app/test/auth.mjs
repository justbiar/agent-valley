// Sign in with NEAR: the wallet signs a one-time NEP-413 message, the server checks the signature and asks the chain
// whether that key is a full-access key of the account. Ownership then follows the account, across browsers.
// Run: node test/auth.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFake } from "./fake-openrouter.mjs";
import { b58encode, nep413Hash } from "../src/auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-or-visitor-0123456789abcdef", ADMIN = "admin-test-token";
const FAKE = 9931, RPC = 9932, PORT = 8919, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-auth-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };

// A wallet: an ed25519 key pair that signs the server's challenge the way a NEP-413 wallet does.
function wallet(accountId) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = "ed25519:" + b58encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const sign = (c, over = {}) => ({ accountId, publicKey: pub, callbackUrl: over.callbackUrl,
    signature: crypto.sign(null, nep413Hash({ message: over.message || c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: over.recipient || c.recipient, callbackUrl: over.callbackUrl || null }), privateKey).toString("base64") });
  return { accountId, pub, sign };
}
const alice = wallet("alice.testnet"), mallory = wallet("alice.testnet"), limited = wallet("limited.testnet"), main = wallet("alice.near");
// The chain: which keys belong to which accounts.
const keys = { [`alice.testnet ${alice.pub}`]: "FullAccess", [`limited.testnet ${limited.pub}`]: { FunctionCall: { receiver_id: "x.testnet" } } };
const rpc = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const p = JSON.parse(body).params, permission = keys[`${p.account_id} ${p.public_key}`];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(permission ? { jsonrpc: "2.0", result: { nonce: 1, permission } } : { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } }));
  });
}).listen(RPC, "127.0.0.1");

function browser(ip) {
  const jar = {};
  const call = async (p, opt = {}) => {
    const res = await fetch(base + p, { method: opt.method || "GET", redirect: "manual", headers: { "Content-Type": "application/json", "cf-connecting-ip": ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (kv.slice(i + 1)) jar[kv.slice(0, i)] = kv.slice(i + 1); else delete jar[kv.slice(0, i)]; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const signIn = async (w, over) => { const c = (await call("/api/auth/challenge", { method: "POST", body: {} })).data; return call("/api/auth/verify", { method: "POST", body: w.sign(c, over) }); };
  return { call, jar, signIn };
}

const { server: fake } = await startFake(FAKE, KEY);
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, ALLOW_SIM_PURCHASE: "0", TRUST_PROXY: "1", OPENROUTER_API_KEY: KEY, REVIEW_PROVIDER: "openrouter", REVIEW_MODEL: "test/cheap", OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, OLLAMA_URL: "http://127.0.0.1:9", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", NEAR_NETWORK: "testnet", NEAR_AUTH_RPC: `http://127.0.0.1:${RPC}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const company = (over = {}) => ({ name: "Kadraj " + Math.random().toString(36).slice(2, 7), sector: "research", provider: "mock", model: "mock/small", price: 1, seed: 2, payoutAccount: "kadraj-test.near", ...over });

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  const a = browser("203.0.113.10"), b = browser("203.0.113.20"), c = browser("203.0.113.30");
  await a.call("/"); await b.call("/"); await c.call("/");
  let co;

  await test("status says nobody is signed in and which network signs in", async () => {
    const { data } = await a.call("/api/status");
    assert.equal(data.viewer.account, null);
    assert.equal(data.viewer.signIn.suffix, ".testnet");
  });
  await test("a company founded before signing in belongs to the browser", async () => {
    const r = await a.call("/api/companies", { method: "POST", body: company() });
    assert.equal(r.status, 200, JSON.stringify(r.data)); co = r.data;
    assert.equal((await a.call("/api/companies")).data.length, 1);
  });
  await test("a signature from a key that is not on the account is refused", async () => {
    const r = await b.signIn(mallory);
    assert.equal(r.status, 400); assert.match(r.data.error, /not a full-access key/);
    assert.equal(b.jar.av_near, undefined);
  });
  await test("a function-call key cannot sign in", async () => {
    assert.equal((await b.signIn(limited)).status, 400);
  });
  await test("a signature over another message or recipient is refused", async () => {
    assert.match((await b.signIn(alice, { message: "Pay me" })).data.error, /does not match/);
    assert.match((await b.signIn(alice, { recipient: "evil-site" })).data.error, /does not match/);
  });
  await test("an account from the other network is refused", async () => {
    assert.match((await b.signIn(main)).data.error, /\.testnet/);
  });
  await test("a challenge answers once: replaying the signed message fails", async () => {
    const ch = (await b.call("/api/auth/challenge", { method: "POST", body: {} })).data, signed = alice.sign(ch);
    assert.equal((await c.call("/api/auth/verify", { method: "POST", body: signed })).status, 400); // another browser cannot use it
    assert.equal((await b.call("/api/auth/verify", { method: "POST", body: signed })).status, 200);
    assert.equal((await b.call("/api/auth/verify", { method: "POST", body: signed })).status, 400);
    await b.call("/api/auth/logout", { method: "POST", body: {} });
    assert.equal((await b.call("/api/status")).data.viewer.account, null);
  });
  await test("signing in moves this browser's companies under the account", async () => {
    const r = await a.signIn(alice, { callbackUrl: "https://valley.biar.dev/" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { account: "alice.testnet", adopted: 1 });
    assert.equal((await a.call("/api/status")).data.viewer.account, "alice.testnet");
  });
  await test("the same account in another browser sees and manages its companies", async () => {
    assert.equal((await b.call("/api/companies")).data.length, 0);
    assert.equal((await b.call(`/api/companies/${co.id}`, { method: "PATCH", body: { status: "paused" } })).status, 404);
    assert.equal((await b.signIn(alice)).status, 200);
    const list = (await b.call("/api/companies")).data;
    assert.equal(list.length, 1); assert.equal(list[0].id, co.id);
    assert.equal((await b.call(`/api/companies/${co.id}`, { method: "PATCH", body: { status: "paused" } })).status, 200);
  });
  await test("a stranger still cannot touch it", async () => {
    assert.equal((await c.call(`/api/companies/${co.id}`, { method: "PATCH", body: { status: "running" } })).status, 404);
  });
  await test("a forged or edited session cookie is ignored", async () => {
    const [body] = b.jar.av_near.split(".");
    c.jar.av_near = Buffer.from(JSON.stringify({ a: "alice.testnet", e: Date.now() + 1e9 })).toString("base64url") + "." + b.jar.av_near.split(".")[1];
    assert.equal((await c.call("/api/status")).data.viewer.account, null);
    c.jar.av_near = body + ".AAAA"; assert.equal((await c.call("/api/status")).data.viewer.account, null);
    delete c.jar.av_near;
  });
  await test("my orders starts empty and needs no sign-in", async () => {
    const r = await c.call("/api/my-orders");
    assert.equal(r.status, 200); assert.deepEqual(r.data, []);
  });
} finally {
  app.kill(); fake.close(); rpc.close();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
