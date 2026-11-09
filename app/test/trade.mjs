// Agent-to-agent trade: a web agency takes a job, buys a UI template, a product image and legal texts from other
// companies, pays them on delivery, and builds the site from their parts. No revenue is created by trading.
// Run: node test/trade.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { SECTORS } from "../src/sectors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8919, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-trade-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json() }; };
const USD = 1e6;

const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", AUCTION_WINDOW_MS: "600" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const found = async (body) => { const r = await api("/api/companies", { method: "POST", body: { provider: "mock", model: "mock/small", seed: 5, payoutAccount: "kadraj-test.near", ...body } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const get = async (id) => (await api("/api/companies")).data.find((c) => c.id === id);

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let web, ui, ui2, vis, law, job;

  await test("sectors list the UI/UX studio, the legal office and what web agencies buy", async () => {
    const { data } = await api("/api/sectors");
    assert.equal(data.design.name, "UI/UX Template Studio");
    assert.equal(data.legal.name, "Digital Law Office");
    assert.deepEqual(data.web.needs, ["design", "visual", "legal"]);
    assert.equal(data.design.system, undefined, "system prompt stays on the server");
  });

  await test("five companies open for business", async () => {
    law = await found({ name: "Madde Hukuk", sector: "legal", price: 0.5 });
    ui = await found({ name: "Kalıp UI", sector: "design", price: 0.4 });
    ui2 = await found({ name: "Pahalı UI", sector: "design", price: 0.9 });
    vis = await found({ name: "Vitrin Görsel", sector: "visual", price: 0.3, imageModel: "mock/image" });
    web = await found({ name: "Sitehane", sector: "web", price: 2 });
  });

  await test("the web agency lists its parts, the suppliers win the sealed rounds, and it waits", async () => {
    job = (await api(`/api/companies/${web.id}/jobs`, { method: "POST", body: { brief: "Seramik kupa satan e-ticaret sitesi" } })).data;
    const waiting = await until(async () => (await api(`/api/companies/${web.id}/jobs`)).data.find((j) => j.id === job.id && j.subs?.length === 3));
    assert.deepEqual(waiting.subs.map((s) => s.name).sort(), ["Kalıp UI", "Madde Hukuk", "Vitrin Görsel"]);
  });

  await test("suppliers deliver, the image is drawn, and the site uses both parts", async () => {
    const done = await until(async () => (await api(`/api/companies/${web.id}/jobs`)).data.find((j) => j.id === job.id && j.status === "done"));
    assert.match(done.output, /Parts from suppliers/);
    assert.match(done.output, /Kalıp UI/);
    const visJob = (await api(`/api/companies/${vis.id}/jobs`)).data.find((j) => j.source === "b2b");
    assert.ok(visJob.image && visJob.b2bPaid);
    const img = await fetch(base + visJob.image);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
  });

  await test("buyers pay suppliers on delivery", async () => {
    const [w, u, u2, v, l] = await Promise.all([get(web.id), get(ui.id), get(ui2.id), get(vis.id), get(law.id)]);
    assert.equal(w.ledger.b2bOut, 1.2 * USD);
    assert.equal(l.ledger.b2bIn, 0.5 * USD);
    assert.equal(u.ledger.b2bIn, 0.4 * USD);
    assert.equal(v.ledger.b2bIn, 0.3 * USD);
    assert.equal(u2.ledger.b2bIn, 0, "the pricier studio got no order");
  });

  await test("trading creates no revenue and the books still balance", async () => {
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
    const city = (await api("/api/city")).data;
    assert.equal(city.trades.length, 3);
    assert.ok(city.trades.every((t) => t.from === web.id));
    // Revenue only from the web agency's own customer (simulated purchase is on in this local run).
    assert.equal(city.books.externalIn, 2 * USD);
    assert.equal(city.sectors.design.form, "web");
  });

  await test("the legal office delivers the legal texts, drafted as not-legal-advice", async () => {
    const lawJob = (await api(`/api/companies/${law.id}/jobs`)).data.find((j) => j.source === "b2b");
    assert.equal(lawJob.status, "done");
    assert.match(lawJob.brief, /privacy policy/);
    // The demo model does not follow prompts, so the rule is checked where it lives: the sector's system prompt.
    assert.match(SECTORS.legal.system, /not legal advice/);
    assert.match(SECTORS.legal.system, /not a lawyer/);
  });

  await test("a part order never orders parts of its own", async () => {
    const uiJobs = (await api(`/api/companies/${ui.id}/jobs`)).data;
    assert.equal(uiJobs.length, 1);
    assert.equal(uiJobs[0].source, "b2b");
    assert.ok(!uiJobs[0].subs);
  });
} finally {
  app.kill();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
