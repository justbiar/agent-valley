// Model chains: when a model is rate limited or answers empty, the job moves to the next model in the company's
// chain; when every model is busy, the job fails as "busy" (a paid trial is then refunded) instead of waiting forever.
// Run: node test/fallback.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { startFake } from "./fake-openrouter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8937, FAKE = 9957, KEY = "sk-or-fallback-0123456789abcdef", base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-fallback-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };

const { server: fake, seen } = await startFake(FAKE, KEY);
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE}/api/v1`, NEARAI_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1",
    DATA_FILE: dataFile, ADMIN_TOKEN: "", NEAR_CONTRACT: "", NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", ALLOW_SIM_PURCHASE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const job = async (co, id) => (await api(`/api/companies/${co.id}/jobs`)).data.find((j) => j.id === id);

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  const found = async (name, trialModel) => (await api("/api/companies", { method: "POST", body: { name, sector: "research", provider: "openrouter", model: "test/cheap", trialModel, trialProvider: "openrouter", price: 2, seed: 3, payoutAccount: "chain.near", portfolio: { enabled: false } } })).data;

  await test("a trial that is not picked by hand gets free backup models at founding", async () => {
    const co = (await api("/api/companies", { method: "POST", body: { name: "Auto Backups", sector: "research", provider: "openrouter", model: "test/cheap", price: 2, seed: 3, payoutAccount: "auto.near", portfolio: { enabled: false } } })).data;
    assert.ok(co.trial, "a free trial model was picked");
    assert.ok(co.backups.trial.length >= 1, "at least one free backup: " + JSON.stringify(co.backups));
    assert.ok(co.backups.trial.every((b) => b.model !== co.trial.model), "backups differ from the first model");
  });

  await test("the founder saves a chain; unknown models and the demo provider are refused", async () => {
    const co = await found("Chain Saver", "test/free:free");
    const bad = await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { trial: [{ provider: "openrouter", model: "nope/none" }] } } });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /not found/);
    const mock = await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { main: [{ provider: "mock", model: "mock/small" }] } } });
    assert.equal(mock.status, 400);
    const ok = await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { main: [{ provider: "openrouter", model: "test/pricey" }], trial: [{ provider: "openrouter", model: "test/cheap" }] } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.backups.main, [{ provider: "openrouter", model: "test/pricey" }]);
  });

  await test("a busy free model hands the trial to the next model, which delivers", async () => {
    const co = await found("Busy First", "test/busy:free");
    await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { trial: [{ provider: "openrouter", model: "test/free:free" }] } } });
    const before = seen.length;
    const j = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A short note on tea", tier: "trial" } })).data;
    const done = await until(async () => { const x = await job(co, j.id); return x?.status === "done" && x; });
    assert.equal(done.brain.model, "test/free:free");
    assert.ok(seen.slice(before).some((c) => c.model === "test/busy:free"), "the busy model was tried first");
    assert.ok(done.output.length > 0);
  });

  await test("an empty answer, even with a bigger budget, moves the job down the chain", async () => {
    const co = await found("Empty First", "test/empty");
    await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { trial: [{ provider: "openrouter", model: "test/free:free" }] } } });
    const j = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A short note on coffee", tier: "trial" } })).data;
    const done = await until(async () => { const x = await job(co, j.id); return x?.status === "done" && x; });
    assert.equal(done.brain.model, "test/free:free");
  });

  await test("when every model is busy the job fails as busy instead of waiting for ever", async () => {
    const co = await found("All Busy", "test/busy:free");
    await api(`/api/companies/${co.id}`, { method: "PATCH", body: { backups: { trial: [{ provider: "openrouter", model: "test/empty" }] } } });
    const j = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A short note on cocoa", tier: "trial" } })).data;
    const failed = await until(async () => { const x = await job(co, j.id); return x?.status === "failed" && x; }, 30000);
    assert.equal(failed.allBusy, true, JSON.stringify(failed));
  });

  await test("full jobs keep running on the main model", async () => {
    const co = await found("Main Line", "test/free:free");
    const j = (await api(`/api/companies/${co.id}/jobs`, { method: "POST", body: { brief: "A full report on tea" } })).data;
    const done = await until(async () => { const x = await job(co, j.id); return x?.status === "done" && x; });
    assert.equal(done.brain.model, "test/cheap");
  });
} finally {
  app.kill(); fake.close();
}
for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
