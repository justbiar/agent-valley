// Agent Valley company console. Zero dependencies: Node 20+.
// Run: node server.mjs   Then open http://127.0.0.1:8787
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTORS, SECTOR_IDS } from "./src/sectors.mjs";
import { createOpenRouter, createOllama, createMock, USD, estimateJobMicros } from "./src/providers.mjs";
import { createRuntime } from "./src/runtime.mjs";
import * as econ from "./src/economy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// .env next to this file, without a dependency. Real environment variables win.
const envFile = path.join(here, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA = process.env.DATA_FILE || path.join(here, "data", "state.json");
const TICK_MS = Number(process.env.TICK_MS || 3000);

// The key stays in memory or in .env. It is never written to state, logged or sent to the browser.
let sessionKey = null;
const getKey = () => sessionKey || process.env.OPENROUTER_API_KEY || null;
const providers = {
  openrouter: createOpenRouter({ getKey, baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", referer: `http://${HOST}:${PORT}` }),
  ollama: createOllama({ baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434" }),
  mock: createMock(),
};

/* ---------- state ---------- */
const store = {
  companies: [],
  books: econ.newBooks(),
  nextId: 1,
  save() {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const tmp = DATA + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ companies: this.companies, books: this.books, nextId: this.nextId }, null, 1));
    fs.renameSync(tmp, DATA);
  },
};
if (fs.existsSync(DATA)) {
  const s = JSON.parse(fs.readFileSync(DATA, "utf8"));
  Object.assign(store, { companies: s.companies || [], books: s.books || econ.newBooks(), nextId: s.nextId || 1 });
  for (const co of store.companies) for (const j of co.jobs) if (j.status === "running") j.status = "queued";
}
const runtime = createRuntime({ store, providers });
setInterval(() => runtime.tick().catch((e) => console.error("tick", e)), TICK_MS);

/* ---------- validation ---------- */
const dollars = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Değer ${min} ile ${max} arasında olmalı`); return Math.round(n * USD); };
const int = (v, min, max) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Değer ${min} ile ${max} arasında olmalı`); return n; };
function parseSchedule(s = {}) {
  const mode = ["always", "interval", "hours"].includes(s.mode) ? s.mode : "always";
  return { mode, everyMin: int(s.everyMin ?? 10, 1, 1440), startHour: int(s.startHour ?? 9, 0, 23), endHour: int(s.endHour ?? 18, 0, 23) };
}
function parseLimits(l = {}) {
  return { maxJobsPerHour: int(l.maxJobsPerHour ?? 6, 1, 600), dailyAiBudget: dollars(l.dailyAiBudget ?? 1, 0, 1000), maxTokens: int(l.maxTokens ?? 900, 100, 4000) };
}

/* ---------- views ---------- */
const view = (co) => {
  const done = co.jobs.filter((j) => j.status === "done");
  const avgCost = done.length ? Math.round(done.slice(0, 10).reduce((a, j) => a + j.costMicros, 0) / Math.min(10, done.length)) : null;
  return {
    id: co.id, name: co.name, sector: co.sector, sectorName: SECTORS[co.sector].name, provider: co.provider, model: co.model,
    stage: co.stage, status: co.status, waiting: co.waiting || null, priceMicros: co.priceMicros, schedule: co.schedule, limits: co.limits, demo: co.demo,
    ledger: { ...co.ledger, balance: econ.balance(co.ledger), profit: co.ledger.revenue - co.ledger.aiCost },
    jobsDone: done.length, jobsQueued: co.jobs.filter((j) => j.status === "queued").length, jobsFailed: co.jobs.filter((j) => j.status === "failed").length,
    avgCostMicros: avgCost, spendToday: co.spend?.ai || 0, createdAt: co.createdAt, log: co.log.slice(0, 30),
  };
};
const jobView = (j) => ({ ...j, output: j.output ? j.output.slice(0, 20000) : null });

/* ---------- http ---------- */
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 200_000) { bad(new Error("İstek çok büyük")); req.destroy(); } }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error("Geçersiz JSON")); } }); });
const find = (id) => store.companies.find((c) => c.id === Number(id));

