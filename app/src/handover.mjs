// Companies change hands, in the app and on chain:
// - transfer: the owner makes a one-time link; whoever opens it, with their NEAR account, takes the company over
// - sale: the owner lists the company at a price; a buyer pays it in NEAR into the contract's escrow
//   (buy_company); once the payment is seen the contract completes the sale and the price waits there as the
//   seller's proceeds. A withdrawn listing or a company that changed hands meanwhile is refunded.
// What passes: the company, its books, jobs, portfolio and shares (the founder's stake goes to the new owner).
// What never passes: the seller's own model key and payment keys. They stay with the seller, so a company that ran
// on its owner's key waits for the new owner's key.
import crypto from "node:crypto";
import { toYocto, yoctoToNear } from "./escrow.mjs";

const DAY = 86_400_000;

export function createHandover({ store, chain, rate, byId, checkAccount, dropKeys, now = () => Date.now(), checkEveryMs = 4000, linkMs = DAY, payWindowMs = DAY }) {
  if (!store.handovers) store.handovers = [];
  if (!store.nextHandover) store.nextHandover = 1;
  if (!store.companySales) store.companySales = [];
  if (!store.nextCompanySale) store.nextCompanySale = 1;
  const token = () => crypto.randomBytes(16).toString("hex");
  const log = (co, text, kind = "stage") => co.log.unshift({ t: now(), kind, text });

  // Moves the company to its new owner and leaves the old owner's keys behind.
  function handOver(co, { ownerId, ownerAccount = null, payoutAccount, how }) {
    const from = co.payoutAccount;
    co.ownerId = ownerId;
    co.ownerAccount = ownerAccount; // the NEAR account the new owner signed in with, if any
    co.payoutAccount = payoutAccount;
    dropKeys(co);
    co.sale = null;
    for (const h of store.handovers) if (h.coId === co.id && h.status === "open") h.status = "cancelled";
    co.ownerHistory = [...(co.ownerHistory || []), { t: now(), from, to: payoutAccount, how }].slice(-20);
    log(co, `Company ${how === "sale" ? "sold" : "transferred"}: ${from || "?"} → ${payoutAccount}. The previous owner's keys were not passed on`);
  }

  /* ---------- transfer by link ---------- */
  function createLink(co) {
    for (const h of store.handovers) if (h.coId === co.id && h.status === "open") h.status = "cancelled";
    const h = { id: store.nextHandover++, coId: co.id, token: token(), status: "open", createdAt: now(), expiresAt: now() + linkMs };
    store.handovers.unshift(h); store.handovers.length = Math.min(store.handovers.length, 300);
    log(co, "Transfer link created (valid 24 hours, single use)");
    store.save();
    return h;
  }
  const openLink = (id, t) => {
    const h = store.handovers.find((x) => x.id === Number(id));
    if (!h || h.token !== String(t || "") || h.status !== "open") throw Object.assign(new Error("The transfer link is invalid or already used"), { status: 404 });
    if (now() > h.expiresAt) { h.status = "expired"; throw Object.assign(new Error("The transfer link has expired"), { status: 410 }); }
    return h;
  };
  async function claim(id, t, { ownerId, ownerAccount = null, payoutAccount }) {
    const h = openLink(id, t), co = byId(h.coId);
    if (!co || co.status === "closed") throw new Error("Company not found");
    const account = await checkAccount(payoutAccount);
    if (account === co.payoutAccount && ownerId === co.ownerId) throw new Error("This company is already yours");
    h.status = "claimed"; h.claimedAt = now();
    handOver(co, { ownerId, ownerAccount, payoutAccount: account, how: "transfer" });
    store.save();
    // On chain the operator hands it over; app-only companies simply change hands here.
    if (co.chain?.id != null) chain()?.transferCompany(co, account, h);
    return co;
  }

  /* ---------- sale ---------- */
  function list(co, priceMicros) {
    if (priceMicros == null) { co.sale = null; log(co, "Sale listing withdrawn"); }
    else {
      if (co.chain?.id == null) throw new Error("The company has no chain id; sales go through escrow on chain");
      co.sale = { priceMicros, listedAt: now() };
      log(co, `Company listed for sale: $${(priceMicros / 1e6).toFixed(2)}`);
    }
    store.save();
    return co.sale;
  }

  async function startPurchase(co, { ownerId, ownerAccount = null, newOwner }) {
    const c = chain();
    if (!c) throw Object.assign(new Error("No chain connection"), { status: 503 });
    if (!co.sale) throw new Error("This company is not for sale");
    if (co.chain?.id == null) throw new Error("The company has no chain id");
    const account = await checkAccount(newOwner);
    const usd = await rate();
    const id = store.nextCompanySale++;
    const s = { id, ref: `cs${id}-${crypto.randomBytes(3).toString("hex")}`, token: token(), coId: co.id, chainId: co.chain.id, priceMicros: co.sale.priceMicros,
      listedAt: co.sale.listedAt, nearUsd: usd, quoteYocto: toYocto(co.sale.priceMicros, usd).toString(), ownerId, ownerAccount, newOwner: account, status: "awaiting_payment", createdAt: now(), checkedAt: 0 };
    store.companySales.unshift(s); store.companySales.length = Math.min(store.companySales.length, 300);
    store.save();
    return s;
  }

  async function check(s) {
    const c = chain();
    if (!c || s.status !== "awaiting_payment") return;
    s.checkedAt = now();
    const onChain = await c.getSale(s.ref).catch(() => null);
    if (!onChain || onChain.status !== "paid") return;
    s.buyer = onChain.buyer; s.paidYocto = onChain.amount;
    const co = byId(s.coId);
    // The listing must still be the one the buyer paid for, at that price, by the same seller.
    const still = co && co.sale && co.sale.listedAt === s.listedAt && co.sale.priceMicros === s.priceMicros;
    const enough = BigInt(onChain.amount) * 100n >= BigInt(s.quoteYocto) * 97n;
    if (!still || !enough) {
      s.status = "refunding"; s.reason = !enough ? "Underpaid" : "The listing changed or was withdrawn";
      await c.refundSale(s.ref, s); s.status = s.refundTx ? "refunded" : "refund_failed"; store.save(); return;
    }
    s.status = "completing"; store.save();
    await c.completeSale(s.ref, s);
    if (!s.completeTx) { s.status = "complete_failed"; store.save(); return; }
    handOver(co, { ownerId: s.ownerId, ownerAccount: s.ownerAccount || null, payoutAccount: s.newOwner, how: "sale" });
    s.status = "completed"; s.completedAt = now();
    store.save();
  }

  async function tick() {
    for (const s of store.companySales) {
      if (s.status !== "awaiting_payment") continue;
      if (now() - s.createdAt > payWindowMs) { s.status = "expired"; store.save(); continue; }
      if (now() - s.checkedAt >= checkEveryMs) await check(s);
    }
  }

  const findSale = (id, t) => {
    const s = store.companySales.find((x) => x.id === Number(id));
    if (!s || s.token !== String(t || "")) throw Object.assign(new Error("Purchase not found"), { status: 404 });
    return s;
  };
  const saleView = (s, txUrl = (h) => h) => ({ id: s.id, ref: s.ref, status: s.status, reason: s.reason || null, coId: s.coId, chainId: s.chainId, priceMicros: s.priceMicros, nearUsd: s.nearUsd,
    quoteYocto: s.quoteYocto, quoteNear: yoctoToNear(s.quoteYocto), newOwner: s.newOwner, buyer: s.buyer || null, completeTx: txUrl(s.completeTx), refundTx: txUrl(s.refundTx) });

  return { handOver, createLink, openLink, claim, list, startPurchase, check, tick, findSale, saleView };
}
