#!/usr/bin/env node
// Simulation mode: the whole economy with scripted agents and no LLM calls, beside the normal mode and never touching it.
// It starts its own server on its own port with a throwaway state file, founds 20 buyer companies and 5 supplier
// companies on the free demo model, and lets the built-in demo customers keep them busy. Buyers need parts, so sealed-bid
// auctions open, suppliers bid by strategy, the contract rules pick winners at the second price, and the city fills up.
//
//   cd app && npm run sim                      then open the URLs it prints
//   SIM_PORT=8788 SIM_BUYERS=20 SIM_SELLERS=5 SIM_MINUTES=0 npm run sim     (SIM_MINUTES=0 runs until Ctrl-C)
//
// Nothing here spends money or calls a model provider: provider keys, the contract and payments are switched off.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIM_PORT || 8788);
const BUYERS = Math.max(1, Number(process.env.SIM_BUYERS || 20));
const SELLERS = Math.max(1, Number(process.env.SIM_SELLERS || 5));
const MINUTES = Number(process.env.SIM_MINUTES || 0);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (m) => "$" + (m / 1e6).toFixed(2);

// Deterministic randomness, so two runs found the same companies with the same strategies.
let seed = 20261112;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const look = () => ({ skin: Math.floor(rnd() * 6), hair: Math.floor(rnd() * 6), hairColor: Math.floor(rnd() * 8), top: Math.floor(rnd() * 8), bottom: Math.floor(rnd() * 6), extra: Math.floor(rnd() * 5), build: Math.floor(rnd() * 3) });

// Suppliers: the sectors buyers need parts from. Each bids by a strategy, set as its floor price.
//   cheap: floor at 30% of list, wins often for little   fair: 60%   premium: floor at list, wins only when alone
const STRATEGIES = { cheap: 0.3, fair: 0.6, premium: 1 };
const SUPPLIER_PLAN = [
  { sector: "design", name: "Pixel Forge", strategy: "cheap", price: 1.2 },
  { sector: "visual", name: "Lumen Shots", strategy: "fair", price: 1.8 },
  { sector: "legal", name: "Clause & Co", strategy: "fair", price: 2.2 },
  { sector: "design", name: "Grid Studio", strategy: "premium", price: 1.0 },
  { sector: "visual", name: "Prism Lab", strategy: "cheap", price: 1.6 },
  { sector: "legal", name: "Fine Print", strategy: "premium", price: 2.0 },
  { sector: "design", name: "Kit Works", strategy: "fair", price: 1.1 },
];
// Buyers: web agencies (buy design, images and legal texts) and social media studios (buy images).
const WEB_NAMES = ["Harbor Web", "Northline Sites", "Copper Pages", "Lantern Digital", "Brightfold", "Quill & Pixel", "Stackyard", "Meadow Labs", "Signal House", "Orbit Works", "Tidewater Web", "Granite Sites", "Atlas Web", "Cedar Sites"];
const SOCIAL_NAMES = ["Echo Social", "Fable Feeds", "Pulse Post", "Ripple Media", "Bloom Social", "Kite Stories", "Juniper Posts", "Vivid Loop", "Cobalt Social", "Daybreak Posts"];

async function api(p, body, method = body ? "POST" : "GET") {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", Origin: base }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${data.error || res.status}`);
  return data;
}

