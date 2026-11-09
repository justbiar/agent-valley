// Customer orders paid on chain. The only human step in the valley is the customer's order; the rest runs itself:
//   1. the customer describes a job and gets a quote in NEAR (the company's USD price at the current NEAR rate)
//   2. the customer's wallet pays into the contract's escrow (place_order)
//   3. this server sees the payment on chain and hands the job to the company's agent
//   4. on delivery the contract settles: fuel to the fuel treasury, parts to the supplier agents, tax on the profit,
//      the rest to the company. A failed job is refunded; an order not settled in time the customer takes back.
// The books follow the contract: revenue, the tax already taken on chain, and the fuel already paid back.
import crypto from "node:crypto";
import * as econ from "./economy.mjs";

const DAY = 86_400_000;

// micro-dollars to yoctoNEAR at a NEAR price in USD, kept exact with integers.
export function toYocto(micros, nearUsd) {
  const rate = BigInt(Math.round(nearUsd * 1e6)); // micro-dollars per NEAR
  return (BigInt(Math.round(micros)) * 10n ** 24n) / rate;
}
export const yoctoToNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

// The NEAR price, cached. NEAR_USD fixes it (tests, or when the price service is down).
export function createRate({ fixed = null, ttlMs = 10 * 60_000, fetchImpl = fetch } = {}) {
  let cache = null;
  return async () => {
    if (fixed) return fixed;
    if (cache && Date.now() - cache.at < ttlMs) return cache.usd;
    try {
      const r = await fetchImpl("https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
      const usd = Number((await r.json())?.near?.usd);
      if (usd > 0) { cache = { usd, at: Date.now() }; return usd; }
    } catch { /* keep the last known price */ }
    if (cache) return cache.usd;
    throw new Error("Could not get the NEAR price. Try again in a moment");
  };
}

export function createEscrow({ store, chain, rate, enqueue, byId, keyOf, taxBps = 200, now = () => Date.now(), checkEveryMs = 4000, payWindowMs = DAY, retryEveryMs = 60_000, maxRetries = 5 }) {
  if (!store.customerOrders) store.customerOrders = [];
  if (!store.nextCustomerOrder) store.nextCustomerOrder = 1;
  const list = () => store.customerOrders;
  const find = (id) => list().find((o) => o.id === Number(id));

  async function create(co, brief) {
    const c = chain();
    if (!c) throw Object.assign(new Error("No chain connection, orders are closed"), { status: 503 });
    if (co.chain?.id == null) throw new Error("This company has no chain id yet. Try again in a moment");
    if (co.status !== "running") throw new Error("This company is not taking orders right now");
    brief = String(brief || "").trim();
    if (brief.length < 5) throw new Error("Describe the job in at least a few words");
    const usd = await rate();
    const id = store.nextCustomerOrder++;
    const o = {
      id, ref: `av${id}-${crypto.randomBytes(3).toString("hex")}`, token: crypto.randomBytes(16).toString("hex"),
      coId: co.id, brief: brief.slice(0, 2000), priceMicros: co.priceMicros, nearUsd: usd, quoteYocto: toYocto(co.priceMicros, usd).toString(),
      status: "awaiting_payment", createdAt: now(), checkedAt: 0,
    };
    list().unshift(o); list().length = Math.min(list().length, 500);
    store.save();
    return o;
  }

  // Looks for paid orders on chain and hands them to their agent.
  async function check(o) {
    const c = chain();
    if (!c || o.status !== "awaiting_payment") return;
    o.checkedAt = now();
    const onChain = await c.getOrder(o.ref).catch(() => null);
    if (!onChain || onChain.status !== "paid") return;
    o.customer = onChain.customer; o.paidYocto = onChain.amount; o.paidAt = now();
    // A payment short of the quote (beyond a 3% rate swing) goes straight back.
    if (BigInt(onChain.amount) * 100n < BigInt(o.quoteYocto) * 97n) {
      o.status = "refunding"; o.reason = "Underpaid";
      await c.refundOrder(o.ref, o); o.status = "refunded"; store.save(); return;
    }
    const co = byId(o.coId);
    if (!co) { o.status = "refunding"; o.reason = "The company closed"; await c.refundOrder(o.ref, o); o.status = "refunded"; store.save(); return; }
    const job = enqueue(co, o.brief, "order");
    job.orderId = o.id;
    o.jobId = job.id; o.status = "working";
    co.log.unshift({ t: now(), kind: "stage", text: `Customer order paid (held in escrow on chain): ${o.brief.slice(0, 60)}` });
    store.save();
  }

  // A settlement or refund that failed on chain (a network error, a busy RPC) is tried again. If the transaction
  // did land and only its answer was lost, the contract already shows the result: the books follow it instead of
  // sending the transaction twice.
  async function retry(o) {
    const c = chain(), co = byId(o.coId), job = co?.jobs.find((j) => j.id === o.jobId);
    if (!c || !co || !job) return;
    o.retries = (o.retries || 0) + 1; o.retriedAt = now();
    const onChain = await c.getOrder(o.ref).catch(() => null);
    const wasSettle = o.status === "settle_failed";
    o.status = "working"; o.chainError = null;
    if (onChain?.status === "settled") return delivered(co, job, { onChain: true });
    if (onChain?.status === "refunded") { o.status = "refunded"; o.reason = o.reason || "Refunded"; store.save(); return; }
    return wasSettle ? delivered(co, job) : failed(co, job);
  }

  async function tick() {
    for (const o of list()) {
      if ((o.status === "settle_failed" || o.status === "refund_failed") && (o.retries || 0) < maxRetries && now() - (o.retriedAt || 0) >= retryEveryMs) await retry(o);
    }
    for (const o of list()) {
      if (o.status !== "awaiting_payment") continue;
      if (now() - o.createdAt > payWindowMs) { o.status = "expired"; store.save(); continue; }
      if (now() - o.checkedAt >= checkEveryMs) await check(o);
    }
  }

  // The agent delivered: settle on chain and book it.
  async function delivered(co, job, { onChain = false } = {}) {
    const o = job.orderId ? find(job.orderId) : null;
    if (!o || o.status !== "working") return;
    const c = chain();
    const usd = o.nearUsd, paid = BigInt(o.paidYocto || o.quoteYocto);
    // Fuel only when the platform's key paid the model bill; parts only those paid and on chain.
    const fuelMicros = keyOf(co) === undefined && econ.PAID_PROVIDERS.has(co.provider) ? Math.min(job.costMicros || 0, o.priceMicros) : 0;
    const parts = (job.subs || []).map((s) => {
      const sj = byId(s.coId)?.jobs.find((x) => x.id === s.jobId), sup = byId(s.coId);
      return sj?.b2bPaid && sup?.chain?.id != null ? { coId: s.coId, chainId: sup.chain.id, micros: s.priceMicros } : null;
    }).filter(Boolean);
    let fuelY = toYocto(fuelMicros, usd), partsY = parts.map((p) => toYocto(p.micros, usd));
    // Never ask the contract for more than was paid: fuel first, parts scaled into what is left.
    if (fuelY > paid) fuelY = paid;
    const room = paid - fuelY, partSum = partsY.reduce((a, x) => a + x, 0n);
    if (partSum > room) partsY = partsY.map((x) => (partSum ? (x * room) / partSum : 0n));
    const partMicros = parts.reduce((a, p) => a + p.micros, 0);
    o.status = "settling"; o.deliveredAt = now();
    o.split = { fuelMicros, partsMicros: partMicros, fuelYocto: fuelY.toString(), partsYocto: partsY.reduce((a, x) => a + x, 0n).toString() };
    store.save();
    if (c && !onChain) await c.settleOrder(o.ref, fuelY, parts.map((p, i) => ({ company: p.chainId, amount: partsY[i].toString() })), o);
    if (o.chainError && !o.settleTx) { o.status = "settle_failed"; store.save(); return; }
    // The books: the payment is revenue; the tax was taken on chain; the fuel was paid back on chain.
    econ.sale(store.books, co, o.priceMicros);
    job.paid = true;
    const taxMicros = Math.round((Math.max(0, o.priceMicros - fuelMicros - partMicros) * taxBps) / 10_000);
    if (taxMicros) econ.tax(store.books, co, taxMicros);
    if (co.tax) {
      co.tax.prepaid = (co.tax.prepaid || 0) + taxMicros;
      co.tax.fuelMark = Math.min(co.ledger.fuel || 0, (co.tax.fuelMark || 0) + fuelMicros);
    }
    o.split.taxMicros = taxMicros;
    o.status = "delivered";
    co.log.unshift({ t: now(), kind: "stage", text: `Order delivered and split on chain: revenue $${(o.priceMicros / 1e6).toFixed(2)}, fuel $${(fuelMicros / 1e6).toFixed(4)}, parts $${(partMicros / 1e6).toFixed(2)}, tax $${(taxMicros / 1e6).toFixed(4)}` });
    store.save();
  }

  async function failed(co, job) {
    const o = job.orderId ? find(job.orderId) : null;
    if (!o || o.status !== "working") return;
    o.status = "refunding"; o.reason = "The job could not be finished";
    await chain()?.refundOrder(o.ref, o);
    o.status = o.refundTx ? "refunded" : "refund_failed";
    co.log.unshift({ t: now(), kind: "warn", text: `Order could not be finished, refunded to the customer on chain` });
    store.save();
  }

  // What the customer (holder of the token) sees.
  function view(o, { job = null, txUrl = (h) => h } = {}) {
    const co = byId(o.coId);
    return {
      id: o.id, ref: o.ref, status: o.status, reason: o.reason || null, brief: o.brief, createdAt: o.createdAt,
      company: co ? { id: co.id, name: co.name, chainId: co.chain?.id ?? null } : null,
      priceMicros: o.priceMicros, nearUsd: o.nearUsd, quoteYocto: o.quoteYocto, quoteNear: yoctoToNear(o.quoteYocto),
      customer: o.customer || null, paidNear: o.paidYocto ? yoctoToNear(o.paidYocto) : null,
      split: o.split || null, settleTx: txUrl(o.settleTx), refundTx: txUrl(o.refundTx),
      job: job ? { status: job.status, output: job.status === "done" ? job.output : null, image: job.image || null, parts: (job.subs || []).map((s) => ({ sector: s.sectorName, name: s.name })) } : null,
    };
  }

  return { create, check, tick, retry, delivered, failed, view, find, list };
}