const routes = {
  "GET /api/status": async () => {
    const out = { books: store.books, check: econ.check(store.books, store.companies), companies: store.companies.length, providers: {} };
    for (const [id, p] of Object.entries(providers)) {
      out.providers[id] = { label: p.label, configured: p.configured() };
      if (p.configured() && id !== "mock") out.providers[id].status = await p.status().catch((e) => ({ ok: false, reason: e.message, code: e.code }));
    }
    out.providers.openrouter.keySource = sessionKey ? "session" : process.env.OPENROUTER_API_KEY ? "env" : null;
    return out;
  },
  "GET /api/sectors": async () => Object.fromEntries(SECTOR_IDS.map((id) => [id, { name: SECTORS[id].name, sells: SECTORS[id].sells, demo: SECTORS[id].demo }])),
  "GET /api/models": async (q) => {
    const p = providers[q.get("provider")];
    if (!p) throw new Error("Bilinmeyen sağlayıcı");
    const list = await p.models();
    return list.map((m) => ({ ...m, estimateMicros: estimateJobMicros(m) })).sort((a, b) => a.estimateMicros - b.estimateMicros);
  },
  "POST /api/settings/openrouter-key": async (_q, body) => {
    const key = String(body.key || "").trim();
    if (key && !/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) throw new Error("Bu bir OpenRouter anahtarına benzemiyor (sk-or- ile başlar)");
    sessionKey = key || null;
    return { ok: true, configured: !!getKey() };
  },
  "GET /api/companies": async () => store.companies.map(view),
  "POST /api/companies": async (_q, b) => {
    const name = String(b.name || "").trim();
    if (name.length < 2 || name.length > 32) throw new Error("Şirket adı 2 ile 32 karakter arasında olmalı");
    if (store.companies.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error("Bu isimde bir şirket var");
    if (!SECTORS[b.sector]) throw new Error("Bilinmeyen sektör");
    if (!providers[b.provider]) throw new Error("Bilinmeyen sağlayıcı");
    const models = await providers[b.provider].models();
    if (!models.some((m) => m.id === b.model)) throw new Error("Model bu sağlayıcıda bulunamadı");
    const co = {
      id: store.nextId++, name, sector: b.sector, provider: b.provider, model: b.model, stage: "idea", status: "running",
      priceMicros: dollars(b.price, 0.01, 1000), schedule: parseSchedule(b.schedule), limits: parseLimits(b.limits),
      demo: { on: !!b.demo?.on, everyMin: int(b.demo?.everyMin ?? 5, 1, 1440), lastAt: 0 },
      ledger: econ.newLedger(), spend: { day: "", ai: 0 }, jobs: [], log: [], createdAt: Date.now(), lastRunAt: 0,
    };
    econ.seed(store.books, co, dollars(b.seed, 0.5, 10000));
    co.log.unshift({ t: Date.now(), kind: "stage", text: `${SECTORS[co.sector].name} atölyesi açıldı, başlangıç bütçesi $${(co.ledger.seed / USD).toFixed(2)}` });
    store.companies.push(co); store.save();
    return view(co);
  },
  "PATCH /api/companies/:id": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Şirket bulunamadı");
    if (b.status && ["running", "paused"].includes(b.status)) co.status = b.status;
    if (b.price != null) co.priceMicros = dollars(b.price, 0.01, 1000);
    if (b.schedule) co.schedule = parseSchedule(b.schedule);
    if (b.limits) co.limits = parseLimits(b.limits);
    if (b.demo) co.demo = { ...co.demo, on: !!b.demo.on, everyMin: int(b.demo.everyMin ?? co.demo.everyMin, 1, 1440) };
    if (b.model) { const models = await providers[co.provider].models(); if (!models.some((m) => m.id === b.model)) throw new Error("Model bulunamadı"); co.model = b.model; }
    store.save();
    return view(co);
  },
  "POST /api/companies/:id/jobs": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Şirket bulunamadı");
    const brief = String(b.brief || "").trim();
    if (brief.length < 5) throw new Error("İş tanımı en az 5 karakter olmalı");
    return jobView(runtime.enqueue(co, brief, "manual"));
  },
  "GET /api/companies/:id/jobs": async (_q, _b, id) => { const co = find(id); if (!co) throw new Error("Şirket bulunamadı"); return co.jobs.slice(0, 50).map(jobView); },
  "POST /api/companies/:id/invest": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Şirket bulunamadı");
    const amount = dollars(b.amount, 0.5, 100000);
    econ.invest(store.books, co, amount);
    co.log.unshift({ t: Date.now(), kind: "stage", text: `Demo yatırımcıdan $${(amount / USD).toFixed(2)} sermaye geldi` });
    store.save();
    return view(co);
  },
};

function match(method, url) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const re = new RegExp("^" + pattern.replace(":id", "(\\d+)") + "$"), hit = url.match(re);
    if (hit) return { fn: routes[key], id: hit[1] };
  }
  return null;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname.startsWith("/api/")) {
    // Browsers on other sites must not drive this console.
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: "Başka bir siteden istek kabul edilmiyor" });
    const r = match(req.method, u.pathname);
    if (!r) return send(res, 404, { error: "Bulunamadı" });
    try { const body = req.method === "GET" ? {} : await readBody(req); return send(res, 200, await r.fn(u.searchParams, body, r.id)); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  const file = path.normalize(path.join(here, "public", u.pathname === "/" ? "index.html" : u.pathname));
  if (!file.startsWith(path.join(here, "public"))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Bulunamadı"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
server.listen(PORT, HOST, () => console.log(`Agent Valley konsolu: http://${HOST}:${PORT}  (OpenRouter anahtarı: ${getKey() ? "var" : "yok"})`));
