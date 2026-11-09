// Company shares: the founder's split, agent-only buyers paying from capital, pool grants and dividends.
// The books must hold after every step, and an investment ring must not raise NER.
// Run: node test/shares.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as shares from "../src/shares.mjs";
import * as econ from "../src/economy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8951, base = `http://127.0.0.1:${PORT}`, USD = 1e6;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-shares-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

// A tiny valley of plain objects for the rules on their own.
function valley() {
  const books = econ.newBooks(), store = { investments: [] }, list = [];
  const make = (id, name, seed, charter) => { const co = { id, name, stage: "idea", ledger: econ.newLedger() }; econ.seed(books, co, seed); shares.issue(co, shares.parseCharter(charter)); list.push(co); return co; };
  const ok = () => { const c = econ.check(books, list); assert.ok(c.nerOk && c.balanceOk, "books hold"); };
  return { books, store, list, make, ok, byId: (id) => list.find((c) => c.id === id) };
}

/* ---------- the rules ---------- */
await test("the charter splits a million shares and prices them from the valuation", () => {
  const c = shares.parseCharter({ founderPct: 60, salePct: 25, valuation: 200 });
  assert.deepEqual(c, { founderBps: 6000, saleBps: 2500, priceMicros: 200 });
  const co = { id: 1 }; shares.issue(co, c);
  assert.equal(co.shares.holders[0].shares, 600_000);
  assert.equal(co.shares.forSale, 250_000);
  assert.equal(co.shares.pool, 150_000);
  assert.deepEqual(co.charter, { founderBps: 6000, saleBps: 2500, sharePriceYocto: "1" }, "the chain mirror gets the same split");
  assert.throws(() => shares.parseCharter({ founderPct: 5 }), /founder stake/);
  assert.throws(() => shares.parseCharter({ founderPct: 80, salePct: 30 }), /100%/);
});

await test("an agent buys shares from capital and becomes a partner; the books hold", () => {
  const v = valley();
  const a = v.make(1, "Sitehane", 2 * USD, { founderPct: 70, salePct: 20, valuation: 100 });
  const b = v.make(2, "Kalıp", 5 * USD, {});
  const { entry, stage } = shares.buy(v.store, b, a, 10_000); // 10,000 x 100 micros = $1
  assert.equal(entry.amount, 1 * USD);
  assert.equal(b.ledger.capital, 4 * USD);
  assert.equal(a.ledger.capital, 3 * USD);
  assert.equal(a.ledger.raised, 1 * USD);
  assert.equal(stage, "funded");
  assert.equal(a.shares.forSale, 190_000);
  assert.deepEqual(shares.holdingsOf(b, v.list).map((h) => [h.name, h.shares]), [["Sitehane", 10_000]]);
  v.ok();
});

await test("earned money cannot buy shares, and nobody buys more than is for sale", () => {
  const v = valley();
  const a = v.make(1, "A", 1 * USD, { valuation: 100 }), b = v.make(2, "B", 0, {});
  econ.sale(v.books, b, 5 * USD);
  assert.throws(() => shares.buy(v.store, b, a, 10), /capital/);
  assert.throws(() => shares.buy(v.store, a, b, 200_001), /for sale/);
  assert.throws(() => shares.buy(v.store, a, a, 1), /its own shares/);
});

await test("an investment ring does not raise NER", () => {
  const v = valley();
  const a = v.make(1, "A", 5 * USD, {}), b = v.make(2, "B", 5 * USD, {});
  econ.sale(v.books, a, 1 * USD);
  for (let i = 0; i < 20; i++) { shares.buy(v.store, a, b, 1000); shares.buy(v.store, b, a, 1000); }
  assert.equal(a.ledger.ner + b.ledger.ner, 1 * USD);
  v.ok();
});

await test("the pool grants shares to a partner agent", () => {
  const v = valley();
  const a = v.make(1, "A", 1 * USD, { founderPct: 70, salePct: 20 }), b = v.make(2, "B", 1 * USD, {});
  shares.grant(v.store, a, b, 50_000);
  assert.equal(a.shares.pool, 50_000);
  assert.throws(() => shares.grant(v.store, a, b, 50_001), /in the pool/);
});

await test("a dividend pays partners with its NER and keeps the founder's part in the company", () => {
  const v = valley();
  const a = v.make(1, "A", 1 * USD, { founderPct: 75, salePct: 25, valuation: 1 }), b = v.make(2, "B", 1 * USD, {});
  shares.buy(v.store, b, a, 250_000); // a quarter of a, $0.25
  econ.sale(v.books, a, 4 * USD);
  const r = shares.dividend(v.store, a, 2 * USD, v.byId);
  assert.equal(r.out, 0.5 * USD);
  assert.equal(r.kept, 1.5 * USD);
  assert.equal(b.ledger.earned, 0.5 * USD);
  assert.equal(b.ledger.ner, 0.5 * USD, "revenue a partner receives keeps its origin");
  assert.equal(a.ledger.earned, 3.5 * USD);
  assert.throws(() => shares.dividend(v.store, a, 10 * USD, v.byId), /earned revenue/);
  v.ok();
});

/* ---------- through the server ---------- */
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", AUCTION_WINDOW_MS: "600", NEAR_CONTRACT: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const found = async (body) => { const r = await api("/api/companies", { method: "POST", body: { provider: "mock", model: "mock/small", seed: 5, payoutAccount: "kadraj-test.near", price: 0.5, ...body } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let a, b;
  await test("founding takes the charter and the market lists the shares", async () => {
    a = await found({ name: "Sitehane", sector: "web", charter: { founderPct: 60, salePct: 30, valuation: 100 } });
    b = await found({ name: "Kalıp", sector: "design" });
    assert.equal(a.shares.forSale, 300_000);
    assert.equal(a.shares.valuationMicros, 100 * USD);
    assert.equal(b.shares.forSale, 200_000, "default charter 70/20/10");
    const r = await api("/api/companies", { method: "POST", body: { provider: "mock", model: "mock/small", seed: 5, payoutAccount: "x.near", name: "Bozuk", sector: "web", price: 1, charter: { founderPct: 5 } } });
    assert.equal(r.status, 400);
    const m = (await api("/api/market")).data;
    assert.equal(m.find((x) => x.id === a.id).forSale, 300_000);
  });

  await test("Kalıp buys 20,000 Sitehane shares: partners on both sides, in the city, books balanced", async () => {
    const r = await api(`/api/companies/${b.id}/buy-shares`, { method: "POST", body: { target: a.id, shares: 20_000 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.holdings[0].name, "Sitehane");
    assert.equal(r.data.ledger.capital, 3 * USD, "$5 seed minus 20,000 x $0.0001");
    const sa = (await api("/api/companies")).data.find((x) => x.id === a.id);
    assert.equal(sa.stage, "funded");
    assert.ok(sa.shares.holders.some((h) => h.name === "Kalıp" && h.shares === 20_000));
    const city = (await api("/api/city")).data;
    assert.equal(city.investments[0].kind, "buy");
    assert.equal(city.companies.find((x) => x.id === a.id).shares.partners[0].name, "Kalıp");
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
  });

  await test("too many shares or too little capital is refused with the reason", async () => {
    let r = await api(`/api/companies/${b.id}/buy-shares`, { method: "POST", body: { target: a.id, shares: 999_999 } });
    assert.equal(r.status, 400); assert.match(r.data.error, /for sale/);
    r = await api(`/api/companies/${a.id}/buy-shares`, { method: "POST", body: { target: b.id, shares: 200_000 } });
    assert.equal(r.status, 400); assert.match(r.data.error, /capital/);
  });
} finally {
  app.kill();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
