// Fuel: when a company runs on the platform's model key, the platform pays the provider and the company owes it
// back. The bill rides on the tax invoice, or goes out early once it passes a threshold; paying it moves money to
// the platform without touching the books twice. The admin's tank shows what was loaded, spent and collected.
// Run: node test/fuel.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import * as econ from "../src/economy.mjs";
import { createTaxes } from "../src/taxes.mjs";
import { createFuel } from "../src/fuel.mjs";
import { startFake } from "./fake-openrouter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8955, FAKE = 9955, KEY = "sk-or-fuel-test-key", base = `http://127.0.0.1:${PORT}`, USD = 1e6;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-fuel-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

const company = (books, id, seed) => { const co = { id, name: "Şirket " + id, createdAt: 0, ledger: econ.newLedger(), log: [] }; econ.seed(books, co, seed); return co; };

/* ---------- the rules ---------- */
await test("a model bill on the platform's key is fuel; on the company's own key it is not", () => {
  const books = econ.newBooks(), co = company(books, 1, 5 * USD);
  econ.aiCost(books, co, 300_000, "nearai");
  econ.aiCost(books, co, 200_000, null);
  assert.equal(co.ledger.aiCost, 500_000);
  assert.equal(co.ledger.fuel, 300_000);
  assert.deepEqual(co.ledger.fuelBy, { nearai: 300_000 });
  assert.ok(econ.check(books, [co]).balanceOk);
  econ.aiCost(books, co, 999, "mock");
  assert.equal(co.ledger.fuel, 300_000, "the demo model costs the platform nothing, so it is not fuel");
});

await test("the tank meters calls made with the platform's key, never a company's own key", async () => {
  const store = { save() {} }, fuel = createFuel({ store, warnMicros: 2 * USD });
  const p = fuel.meter("nearai", { chat: async () => ({ costMicros: 1000 }), models: () => "kept" });
  await p.chat({ model: "m" }); await p.chat({ model: "m", key: "own" });
  assert.equal(store.fuel.spent.nearai, 1000);
  assert.equal(p.models(), "kept", "other provider methods still work");
  assert.equal(fuel.view().providers.nearai.level, "unknown", "no top-up recorded yet");
  fuel.topup("nearai", 10 * USD, "kart");
  const v = fuel.view().providers.nearai;
  assert.deepEqual([v.loadedMicros, v.spentMicros, v.remainingMicros, v.level], [10 * USD, 1000, 10 * USD - 1000, "ok"]);
  assert.throws(() => fuel.topup("other", 1), /nearai or openrouter/);
});

// A month's invoice carries tax and fuel together; paying it settles both but deducts only the tax.
await test("the month's invoice adds fuel to tax; paying it deducts only the tax from the books", async () => {
  let t = 0, collected = 0; const sessions = {};
  const ping = { createSession: async (a) => { sessions.s1 = { status: "CREATED", amountMicros: a.amountMicros }; return { sessionId: "s1", url: "u" }; }, getSession: async (id) => sessions[id] };
  const books = econ.newBooks(), co = company(books, 1, 5 * USD), store = { companies: [co], books, save() {} };
  const taxes = createTaxes({ store, ping, platformAccount: "valley.near", bps: 200, minMicros: 1, periodMs: 1000, fuelBillMicros: 50 * USD, onFuelPaid: (_c, m) => (collected += m), now: () => t });
  taxes.tick();
  econ.sale(books, co, 10 * USD); econ.aiCost(books, co, 2 * USD, "nearai");
  t = 1500; taxes.tick();
  const inv = co.tax.invoices[0];
  assert.equal(inv.taxMicros, 160_000, "2% of $8 profit");
  assert.equal(inv.fuelMicros, 2 * USD);
  const before = econ.balance(co.ledger);
  await taxes.checkout(co, inv.id, "http://x");
  assert.equal(sessions.s1.amountMicros, 2_160_000, "the customer of the platform pays tax plus fuel at once");
  sessions.s1.status = "COMPLETED"; t = 5000;
  await taxes.confirm(co);
  assert.equal(inv.status, "paid");
  assert.equal(before - econ.balance(co.ledger), 160_000, "fuel was already counted when the job ran");
  assert.equal(collected, 2 * USD);
  assert.equal(taxes.fuelOwed(co), 0);
  assert.ok(econ.check(books, [co]).balanceOk);
});

await test("fuel past the threshold is billed before the month ends, and an unpaid bill stops new orders", () => {
  let t = 0;
  const books = econ.newBooks(), co = company(books, 1, 5 * USD), store = { companies: [co], books, save() {} };
  const taxes = createTaxes({ store, ping: null, platformAccount: "", minMicros: 1, periodMs: 10_000_000, graceMs: 100, fuelBillMicros: 1 * USD, now: () => t });
  taxes.tick();
  econ.aiCost(books, co, 600_000, "openrouter"); taxes.tick();
  assert.equal(co.tax.invoices.length, 0, "under the threshold");
  econ.aiCost(books, co, 600_000, "openrouter"); taxes.tick();
  assert.equal(co.tax.invoices[0].kind, "fuel");
  assert.equal(co.tax.invoices[0].fuelMicros, 1_200_000);
  assert.equal(taxes.fuelOwed(co), 0);
  t = 1000;
  assert.equal(taxes.overdue(co), true);
});

/* ---------- through the server ---------- */
const { server: fake } = await startFake(FAKE, KEY);
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", AUCTION_WINDOW_MS: "300", NEAR_CONTRACT: "", FUEL_BILL_USD: "0.0001", TAX_MIN_MICROS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  await test("a company on the platform's key burns fuel, gets a fuel invoice, and the admin's tank shows it", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Yakıtlı", sector: "research", provider: "openrouter", model: "test/cheap", price: 0.5, seed: 2, payoutAccount: "x.near" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Kahve pazarı" } });
    const co = await until(async () => { const c = (await api("/api/companies")).data.find((x) => x.id === r.data.id); return c.tax.invoices.some((i) => i.kind === "fuel") && c; });
    const inv = co.tax.invoices.find((i) => i.kind === "fuel");
    assert.ok(inv.fuelMicros > 0 && inv.totalMicros === inv.fuelMicros);
    await api("/api/fuel/topup", { method: "POST", body: { provider: "openrouter", amount: 10, note: "test" } });
    const f = (await api("/api/fuel")).data;
    assert.ok(f.providers.openrouter.spentMicros >= inv.fuelMicros, "the tank counted the same calls");
    assert.equal(f.providers.openrouter.loadedMicros, 10 * USD);
    assert.equal(f.providers.openrouter.level, "ok");
    assert.equal(f.companies[0].name, "Yakıtlı");
    assert.ok(f.owedMicros >= inv.fuelMicros);
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
  });
} finally {
  app.kill(); fake.close();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
