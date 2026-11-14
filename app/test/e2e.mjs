// End-to-end test: the real server against a fake OpenRouter. No key, no network, no spend.
// Run: node test/e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import http from "node:http";
import { startFake } from "./fake-openrouter.mjs";
import { checkUrl } from "../src/webresearch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-or-test-0123456789abcdef";
const FAKE = 9911, PORT = 8899, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every company needs its own NEAR payout account; founding calls without one get a test account here.
const api = async (p, opt = {}) => {
  if (p === "/api/companies" && opt.method === "POST" && opt.body && !("payoutAccount" in opt.body)) opt = { ...opt, body: { ...opt.body, payoutAccount: "kadraj-test.near" } };
  const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json", ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const data = await res.json();
  return { status: res.status, data };
};
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };

const { server: fake, seen } = await startFake(FAKE, KEY);
// A shop page for the research agent to read.
const SHOP = 9912;
const shopSite = http.createServer((req, res) => {
  if (req.url === "/moved") { res.writeHead(302, { Location: "/" }); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Kil Atölyesi · El yapımı seramik</title><meta name="description" content="El yapımı kupa ve tabaklar"><meta property="og:site_name" content="Kil Atölyesi"><meta name="theme-color" content="#c8553d"><script>alert("ignore me")</script><script type="application/ld+json">{"@type":"Product","name":"Terracotta Kupa","brand":{"name":"Kil Atölyesi"},"offers":{"price":"340"}}</script></head><body><h1>El yapımı seramik</h1><p>Her kupa tek tek elde şekillendirilir.</p></body></html>`);
}).listen(SHOP, "127.0.0.1");
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "200", AUCTION_WINDOW_MS: "600", ALLOW_PRIVATE_FETCH: "1", ORDERS_PER_IP_PER_DAY: "3" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);

  await test("starts empty", async () => {
    const { data } = await api("/api/companies");
    assert.equal(data.length, 0);
  });

  await test("reads key status from OpenRouter", async () => {
    const { data } = await api("/api/status");
    assert.equal(data.providers.openrouter.status.ok, true);
    assert.equal(data.providers.openrouter.status.limitRemaining, 4.2);
    assert.equal(data.providers.openrouter.keySource, "env");
  });

  await test("lists models with per-job estimates, free flag from :free", async () => {
    const { data } = await api("/api/models?provider=openrouter");
    const cheap = data.find((m) => m.id === "test/cheap"), free = data.find((m) => m.id === "test/free:free");
    assert.ok(Math.abs(cheap.promptPerM - 0.2) < 1e-9 && Math.abs(cheap.completionPerM - 0.8) < 1e-9);
    assert.equal(cheap.estimateMicros, 680);
    assert.equal(free.free, true);
  });

  let shop;
  await test("founds a company with seed capital", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Kadraj", sector: "visual", provider: "openrouter", model: "test/cheap", price: 0.05, seed: 2, limits: { maxJobsPerHour: 10, dailyAiBudget: 1 } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    shop = r.data;
    assert.equal(shop.stage, "idea");
    assert.equal(shop.ledger.capital, 2_000_000);
  });

  await test("runs queued jobs, books real model cost and simulated revenue", async () => {
    for (const b of ["Seramik kupa görselleri", "Kulaklık görselleri", "Zeytinyağı görselleri"]) await api(`/api/companies/${shop.id}/jobs`, { method: "POST", body: { brief: b } });
    const co = await until(async () => { const { data } = await api("/api/companies"); const c = data.find((x) => x.id === shop.id); return c.jobsDone === 3 && c; });
    assert.equal(co.ledger.revenue, 150_000);
    assert.equal(co.ledger.aiCost, 6_300);
    assert.equal(co.ledger.profit, 143_700);
    assert.equal(co.ledger.ner, 150_000);
    const { data: jobs } = await api(`/api/companies/${shop.id}/jobs`);
    assert.ok(jobs[0].output.startsWith("Teslimat:"));
    assert.equal(jobs[0].tokens.completion, 300);
  });

  await test("sends attribution headers and the token cap", async () => {
    const call = seen.find((s) => s.model === "test/cheap");
    assert.equal(call.headers.title, "Agent Valley");
    assert.ok(call.headers.referer.startsWith("http://127.0.0.1"));
    assert.equal(call.maxTokens, 1600, "the default budget leaves room for reasoning models");
  });

  await test("investment moves the company to funded, then sales to headquarters", async () => {
    let r = await api(`/api/companies/${shop.id}/invest`, { method: "POST", body: { amount: 20 } });
    assert.equal(r.data.stage, "funded");
    await api(`/api/companies/${shop.id}`, { method: "PATCH", body: { price: 5 } });
    await api(`/api/companies/${shop.id}/jobs`, { method: "POST", body: { brief: "Büyük kampanya görselleri" } });
    const co = await until(async () => { const { data } = await api("/api/companies"); const c = data.find((x) => x.id === shop.id); return c.stage === "market" && c; });
    assert.equal(co.stage, "market");
  });

  await test("stops a company that loses money on every job", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Zarar AŞ", sector: "web", provider: "openrouter", model: "test/pricey", price: 0.01, seed: 5, limits: { maxJobsPerHour: 10, dailyAiBudget: 5 } } });
    for (let i = 0; i < 4; i++) await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Landing page " + i } });
    const co = await until(async () => { const { data } = await api("/api/companies"); const c = data.find((x) => x.id === r.data.id); return c.status === "unprofitable" && c; });
    assert.equal(co.jobsDone, 3);
    assert.equal(co.jobsQueued, 1);
  });

  await test("402 from OpenRouter pauses the company and keeps the job", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Kredisiz", sector: "research", provider: "openrouter", model: "test/broke", price: 0.05, seed: 1 } });
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Pazar raporu" } });
    const co = await until(async () => { const { data } = await api("/api/companies"); const c = data.find((x) => x.id === r.data.id); return c.status === "no_credits" && c; });
    assert.equal(co.jobsQueued, 1);
    assert.equal(co.ledger.aiCost, 0);
  });

  await test("429 waits for Retry-After, then the job runs", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Sabırlı", sector: "social", provider: "openrouter", model: "test/limited", price: 0.05, seed: 1 } });
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Instagram haftası" } });
    const co = await until(async () => { const { data } = await api("/api/companies"); const c = data.find((x) => x.id === r.data.id); return c.jobsDone === 1 && c; }, 10000);
    assert.equal(co.status, "running");
  });

  await test("office hours keep jobs waiting outside the schedule", async () => {
    const h = new Date().getHours(), start = (h + 2) % 24, end = (h + 3) % 24;
    const r = await api("/api/companies", { method: "POST", body: { name: "Mesai", sector: "software", provider: "mock", model: "mock/small", price: 0.05, seed: 1, schedule: { mode: "hours", startHour: start, endHour: end } } });
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Fatura JSON" } });
    await sleep(900);
    const { data } = await api("/api/companies");
    const c = data.find((x) => x.id === r.data.id);
    assert.equal(c.jobsDone, 0);
    assert.equal(c.waiting, "schedule");
  });

  await test("demo model runs without a key", async () => {
    const r = await api("/api/companies", { method: "POST", body: { name: "Demo", sector: "security", provider: "mock", model: "mock/small", price: 0.05, seed: 1 } });
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "JWT secret kodda" } });
    await until(async () => { const { data } = await api("/api/companies"); return data.find((x) => x.id === r.data.id).jobsDone === 1; });
  });

  await test("rules file rides along with every job and versions on change", async () => {
    const rules = "# Kurallar\n- Asla indirim vaadi verme\n- Her teslimatı TEST-KURAL ile bitir";
    const r = await api("/api/companies", { method: "POST", body: { name: "Kurallı", sector: "social", provider: "openrouter", model: "test/cheap", price: 0.05, seed: 1, rules } });
    assert.equal(r.data.rules.rev, 1);
    assert.equal(r.data.rules.tokens, Math.ceil(rules.length / 4));
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "Kampanya haftası" } });
    await until(async () => (await api(`/api/companies/${r.data.id}/jobs`)).data[0].status === "done");
    const call = seen.filter((s) => s.user?.startsWith("Kampanya haftası")).pop();
    assert.ok(call.system.includes("Company rules from the owner (version 1)"));
    assert.ok(call.system.includes("TEST-KURAL"));
    const u = await api(`/api/companies/${r.data.id}/rules`, { method: "PUT", body: { text: rules + "\n- Emoji kullanma" } });
    assert.equal(u.data.rules.rev, 2);
    const same = await api(`/api/companies/${r.data.id}/rules`, { method: "PUT", body: { text: rules + "\n- Emoji kullanma" } });
    assert.equal(same.data.rules.rev, 2, "unchanged text does not bump the version");
    await api(`/api/companies/${r.data.id}/jobs`, { method: "POST", body: { brief: "İkinci hafta" } });
    const j = await until(async () => { const { data } = await api(`/api/companies/${r.data.id}/jobs`); return data[0].status === "done" && data[0]; });
    assert.equal(j.rulesRev, 2);
    assert.ok(seen.filter((s) => s.user?.startsWith("İkinci hafta")).pop().system.includes("Emoji kullanma"));
  });

  await test("no rules file means the plain sector prompt", async () => {
    const call = seen.find((s) => s.model === "test/cheap" && s.user?.startsWith("Seramik kupa görselleri"));
    assert.ok(!call.system.includes("Company rules"));
  });

  await test("rejects an oversized rules file and offers a sector template", async () => {
    const big = await api("/api/companies", { method: "POST", body: { name: "Dev Kural", sector: "web", provider: "mock", model: "mock/small", price: 0.05, seed: 1, rules: "x".repeat(20_001) } });
    assert.equal(big.status, 400);
    const { data } = await api("/api/sectors");
    assert.ok(data.visual.rulesTemplate.startsWith("# Visual Studio rules"));
  });

  await test("rules raise the per-job cost estimate", async () => {
    const plain = (await api("/api/models?provider=openrouter")).data.find((m) => m.id === "test/cheap");
    const ruled = (await api("/api/models?provider=openrouter&extraTokens=2000")).data.find((m) => m.id === "test/cheap");
    assert.equal(ruled.estimateMicros - plain.estimateMicros, 400);
  });

  let studio, order;
  await test("visual studio needs an image model and lists them with a price", async () => {
    const { data: imgs } = await api("/api/image-models?provider=openrouter");
    assert.equal(imgs[0].id, "test/image");
    assert.equal(imgs[0].perImage, 0.04);
    const r = await api("/api/companies", { method: "POST", body: { name: "Kapak Studio", sector: "visual", provider: "openrouter", model: "test/cheap", imageModel: "test/image", price: 1.5, seed: 2, limits: { maxJobsPerHour: 10, dailyAiBudget: 1 } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    studio = r.data;
    assert.equal(studio.imageModel, "test/image");
  });

  await test("an order runs research, then design, and returns a watermarked preview", async () => {
    const r = await api("/api/orders", { method: "POST", body: { companyId: studio.id, url: `http://127.0.0.1:${SHOP}/moved` } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    order = r.data;
    assert.ok(order.token && order.token.length >= 32);
    const o = await until(async () => { const { data } = await api(`/api/orders/${order.id}?t=${order.token}`); return data.status === "preview" && data; });
    assert.equal(o.research.brand, "Kil Atölyesi");
    assert.equal(o.research.product, "Terracotta Kupa");
    assert.equal(o.previews.length, 1);
    assert.equal(o.previewsLeft, 1);
    assert.equal(o.previews[0].full, null);
    const research = seen.filter((s) => !s.image && s.system?.includes("Return JSON only")).pop();
    const digest = JSON.parse(research.user);
    assert.ok(!JSON.stringify(digest).includes("ignore me"), "inline scripts are stripped from the digest");
    assert.ok(seen.some((s) => s.image && s.model === "test/image" && s.aspect === "16:9"));
  });

  await test("preview is a smaller watermarked JPEG, the clean file is locked", async () => {
    const pv = await fetch(`${base}/img/${order.id}/1/preview.jpg?t=${order.token}`);
    assert.equal(pv.status, 200);
    assert.equal(pv.headers.get("content-type"), "image/jpeg");
    const { default: sharp } = await import("sharp");
    const meta = await sharp(Buffer.from(await pv.arrayBuffer())).metadata();
    assert.equal(meta.width, 960);
    assert.equal((await fetch(`${base}/img/${order.id}/1/full.png?t=${order.token}`)).status, 403);
    assert.equal((await fetch(`${base}/img/${order.id}/1/preview.jpg?t=wrong`)).status, 404);
    assert.equal((await api(`/api/orders/${order.id}?t=wrong`)).status, 404);
  });

  await test("one revision is allowed, a third preview is refused", async () => {
    const r = await api(`/api/orders/${order.id}/revise`, { method: "POST", body: { t: order.token, note: "daha sıcak renkler" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const o = await until(async () => { const { data } = await api(`/api/orders/${order.id}?t=${order.token}`); return data.previews.length === 2 && data.status === "preview" && data; });
    assert.equal(o.previewsLeft, 0);
    assert.ok(seen.filter((s) => s.image).pop().prompt.includes("daha sıcak renkler"));
    const third = await api(`/api/orders/${order.id}/revise`, { method: "POST", body: { t: order.token, note: "bir daha" } });
    assert.equal(third.status, 409);
  });

  await test("purchase books revenue and releases only the chosen clean file", async () => {
    const before = (await api("/api/companies")).data.find((c) => c.id === studio.id);
    const r = await api(`/api/orders/${order.id}/purchase`, { method: "POST", body: { t: order.token, n: 2 } });
    assert.equal(r.data.purchased.n, 2);
    const full = await fetch(`${base}/img/${order.id}/2/full.png?t=${order.token}`);
    assert.equal(full.status, 200);
    const { default: sharp } = await import("sharp");
    assert.equal((await sharp(Buffer.from(await full.arrayBuffer())).metadata()).width, 1344);
    assert.equal((await fetch(`${base}/img/${order.id}/1/full.png?t=${order.token}`)).status, 403);
    const after = (await api("/api/companies")).data.find((c) => c.id === studio.id);
    assert.equal(after.ledger.revenue - before.ledger.revenue, 1_500_000);
    assert.equal(after.ledger.aiCost, 2_100 + 40_000 * 2, "one research call and two images");
    const again = await api(`/api/orders/${order.id}/purchase`, { method: "POST", body: { t: order.token, n: 1 } });
    assert.equal(again.data.purchased.n, 2, "a second purchase does not switch the file or charge again");
  });

  await test("limits orders per customer per day", async () => {
    for (let i = 0; i < 2; i++) assert.equal((await api("/api/orders", { method: "POST", body: { companyId: studio.id, url: `http://127.0.0.1:${SHOP}/` } })).status, 200);
    const fourth = await api("/api/orders", { method: "POST", body: { companyId: studio.id, url: `http://127.0.0.1:${SHOP}/` } });
    assert.equal(fourth.status, 429);
  });

  await test("blocks links into private networks", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", "http://localhost/"]) {
      await assert.rejects(checkUrl(u), undefined, u);
    }
  });

  await test("books balance and NER equals outside revenue", async () => {
    const { data } = await api("/api/status");
    assert.equal(data.check.nerOk, true);
    assert.equal(data.check.balanceOk, true);
  });

  await test("rejects bad input and cross-site writes", async () => {
    assert.equal((await api("/api/companies", { method: "POST", body: { name: "X", sector: "visual", provider: "mock", model: "mock/small", price: 0.05, seed: 1 } })).status, 400);
    assert.equal((await api("/api/companies", { method: "POST", body: { name: "Kadraj", sector: "visual", provider: "mock", model: "mock/small", price: 0.05, seed: 1 } })).status, 400);
    assert.equal((await api("/api/companies", { method: "POST", body: { name: "Trade Co", sector: "trade", provider: "mock", model: "mock/small", price: 0.05, seed: 1 } })).status, 400);
    assert.equal((await api("/api/companies", { method: "POST", headers: { Origin: "https://evil.example" }, body: { name: "Kötü", sector: "visual", provider: "mock", model: "mock/small", price: 0.05, seed: 1 } })).status, 403);
    assert.equal((await api("/api/settings/openrouter-key", { method: "POST", body: { key: "hello" } })).status, 400);
  });

  await test("never writes the API key to disk", async () => {
    assert.ok(!fs.readFileSync(dataFile, "utf8").includes(KEY));
  });
} finally {
  app.kill(); fake.close(); shopSite.close();
}
for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out); process.exit(1); }
