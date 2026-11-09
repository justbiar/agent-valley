// Public mode: every visitor may found a company, but only on the demo model or their own key,
// only their own companies are theirs to change, and nothing books revenue without a payment rail.
// Run: node test/public.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFake } from "./fake-openrouter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk-or-visitor-0123456789abcdef", ADMIN = "admin-test-token";
const FAKE = 9921, PORT = 8909, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-pub-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };

// A browser: keeps its cookies and sends a fixed client IP the way Cloudflare would.
function browser(ip) {
  const jar = {};
  const call = async (p, opt = {}) => {
    const res = await fetch(base + p, { method: opt.method || "GET", redirect: "manual", headers: { "Content-Type": "application/json", "cf-connecting-ip": ip, Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), ...(opt.headers || {}) }, body: opt.body ? (typeof opt.body === "string" ? opt.body : JSON.stringify(opt.body)) : undefined });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call, jar };
}

const { server: fake } = await startFake(FAKE, KEY);
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: ADMIN, ALLOW_SIM_PURCHASE: "0", TRUST_PROXY: "1", OPENROUTER_API_KEY: KEY, REVIEW_PROVIDER: "openrouter", REVIEW_MODEL: "test/cheap", OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "200", AUCTION_WINDOW_MS: "600" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const company = (over = {}) => ({ name: "Kadraj " + Math.random().toString(36).slice(2, 7), sector: "research", provider: "mock", model: "mock/small", price: 1, seed: 2, payoutAccount: "kadraj-test.near", ...over });

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  const a = browser("203.0.113.10"), b = browser("203.0.113.20"), owner = browser("203.0.113.30");
  await a.call("/"); await b.call("/");
  let aCo;

  await test("console page is open to visitors and sets a visitor cookie", async () => {
    const r = await browser("203.0.113.40").call("/");
    assert.equal(r.status, 200);
    assert.ok(a.jar.av_vid && /^[a-f0-9]{32}$/.test(a.jar.av_vid));
  });

  await test("visitor status hides the owner's key and machine", async () => {
    const { data } = await a.call("/api/status");
    assert.equal(data.viewer.admin, false);
    assert.equal(data.providers.ollama, undefined);
    assert.equal(data.providers.openrouter.configured, false);
    assert.equal(data.books, undefined);
  });

  await test("visitor founds a demo-model company", async () => {
    const r = await a.call("/api/companies", { method: "POST", body: company({ name: "Kadraj A" }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    aCo = r.data;
  });

  await test("each visitor sees only their own companies", async () => {
    assert.equal((await a.call("/api/companies")).data.length, 1);
    assert.equal((await b.call("/api/companies")).data.length, 0);
  });

  await test("another visitor cannot touch it", async () => {
    assert.equal((await b.call(`/api/companies/${aCo.id}`, { method: "PATCH", body: { status: "paused" } })).status, 404);
    assert.equal((await b.call(`/api/companies/${aCo.id}/jobs`, { method: "POST", body: { brief: "başkasının şirketi" } })).status, 404);
    assert.equal((await b.call(`/api/companies/${aCo.id}/rules`, { method: "PUT", body: { text: "x" } })).status, 404);
    assert.equal((await b.call(`/api/companies/${aCo.id}/jobs`)).status, 404);
  });

  await test("only the owner makes a transfer link; whoever claims it owns the company in their own console", async () => {
    assert.equal((await b.call(`/api/companies/${aCo.id}/transfer-link`, { method: "POST" })).status, 404, "a stranger cannot hand it over");
    const link = (await a.call(`/api/companies/${aCo.id}/transfer-link`, { method: "POST" })).data;
    const q = new URLSearchParams(link.url.split("?")[1]);
    const r = await b.call(`/api/handover/${q.get("h")}/claim?t=${q.get("t")}`, { method: "POST", body: { payoutAccount: "visitor-b.near" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await a.call("/api/companies")).data.length, 0, "gone from the old owner's console");
    assert.equal((await b.call("/api/companies")).data[0].id, aCo.id, "in the new owner's console");
    // Hand it back so the rest of the tests see A as the owner.
    const back = (await b.call(`/api/companies/${aCo.id}/transfer-link`, { method: "POST" })).data;
    const q2 = new URLSearchParams(back.url.split("?")[1]);
    assert.equal((await a.call(`/api/handover/${q2.get("h")}/claim?t=${q2.get("t")}`, { method: "POST", body: { payoutAccount: "kadraj-test.near" } })).status, 200);
  });

  await test("visitors cannot use the owner's machine, key or investor", async () => {
    assert.equal((await b.call("/api/companies", { method: "POST", body: company({ provider: "ollama", model: "x" }) })).status, 400);
    assert.equal((await b.call("/api/models?provider=ollama")).status, 400);
    assert.equal((await b.call("/api/settings/openrouter-key", { method: "POST", body: { key: "" } })).status, 401);
    assert.equal((await a.call(`/api/companies/${aCo.id}/invest`, { method: "POST", body: { amount: 20 } })).status, 401);
  });

  await test("visitor caps: seed and daily budget", async () => {
    assert.equal((await b.call("/api/companies", { method: "POST", body: company({ seed: 500 }) })).status, 400);
    assert.equal((await b.call("/api/companies", { method: "POST", body: company({ limits: { dailyAiBudget: 50 } }) })).status, 400);
  });

  await test("OpenRouter needs the visitor's own working key", async () => {
    const or = (key) => b.call("/api/companies", { method: "POST", body: company({ provider: "openrouter", model: "test/cheap", key }) });
    assert.equal((await or(undefined)).status, 400);
    assert.match((await or("sk-or-wrong-0123456789abc")).data.error, /Could not verify/);
    const ok = await or(KEY);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.ownKey, true);
    assert.equal(ok.data.keyLoaded, true);
  });

  await test("a delivered job books no revenue without a payment rail", async () => {
    await a.call(`/api/companies/${aCo.id}/jobs`, { method: "POST", body: { brief: "Pazar raporu hazırla" } });
    const co = await until(async () => (await a.call("/api/companies")).data.find((c) => c.id === aCo.id && c.jobsDone === 1));
    assert.equal(co.ledger.revenue, 0);
    assert.equal(co.stage, "idea");
    const city = (await a.call("/api/city")).data;
    assert.equal(city.companies.find((c) => c.id === aCo.id).sales, 0);
    assert.equal(city.books.externalIn, 0);
  });

  await test("two companies per IP per day", async () => {
    assert.equal((await a.call("/api/companies", { method: "POST", body: company() })).status, 200);
    assert.equal((await a.call("/api/companies", { method: "POST", body: company() })).status, 429);
  });

  await test("city feed shows companies without owner data", async () => {
    const { data } = await b.call("/api/city");
    assert.ok(data.companies.length >= 3);
    const text = JSON.stringify(data);
    for (const leak of [a.jar.av_vid, "203.0.113", KEY, "ownerId", "founderIp"]) assert.ok(!text.includes(leak), leak);
  });

  await test("own keys never reach the state file", async () => {
    assert.ok(!fs.readFileSync(dataFile, "utf8").includes(KEY));
  });

  let goodIdea;
  await test("an idea is reviewed by the agent and waits for the owner", async () => {
    const r = await b.call("/api/ideas", { method: "POST", body: { name: "Logo Stüdyosu", sells: "Küçük işletmelere logo", customer: "Yeni açılan kafeler", deliverable: "Üç SVG logo konsepti ve renk paleti", example: "Bir kahveci için logo" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    goodIdea = await until(async () => (await b.call("/api/ideas")).data.find((i) => i.id === r.data.id && i.status !== "reviewing"));
    assert.equal(goodIdea.status, "awaiting_owner");
    assert.equal(goodIdea.review.feasible, true);
    assert.equal(goodIdea.proposal.system, undefined, "the applicant does not see the prompt");
    assert.match(goodIdea.proposal.id, /^[a-z0-9_]+$/);
    assert.deepEqual(goodIdea.proposal.needs, ["visual"], "unknown supplier sectors are dropped");
  });

  await test("an idea that needs physical work is rejected by the review", async () => {
    const r = await a.call("/api/ideas", { method: "POST", body: { name: "Kupa Baskı", sells: "Baskılı kupa", customer: "Hediye arayanlar", deliverable: "Kupaya baskı yapıp kargo ile gönderme" } });
    const done = await until(async () => (await a.call("/api/ideas")).data.find((i) => i.id === r.data.id && i.status !== "reviewing"));
    assert.equal(done.status, "rejected");
  });

  await test("visitors cannot approve, other visitors cannot see a pending idea", async () => {
    assert.equal((await b.call(`/api/ideas/${goodIdea.id}/decide`, { method: "POST", body: { approve: true } })).status, 401);
    assert.ok(!(await a.call("/api/ideas")).data.some((i) => i.id === goodIdea.id));
    assert.ok(!(await a.call("/api/sectors")).data[goodIdea.proposal.id]);
  });

  await test("owner logs in and sees every company", async () => {
    assert.equal((await owner.call("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=wrong" })).status, 303);
    assert.ok(!owner.jar.av_admin);
    await owner.call("/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "token=" + ADMIN });
    assert.ok(owner.jar.av_admin);
    const { data } = await owner.call("/api/companies");
    assert.ok(data.length >= 3);
    assert.equal((await owner.call(`/api/companies/${aCo.id}`, { method: "PATCH", body: { status: "paused" } })).status, 200);
  });

  await test("the stake calculator is the owner's alone", async () => {
    assert.equal((await b.call("/api/compute")).status, 401);
    assert.equal((await b.call("/api/compute", { method: "POST", body: { stakedNear: 1 } })).status, 401);
    await owner.call("/api/compute", { method: "POST", body: { stakedNear: 250, usdPer100NearMonth: 2 } });
    const c = (await owner.call("/api/compute")).data;
    assert.equal(c.monthlyCreditMicros, 5_000_000);
    assert.equal(c.key, "no_key");
    assert.equal(c.openrouter.key, "ok");
    assert.equal(c.openrouter.limitRemaining, 4.2);
    assert.equal(c.openrouter.spend30dMicros, 0, "visitors' own-key spend is not the owner's bill");
  });

  await test("owner sees the proposed prompt, approves, and anyone can found in the new sector", async () => {
    const pending = (await owner.call("/api/ideas")).data.find((i) => i.id === goodIdea.id);
    assert.match(pending.proposal.system, /logo studio/);
    const r = await owner.call(`/api/ideas/${goodIdea.id}/decide`, { method: "POST", body: { approve: true } });
    assert.equal(r.data.status, "approved");
    const sid = r.data.sectorId;
    assert.equal((await b.call("/api/sectors")).data[sid].custom, true);
    const co = await browser("203.0.113.50").call("/api/companies", { method: "POST", body: company({ sector: sid }) });
    assert.equal(co.status, 200, JSON.stringify(co.data));
    assert.equal((await b.call("/api/city")).data.sectors[sid].form, "visual");
  });
} finally {
  app.kill(); fake.close();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
