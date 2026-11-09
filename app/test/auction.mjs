// Sealed-bid part auctions: suppliers bid at once, the lowest bid wins and is paid the second-lowest bid,
// every commitment can be checked after the reveal, and the books still balance.
// Run: node test/auction.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { floorOf, bidOf, runAuction, verifyAuction, commitOf } from "../src/auction.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8947, base = `http://127.0.0.1:${PORT}`;
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-auction-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json() }; };
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const co = (id, price, min) => ({ id, name: "S" + id, priceMicros: price, ...(min != null ? { minPriceMicros: min } : {}) });

/* ---------- the rule on its own ---------- */
await test("idle suppliers bid their floor, busy ones rise to list price", () => {
  const s = co(1, 400_000);
  assert.equal(floorOf(s, 100_000), 200_000, "half of list when the model bill is small");
  assert.equal(floorOf(s, 300_000), 375_000, "the model bill plus 25% when that is higher");
  assert.equal(floorOf(co(1, 400_000, 250_000)), 250_000, "the owner's floor wins");
  assert.equal(floorOf(co(1, 400_000, 900_000)), 400_000, "never above list");
  assert.equal(bidOf(s, { load: 0 }), 200_000);
  assert.equal(bidOf(s, { load: 3 }), 400_000);
  assert.ok(bidOf(s, { load: 1 }) > 200_000 && bidOf(s, { load: 1 }) < 400_000);
});

await test("the lowest bid wins and is paid the second-lowest bid", () => {
  const a = runAuction({ id: 7, t: 1, buyer: { id: 9, name: "B" }, sector: "design", bidders: [
    { co: co(1, 500_000), bid: 300_000 }, { co: co(2, 400_000), bid: 220_000 }, { co: co(3, 600_000), bid: 350_000 }] });
  assert.equal(a.winner.coId, 2);
  assert.equal(a.priceMicros, 300_000);
  assert.equal(a.rule, "second-price");
  assert.ok(verifyAuction(a));
});

await test("the second price never exceeds the winner's own list price", () => {
  const a = runAuction({ id: 1, t: 1, buyer: { id: 9, name: "B" }, sector: "design", bidders: [{ co: co(1, 250_000), bid: 200_000 }, { co: co(2, 900_000), bid: 800_000 }] });
  assert.equal(a.priceMicros, 250_000);
  assert.ok(verifyAuction(a));
});

await test("a lone supplier is paid its list price; a tie goes to the earlier seal, as on chain", () => {
  const one = runAuction({ id: 2, t: 1, buyer: { id: 9, name: "B" }, sector: "design", bidders: [{ co: co(1, 400_000), bid: 200_000 }] });
  assert.equal(one.rule, "list-price"); assert.equal(one.priceMicros, 400_000); assert.ok(verifyAuction(one));
  const tie = runAuction({ id: 3, t: 1, buyer: { id: 9, name: "B" }, sector: "design", bidders: [{ co: co(1, 400_000), bid: 200_000, t: 50 }, { co: co(2, 400_000), bid: 200_000, t: 20 }] });
  assert.equal(tie.winner.coId, 2);
});

await test("the app seals exactly like the contract (sha256 of round|company|bid|list|salt)", () => {
  assert.equal(commitOf(7, 12, 200000, 600000, "b2"), "8ed5c0d8a06dcbaadb5c94be9c5f57d5c7716618b7031d681aa9c9d316470abe");
});

await test("a changed bid or a wrong winner fails verification", () => {
  const a = runAuction({ id: 4, t: 1, buyer: { id: 9, name: "B" }, sector: "design", bidders: [{ co: co(1, 500_000), bid: 300_000 }, { co: co(2, 500_000), bid: 250_000 }] });
  const forged = structuredClone(a); forged.bids[0].bid = 100_000;
  assert.equal(verifyAuction(forged), false, "commitment no longer matches");
  const rigged = structuredClone(a); rigged.priceMicros = 500_000;
  assert.equal(verifyAuction(rigged), false, "price does not follow the rule");
});

