// Customer orders paid into the contract's escrow: the payment is seen on chain, the agent gets the job, delivery
// settles the split on chain, failure refunds, and the books follow without double tax or double fuel.
// Run: node test/escrow.mjs
import assert from "node:assert/strict";
import * as econ from "../src/economy.mjs";
import { createEscrow, toYocto, yoctoToNear } from "../src/escrow.mjs";
import { createTaxes } from "../src/taxes.mjs";

const USD = 1e6, NEAR = 10n ** 24n;
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

// A stand-in for the contract's order methods.
function fakeChain() {
  const orders = {}, calls = [], fail = { settle: 0, lostAnswer: 0 };
  return {
    orders, calls, fail,
    pay: (ref, amount, customer = "cust.testnet") => (orders[ref] = { order_ref: ref, status: "paid", amount: String(amount), customer }),
    async getOrder(ref) { return orders[ref] || null; },
    async settleOrder(ref, fuel, parts, rec) {
      if (fail.settle > 0) { fail.settle--; calls.push({ m: "settle-failed", ref }); rec.chainError = "rpc down"; return; }
      const o = orders[ref], sum = BigInt(fuel) + parts.reduce((a, p) => a + BigInt(p.amount), 0n);
      if (sum > BigInt(o.amount)) throw new Error("Fuel and parts exceed the payment");
      calls.push({ m: "settle", ref, fuel: String(fuel), parts }); o.status = "settled";
      if (fail.lostAnswer > 0) { fail.lostAnswer--; rec.chainError = "timeout waiting for the answer"; return; }
      rec.settleTx = "tx-settle";
    },
    async refundOrder(ref, rec) { calls.push({ m: "refund", ref }); orders[ref].status = "refunded"; rec.refundTx = "tx-refund"; },
  };
}

function valley({ ownKey = false } = {}) {
  let t = 1_000_000;
  const books = econ.newBooks(), jobs = [];
  const mk = (id, name, chainId) => { const co = { id, name, status: "running", provider: "nearai", priceMicros: 2 * USD, chain: { id: chainId }, createdAt: 0, ledger: econ.newLedger(), log: [], jobs: [] }; econ.seed(books, co, 5 * USD); return co; };
  const web = mk(1, "Sitehane", 10), ui = mk(2, "Kalıp", 11);
  const companies = [web, ui];
  const store = { companies, books, save() {} };
  const chain = fakeChain();
  const taxes = createTaxes({ store, ping: null, platformAccount: "", minMicros: 1, periodMs: 1_000_000_000, now: () => t });
  taxes.tick();
  const escrow = createEscrow({
    store, chain: () => chain, rate: async () => 2, byId: (id) => companies.find((c) => c.id === id), keyOf: () => (ownKey ? "own" : undefined),
    enqueue: (co, brief, source) => { const j = { id: `${co.id}-${co.jobs.length + 1}`, brief, source, status: "queued" }; co.jobs.unshift(j); jobs.push(j); return j; },
    now: () => t, checkEveryMs: 0, payWindowMs: 60_000, retryEveryMs: 1000,
  });
  return { books, store, chain, escrow, web, ui, jobs, taxes, advance: (ms) => (t += ms), ok: () => assert.ok(econ.check(books, companies).balanceOk && econ.check(books, companies).nerOk, "books hold") };
}

await test("dollars become an exact NEAR quote", () => {
  assert.equal(toYocto(1 * USD, 2), NEAR / 2n);
  assert.equal(toYocto(3 * USD, 1.5), 2n * NEAR);
  assert.equal(yoctoToNear((NEAR * 3n) / 4n), 0.75);
});

await test("an order is quoted in NEAR and waits for payment", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  assert.equal(o.status, "awaiting_payment");
  assert.equal(o.quoteYocto, String(NEAR), "$2 at $2 a NEAR is 1 NEAR");
  assert.match(o.ref, /^av1-[0-9a-f]{6}$/);
  await v.escrow.tick();
  assert.equal(o.status, "awaiting_payment", "nothing paid yet");
  await assert.rejects(v.escrow.create(v.web, "x"), /Describe the job/);
});

await test("a payment seen on chain hands the job to the agent", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  assert.equal(o.status, "working");
  assert.equal(o.customer, "cust.testnet");
  assert.equal(v.jobs[0].source, "order");
  assert.equal(v.jobs[0].orderId, o.id);
});

