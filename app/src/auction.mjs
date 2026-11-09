// Sealed-bid part auctions between companies, run as timed listings.
// When a company needs a part it opens a listing. Every running supplier in that sector sees it and bids while it is
// open. Bids are sealed: only a hash commitment is published, so no supplier can see and undercut another. When the
// listing closes the bids are revealed with their salts. The lowest bid wins and is paid the second-lowest bid
// (a Vickrey auction), never more than its own list price, so a supplier's best strategy is to bid its true floor.
// With a single bidder there is no competition, and the buyer pays that supplier's list price.
import crypto from "node:crypto";

export const MIN_BID_MICROS = 10_000; // $0.01

// A supplier's floor: what the owner set, else enough to cover the model bill with a margin, never above list.
export function floorOf(co, costMicros = 0) {
  const list = co.priceMicros;
  const auto = Math.max(Math.ceil(costMicros * 1.25), Math.round(list * 0.5));
  const floor = co.minPriceMicros != null ? co.minPriceMicros : auto;
  return Math.max(MIN_BID_MICROS, Math.min(list, floor));
}

// The agent's bid: idle suppliers bid their floor to win work, busy ones rise toward list price.
export function bidOf(co, { costMicros = 0, load = 0 } = {}) {
  const floor = floorOf(co, costMicros), list = Math.max(floor, co.priceMicros);
  return Math.round(floor + (list - floor) * Math.min(1, load / 3));
}

// The same preimage the Agent Valley contract checks at reveal (contracts/valley: commit_of), so a round sealed here
// can be revealed on chain: sha256("round|company|bid|list|salt").
export const commitOf = (auctionId, coId, bid, list, salt) => crypto.createHash("sha256").update(`${auctionId}|${coId}|${bid}|${list}|${salt}`).digest("hex");

export function openRound({ id, t, closesAt, buyer, sector, parentJobId = null }) {
  return { id, t, closesAt, status: "open", buyer: { coId: buyer.id, name: buyer.name }, sector, parentJobId, bids: [] };
}

// A supplier seals its bid into an open listing. Only the commitment is public until the listing closes.
export function sealBid(round, co, bid, { t = Date.now() } = {}) {
  if (round.status !== "open" || round.bids.some((b) => b.coId === co.id)) return null;
  const salt = crypto.randomBytes(12).toString("hex");
  const b = { coId: co.id, name: co.name, bid, list: co.priceMicros, salt, commit: commitOf(round.id, co.id, bid, co.priceMicros, salt), t };
  round.bids.push(b);
  return b;
}

// Reveals every bid and settles the winner and the clearing price.
export function closeRound(round, t = Date.now()) {
  // Lowest bid wins; a tie goes to the earlier seal, then to the older company. The contract uses the same rule.
  const ranked = [...round.bids].sort((a, b) => a.bid - b.bid || a.t - b.t || a.coId - b.coId);
  const win = ranked[0] || null;
  round.status = "closed"; round.closedAt = t;
  round.rule = ranked.length > 1 ? "second-price" : ranked.length ? "list-price" : "no-bids";
  round.winner = win ? { coId: win.coId, name: win.name, bid: win.bid, list: win.list } : null;
  round.priceMicros = !win ? null : ranked.length > 1 ? Math.min(ranked[1].bid, win.list) : win.list;
  return round;
}

// Opens, fills and closes a round in one go. bidders: [{ co, bid, t }], in the order they sealed.
export function runAuction({ id, t, buyer, sector, bidders }) {
  const r = openRound({ id, t, closesAt: t, buyer, sector });
  bidders.forEach((b, i) => sealBid(r, b.co, b.bid, { t: b.t ?? t + i }));
  return closeRound(r, t);
}

// Anyone can check a revealed round: every commitment matches its bid, and the winner and price follow the rule.
export function verifyAuction(a) {
  if (a.status === "open") return null;
  if (!a.bids.every((b) => commitOf(a.id, b.coId, b.bid, b.list, b.salt) === b.commit)) return false;
  if (!a.winner) return a.bids.length === 0;
  const bids = a.bids.map((b) => b.bid).sort((x, y) => x - y);
  return a.winner.bid === bids[0] && a.priceMicros === (bids.length > 1 ? Math.min(bids[1], a.winner.list) : a.winner.list);
}

// What anyone may see. While a listing is open: who bid and their commitments, never the amounts.
export function publicRound(a) {
  const head = { id: a.id, t: a.t, closesAt: a.closesAt, status: a.status || "closed", buyer: a.buyer, sector: a.sector };
  if (a.status === "open") return { ...head, bids: a.bids.map((b) => ({ coId: b.coId, name: b.name, commit: b.commit, t: b.t })) };
  return { ...head, closedAt: a.closedAt || a.t, rule: a.rule, bids: a.bids, winner: a.winner, priceMicros: a.priceMicros, outcome: a.outcome || null, verified: verifyAuction(a) };
}
