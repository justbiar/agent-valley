// Company shares: every company is founded with the supply its founder picks (1,000,000 by default, no upper
// limit, fixed at founding) split three ways, and only agent companies can
// buy them, so agents invest in each other and become partners. Same rules as the contract (contracts/valley):
// - founder stake, shares for sale at a fixed price, and an ecosystem pool the company grants to partner agents
// - a buyer pays from its capital, never its earned money, so an investment ring cannot raise NER
// - a dividend comes from earned money; partners receive their part with its NER, the founder's part stays in
// Money here is in micro-dollars, like the rest of the books. The contract mirrors who owns what.
import { USD } from "./providers.mjs";
import { promote } from "./economy.mjs";

export const TOTAL_SHARES = 1_000_000; // the default supply
export const MIN_SUPPLY = 100;
export const DEFAULT_CHARTER = { founderPct: 70, salePct: 20, valuation: 50, supply: TOTAL_SHARES };

// What the founder chose, checked. Percentages are whole numbers; the pool gets the rest.
export function parseCharter(b = {}) {
  const founderPct = Math.round(Number(b.founderPct ?? DEFAULT_CHARTER.founderPct));
  const salePct = Math.round(Number(b.salePct ?? DEFAULT_CHARTER.salePct));
  const valuation = Number(b.valuation ?? DEFAULT_CHARTER.valuation);
  const supply = Number(b.supply ?? DEFAULT_CHARTER.supply);
  if (!(founderPct >= 10 && founderPct <= 100)) throw new Error("The founder stake must be between 10% and 100%");
  if (!(salePct >= 0 && founderPct + salePct <= 100)) throw new Error("Founder stake plus shares for sale cannot exceed 100%");
  if (!(valuation >= 1 && valuation <= 1_000_000)) throw new Error("Valuation must be between $1 and $1,000,000");
  // No upper limit of our own: the only bound is the largest whole number JavaScript counts exactly.
  if (!(Number.isInteger(supply) && supply >= MIN_SUPPLY)) throw new Error("The supply must be a whole number of at least 100 shares");
  if (!Number.isSafeInteger(supply)) throw new Error("The supply is too large to count exactly");
  // A share can cost less than a micro-dollar when the supply is large; costs are rounded when shares are bought.
  const priceMicros = (valuation * USD) / supply;
  return { founderBps: founderPct * 100, saleBps: salePct * 100, priceMicros, supply };
}

// Issues the shares at founding, the same split the contract makes.
export function issue(co, charter) {
  const total = charter.supply || TOTAL_SHARES;
  const founder = Math.floor((total * charter.founderBps) / 10_000);
  const forSale = Math.floor((total * charter.saleBps) / 10_000);
  co.shares = { total, priceMicros: charter.priceMicros, forSale, pool: total - founder - forSale, holders: [{ coId: null, shares: founder }] };
  // On chain the price is a nominal 1 yoctoNEAR a share: the contract records who owns what, the books hold the money.
  co.charter = { founderBps: charter.founderBps, saleBps: charter.saleBps, sharePriceYocto: "1", supply: total };
  return co.shares;
}
export const ensureShares = (co) => co.shares || issue(co, parseCharter({}));

const held = (s) => s.holders.reduce((a, h) => a + h.shares, 0);
function addHolder(s, coId, n) {
  const h = s.holders.find((x) => x.coId === coId);
  if (h) h.shares += n; else s.holders.push({ coId, shares: n });
}
const whole = (n) => { const v = Number(n); if (!Number.isInteger(v) || v <= 0) throw new Error("Share count must be a positive whole number"); return v; };

// An agent company buys shares of another company from its capital.
export function buy(store, buyer, target, n) {
  n = whole(n);
  if (buyer.id === target.id) throw new Error("A company cannot buy its own shares");
  const s = ensureShares(target);
  if (n > s.forSale) throw new Error(`Only ${s.forSale.toLocaleString("en-US")} shares are for sale`);
  const cost = Math.round(n * s.priceMicros);
  if (!(cost >= 1)) throw new Error("That many shares cost less than a micro-dollar. Buy more");
  if (cost > buyer.ledger.capital) throw new Error(`Shares are paid from capital, and ${buyer.name} does not have enough capital ($${(cost / USD).toFixed(2)} needed)`);
  buyer.ledger.capital -= cost;
  buyer.ledger.invested = (buyer.ledger.invested || 0) + cost;
  target.ledger.capital += cost;
  target.ledger.raised += cost;
  s.forSale -= n;
  addHolder(s, buyer.id, n);
  const stage = promote(target);
  return log(store, { kind: "buy", from: buyer.id, to: target.id, shares: n, amount: cost }, stage);
}

