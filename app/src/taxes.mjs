// The platform's only income: a small monthly tax on each company's profit. No fee per sale, nothing else.
// At each period's end the company's profit for that period is taken from its books:
//   customer sales + parts sold to other companies - parts bought - model bill.
// Losses carry forward: a losing period's loss is deducted from later profit before any tax.
// A share of a positive profit becomes an invoice the founder pays on chain (PingPay, to the platform account).
// Amounts under the minimum roll into the next period. An invoice past its due date stops new customer orders.
// Fuel: when a company runs on the platform's model key, the platform pays the provider (NEAR AI, OpenRouter) and
// the company owes it that bill. Fuel goes on the same invoice as the tax, and when unbilled fuel passes
// fuelBillMicros an interim fuel invoice goes out without waiting for the month's end. The books already counted
// the model bill when the job ran, so a paid fuel invoice moves real money to the platform account and nothing more.
// Orders settled on chain (escrow.mjs) pay their tax and fuel there: that tax is counted as prepaid and taken off the
// month's invoice, and the fuel mark moves past the fuel already paid.
import * as econ from "./economy.mjs";

const DAY = 86_400_000;
const snapshot = (co) => ({ revenue: co.ledger.revenue, b2bIn: co.ledger.b2bIn || 0, b2bOut: co.ledger.b2bOut || 0, aiCost: co.ledger.aiCost });
const profitBetween = (a, b) => (b.revenue - a.revenue) + (b.b2bIn - a.b2bIn) - (b.b2bOut - a.b2bOut) - (b.aiCost - a.aiCost);

