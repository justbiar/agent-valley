// The NEAR mirror: transactions go out one at a time and in order, a round is revealed only with the seals that
// reached the chain, the contract's verdict is compared with the app's, and a failing chain never breaks the valley.
// Uses a stand-in for the contract that follows its rules. Run: node test/chain.mjs
import assert from "node:assert/strict";
import { createChain, chainName, chainSector, agentAccount } from "../src/chain.mjs";
import { openRound, sealBid, closeRound, commitOf } from "../src/auction.mjs";

const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

// Stand-in contract: same checks and the same winner rule as contracts/valley.
function fakeContract({ failOn = new Set() } = {}) {
  const calls = [], companies = [], rounds = {};
  let n = 0, busy = false;
  return {
    calls, companies, rounds,
    async call(method, args, deposit = 0n) {
      assert.equal(busy, false, "two transactions in flight at once"); busy = true;
      await new Promise((r) => setTimeout(r, 5));
      busy = false;
      calls.push({ method, args, deposit });
      if (failOn.has(method)) throw new Error(`${method} failed on chain`);
      const tx = "tx" + ++n;
      if (method === "found") { companies.push({ ...args, id: companies.length }); return { txHash: tx, value: companies.length - 1 }; }
      if (method === "open_round") { rounds[args.round] = { ...args, seals: [], closed: false }; return { txHash: tx, value: null }; }
      if (method === "seal") { rounds[args.round].seals.push({ company: args.company, commit: args.commit, at: n }); return { txHash: tx, value: null }; }
      if (method === "reveal") {
        const r = rounds[args.round];
        const bids = args.reveals.map((rv) => {
          const s = r.seals.find((x) => x.company === rv.company);
          if (!s) throw new Error("No sealed bid from this company");
          const ref = companies[rv.company].card.ref_id;
          if (commitOf(args.round, ref, Number(rv.bid), Number(rv.list), rv.salt) !== s.commit) throw new Error("Reveal does not match the sealed bid");
          return { company: rv.company, bid: Number(rv.bid), list: Number(rv.list), at: s.at };
        }).sort((a, b) => a.bid - b.bid || a.at - b.at || a.company - b.company);
        r.winner = bids[0]?.company ?? null;
        r.price = bids.length ? String(bids.length > 1 ? Math.min(bids[1].bid, bids[0].list) : bids[0].list) : null;
        r.closed = true;
        return { txHash: tx, value: r.winner };
      }
      return { txHash: tx, value: null };
    },
    async view(method, args) { return method === "get_round" ? rounds[args.round] : null; },
  };
}

const co = (id, name, sector, price) => ({ id, name, sector, priceMicros: price, model: "mock/small", payoutAccount: "kadraj.near" });

await test("names fit 32 bytes and agent accounts live under the contract", () => {
  assert.equal(Buffer.byteLength(chainName("Şirin Çiçek Görsel Stüdyosu Ağaçlı")) <= 32, true);
  assert.equal(chainSector("Logo Stüdyosu!"), "logostdyosu");
  assert.equal(agentAccount({ id: 12 }, "agentvalley-biar.testnet"), "a12.agentvalley-biar.testnet");
});

await test("founding gives each company an Agent ID, its card and the payout owner", async () => {
  const c = fakeContract(), chain = createChain({ client: c, contractId: "v.testnet", log: () => {} });
  const a = co(5, "Kalıp A", "design", 500_000);
  await chain.found(a);
  assert.deepEqual(a.chain, { id: 0, agent: "a5.v.testnet", tx: "tx1" });
  const f = c.calls[0];
  assert.equal(f.args.owner, "kadraj.near");
  assert.equal(f.args.card.ref_id, 5);
  assert.equal(f.args.charter.founder_bps, 10_000);
  assert.ok(f.deposit > 0n);
  assert.equal(chain.found(a), null, "a company is founded on chain once");
});