// The company grants shares from its ecosystem pool to a partner agent, for example a supplier it relies on.
export function grant(store, co, to, n) {
  n = whole(n);
  if (co.id === to.id) throw new Error("A company cannot grant shares to itself");
  const s = ensureShares(co);
  if (n > s.pool) throw new Error(`Only ${s.pool.toLocaleString("en-US")} shares are in the pool`);
  s.pool -= n;
  addHolder(s, to.id, n);
  return log(store, { kind: "grant", from: co.id, to: to.id, shares: n, amount: 0 });
}

// Pays a dividend from earned money by shares held. Partners receive theirs as earned money with its NER;
// the founder's part stays in the company. byId resolves partner companies.
export function dividend(store, co, amount, byId) {
  amount = Math.round(Number(amount));
  if (!(amount > 0)) throw new Error("Amount must be positive");
  if (amount > co.ledger.earned) throw new Error(`Dividends come only from earned revenue ($${(co.ledger.earned / USD).toFixed(2)} available)`);
  const s = ensureShares(co), total = held(s), paid = [];
  for (const h of s.holders) {
    if (h.coId == null) continue;
    const p = byId(h.coId);
    const part = Math.floor((amount * h.shares) / total);
    if (!p || !part) continue;
    co.ledger.earned -= part; co.ledger.ner -= part;
    p.ledger.earned += part; p.ledger.ner += part;
    p.ledger.dividendsIn = (p.ledger.dividendsIn || 0) + part;
    paid.push({ coId: p.id, amount: part });
  }
  const out = paid.reduce((a, x) => a + x.amount, 0);
  co.ledger.dividendsOut = (co.ledger.dividendsOut || 0) + out;
  log(store, { kind: "dividend", from: co.id, to: null, shares: 0, amount: out, parts: paid });
  return { paid, out, kept: amount - out };
}

function log(store, rec, stage = null) {
  if (!store.investments) store.investments = [];
  const entry = { t: Date.now(), ...rec };
  store.investments.unshift(entry);
  store.investments.length = Math.min(store.investments.length, 300);
  return { entry, stage };
}

// Brings the app's books in line with the token balances on chain. People buy shares with NEAR from their own wallet
// and send them to each other there; the chain is the record. `onChain` is the contract's get_company view.
// Founder (the chain owner) and plain accounts are compared as one group, so a transfer between them changes no
// books, and only the growth of the group is a purchase: those shares leave "for sale" and their price is capital.
export function syncAccounts(co, onChain, owner) {
  if (!onChain?.holders) return { bought: 0 };
  const s = ensureShares(co);
  const chainAcc = onChain.holders.filter((h) => h.company == null && h.account);
  const appAcc = s.holders.filter((h) => h.coId == null);
  const before = appAcc.reduce((a, h) => a + h.shares, 0), after = chainAcc.reduce((a, h) => a + Number(h.shares), 0);
  const bought = Math.max(0, Math.min(after - before, s.forSale));
  const others = chainAcc.filter((h) => h.account !== owner).map((h) => ({ coId: null, account: h.account, shares: Number(h.shares) }));
  const founder = Number(chainAcc.find((h) => h.account === owner)?.shares || 0);
  s.holders = [{ coId: null, shares: founder }, ...others, ...s.holders.filter((h) => h.coId != null)];
  if (bought) {
    const cost = Math.round(bought * s.priceMicros);
    s.forSale -= bought;
    co.ledger.capital += cost; co.ledger.raised += cost;
    promote(co);
  }
  return { bought, cost: bought ? Math.round(bought * s.priceMicros) : 0 };
}

// The cap table as anyone may see it.
export function capTable(co, byId) {
  const s = ensureShares(co), total = s.total;
  const pct = (n) => Math.round((n / total) * 10_000) / 100;
  return {
    total, priceMicros: s.priceMicros, valuationMicros: Math.round(s.priceMicros * total), forSale: s.forSale, pool: s.pool,
    holders: s.holders.map((h) => ({ coId: h.coId, account: h.account || null, name: h.account || (h.coId == null ? "Founder" : byId(h.coId)?.name || "closed"), shares: h.shares, pct: pct(h.shares) })),
    forSalePct: pct(s.forSale), poolPct: pct(s.pool),
  };
}

// Which companies this one holds shares in.
export function holdingsOf(co, companies) {
  return companies.filter((c) => c.shares?.holders.some((h) => h.coId === co.id)).map((c) => {
    const h = c.shares.holders.find((x) => x.coId === co.id);
    return { coId: c.id, name: c.name, shares: h.shares, pct: Math.round((h.shares / c.shares.total) * 10_000) / 100, valueMicros: Math.round(h.shares * c.shares.priceMicros) };
  });
}
