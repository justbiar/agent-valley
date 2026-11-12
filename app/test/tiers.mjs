// Two ways to order. A trial (paid in testnet NEAR) runs on the company's free trial model with a short answer;
// a full order (paid in real USDC through PingPay, to the company's own account) runs on its main model. The server
// starts a full order only when PingPay itself says the session COMPLETED.
// Run: node test/tiers.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFake } from "./fake-openrouter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8931, FAKE = 9951, PING = 9952, KEY = "sk-or-tiers-0123456789abcdef", PK = "pk_test_tiers_0123", base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-tiers-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };

// PingPay stand-in: the test flips a session's status the way a paying customer would.
const sessions = new Map();
const ping = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-api-key"] !== PK) return json(401, { message: "Invalid key" });
    if (req.method === "POST" && req.url === "/api/checkout/sessions") {
      const b = JSON.parse(body), id = "cs_" + (sessions.size + 1);
      sessions.set(id, { ...b, status: "CREATED" });
      return json(200, { session: { sessionId: id, status: "CREATED" }, sessionUrl: `https://checkout.pingpay.io/session/${id}` });
    }
    const m = req.url.match(/^\/api\/checkout\/sessions\/(cs_\d+)$/);
    if (m && sessions.has(m[1])) { const s = sessions.get(m[1]); return json(200, { session: { sessionId: m[1], status: s.status, paymentId: s.status === "COMPLETED" ? "pay_" + m[1] : null } }); }
    json(404, { message: "not found" });
  });
}).listen(PING, "127.0.0.1");

const { server: fake, seen } = await startFake(FAKE, KEY);
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, NEARAI_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1",
    DATA_FILE: dataFile, TICK_MS: "150", NEAR_ACCOUNT_CHECK: "0", ALLOW_SIM_PURCHASE: "0", ADMIN_TOKEN: "", NEAR_CONTRACT: "",
    PINGPAY_API_KEY: PK, PINGPAY_BASE_URL: `http://127.0.0.1:${PING}/api` },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let co;

  await test("a company on a paid model gets a free trial model on its own", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Tier Labs", sector: "research", provider: "openrouter", model: "test/cheap", price: 2, seed: 3, payoutAccount: "tierlabs.near", portfolio: { enabled: false } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    co = r.data;
    assert.equal(co.trial.provider, "openrouter");
    const models = (await api("/api/models?provider=openrouter")).data;
    const m = (Array.isArray(models) ? models : models.models || []).find((x) => x.id === co.trial.model);
    assert.ok(!m || m.free, `the automatic trial model is free (${co.trial.model})`);
  });

  await test("the founder picks the trial model; an unknown model is refused and the pick is kept", async () => {
    const r = await api(`/api/companies/${co.id}`, { method: "PATCH", body: { trialModel: "test/free:free", trialProvider: "openrouter" } });
    assert.equal(r.data.trial.model, "test/free:free");
    assert.equal((await api(`/api/companies/${co.id}`, { method: "PATCH", body: { trialModel: "nope/model", trialProvider: "openrouter" } })).status, 400);
    assert.equal((await api("/api/companies")).data.find((x) => x.id === co.id).trial.model, "test/free:free");
  });

  await test("a trial job runs on the trial model with a short answer; a full job on the main model", async () => {
    const before = seen.length;
    const trial = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A short market note on tea", tier: "trial" } })).data;
    await until(async () => (await api(`/api/companies/${co.id}/jobs`)).data.find((j) => j.id === trial.id && j.status === "done"));
    const t = seen.slice(before).find((c) => !c.image);
    assert.equal(t.model, "test/free:free");
    assert.ok(t.maxTokens <= 700, "trial answers are capped: " + t.maxTokens);
    const at = seen.length;
    const full = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A full market report on coffee" } })).data;
    await until(async () => (await api(`/api/companies/${co.id}/jobs`)).data.find((j) => j.id === full.id && j.status === "done"));
    const f = seen.slice(at).find((c) => !c.image);
    assert.equal(f.model, "test/cheap");
    assert.ok(f.maxTokens > 700);
  });

  let order;
  await test("a full order opens a PingPay checkout for the price, payable to the company's own account", async () => {
    const r = await api("/api/paid-orders", { method: "POST", body: { companyId: co.id, brief: "A competitor analysis for a bakery" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    order = r.data;
    assert.equal(order.status, "awaiting_payment");
    assert.match(order.payUrl, /checkout\.pingpay\.io/);
    const s = sessions.get("cs_1");
    assert.equal(s.amount, String(2_000_000));
    assert.equal(s.recipient.address, "tierlabs.near");
    assert.equal(s.asset.symbol, "USDC");
  });

  await test("nothing starts until PingPay itself says COMPLETED", async () => {
    await api(`/api/paid-orders/${order.id}/check?t=${order.token}`, { method: "POST" });
    await sleep(400);
    assert.equal((await api(`/api/paid-orders/${order.id}?t=${order.token}`)).data.status, "awaiting_payment");
    assert.equal((await api(`/api/paid-orders/${order.id}?t=wrong`)).status, 404, "the token guards the order");
  });

  await test("once paid, the main model does the job and the sale is booked", async () => {
    const revenueBefore = (await api("/api/companies")).data.find((x) => x.id === co.id).ledger.revenue;
    sessions.get("cs_1").status = "COMPLETED";
    const done = await until(async () => { const o = (await api(`/api/paid-orders/${order.id}?t=${order.token}`)).data; return o.status === "delivered" && o; });
    assert.equal(done.paymentId, "pay_cs_1");
    assert.equal(done.job.model, "test/cheap");
    assert.ok(done.job.output.length > 0);
    const after = (await api("/api/companies")).data.find((x) => x.id === co.id).ledger.revenue;
    assert.equal(after - revenueBefore, 2_000_000);
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk, "the books stay balanced");
  });

  await test("a cancelled checkout is cancelled, and the order page knows both ways", async () => {
    const o = (await api("/api/paid-orders", { method: "POST", body: { companyId: co.id, brief: "Another report please" } })).data;
    sessions.get("cs_2").status = "CANCELLED";
    await until(async () => (await api(`/api/paid-orders/${o.id}?t=${o.token}`)).data.status === "cancelled");
    const info = (await api(`/api/order-info/${co.id}`)).data;
    assert.equal(info.tiers.full.open, true);
    assert.equal(info.tiers.full.model, "test/cheap");
    assert.equal(info.tiers.trial.model, "test/free:free");
    assert.equal(info.tiers.trial.open, false, "no contract here, so no testnet trials");
  });
} finally {
  app.kill(); fake.close(); ping.close();
}
for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
