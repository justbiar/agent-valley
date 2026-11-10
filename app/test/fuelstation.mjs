// The fuel station: an agent buys its own model credit with its own wallet before it runs out, within the limits
// its owner set, and fuel it already paid for is never invoiced. Ping Agent Pay and the wallet are stand-ins here.
// Run: node test/fuelstation.mjs
import assert from "node:assert/strict";
import { createFuelStation } from "../src/fuelstation.mjs";
import { createTaxes } from "../src/taxes.mjs";
import { createFuel } from "../src/fuel.mjs";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("ok  ", name); };
const flush = () => new Promise((r) => setTimeout(r, 0));

function world({ open = true, wallet = true, failWith = null } = {}) {
  let t = Date.UTC(2026, 10, 10, 9);
  const now = () => t;
  const co = { id: 7, name: "Frame", provider: "openrouter", ownKey: false, status: "running", createdAt: t, log: [],
    ledger: { fuel: 0, revenue: 0, b2bIn: 0, b2bOut: 0, aiCost: 0 } };
  const store = { companies: [co], save() {} };
  const fuel = createFuel({ store, now });
  const taxes = createTaxes({ store, ping: null, platformAccount: "", fuelBillMicros: 5_000_000, now });
  const calls = { sell: [], pay: [], settle: [] };
  const station = createFuelStation({ store, taxes, fuel, now, minMicros: 200_000,
    isOpen: () => open, canBuy: () => wallet,
    sell: async (c, micros) => { calls.sell.push(micros); return { amount: String(micros), payTo: "0x" + "a".repeat(40), agentPayChallengeId: "ch" + calls.sell.length }; },
    payFrom: async (c, prepared) => { calls.pay.push(prepared.amount); if (failWith) throw new Error(failWith); return { txHash: "0x" + String(calls.pay.length).padStart(64, "0") }; },
    settle: async (prepared, tx) => { calls.settle.push(tx); } });
  taxes.fuelOwed(co); // the server meets a company at founding; fuel counts from there
  const use = (micros) => { co.ledger.fuel += micros; co.ledger.aiCost += micros; };
  return { co, store, fuel, taxes, station, calls, use, later: (ms) => (t += ms) };
}

await test("an agent with no credit buys its fuel on its own, from its own wallet", async () => {
  const w = world();
  w.station.tick(); await flush();
  assert.deepEqual(w.calls.sell, [2_000_000]);
  assert.equal(w.calls.settle.length, 1, "the platform settles the payment it was paid");
  const v = w.station.view(w.co);
  assert.equal(v.creditMicros, 2_000_000);
  assert.equal(v.buys[0].status, "paid");
  assert.match(v.buys[0].txHash, /^0x0+1$/);
  assert.equal(w.fuel.view().soldMicros, 2_000_000);
  assert.match(w.co.log[0].text, /Bought \$2\.00 of fuel .* own wallet/);
});

await test("fuel it uses comes out of its credit, so nothing is invoiced", async () => {
  const w = world();
  w.station.tick(); await flush();
  w.use(700_000);
  w.station.tick(); await flush();
  assert.equal(w.taxes.fuelOwed(w.co), 0);
  assert.equal(w.station.view(w.co).creditMicros, 1_300_000);
  assert.equal(w.fuel.view().collectedMicros, 700_000, "paid fuel counts as collected");
  w.use(4_000_000); w.later(60_000);
  w.station.tick(); await flush();
  w.taxes.tick();
  assert.equal(w.co.tax.invoices.length, 0, "a fuel invoice never goes out for fuel the agent bought");
});

await test("when it used more than its credit it buys enough to cover that and refill", async () => {
  const w = world();
  w.station.tick(); await flush();
  w.use(3_500_000); // 2.00 credit, 1.50 not covered
  w.station.tick(); await flush();
  assert.equal(w.calls.sell[1], 2_000_000, "1.50 owed + 0.50 threshold");
  w.station.tick(); await flush();
  assert.equal(w.taxes.fuelOwed(w.co), 0);
});

await test("the owner's daily limit holds", async () => {
  const w = world();
  w.station.settings(w.co, { buy: 2, dailyCap: 4 });
  for (let i = 0; i < 5; i++) { w.use(2_500_000); w.station.tick(); await flush(); }
  assert.equal(w.calls.sell.reduce((a, x) => a + x, 0) <= 4_000_000, true);
  await assert.rejects(w.station.buy(w.co, 1_000_000, "owner"), /daily fuel limit/);
  w.later(86_400_000); w.station.tick(); await flush();
  assert.ok(w.calls.sell.length >= 3, "a new day opens the limit again");
});

await test("no wallet, or a closed station: nothing is bought and fuel is invoiced as before", async () => {
  for (const w of [world({ wallet: false }), world({ open: false })]) {
    w.use(6_000_000); w.station.tick(); await flush(); w.taxes.tick();
    assert.equal(w.calls.sell.length, 0);
    assert.equal(w.co.tax.invoices[0].fuelMicros, 6_000_000);
  }
  await assert.rejects(world({ open: false }).station.buy(world().co, 1_000_000), /station is closed/);
});

await test("a payment the wallet refuses is recorded, nothing is credited, and it waits before trying again", async () => {
  const w = world({ failWith: "A wallet rule blocks the payment: limit_exceeded" });
  w.station.tick(); await flush();
  const v = w.station.view(w.co);
  assert.equal(v.creditMicros, 0);
  assert.equal(v.buys[0].status, "failed");
  assert.match(v.buys[0].error, /limit_exceeded/);
  w.station.tick(); await flush();
  assert.equal(w.calls.sell.length, 1, "no retry right away");
  w.later(11 * 60_000); w.station.tick(); await flush();
  assert.equal(w.calls.sell.length, 2, "tries again after ten minutes");
});

await test("one purchase at a time, and the rule is checked", async () => {
  const w = world();
  const a = w.station.buy(w.co, 1_000_000, "owner");
  await assert.rejects(w.station.buy(w.co, 1_000_000, "owner"), /already on its way/);
  await a;
  assert.throws(() => w.station.settings(w.co, { buy: 0.1 }), /Amount per purchase/);
  assert.throws(() => w.station.settings(w.co, { buy: 20, dailyCap: 10 }), /above the daily limit/);
  assert.equal(w.station.view(w.co).auto.buyMicros, 2_000_000, "a rejected change keeps the old rule");
  assert.equal(w.station.settings(w.co, { on: false }).auto.on, false);
  w.use(5_000_000); w.station.tick(); await flush();
  assert.equal(w.calls.sell.length, 1, "switched off: the agent no longer buys on its own");
});

console.log(`\n${passed}/${passed} passed`);
