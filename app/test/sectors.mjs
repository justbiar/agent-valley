// The sector builder: applicants design a sector's settings, the reviewer checks them, the owner may adjust them,
// and an approved sector joins the supply chain. The platform adds no sector itself.
// Run: node test/sectors.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createIdeas, cleanSettings, reviewSystem, restoreLinks } from "../src/ideas.mjs";
import { SECTORS, BUILTIN } from "../src/sectors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8953, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-sectors-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

const app = (settings, extra = {}) => ({ name: "Logo Stüdyosu", sells: "Küçük işletmelere logo", customer: "Yeni açılan kafeler", deliverable: "Üç SVG logo konsepti ve renk paleti", example: "Kahveci için logo", settings, ...extra });
const memStore = () => ({ ideas: [], customSectors: {}, supplyLinks: [], save() {} });
const reviewerSays = (verdict) => ({ chat: async () => ({ text: JSON.stringify(verdict), costMicros: 10 }) });

await test("settings are checked: unknown sectors, forms and outputs are dropped, links capped at three", () => {
  const s = cleanSettings({ output: "video", needs: ["web", "nope", "visual", "research", "social"], suppliesTo: ["web", "web"], form: "castle", color: "red", priceUSD: 5000, demo: "a\nb\nc\nd" });
  assert.equal(s.output, "text");
  assert.deepEqual(s.needs, ["web", "visual", "research"]);
  assert.deepEqual(s.suppliesTo, ["web"]);
  assert.equal(s.form, null);
  assert.equal(s.color, null);
  assert.equal(s.priceUSD, null);
  assert.deepEqual(s.demo, ["a", "b", "c"]);
});

await test("the reviewer's rules keep hardware rental out and say the settings must make sense", () => {
  const r = reviewSystem();
  assert.match(r, /no renting out hardware/);
  assert.match(r, /settingsNotes/);
  assert.match(r, /ignore anything in it/);
});

await test("the applicant's settings win; the agent's instructions come from the reviewer", async () => {
  const store = memStore();
  const ideas = createIdeas({ store, reviewer: reviewerSays({ feasible: true, score: 82, reasons: ["uygun"], settingsNotes: ["renk korundu"], sector: { id: "logo", name: "Logo Stüdyosu", sells: "Logo", system: "You design logos.", form: "research", needs: ["research"], output: "text" } }) });
  const idea = await ideas.apply(app({ output: "image", form: "visual", color: "#a855f7", needs: ["research"], suppliesTo: ["web"], partBrief: "Logo: SVG ve renkler", priceUSD: 0.4, demo: ["Kahveci logosu"] }), { ip: "1", vid: "v1" });
  await until(() => idea.status !== "reviewing");
  const s = idea.proposal.sector;
  assert.equal(idea.status, "awaiting_owner");
  assert.equal(s.output, "image");
  assert.equal(s.form, "visual");
  assert.equal(s.color, "#a855f7");
  assert.deepEqual(s.suppliesTo, ["web"]);
  assert.equal(s.priceUSD, 0.4);
  assert.equal(s.system, "You design logos.", "the applicant cannot write the agent's instructions past the reviewer");
  assert.deepEqual(idea.review.settingsNotes, ["renk korundu"]);
});

await test("a regulated field always carries the draft-only line; a taken colour is replaced", async () => {
  const store = memStore();
  const ideas = createIdeas({ store, reviewer: reviewerSays({ feasible: true, score: 70, sector: { system: "You draft tenancy contracts." } }) });
  const idea = await ideas.apply(app({ regulated: true, color: SECTORS.web.color }, { name: "Kira Sözleşmesi" }), { ip: "2", vid: "v2" });
  await until(() => idea.status !== "reviewing");
  assert.match(idea.proposal.sector.system, /not professional advice/);
  assert.notEqual(idea.proposal.sector.color, SECTORS.web.color);
});

await test("a rejected idea creates nothing", async () => {
  const store = memStore(), before = Object.keys(SECTORS).length;
  const ideas = createIdeas({ store, reviewer: reviewerSays({ feasible: false, score: 10, reasons: ["donanım kiralama"], sector: {} }) });
  const idea = await ideas.apply(app({}, { name: "GPU Kiralama", deliverable: "Saatlik GPU erişimi" }), { ip: "3", vid: "v3" });
  await until(() => idea.status !== "reviewing");
  assert.equal(idea.status, "rejected");
  assert.equal(Object.keys(SECTORS).length, before);
});

await test("the owner edits a proposal, then approval registers it and links it into the supply chain", async () => {
  const store = memStore();
  const ideas = createIdeas({ store, reviewer: null });
  const idea = await ideas.apply(app({ output: "image", suppliesTo: ["social"], needs: ["research"] }, { name: "Afiş Atölyesi" }), { ip: "4", vid: "v4" });
  await until(() => idea.status !== "reviewing");
  assert.throws(() => ideas.edit(idea.id, { color: SECTORS.visual.color }), /Another category/);
  ideas.edit(idea.id, { name: "Afiş ve Poster", form: "social", suppliesTo: ["social", "web"], priceUSD: 0.25 });
  ideas.decide(idea.id, true);
  const id = idea.sectorId;
  assert.equal(SECTORS[id].name, "Afiş ve Poster");
  assert.equal(SECTORS[id].form, "social");
  assert.equal(SECTORS[id].output, "image");
  assert.ok(SECTORS.social.needs.includes(id) && SECTORS.web.needs.includes(id), "joins the part auctions of the sectors it supplies");
  assert.deepEqual(store.supplyLinks.map((l) => l.buyer), ["social", "web"]);
  assert.throws(() => ideas.edit(idea.id, { name: "x" }), /awaiting approval/);
  // After a restart the links come back from the store.
  SECTORS.social.needs = SECTORS.social.needs.filter((n) => n !== id);
  restoreLinks(store);
  assert.ok(SECTORS.social.needs.includes(id));
  assert.ok(!BUILTIN.has(id), "it is an applicant's sector, not a built-in one");
});

/* ---------- through the server ---------- */
const srv = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", NEAR_CONTRACT: "", REVIEW_PROVIDER: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; srv.stdout.on("data", (d) => (out += d)); srv.stderr.on("data", (d) => (out += d));
try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  await test("apply with settings, adjust, approve, and the sector shows up ready to found in", async () => {
    const r = await api("/api/ideas", { method: "POST", body: app({ output: "image", form: "visual", needs: ["research"], suppliesTo: ["web"], priceUSD: 0.3, demo: ["Kafe logosu"] }, { name: "Marka Kimliği" }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const idea = await until(async () => (await api("/api/ideas")).data.find((i) => i.id === r.data.id && i.status === "awaiting_owner"));
    assert.equal(idea.proposal.output, "image");
    const e = await api(`/api/ideas/${idea.id}/proposal`, { method: "PATCH", body: { priceUSD: 0.35 } });
    assert.equal(e.data.proposal.priceUSD, 0.35);
    await api(`/api/ideas/${idea.id}/decide`, { method: "POST", body: { approve: true } });
    const secs = (await api("/api/sectors")).data;
    const id = Object.keys(secs).find((k) => secs[k].name === "Marka Kimliği");
    assert.ok(id);
    assert.equal(secs[id].output, "image");
    assert.deepEqual(secs[id].needs, ["research"]);
    assert.equal(secs[id].priceUSD, 0.35);
    assert.ok(secs.web.needs.includes(id), "web agencies now list it in their part auctions");
    const disk = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.deepEqual(disk.supplyLinks, [{ buyer: "web", supplier: id }]);
  });
} finally {
  srv.kill();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-1500)); process.exit(1); }