await test("a full round goes out in order and the contract agrees with the app", async () => {
  const c = fakeContract(), chain = createChain({ client: c, contractId: "v.testnet", log: () => {}, revealDelayMs: 0 });
  const buyer = co(1, "Sitehane", "web", 2_000_000), A = co(2, "Kalıp A", "design", 500_000), B = co(3, "Kalıp B", "design", 600_000), C = co(4, "Kalıp C", "design", 500_000);
  const all = [buyer, A, B, C];
  for (const x of all) chain.found(x);
  const round = openRound({ id: 9, t: Date.now(), closesAt: Date.now(), buyer, sector: "design" });
  chain.openRound(round, buyer);
  for (const [s, bid] of [[A, 300_000], [B, 200_000], [C, 250_000]]) chain.seal(round, s, sealBid(round, s, bid));
  closeRound(round);
  await chain.reveal(round, (id) => all.find((x) => x.id === id));
  assert.deepEqual(c.calls.map((x) => x.method), ["found", "found", "found", "found", "open_round", "seal", "seal", "seal", "reveal"]);
  assert.equal(round.winner.name, "Kalıp B");
  assert.equal(round.chain.winner, B.chain.id);
  assert.equal(round.chain.price, 250_000);
  assert.equal(round.chain.agrees, true);
  assert.equal(Object.keys(round.chain.seals).length, 3);
});

await test("a supplier without an Agent ID bids in the app but stays out of the chain reveal", async () => {
  const c = fakeContract(), chain = createChain({ client: c, contractId: "v.testnet", log: () => {}, revealDelayMs: 0 });
  const buyer = co(1, "Sitehane", "web", 2_000_000), A = co(2, "Kalıp A", "design", 500_000), B = co(3, "Kalıp B", "design", 600_000);
  chain.found(buyer); chain.found(A); // B never gets an id
  const round = openRound({ id: 1, t: Date.now(), closesAt: Date.now(), buyer, sector: "design" });
  chain.openRound(round, buyer);
  chain.seal(round, A, sealBid(round, A, 300_000));
  assert.equal(chain.seal(round, B, sealBid(round, B, 200_000)), null);
  closeRound(round);
  await chain.reveal(round, (id) => [buyer, A, B].find((x) => x.id === id));
  assert.equal(c.calls.at(-1).args.reveals.length, 1);
  assert.equal(round.chain.agrees, null, "not every app bid reached the chain, so no verdict comparison");
});

await test("a round whose buyer has no Agent ID stays app-only", () => {
  const chain = createChain({ client: fakeContract(), contractId: "v.testnet", log: () => {} });
  const round = openRound({ id: 2, t: 1, closesAt: 2, buyer: co(1, "X", "web", 1), sector: "design" });
  assert.equal(chain.openRound(round, co(1, "X", "web", 1)), null);
  assert.ok(round.chain.skipped);
});

await test("a failing chain records the error and keeps the queue moving", async () => {
  const c = fakeContract({ failOn: new Set(["open_round"]) }), chain = createChain({ client: c, contractId: "v.testnet", log: () => {}, revealDelayMs: 0 });
  const buyer = co(1, "Sitehane", "web", 2_000_000), A = co(2, "Kalıp A", "design", 500_000);
  chain.found(buyer); chain.found(A);
  const round = openRound({ id: 3, t: Date.now(), closesAt: Date.now(), buyer, sector: "design" });
  chain.openRound(round, buyer);
  chain.seal(round, A, sealBid(round, A, 300_000));
  closeRound(round);
  chain.reveal(round, (id) => [buyer, A].find((x) => x.id === id));
  const d = co(9, "Sonraki", "visual", 1);
  await chain.found(d);
  assert.match(round.chain.error, /open_round failed/);
  assert.equal(round.chain.reveal, undefined);
  assert.equal(d.chain.id, 2, "later transactions still go out");
  assert.equal(chain.stats.failed, 3, "the failed open, and the seal and reveal that depended on it");
});

await test("share purchases and pool grants go on chain with their hash on the log entry", async () => {
  const c = fakeContract(), chain = createChain({ client: c, contractId: "v.testnet", log: () => {} });
  const A = co(1, "Sitehane", "web", 1), B = co(2, "Kalıp", "design", 1);
  chain.found(A); chain.found(B);
  const buy = { kind: "buy" }, grant = { kind: "grant" };
  chain.buyShares(A, B, 20_000, buy);
  await chain.grantShares(A, B, 5_000, grant);
  assert.deepEqual(c.calls.slice(2).map((x) => [x.method, x.args]), [["buy_shares", { id: 0, buyer: 1, shares: 20_000 }], ["grant_shares", { id: 0, to: 1, shares: 5_000 }]]);
  assert.ok(buy.tx && grant.tx);
  assert.equal(chain.buyShares(A, co(3, "Yok", "web", 1), 1, {}), null, "a partner without an Agent ID stays off chain");
});

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
