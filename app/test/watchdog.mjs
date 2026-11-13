// The paid order watchdog: a paid job that does not start says why after a few minutes, is marked stalled (refund
// due) after two hours, and a late delivery still counts and clears it. Run: node test/watchdog.mjs
import assert from "node:assert/strict";
import { createPaidOrders } from "../src/paidorders.mjs";

let t = 1_000_000;
const MIN = 60_000, HOUR = 3_600_000;
const co = { id: 4, name: "Law Office", status: "running", waiting: "no_provider", log: [], stage: "idea", jobs: [{ id: "4-1", status: "queued", costMicros: 0 }],
  ledger: { revenue: 0, earned: 0, ner: 0, capital: 0, raised: 0, aiCost: 0, seed: 0 } };
const store = { paidOrders: [], nextPaidOrder: 1, companies: [co], books: { revenue: 0, ner: 0, external: 0, capital: 0 }, save() {} };
const po = createPaidOrders({ store, ping: {}, enqueue: () => null, byId: (id) => store.companies.find((c) => c.id === id), now: () => t });
store.paidOrders.push({ id: 2, token: "x", coId: 4, brief: "A privacy policy", priceMicros: 2_000_000, tier: "full", status: "working", createdAt: t, paidAt: t, jobId: "4-1" });
const o = store.paidOrders[0];

const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

await test("a paid job that just started waiting is left alone", async () => {
  t += MIN; await po.tick();
  assert.equal(o.stall, undefined);
});
await test("after three minutes the customer and the owner see why it waits", async () => {
  t += 3 * MIN; await po.tick();
  assert.equal(o.stall.why, "no_provider");
  assert.match(po.view(o).waiting.reason, /model key is not connected/);
  assert.equal(po.waitingFor(co).length, 1);
  assert.match(co.log[0].text, /paid but has not started/);
});
await test("after two hours the order is stalled and a refund is due", async () => {
  t += 2 * HOUR; await po.tick();
  assert.equal(o.status, "stalled");
  assert.match(o.reason, /owes you a refund/);
});
await test("a late delivery still counts: the sale is booked and the stall cleared", async () => {
  co.jobs[0] = { ...co.jobs[0], status: "done", startedAt: t, brain: { provider: "nearai", model: "typesafe/jev-1.13" }, model: "typesafe/jev-1.13" };
  po.delivered(co, { ...co.jobs[0], paidOrderId: 2 });
  assert.equal(o.status, "delivered");
  assert.equal(o.stall, null);
  assert.equal(po.waitingFor(co).length, 0);
});
await test("the delivery names the model that really did the work", async () => {
  const v = po.view(o, { job: co.jobs[0] });
  assert.deepEqual(v.job.servedBy, { model: "typesafe/jev-1.13", provider: "nearai", fallback: false });
});

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