// Never attach to a server that is already there: that could be the normal mode, or a sim from another run.
if (await fetch(base + "/api/status").then(() => true, () => false)) { console.error(`Port ${PORT} is already in use. Stop what runs there, or pick another port: SIM_PORT=8799 npm run sim`); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-valley-sim-"));
// The sim server: demo model only, no admin token (the script is the owner), no chain, no payment rail, no outside lookups.
const env = { ...process.env, PORT: String(PORT), DATA_FILE: path.join(dir, "state.json"), ADMIN_TOKEN: "", OPENROUTER_API_KEY: "", NEARAI_API_KEY: "",
  PINGPAY_API_KEY: "", PINGPAY_PLATFORM_ACCOUNT: "", NEAR_CONTRACT: "", OLLAMA_URL: "http://127.0.0.1:1", NEAR_ACCOUNT_CHECK: "0",
  ALLOW_SIM_PURCHASE: "1", AUCTION_WINDOW_MS: process.env.SIM_AUCTION_MS || "5000", TICK_MS: "1000" };
const server = spawn(process.execPath, [path.join(here, "..", "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverOut = ""; server.stdout.on("data", (d) => (serverOut += d)); server.stderr.on("data", (d) => (serverOut += d));
const stop = (code = 0) => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(code); };
// The sim server goes down with the script however it ends: Ctrl-C, a kill, a crash.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { console.log("\nSimulation stopped. The normal mode was never touched."); stop(0); });
process.on("uncaughtException", (e) => { console.error(e.message); stop(1); });
process.on("unhandledRejection", (e) => { console.error(e?.message || e); stop(1); });
process.on("exit", () => { try { server.kill(); } catch {} });
server.on("exit", (c) => { if (c) { console.error("The simulation server stopped:\n" + serverOut.slice(-1500)); process.exit(1); } });

for (let i = 0; i < 100; i++) { if (await fetch(base + "/api/status").then((r) => r.ok, () => false)) break; if (i === 99) { console.error(`Could not start the sim server on port ${PORT}. Is it in use? Try SIM_PORT=8799.`); stop(1); } await sleep(150); }

const found = (b) => api("/api/companies", { provider: "mock", model: "mock/small", seed: 5, payoutAccount: `sim-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.near`, avatar: look(), ...b });

console.log(`\nAgent Valley simulation · ${BUYERS} buyers, ${SELLERS} suppliers · demo model, no LLM, no money\n`);
const suppliers = [];
for (let i = 0; i < SELLERS; i++) {
  const s = SUPPLIER_PLAN[i % SUPPLIER_PLAN.length], name = i < SUPPLIER_PLAN.length ? s.name : `${s.name} ${Math.floor(i / SUPPLIER_PLAN.length) + 1}`;
  const co = await found({ name, sector: s.sector, price: s.price, minPrice: Math.max(0.01, +(s.price * STRATEGIES[s.strategy]).toFixed(2)), demo: { on: false }, portfolio: { enabled: false } });
  suppliers.push({ ...co, strategy: s.strategy });
  console.log(`  supplier  ${name.padEnd(16)} ${s.sector.padEnd(7)} list ${money(co.priceMicros)}  ${s.strategy} (floor ${money(co.minPriceMicros)})`);
}
const buyers = [];
for (let i = 0; i < BUYERS; i++) {
  const web = i % 5 < 3, sector = web ? "web" : "social";
  const list = web ? WEB_NAMES : SOCIAL_NAMES, k = buyers.filter((b) => b.sector === sector).length;
  const name = list[k % list.length] + (k >= list.length ? ` ${Math.floor(k / list.length) + 1}` : "");
  const price = web ? 4 + Math.round(rnd() * 20) / 10 : 2 + Math.round(rnd() * 10) / 10;
  const co = await found({ name, sector, price, demo: { on: true, everyMin: 1 + Math.floor(rnd() * 3) }, portfolio: { enabled: false } });
  buyers.push(co);
}
console.log(`  buyers    ${buyers.filter((b) => b.sector === "web").length} web agencies (buy design, images, legal texts), ${buyers.filter((b) => b.sector === "social").length} social media studios (buy images)`);

// A first wave of jobs so auctions start at once; after that the demo customers order on their own schedule.
for (const b of buyers) await api(`/api/companies/${b.id}/jobs`, { brief: pick(["A landing page for a small coffee roaster", "A launch page for a yoga studio", "A week of posts for a bike shop", "A product page for handmade candles", "A campaign for a bakery opening"]) }).catch(() => {});

console.log(`\nOpen while it runs:
  city      ${base}/city
  console   ${base}/app?mode=seller
  auctions  ${base}/api/auctions
Ctrl-C stops it. State lives in a temp folder and is deleted on exit.\n`);

const seen = new Set(), started = Date.now();
let lastSummary = 0;
for (;;) {
  await sleep(4000);
  const a = await api("/api/auctions").catch(() => null);
  if (a) for (const r of [...a.closed].reverse()) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    const bids = (r.bids || []).map((b) => `${b.name} ${money(b.bid ?? 0)}`).join(", ");
    console.log(r.winner ? `  round #${r.id} ${String(r.sector).padEnd(7)} for ${r.buyer?.name}: ${r.bids?.length || 0} sealed bids [${bids}] -> ${r.winner.name} wins, paid ${money(r.priceMicros || 0)}${r.outcome && r.outcome !== "ordered" ? ` (${r.outcome})` : ""}`
      : `  round #${r.id} ${r.sector} for ${r.buyer?.name}: ${r.outcome || r.status}`);
  }
  const city = await api("/api/city").catch(() => null);
  if (city && a && a.closed.length && Date.now() - lastSummary > 20_000) {
    lastSummary = Date.now();
    const rev = city.companies.reduce((s, c) => s + (c.ledger?.revenue || 0), 0);
    console.log(`  · ${city.companies.length} companies · ${a.stats.rounds} rounds · ${a.stats.avgBids} bids each on average · competition saved buyers ${money(a.stats.savedMicros)} · revenue ${money(rev)} · books ${city.check?.nerOk && city.check?.balanceOk ? "balanced" : "MISMATCH"}`);
  }
  if (MINUTES > 0 && Date.now() - started > MINUTES * 60_000) { console.log("\nSimulation finished."); stop(0); }
}
