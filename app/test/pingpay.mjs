// Real customer payment through PingPay hosted checkout, against a local stand-in for the PingPay API.
// Nothing unlocks until the server itself sees the session COMPLETED at PingPay.
// Run: node test/pingpay.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8929, PING = 9941, SHOP = 9942, RPC = 9943, base = `http://127.0.0.1:${PORT}`, PK = "pk_test_valley_0123";
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-ping-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };

// PingPay stand-in: remembers sessions; the test flips their status like a paying customer would.
const sessions = new Map();
const ping = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-publishable-key"] !== PK && req.headers["x-api-key"] !== PK) return json(401, { code: "UNAUTHENTICATED", message: "Invalid or missing publishable key." });
    if (req.method === "POST" && req.url === "/api/checkout/sessions") {
      const b = JSON.parse(body), id = "cs_" + (sessions.size + 1);
      sessions.set(id, { ...b, status: "CREATED" });
      return json(200, { session: { sessionId: id, status: "CREATED", paymentId: null, recipient: b.recipient }, sessionUrl: `https://checkout.pingpay.io/session/${id}` });
    }
    const m = req.url.match(/^\/api\/checkout\/sessions\/(cs_\d+)$/);
    if (m && sessions.has(m[1])) { const s = sessions.get(m[1]); return json(200, { session: { sessionId: m[1], status: s.status, paymentId: s.status === "COMPLETED" ? "pay_1" : null } }); }
    json(404, { code: "NOT_FOUND", message: "Checkout session not found." });
  });
}).listen(PING, "127.0.0.1");
// NEAR RPC stand-in: only these mainnet accounts exist.
const onChain = new Set(["kadraj.near", "vitrin.near", "valley.near"]);
const rpc = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const id = JSON.parse(body).params.account_id;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(onChain.has(id) ? { jsonrpc: "2.0", id: "x", result: { amount: "1" } } : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }));
  });
}).listen(RPC, "127.0.0.1");
const shopSite = http.createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Kil Atölyesi</title><h1>El yapımı seramik</h1>"); }).listen(SHOP, "127.0.0.1");