/* ---------- inside the running economy ---------- */
const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, NEAR_ACCOUNT_CHECK: "0", TICK_MS: "150", AUCTION_WINDOW_MS: "2000" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const found = async (body) => { const r = await api("/api/companies", { method: "POST", body: { provider: "mock", model: "mock/small", seed: 5, payoutAccount: "kadraj-test.near", ...body } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let a, b, c, web;

  await test("three UI studios open with different list prices and floors", async () => {
    a = await found({ name: "Kalıp A", sector: "design", price: 0.5, minPrice: 0.3 });
    b = await found({ name: "Kalıp B", sector: "design", price: 0.6, minPrice: 0.2 });
    c = await found({ name: "Kalıp C", sector: "design", price: 0.5 });
    web = await found({ name: "Sitehane", sector: "web", price: 2 });
    assert.equal(b.minPriceMicros, 200_000);
    assert.equal(c.minPriceMicros, null);
    assert.equal(c.bidFloorMicros, 250_000, "automatic floor (half of list) shown to the owner");
  });

  await test("a site order opens a listing on the board; while open, bids show only as commitments", async () => {
    await api(`/api/companies/${web.id}/jobs`, { method: "POST", body: { brief: "Seramik kupa e-ticaret sitesi" } });
    const board = await until(async () => { const d = (await api("/api/auctions")).data; return d.open.length && d.open[0].bids.length ? d : null; });
    const open = board.open[0];
    assert.equal(open.sector, "design");
    assert.equal(open.buyer.name, "Sitehane");
    assert.ok(open.closesAt > open.t);
    assert.ok(open.bids.every((x) => /^[0-9a-f]{64}$/.test(x.commit) && x.bid === undefined && x.salt === undefined), "amounts stay sealed");
    const st = (await api("/api/companies")).data.find((x) => x.id === web.id);
    assert.equal(st.jobsQueued, 0, "the main job waits for the listing instead of running");
  });

  await test("the listing closes: B bids lowest, wins and is paid the second-lowest bid", async () => {
    const city = await until(async () => { const d = (await api("/api/city")).data; return d.auctions.length && d.trades.length ? d : null; });
    const round = city.auctions[0];
    assert.equal(round.status, "closed");
    assert.equal(round.sector, "design");
    assert.equal(round.bids.length, 3);
    assert.ok(round.bids.every((x) => /^[0-9a-f]{64}$/.test(x.commit) && x.salt), "every bid sealed and revealed");
    assert.equal(round.winner.name, "Kalıp B");
    assert.equal(round.winner.bid, 200_000);
    assert.equal(round.priceMicros, 250_000, "C's automatic floor ($0.25) is the second-lowest bid");
    assert.equal(round.verified, true);
    assert.equal(city.trades[0].to, b.id);
    assert.equal(city.trades[0].amount, round.priceMicros, "the trade pays the clearing price, not B's $0.60 list");
    const board = (await api("/api/auctions")).data;
    assert.equal(board.open.length, 0);
    assert.equal(board.stats.ordered, 1);
    assert.equal(board.stats.savedMicros, 600_000 - 250_000, "B's list price minus what it was paid");
  });

  await test("losers hear they lost, the books still balance", async () => {
    const list = (await api("/api/companies")).data;
    assert.ok(list.find((x) => x.id === a.id).log.some((l) => /Lost the .* auction/.test(l.text)));
    assert.ok(list.find((x) => x.id === b.id).log.some((l) => /Won the .* auction/.test(l.text)));
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
  });

  await test("an owner can change or clear the floor", async () => {
    let r = await api(`/api/companies/${c.id}`, { method: "PATCH", body: { minPrice: 0.35 } });
    assert.equal(r.data.minPriceMicros, 350_000);
    r = await api(`/api/companies/${c.id}`, { method: "PATCH", body: { minPrice: null } });
    assert.equal(r.data.minPriceMicros, null);
  });

  await test("rounds survive a restart of the state file", async () => {
    const disk = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.ok(disk.auctions.length >= 1 && disk.nextAuction >= 1);
  });
} finally {
  app.kill();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
