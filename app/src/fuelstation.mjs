// The fuel station: a company's agent buys its own model credit ("fuel") from the platform, with its own wallet,
// before it runs out. Nobody tops it up by hand and nobody pays its bill afterwards.
//
//   seller  the platform, through Ping Agent Pay (x402): it prepares a payment challenge and later settles it
//   buyer   the company's Agent Connect wallet: it pays the challenge in USDC (the wallet's own rules still apply,
//           so an owner-signed limit or an approval step can stop a purchase)
//   credit  what a company bought and has not burnt yet. Fuel the company uses is taken from its credit first
//           (the fuel mark in taxes.mjs moves past it); only what credit does not cover goes on an invoice.
//
// The owner sets the rule once: buy `buyMicros` when credit drops under `belowMicros`, never more than
// `dailyCapMicros` a day. The purchase itself is the agent's: it happens on the next tick, with no click.

export const STATION_DEFAULTS = { on: true, belowMicros: 500_000, buyMicros: 2_000_000, dailyCapMicros: 10_000_000 };
const RETRY_MS = 10 * 60_000;

export function createFuelStation({ store, taxes, fuel, sell, settle, payFrom, isOpen, canBuy, minMicros = 200_000, now = () => Date.now() }) {
  const state = (co) => {
    if (!co.fuelTank) co.fuelTank = { creditMicros: 0, auto: { ...STATION_DEFAULTS }, buys: [], day: "", boughtToday: 0, retryAt: 0 };
    return co.fuelTank;
  };
  const buying = new Set(); // company ids with a purchase in flight (memory only)
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const fmt = (m) => "$" + (m / 1e6).toFixed(2);

  // Fuel already used is paid out of credit first.
  function applyCredit(co) {
    const s = state(co);
    if (!(s.creditMicros > 0)) return 0;
    const covered = taxes.coverFuel(co, s.creditMicros);
    if (covered > 0) { s.creditMicros -= covered; fuel.collect(co, covered); }
    return covered;
  }

  // What the agent would buy right now, or 0. Enough to cover unpaid use and refill to its usual amount.
  function wanted(co) {
    const s = state(co), a = s.auto;
    if (!a.on || !isOpen() || !canBuy(co) || buying.has(co.id) || now() < (s.retryAt || 0)) return 0;
    const owed = taxes.fuelOwed(co);
    if (s.creditMicros - owed >= a.belowMicros) return 0;
    if (s.day !== dayOf(now())) { s.day = dayOf(now()); s.boughtToday = 0; }
    const room = a.dailyCapMicros - s.boughtToday;
    const amount = Math.min(room, Math.max(a.buyMicros, owed + a.belowMicros - s.creditMicros));
    return amount >= minMicros ? Math.ceil(amount / 10_000) * 10_000 : 0;
  }

  async function buy(co, amountMicros, why = "auto") {
    const s = state(co);
    if (!isOpen()) throw Object.assign(new Error("The fuel station is closed (no platform Agent Pay key)"), { status: 409 });
    if (!canBuy(co)) throw new Error("This company has no Agent Connect wallet, or runs on its own model key");
    if (buying.has(co.id)) throw Object.assign(new Error("A fuel purchase is already on its way"), { status: 409 });
    if (!(amountMicros >= minMicros)) throw new Error(`The station sells at least ${fmt(minMicros)} at a time`);
    if (s.day !== dayOf(now())) { s.day = dayOf(now()); s.boughtToday = 0; }
    if (s.boughtToday + amountMicros > s.auto.dailyCapMicros) throw new Error(`Over the daily fuel limit (${fmt(s.auto.dailyCapMicros)})`);
    buying.add(co.id);
    const rec = { t: now(), micros: amountMicros, why, status: "paying", txHash: null };
    s.buys.unshift(rec); s.buys.length = Math.min(s.buys.length, 20);
    try {
      const prepared = await sell(co, amountMicros);
      const paid = await payFrom(co, prepared);
      await settle(prepared, paid.txHash);
      Object.assign(rec, { status: "paid", txHash: paid.txHash });
      s.creditMicros += amountMicros; s.boughtToday += amountMicros; s.retryAt = 0;
      fuel.sold?.(co, amountMicros, paid.txHash);
      applyCredit(co);
      co.log.unshift({ t: now(), kind: "stage", text: `Bought ${fmt(amountMicros)} of fuel from the station with its own wallet${why === "auto" ? " (credit was running low)" : ""}` });
      return rec;
    } catch (e) {
      Object.assign(rec, { status: "failed", error: String(e.message).slice(0, 200) });
      s.retryAt = now() + RETRY_MS;
      co.log.unshift({ t: now(), kind: "warn", text: `Fuel purchase failed: ${rec.error}` });
      throw e;
    } finally { buying.delete(co.id); store.save(); }
  }

  return {
    // Before the invoices: spend credit on fuel used, then let every agent that is low buy more.
    tick() {
      let changed = false;
      for (const co of store.companies) {
        if (applyCredit(co) > 0) changed = true;
        const amount = wanted(co);
        if (amount) buy(co, amount, "auto").catch(() => {});
      }
      if (changed) store.save();
    },
    buy,
    wanted,
    settings(co, b = {}) {
      // Checked as a whole first: a rejected change leaves the old rule untouched.
      const st = state(co), a = { ...st.auto }, usd =(v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between $${lo} and $${hi}`); return Math.round(n * 1e6); };
      if (b.on !== undefined) a.on = !!b.on;
      if (b.below !== undefined) a.belowMicros = usd(b.below, 0, 100, "Buy when credit is under");
      if (b.buy !== undefined) a.buyMicros = usd(b.buy, minMicros / 1e6, 100, "Amount per purchase");
      if (b.dailyCap !== undefined) a.dailyCapMicros = usd(b.dailyCap, minMicros / 1e6, 1000, "Daily limit");
      if (a.buyMicros > a.dailyCapMicros) throw new Error("The amount per purchase is above the daily limit");
      st.auto = a;
      store.save();
      return this.view(co);
    },
    view(co) {
      const s = state(co);
      return {
        open: isOpen(), canBuy: canBuy(co), creditMicros: s.creditMicros, owedMicros: taxes.fuelOwed(co), auto: { ...s.auto },
        boughtTodayMicros: s.day === dayOf(now()) ? s.boughtToday : 0, buying: buying.has(co.id), minMicros,
        buys: s.buys.slice(0, 8).map((r) => ({ t: r.t, micros: r.micros, why: r.why, status: r.status, txHash: r.txHash, error: r.error || null })),
      };
    },
  };
}