const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, TICK_MS: "150", AUCTION_WINDOW_MS: "600", ALLOW_PRIVATE_FETCH: "1", ALLOW_SIM_PURCHASE: "0",
    PINGPAY_API_KEY: PK, PINGPAY_BASE_URL: `http://127.0.0.1:${PING}/api`, NEAR_RPC_URL: `http://127.0.0.1:${RPC}`, PINGPAY_PLATFORM_ACCOUNT: "valley.near", TAX_BPS: "200", TAX_PERIOD_MS: "4000", TAX_GRACE_MS: "2500", TAX_MIN_MICROS: "1000" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let co, order;

  await test("every company needs its own NEAR mainnet account, checked on chain", async () => {
    const tryOpen = (payoutAccount) => api("/api/companies", { method: "POST", body: { name: "Hesapsız", sector: "visual", provider: "mock", model: "mock/small", imageModel: "mock/image", price: 1.5, seed: 3, payoutAccount } });
    assert.match((await tryOpen(undefined)).data.error, /Enter the company's NEAR account/);
    assert.match((await tryOpen("not a wallet!")).data.error, /valid NEAR account/);
    assert.match((await tryOpen("kadraj.testnet")).data.error, /\.testnet/);
    assert.match((await tryOpen("yazim-hatasi.near")).data.error, /was not found/);
    assert.equal((await api("/api/companies")).data.length, 0);
  });

  await test("the shop takes PingPay payments", async () => {
    co = (await api("/api/companies", { method: "POST", body: { name: "Vitrin Kapak", sector: "visual", provider: "mock", model: "mock/small", imageModel: "mock/image", price: 1.5, seed: 3, payoutAccount: "Kadraj.near" } })).data;
    assert.equal(co.payoutAccount, "kadraj.near");
    assert.equal((await api(`/api/shop/${co.id}`)).data.payments, "pingpay");
  });

  await test("the founder can move payouts to another verified account, and the change is logged", async () => {
    assert.equal((await api(`/api/companies/${co.id}`, { method: "PATCH", body: { payoutAccount: "nope-not-here.near" } })).status, 400);
    const r = await api(`/api/companies/${co.id}`, { method: "PATCH", body: { payoutAccount: "vitrin.near" } });
    assert.equal(r.data.payoutAccount, "vitrin.near");
    assert.match(r.data.log[0].text, /kadraj\.near → vitrin\.near/);
    await api(`/api/companies/${co.id}`, { method: "PATCH", body: { payoutAccount: "kadraj.near" } });
  });

  await test("an order makes a watermarked preview", async () => {
    order = (await api("/api/orders", { method: "POST", body: { companyId: co.id, url: `http://127.0.0.1:${SHOP}/` } })).data;
    order = await until(async () => { const o = (await api(`/api/orders/${order.id}?t=${order.token}`)).data; return o.previews?.length ? { ...o, token: order.token } : null; });
  });

  await test("simulated purchase stays closed", async () => {
    assert.equal((await api(`/api/orders/${order.id}/purchase`, { method: "POST", body: { t: order.token, n: 1 } })).status, 402);
  });

  await test("checkout opens a PingPay session for the exact price, straight to the founder, with no fee", async () => {
    assert.equal((await api(`/api/orders/${order.id}/checkout`, { method: "POST", body: { t: "wrong", n: 1 } })).status, 404);
    const r = await api(`/api/orders/${order.id}/checkout`, { method: "POST", body: { t: order.token, n: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.url, /^https:\/\/checkout\.pingpay\.io\/session\/cs_1$/);
    const s = sessions.get("cs_1");
    assert.equal(s.amount, "1500000");
    assert.deepEqual(s.asset, { chain: "NEAR", symbol: "USDC" });
    assert.equal(s.recipient.address, "kadraj.near");
    assert.equal(s.fees, undefined, "the platform takes nothing per sale");
    assert.match(s.successUrl, new RegExp(`o=${order.id}&t=${order.token}&paid=1$`));
  });

  await test("nothing unlocks while the payment is pending", async () => {
    const o = (await api(`/api/orders/${order.id}?t=${order.token}`)).data;
    assert.equal(o.purchased, null);
    assert.equal(o.checkout.pending, true);
    assert.equal((await fetch(`${base}/img/${order.id}/1/full.png?t=${order.token}`)).status, 403);
  });

  await test("once PingPay reports COMPLETED the clean file unlocks and real revenue is booked", async () => {
    sessions.get("cs_1").status = "COMPLETED";
    const o = await until(async () => { const x = (await api(`/api/orders/${order.id}?t=${order.token}`)).data; return x.purchased ? x : null; }, 8000);
    assert.equal(o.purchased.via, "pingpay");
    assert.equal((await fetch(`${base}/img/${order.id}/1/full.png?t=${order.token}`)).status, 200);
    const c = (await api("/api/companies")).data.find((x) => x.id === co.id);
    assert.equal(c.ledger.revenue, 1_500_000);
    const city = (await api("/api/city")).data;
    assert.equal(city.books.externalIn, 1_500_000);
    assert.equal(city.companies.find((x) => x.id === co.id).sales, 1);
    assert.equal(city.companies.find((x) => x.id === co.id).payoutAccount, "kadraj.near");
  });

  await test("the company's own account shows what came in", async () => {
    const a = (await api("/api/companies")).data.find((x) => x.id === co.id).account;
    assert.equal(a.payoutAccount, "kadraj.near");
    assert.equal(a.nearSales, 1);
    assert.equal(a.nearInMicros, 1_500_000);
    assert.equal(a.recent[0].paymentId, "pay_1");
  });

  let invoices;
  await test("at the period's end 2% of the profit becomes a tax invoice", async () => {
    // Fuel can be billed before the first sale, so wait until the profit itself has been invoiced.
    invoices = await until(async () => { const t = (await api(`/api/companies/${co.id}/taxes`)).data; return t.invoices?.reduce((a, i) => a + i.taxableMicros, 0) > 1_400_000 ? t.invoices : null; }, 15000);
    // Losses carry forward, so the taxed base is sales minus the model bill even if they fell in different periods.
    const total = invoices.reduce((a, i) => a + i.taxableMicros, 0), taxed = invoices.reduce((a, i) => a + i.taxMicros, 0);
    assert.ok(total > 1_400_000 && total < 1_500_000, "taxable profit is sales minus the model bill: " + total);
    assert.ok(Math.abs(taxed - total * 0.02) <= invoices.length + 1, `tax ${taxed} is 2% of ${total}`);
    assert.ok(invoices.every((i) => i.bps === 200));
  });

  await test("an overdue tax stops new customer orders", async () => {
    await sleep(2800);
    const r = await api("/api/orders", { method: "POST", body: { companyId: co.id, url: `http://127.0.0.1:${SHOP}/` } });
    assert.equal(r.status, 402);
    assert.match(r.data.error, /tax/);
    assert.equal((await api(`/api/companies/${co.id}/taxes`)).data.overdue, true);
  });

  await test("the founder pays the tax on chain to the platform account and orders open again", async () => {
    for (const inv of invoices.filter((i) => i.status === "due")) {
      const r = await api(`/api/companies/${co.id}/tax-checkout`, { method: "POST", body: { invoiceId: inv.id } });
      assert.match(r.data.url, /checkout\.pingpay\.io/);
      const id = r.data.url.split("/").pop(), sess = sessions.get(id);
      assert.equal(sess.recipient.address, "valley.near");
      assert.equal(sess.amount, String(inv.totalMicros), "tax plus the fuel the platform key burned");
      assert.equal(inv.totalMicros, inv.taxMicros + inv.fuelMicros);
      sess.status = "COMPLETED";
    }
    const t = await until(async () => { const x = (await api(`/api/companies/${co.id}/taxes`)).data; return x.invoices.every((i) => i.status === "paid") && !x.overdue ? x : null; }, 8000);
    const c = (await api("/api/companies")).data.find((x) => x.id === co.id);
    assert.equal(c.ledger.taxPaid, t.invoices.reduce((a, i) => a + i.taxMicros, 0));
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
    assert.equal((await api("/api/orders", { method: "POST", body: { companyId: co.id, url: `http://127.0.0.1:${SHOP}/` } })).status, 200);
  });

  await test("the owner closes a company and the books still balance", async () => {
    const r = await api(`/api/companies/${co.id}`, { method: "DELETE", body: { reason: "test" } });
    assert.equal(r.data.closed, co.id);
    assert.equal((await api("/api/companies")).data.length, 0);
    assert.equal((await api(`/api/shop/${co.id}`)).status, 400);
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
    assert.equal((await api("/api/city")).data.companies.length, 0);
  });
} finally {
  app.kill(); ping.close(); shopSite.close(); rpc.close();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
