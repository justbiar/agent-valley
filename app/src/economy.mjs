// The same two-bucket ledger as the simulator and the NEAR contract, in micro-dollars.
// earned: traces back to a customer. capital: seed and investment.
// Invariants: sum(ner) == externalIn, sum(balances) == capitalIn + externalIn - externalOut.
import { USD } from "./providers.mjs";

export const MARKET_NER = 5 * USD; // a funded company moves to headquarters at $5 of net external revenue

export function newBooks() {
  return { capitalIn: 0, externalIn: 0, externalOut: 0 };
}

export function newLedger() {
  return { earned: 0, capital: 0, ner: 0, seed: 0, raised: 0, revenue: 0, aiCost: 0 };
}

export const balance = (l) => l.earned + l.capital;

function take(l, amount) {
  const total = balance(l);
  if (amount > total) throw new Error("Not enough balance");
  if (!total) return { e: 0, c: 0 };
  let e = Math.min(Math.floor((amount * l.earned) / total), l.earned);
  let c = amount - e;
  if (c > l.capital) { c = l.capital; e = amount - c; }
  l.earned -= e; l.capital -= c;
  return { e, c };
}

export function seed(books, co, amount) {
  co.ledger.capital += amount; co.ledger.seed += amount; books.capitalIn += amount;
}

export function invest(books, co, amount) {
  co.ledger.capital += amount; co.ledger.raised += amount; books.capitalIn += amount;
  promote(co);
}

// A customer pays for a delivered job: the only way NER is created.
export function sale(books, co, amount) {
  co.ledger.earned += amount; co.ledger.ner += amount; co.ledger.revenue += amount; books.externalIn += amount;
  promote(co);
}

// The model bill leaves the system. It is paid pro rata from both buckets.
export function aiCost(books, co, amount) {
  const paid = Math.min(amount, balance(co.ledger));
  take(co.ledger, paid);
  co.ledger.aiCost += amount;
  books.externalOut += paid;
  return paid;
}

export function promote(co) {
  const before = co.stage;
  if (co.stage === "idea" && co.ledger.raised > 0) co.stage = "funded";
  if (co.stage === "funded" && co.ledger.ner >= MARKET_NER) co.stage = "market";
  return co.stage !== before ? co.stage : null;
}

export function check(books, companies) {
  const ner = companies.reduce((a, c) => a + c.ledger.ner, 0);
  const bal = companies.reduce((a, c) => a + balance(c.ledger), 0);
  return { nerOk: ner === books.externalIn, balanceOk: bal === books.capitalIn + books.externalIn - books.externalOut };
}
