// Full orders, paid in real USDC. The other way to order is a trial in testnet NEAR through the escrow contract
// (escrow.mjs), which a company serves with its free or cheap trial model. A full order runs on the company's main
// model at its own limits, so this is where real work at any scale is bought.
//
//   1. the customer describes the job; the server opens a PingPay checkout for the company's price, payable to the
//      company's own NEAR account (the platform never holds the money)
//   2. the server asks PingPay until the session is COMPLETED (a customer's claim is never trusted), then the job
//      starts on the main model
//   3. on delivery the sale is booked; tax and the model bill (fuel) go on the company's monthly invoice
//
// There is no contract in this path, so no escrow either: a failed job is marked and the founder refunds it.
import crypto from "node:crypto";
import * as econ from "./economy.mjs";

export function createPaidOrders({ store, ping, enqueue, byId, now = () => Date.now(), checkEveryMs = 4000, payWindowMs = 2 * 3_600_000 }) {
  if (!store.paidOrders) store.paidOrders = [];
  if (!store.nextPaidOrder) store.nextPaidOrder = 1;
  const list = () => store.paidOrders;
  const find = (id) => list().find((o) => o.id === Number(id));
  const fmt = (m) => "$" + (m / 1e6).toFixed(2);
  const open = (co) => !!ping && !!co?.payoutAccount;

  async function create(co, brief, base) {
    if (!ping) throw Object.assign(new Error("Paid orders are not open: no payment provider is set up"), { status: 503 });
    if (!co.payoutAccount) throw new Error("This company has no NEAR account to receive payments");
    if (co.status !== "running") throw new Error("This company is not taking orders right now");
    brief = String(brief || "").trim();
    if (brief.length < 5) throw new Error("Describe the job in at least a few words");
    const id = store.nextPaidOrder++, token = crypto.randomBytes(16).toString("hex");
    const back = `${base}/order.html?c=${co.id}&p=${id}&t=${token}`;
    const s = await ping.createSession({ amountMicros: co.priceMicros, recipient: co.payoutAccount, successUrl: back + "&paid=1", cancelUrl: back,
      metadata: { paidOrder: String(id), company: String(co.id) } });
    const o = { id, token, coId: co.id, brief: brief.slice(0, 2000), priceMicros: co.priceMicros, tier: "full", status: "awaiting_payment",
      createdAt: now(), checkedAt: 0, session: { id: s.sessionId, url: s.url } };
    list().unshift(o); list().length = Math.min(list().length, 500);
    store.save();
    return o;
  }

  // Only a COMPLETED session starts the job.
  async function check(o) {
    if (o.status !== "awaiting_payment" || !o.session?.id) return;
    o.checkedAt = now();
    const s = await ping.getSession(o.session.id).catch(() => null);
    if (!s) return;
    if (s.status === "COMPLETED") {
      const co = byId(o.coId);
      if (!co) { o.status = "failed"; o.reason = "The company closed after the payment"; store.save(); return; }
      const job = enqueue(co, o.brief, "paid", { tier: "full" });
      job.paidOrderId = o.id;
      Object.assign(o, { status: "working", jobId: job.id, paidAt: now(), paymentId: s.paymentId || null });
      co.log.unshift({ t: now(), kind: "stage", text: `Paid order (${fmt(o.priceMicros)} USDC to its own account): ${o.brief.slice(0, 60)}` });
      store.save();
    } else if (["EXPIRED", "CANCELLED", "FAILED"].includes(s.status)) { o.status = "cancelled"; store.save(); }
  }

  async function tick() {
    for (const o of list()) {
      if (o.status !== "awaiting_payment") continue;
      if (now() - o.createdAt > payWindowMs) { o.status = "expired"; store.save(); continue; }
      if (now() - o.checkedAt >= checkEveryMs) await check(o);
    }
  }

  function delivered(co, job) {
    const o = job.paidOrderId ? find(job.paidOrderId) : null;
    if (!o || o.status !== "working") return;
    econ.sale(store.books, co, o.priceMicros);
    job.paid = true;
    const stage = econ.promote(co);
    Object.assign(o, { status: "delivered", deliveredAt: now(), costMicros: job.costMicros || 0 });
    co.log.unshift({ t: now(), kind: "stage", text: `Paid order delivered: revenue ${fmt(o.priceMicros)}, model cost ${fmt(job.costMicros || 0)}` });
    if (stage) co.log.unshift({ t: now(), kind: "stage", text: stage === "market" ? "Selling a product: moved into a downtown building" : "Got investment: moved into a company building" });
    store.save();
  }

  function failed(co, job) {
    const o = job.paidOrderId ? find(job.paidOrderId) : null;
    if (!o || o.status !== "working") return;
    Object.assign(o, { status: "failed", reason: job.error || "The job failed" });
    co.log.unshift({ t: now(), kind: "error", text: `Paid order #${o.id} failed. The payment is in the company's account: refund the customer` });
    store.save();
  }

  function view(o, { job = null } = {}) {
    const co = byId(o.coId);
    return {
      id: o.id, rail: "pingpay", tier: o.tier, status: o.status, reason: o.reason || null, brief: o.brief, createdAt: o.createdAt,
      company: co ? { id: co.id, name: co.name, payoutAccount: co.payoutAccount || null } : null,
      priceMicros: o.priceMicros, payUrl: o.status === "awaiting_payment" ? o.session?.url || null : null, paymentId: o.paymentId || null,
      paidAt: o.paidAt || null, deliveredAt: o.deliveredAt || null,
      job: job ? { status: job.status, output: job.status === "done" ? job.output : null, image: job.image || null, model: job.brain?.model || null, parts: (job.subs || []).map((s) => ({ sector: s.sectorName, name: s.name })) } : null,
    };
  }

  return { create, check, tick, delivered, failed, view, find, open };
}
