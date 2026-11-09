// Companies change hands: a one-time transfer link, or a sale paid into the contract's escrow. The old owner's keys
// never pass; a listing that changed after payment, or a short payment, is refunded.
// Run: node test/handover.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHandover } from "../src/handover.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8959, base = `http://127.0.0.1:${PORT}`, USD = 1e6, NEAR = 10n ** 24n;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-handover-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

function fakeChain() {
  const sales = {}, calls = [];
  return {
    sales, calls,
    pay: (ref, amount) => (sales[ref] = { sale_ref: ref, status: "paid", amount: String(amount), buyer: "buyer.testnet" }),
    async getSale(ref) { return sales[ref] || null; },
    async completeSale(ref, rec) { calls.push(["complete", ref]); sales[ref].status = "completed"; rec.completeTx = "tx-complete"; },
    async refundSale(ref, rec) { calls.push(["refund", ref]); sales[ref].status = "refunded"; rec.refundTx = "tx-refund"; },
    async transferCompany(co, account, rec) { calls.push(["transfer", co.id, account]); rec.transferTx = "tx-transfer"; },
  };
}
function setup() {
  let t = 1_000_000;
  const co = { id: 1, name: "Sitehane", status: "running", ownerId: "vid-seller", payoutAccount: "seller.near", ownKey: true, chain: { id: 7 }, log: [], agentPay: { sell: true, buy: true } };
  const keys = new Map([[1, "sk-seller-own-key"]]), store = { companies: [co], save() {} }, chain = fakeChain();
  const h = createHandover({ store, chain: () => chain, rate: async () => 2, byId: (id) => store.companies.find((c) => c.id === id),
    checkAccount: async (raw) => { const a = String(raw || "").trim().toLowerCase(); if (!/^[a-z0-9._-]{2,64}$/.test(a)) throw new Error("NEAR hesabı geçersiz"); return a; },
    dropKeys: (c) => { keys.delete(c.id); c.agentPay = { sell: false, buy: false }; }, now: () => t, checkEveryMs: 0, linkMs: 60_000 });
  return { co, keys, store, chain, h, advance: (ms) => (t += ms) };
}

await test("a transfer link hands the company over once and leaves the old owner's keys behind", async () => {
  const v = setup();
  const link = v.h.createLink(v.co);
  await v.h.claim(link.id, link.token, { ownerId: "vid-friend", payoutAccount: "Friend.near" });
  assert.equal(v.co.ownerId, "vid-friend");
  assert.equal(v.co.payoutAccount, "friend.near");
  assert.equal(v.keys.has(1), false, "the seller's own model key is gone");
  assert.equal(v.co.ownKey, true, "so a key-run company waits for the new owner's key instead of using the platform's");
  assert.deepEqual(v.co.agentPay, { sell: false, buy: false });
  assert.deepEqual(v.chain.calls[0], ["transfer", 1, "friend.near"]);
  await assert.rejects(v.h.claim(link.id, link.token, { ownerId: "vid-thief", payoutAccount: "thief.near" }), /invalid or already used/);
});

await test("a wrong token or an expired link takes nothing", async () => {
  const v = setup();
  const link = v.h.createLink(v.co);
  await assert.rejects(v.h.claim(link.id, "nope", { ownerId: "x", payoutAccount: "x.near" }), /invalid/);
  v.advance(61_000);
  await assert.rejects(v.h.claim(link.id, link.token, { ownerId: "x", payoutAccount: "x.near" }), /expired/);
  assert.equal(v.co.ownerId, "vid-seller");
});

await test("a paid sale completes on chain and the buyer becomes the owner", async () => {
  const v = setup();
  v.h.list(v.co, 50 * USD);
  const s = await v.h.startPurchase(v.co, { ownerId: "vid-buyer", newOwner: "buyer.testnet" });
  assert.equal(s.quoteYocto, String(25n * NEAR), "$50 at $2 a NEAR");
  v.chain.pay(s.ref, 25n * NEAR);
  await v.h.tick();
  assert.equal(s.status, "completed");
  assert.equal(v.co.ownerId, "vid-buyer");
  assert.equal(v.co.payoutAccount, "buyer.testnet");
  assert.equal(v.co.sale, null, "the listing is gone");
  assert.equal(v.co.ownerHistory.at(-1).how, "sale");
});

await test("a listing withdrawn or repriced after payment refunds the buyer", async () => {
  const v = setup();
  v.h.list(v.co, 50 * USD);
  const s = await v.h.startPurchase(v.co, { ownerId: "vid-buyer", newOwner: "buyer.testnet" });
  v.h.list(v.co, 80 * USD);
  v.chain.pay(s.ref, 25n * NEAR);
  await v.h.tick();
  assert.equal(s.status, "refunded");
  assert.equal(v.co.ownerId, "vid-seller");
});

await test("a short payment is refunded", async () => {
  const v = setup();
  v.h.list(v.co, 50 * USD);
  const s = await v.h.startPurchase(v.co, { ownerId: "vid-buyer", newOwner: "buyer.testnet" });
  v.chain.pay(s.ref, 10n * NEAR);
  await v.h.tick();
  assert.equal(s.status, "refunded");
  assert.equal(s.reason, "Underpaid");
});

/* ---------- through the server ---------- */
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", NEAR_CONTRACT: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  await test("the owner makes a link, the claimer sees the company and takes it over", async () => {
    const co = (await api("/api/companies", { method: "POST", body: { name: "Devirlik", sector: "research", provider: "mock", model: "mock/small", price: 1, seed: 3, payoutAccount: "eski.near" } })).data;
    const link = (await api(`/api/companies/${co.id}/transfer-link`, { method: "POST" })).data;
    assert.match(link.url, /^\/claim\.html\?h=\d+&t=[0-9a-f]{32}$/);
    const q = new URLSearchParams(link.url.split("?")[1]);
    const info = (await api(`/api/handover/${q.get("h")}?t=${q.get("t")}`)).data;
    assert.equal(info.company.name, "Devirlik");
    const r = await api(`/api/handover/${q.get("h")}/claim?t=${q.get("t")}`, { method: "POST", body: { payoutAccount: "yeni.near" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = (await api("/api/companies")).data.find((x) => x.id === co.id);
    assert.equal(after.payoutAccount, "yeni.near");
    assert.equal(after.ownerHistory[0].to, "yeni.near");
    assert.equal((await api(`/api/handover/${q.get("h")}?t=${q.get("t")}`)).status, 404, "the link is spent");
  });

  await test("a sale needs an on-chain company, and the market shows a listing", async () => {
    const co = (await api("/api/companies", { method: "POST", body: { name: "Satılık", sector: "research", provider: "mock", model: "mock/small", price: 1, seed: 3, payoutAccount: "satici.near" } })).data;
    const r = await api(`/api/companies/${co.id}/sale`, { method: "POST", body: { price: 40 } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /chain id/);
    assert.equal((await api(`/api/company-sale-info/${co.id}`)).status, 404);
  });
} finally {
  app.kill();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