await test("a short payment goes straight back", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR / 2n);
  await v.escrow.tick();
  assert.equal(o.status, "refunded");
  assert.equal(v.jobs.length, 0);
});

await test("delivery settles on chain: fuel, parts and tax, and the books follow without charging twice", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  const job = v.jobs[0];
  // The agent bought a UI part for $0.50 and spent $0.20 of the platform's model credit.
  const part = { id: "2-1", status: "done", b2bPaid: true };
  v.ui.jobs.push(part);
  econ.trade(v.books, v.web, v.ui, 500_000);
  econ.aiCost(v.books, v.web, 200_000, "nearai");
  Object.assign(job, { status: "done", costMicros: 200_000, subs: [{ coId: 2, jobId: "2-1", priceMicros: 500_000 }] });
  await v.escrow.delivered(v.web, job);
  const call = v.chain.calls.find((c) => c.m === "settle");
  assert.equal(call.fuel, String(toYocto(200_000, 2)));
  assert.deepEqual(call.parts, [{ company: 11, amount: String(toYocto(500_000, 2)) }]);
  assert.equal(o.status, "delivered");
  assert.equal(o.split.taxMicros, Math.round((2 * USD - 200_000 - 500_000) * 0.02));
  assert.equal(v.web.ledger.revenue, 2 * USD);
  assert.equal(job.paid, true);
  assert.equal(v.web.tax.prepaid, o.split.taxMicros);
  assert.equal(v.taxes.fuelOwed(v.web), 0, "the fuel was paid back on chain");
  v.ok();
});

await test("the month's invoice does not tax again what the contract already taxed", async () => {
  const v = valley({ ownKey: true });
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  Object.assign(v.jobs[0], { status: "done", costMicros: 0, subs: [] });
  await v.escrow.delivered(v.web, v.jobs[0]);
  assert.equal(v.chain.calls[0].fuel, "0", "a company on its own key owes no fuel");
  v.advance(2_000_000_000); v.taxes.tick();
  const inv = v.web.tax.invoices[0];
  assert.ok(!inv || inv.taxMicros === 0, "nothing more to pay for this month");
});

await test("a failed job is refunded on chain; an unpaid order expires", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  await v.escrow.failed(v.web, v.jobs[0]);
  assert.equal(o.status, "refunded");
  assert.equal(o.refundTx, "tx-refund");
  const late = await v.escrow.create(v.web, "Başka bir iş");
  v.advance(61_000); await v.escrow.tick();
  assert.equal(late.status, "expired");
});

await test("the customer's view shows the split and the delivery, never other customers' data", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  const view = v.escrow.view(o, { job: { status: "done", output: "<html>site</html>", subs: [] } });
  assert.equal(view.quoteNear, 1);
  assert.equal(view.job.output, "<html>site</html>");
  assert.equal(view.token, undefined, "the token is not echoed in the view");
});

await test("a settlement that failed on chain is tried again and booked once", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  Object.assign(v.jobs[0], { status: "done", costMicros: 0, subs: [] });
  v.chain.fail.settle = 1;
  await v.escrow.delivered(v.web, v.jobs[0]);
  assert.equal(o.status, "settle_failed");
  assert.equal(v.web.ledger.revenue, 0, "nothing booked while the chain has not settled");
  v.advance(1500); await v.escrow.tick();
  assert.equal(o.status, "delivered");
  assert.equal(v.web.ledger.revenue, 2 * USD);
  assert.equal(v.chain.calls.filter((c) => c.m === "settle").length, 1);
  v.ok();
});

await test("when the settlement landed but its answer was lost, the retry reads the chain instead of paying twice", async () => {
  const v = valley();
  const o = await v.escrow.create(v.web, "Kahve dükkânı sitesi");
  v.chain.pay(o.ref, NEAR);
  await v.escrow.tick();
  Object.assign(v.jobs[0], { status: "done", costMicros: 0, subs: [] });
  v.chain.fail.lostAnswer = 1;
  await v.escrow.delivered(v.web, v.jobs[0]);
  assert.equal(o.status, "settle_failed");
  v.advance(1500); await v.escrow.tick();
  assert.equal(o.status, "delivered");
  assert.equal(v.chain.calls.filter((c) => c.m === "settle").length, 1, "the contract was not asked to settle a second time");
  assert.equal(v.web.ledger.revenue, 2 * USD, "booked exactly once");
  v.ok();
});

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
