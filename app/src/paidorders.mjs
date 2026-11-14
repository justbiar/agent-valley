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
// Who really did a job: the model the provider says answered (from its response), and the provider.
export const servedBy = (job) => ({ model: job.model || job.brain?.model || null, provider: job.brain?.provider || null, fallback: (job.brainIdx || 0) > 0 });

// The watchdog: a paid job that has not started after noticeMs gets a visible reason on the order page and in the
// company's console; after stallMs it is marked stalled, which means the company owes the customer a refund (it may
// still deliver, and a late delivery clears that).
export const WAIT_REASON = {
  no_provider: "the company's model key is not connected", no_credits: "the model provider's credit ran out", rate_limited: "every model in the company's chain is busy",
  paused: "the company is paused", broke: "the company's budget does not cover the job", daily_budget: "the company's daily model budget is used up",
  hourly_limit: "the company is at its hourly job limit", schedule: "the company is outside its working hours", unprofitable: "the company stopped itself (losing money)", queued: "other jobs are ahead of it",
};
export function createPaidOrders({ store, ping, enqueue, byId, now = () => Date.now(), checkEveryMs = 4000, payWindowMs = 2 * 3_600_000, noticeMs = 3 * 60_000, stallMs = 2 * 3_600_000 }) {
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

  // A paid job that does not start: say why, and after stallMs mark the order stalled.
  function watch(o) {
    const co = byId(o.coId), job = co?.jobs.find((j) => j.id === o.jobId);
    if (!co || !job) return;
    if (job.startedAt || job.status === "done" || job.status === "running") { if (o.stall) { o.stall = null; store.save(); } return; }
    const waited = now() - (o.paidAt || o.createdAt);
    if (waited < noticeMs) return;
    const why = co.status !== "running" ? co.status : co.waiting || "queued";
    if (!o.stall || o.stall.why !== why) {
      o.stall = { why, since: o.stall?.since || now() };
      co.log.unshift({ t: now(), kind: "error", text: `Paid order #${o.id} is paid but has not started: ${WAIT_REASON[why] || why}` });
      store.save();
    }
    if (waited >= stallMs && o.status === "working") {
      Object.assign(o, { status: "stalled", reason: `Not started within ${Math.round(stallMs / 3_600_000)} hours: ${WAIT_REASON[why] || why}. The payment is in the company's account and it owes you a refund` });
      co.log.unshift({ t: now(), kind: "error", text: `Paid order #${o.id} stalled. The payment is in the company's account: refund the customer` });
      store.save();
    }
  }

  async function tick() {
    for (const o of list()) {
      if (o.status === "working" || o.status === "stalled") { watch(o); continue; }
      if (o.status !== "awaiting_payment") continue;
      if (now() - o.createdAt > payWindowMs) { o.status = "expired"; store.save(); continue; }
      if (now() - o.checkedAt >= checkEveryMs) await check(o);
    }
  }

  function delivered(co, job) {
    const o = job.paidOrderId ? find(job.paidOrderId) : null;
    if (!o || !["working", "stalled"].includes(o.status)) return;
    econ.sale(store.books, co, o.priceMicros);
    o.stall = null; o.reason = null;
    job.paid = true;
    const stage = econ.promote(co);
    Object.assign(o, { status: "delivered", deliveredAt: now(), costMicros: job.costMicros || 0 });
    co.log.unshift({ t: now(), kind: "stage", text: `Paid order delivered: revenue ${fmt(o.priceMicros)}, model cost ${fmt(job.costMicros || 0)}` });
    if (stage) co.log.unshift({ t: now(), kind: "stage", text: stage === "market" ? "Selling a product: moved into a downtown building" : "Got investment: moved into a company building" });
    store.save();
  }

  // A paid order whose job failed (a provider error, say) runs again on the same payment, at most MAX_RETRIES times.
  const MAX_RETRIES = 3;
  const canRetry = (o) => o.status === "failed" && !!o.paidAt && (o.retries || 0) < MAX_RETRIES;
  function retry(o) {
    if (!canRetry(o)) throw Object.assign(new Error(o.status !== "failed" ? "Only a failed order can run again" : "This order cannot run again"), { status: 409 });
    const co = byId(o.coId);
    if (!co || co.status !== "running") throw Object.assign(new Error("This company is not taking orders right now"), { status: 409 });
    const job = enqueue(co, o.brief, "paid", { tier: "full" });
    job.paidOrderId = o.id;
    Object.assign(o, { status: "working", jobId: job.id, reason: null, stall: null, retries: (o.retries || 0) + 1, paidAt: now() });
    co.log.unshift({ t: now(), kind: "stage", text: `Paid order #${o.id} runs again (try ${o.retries + 1})` });
    store.save();
    return o;
  }

  function failed(co, job) {
    const o = job.paidOrderId ? find(job.paidOrderId) : null;
    if (!o || !["working", "stalled"].includes(o.status)) return;
    Object.assign(o, { status: "failed", reason: job.error || "The job failed", stall: null });
    co.log.unshift({ t: now(), kind: "error", text: `Paid order #${o.id} failed. The payment is in the company's account: refund the customer` });
    store.save();
  }

  function view(o, { job = null } = {}) {
    const co = byId(o.coId);
    return {
      id: o.id, rail: "pingpay", tier: o.tier, status: o.status, reason: o.reason || null, brief: o.brief, createdAt: o.createdAt,
      company: co ? { id: co.id, name: co.name, payoutAccount: co.payoutAccount || null } : null,
      priceMicros: o.priceMicros, payUrl: o.status === "awaiting_payment" ? o.session?.url || null : null, paymentId: o.paymentId || null,
      paidAt: o.paidAt || null, deliveredAt: o.deliveredAt || null, canRetry: canRetry(o),
      waiting: o.stall ? { reason: WAIT_REASON[o.stall.why] || o.stall.why, since: o.stall.since } : null,
      job: job ? { status: job.status, output: job.status === "done" ? job.output : null, image: job.image || null, model: job.brain?.model || null, servedBy: job.status === "done" ? servedBy(job) : null, parts: (job.subs || []).map((s) => ({ sector: s.sectorName, name: s.name })) } : null,
    };
  }

  // For the company console: paid orders of this company that wait or stalled.
  const waitingFor = (co) => list().filter((o) => o.coId === co.id && o.stall && ["working", "stalled"].includes(o.status)).map((o) => ({ id: o.id, status: o.status, reason: WAIT_REASON[o.stall.why] || o.stall.why, since: o.stall.since, priceMicros: o.priceMicros }));
  return { create, check, tick, delivered, failed, retry, view, find, open, waitingFor };
}