export function createTaxes({ store, ping, platformAccount, bps = 200, minMicros = 100_000, graceMs = 15 * DAY, periodMs = 0, fuelBillMicros = 5_000_000, onFuelPaid = () => {}, now = () => Date.now() }) {
  // Calendar months (UTC) in production; fixed-length periods only when a test asks for them.
  const periodOf = (t) => (periodMs ? `p${Math.floor(t / periodMs)}` : new Date(t).toISOString().slice(0, 7));
  const ensure = (co) => { if (!co.tax) co.tax = { period: periodOf(co.createdAt || now()), start: { revenue: 0, b2bIn: 0, b2bOut: 0, aiCost: 0 }, carry: 0, loss: 0, invoices: [], next: 1, fuelMark: co.ledger.fuel || 0 }; if (co.tax.loss == null) co.tax.loss = 0; if (co.tax.fuelMark == null) co.tax.fuelMark = co.ledger.fuel || 0; return co.tax; };
  const fuelOwed = (co) => Math.max(0, (co.ledger.fuel || 0) - ensure(co).fuelMark);
  const totalOf = (i) => i.taxMicros + (i.fuelMicros || 0);
  function issue(co, fields) {
    const t = ensure(co);
    const inv = { id: t.next++, bps, status: "due", issuedAt: now(), dueAt: now() + graceMs, checkout: null, taxMicros: 0, fuelMicros: 0, ...fields };
    t.invoices.unshift(inv); t.invoices.length = Math.min(t.invoices.length, 24);
    return inv;
  }

  function close(co) {
    const t = ensure(co), k = periodOf(now());
    if (t.period === k) return null;
    const end = snapshot(co), profit = profitBetween(t.start, end), base = profit - t.loss;
    const taxable = Math.max(0, base);
    t.loss = Math.max(0, -base);
    const prepaid = t.prepaid || 0;
    const due = Math.max(0, Math.round((taxable * bps) / 10_000) - prepaid) + t.carry, fuel = fuelOwed(co);
    let inv = null;
    if (due + fuel >= minMicros) {
      inv = issue(co, { period: t.period, profitMicros: profit, taxableMicros: taxable, taxMicros: due, fuelMicros: fuel });
      t.carry = 0; t.fuelMark = co.ledger.fuel || 0;
      co.log.unshift({ t: now(), kind: "stage", text: `${t.period} invoice: profit ${fmt(profit)}, tax ${fmt(due)} (${bps / 100}%)${fuel ? `, AI fuel ${fmt(fuel)}` : ""}. Due ${new Date(inv.dueAt).toLocaleDateString("en-US")}` });
    } else t.carry = due;
    t.period = k; t.start = end; t.prepaid = 0;
    return inv;
  }

  // Asks PingPay about open tax checkouts. Only a COMPLETED session settles an invoice.
  async function confirm(co) {
    for (const inv of ensure(co).invoices) {
      if (inv.status !== "due" || !inv.checkout || now() - (inv.checkout.checkedAt || 0) < 3000) continue;
      inv.checkout.checkedAt = now();
      const s = await ping?.getSession(inv.checkout.sessionId).catch(() => null);
      if (s?.status === "COMPLETED") {
        if (inv.taxMicros) econ.tax(store.books, co, inv.taxMicros);
        Object.assign(inv, { status: "paid", paidAt: now(), paymentId: s.paymentId || null, checkout: null });
        if (inv.fuelMicros) onFuelPaid(co, inv.fuelMicros);
        co.log.unshift({ t: now(), kind: "stage", text: `${inv.period} invoice paid (${fmt(totalOf(inv))}${inv.fuelMicros ? `, fuel ${fmt(inv.fuelMicros)}` : ""})` });
        store.save();
      } else if (s && ["EXPIRED", "CANCELLED"].includes(s.status)) { inv.checkout = null; store.save(); }
    }
  }

  const overdue = (co) => ensure(co).invoices.some((i) => i.status === "due" && now() > i.dueAt);
  return {
    bps,
    tick() {
      let changed = false;
      for (const co of store.companies) {
        if (close(co)) changed = true;
        // A company burning fuel fast pays for it before the month ends.
        const fuel = fuelOwed(co);
        if (fuelBillMicros && fuel >= fuelBillMicros) {
          const inv = issue(co, { period: `${ensure(co).period} fuel`, kind: "fuel", fuelMicros: fuel });
          ensure(co).fuelMark = co.ledger.fuel || 0;
          co.log.unshift({ t: now(), kind: "stage", text: `Fuel invoice: used ${fmt(fuel)} of the platform's AI credit. Due ${new Date(inv.dueAt).toLocaleDateString("en-US")}` });
          changed = true;
        }
      }
      if (changed) store.save();
    },
    fuelOwed,
    // Fuel the company already paid for up front (the fuel station): the mark moves past it, so it is never invoiced.
    coverFuel(co, micros) { const c = Math.min(fuelOwed(co), Math.max(0, Math.floor(micros) || 0)); ensure(co).fuelMark += c; return c; },
    overdue,
    async checkout(co, invoiceId, base) {
      const inv = ensure(co).invoices.find((i) => i.id === Number(invoiceId));
      if (!inv) throw new Error("Invoice not found");
      if (inv.status === "paid") return { paid: true };
      if (!ping || !platformAccount) throw Object.assign(new Error("Tax payment is not open yet"), { status: 402 });
      const back = `${base}/?c=${co.id}`;
      const s = await ping.createSession({ amountMicros: totalOf(inv), recipient: platformAccount, successUrl: back, cancelUrl: back, metadata: { taxInvoice: String(inv.id), company: String(co.id), period: inv.period } });
      inv.checkout = { sessionId: s.sessionId, at: now(), checkedAt: 0 };
      store.save();
      return { url: s.url };
    },
    confirm,
    view(co) {
      const t = ensure(co), profit = profitBetween(t.start, snapshot(co)), taxable = Math.max(0, profit - t.loss);
      return {
        bps, period: t.period, profitMicros: profit, lossMicros: t.loss, estimateMicros: Math.max(0, Math.round((taxable * bps) / 10_000) - (t.prepaid || 0)) + t.carry, carryMicros: t.carry, prepaidMicros: t.prepaid || 0,
        fuelOwedMicros: fuelOwed(co), fuelBillMicros, fuelTotalMicros: co.ledger.fuel || 0,
        overdue: overdue(co), payable: !!(ping && platformAccount),
        invoices: t.invoices.map((i) => ({ id: i.id, period: i.period, profitMicros: i.profitMicros, taxableMicros: i.taxableMicros ?? i.profitMicros, taxMicros: i.taxMicros, fuelMicros: i.fuelMicros || 0, totalMicros: totalOf(i), kind: i.kind || "period", bps: i.bps, status: i.status, dueAt: i.dueAt, paidAt: i.paidAt || null, paying: !!i.checkout })),
      };
    },
  };
}

const fmt = (m) => "$" + (m / 1e6).toFixed(m && Math.abs(m) < 10_000 ? 4 : 2);
