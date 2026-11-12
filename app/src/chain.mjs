// Mirrors the valley onto the Agent Valley contract (contracts/valley) on NEAR: every company gets an Agent ID card,
// every part listing is opened, sealed and revealed on chain, and delivered parts build on-chain reputation.
// The contract, not this server, picks each round's winner and price; the server checks that both agree.
//
// The chain is a mirror, never a gate: a failed transaction is recorded on the object and the valley keeps running.
// Transactions go out one at a time, so nonces never collide and a round is opened before its seals and revealed last.
// The signing key is read from the NEAR CLI's credentials file and is never stored, logged or sent anywhere else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const YOCTO = 10n ** 24n;
const FOUND_DEPOSIT = (3n * YOCTO) / 100n; // 0.03 NEAR: storage for the card plus the contract's 0.01 NEAR seed
const GAS = 60n * 10n ** 12n;

// Names on chain are at most 32 bytes; Turkish letters take two, so cut by bytes, not characters.
export function chainName(name) {
  let out = "";
  for (const ch of String(name)) { if (Buffer.byteLength(out + ch) > 32) break; out += ch; }
  return out.length >= 2 ? out : (out + "--").slice(0, 2);
}
export const chainSector = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32).padEnd(2, "_");
// Each company's agent identity under the contract account, e.g. a12.agentvalley-biar.testnet.
export const agentAccount = (co, contractId, prefix = "a") => `${prefix}${co.id}.${contractId}`;

// In a container the operator key comes from NEAR_OPERATOR_KEY (an encrypted secret) instead of the CLI keychain.
export function loadKey({ network, signer, file }) {
  let key = process.env.NEAR_OPERATOR_KEY;
  if (!key) {
    const p = file || path.join(os.homedir(), ".near-credentials", network, `${signer}.json`);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    key = j.private_key || j.secret_key;
  }
  if (!/^ed25519:/.test(key || "")) throw new Error("No ed25519 private key in the NEAR key file");
  return key;
}

// The real client: one Account that signs with the operator key. Returns { txHash, value }.
export async function nearClient({ network = "testnet", contractId, signer = contractId, rpcUrl, keyFile }) {
  const { Account, JsonRpcProvider } = await import("near-api-js");
  const provider = new JsonRpcProvider({ url: rpcUrl || (network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com") });
  const account = new Account(signer, provider, loadKey({ network, signer, file: keyFile }));
  return {
    async call(methodName, args, deposit = 0n) {
      const r = await account.callFunctionRaw({ contractId, methodName, args, deposit, gas: GAS });
      const ok = r?.status?.SuccessValue;
      const failure = r?.status?.Failure;
      if (failure) throw new Error(`${methodName}: ${JSON.stringify(failure).slice(0, 240)}`);
      let value = null;
      if (ok) { try { value = JSON.parse(Buffer.from(ok, "base64").toString("utf8")); } catch { value = null; } }
      return { txHash: r?.transaction?.hash || r?.transaction_outcome?.id || null, value };
    },
    async view(method, args) { return provider.callFunction({ contractId, method, args }); },
  };
}

export function createChain({ client, contractId, explorer = "https://testnet.nearblocks.io", save = () => {}, log = console.error, now = () => Date.now(), revealDelayMs = 3000, agentPrefix = "a" }) {
  let tail = Promise.resolve();
  const stats = { sent: 0, failed: 0, lastError: null, lastAt: null };
  // Serial queue: every transaction waits for the previous one.
  function queue(label, fn) {
    const p = tail.then(async () => {
      try { const r = await fn(); stats.sent++; stats.lastAt = now(); return r; }
      catch (e) { stats.failed++; stats.lastError = `${label}: ${e.message}`.slice(0, 300); log("chain", stats.lastError); throw e; }
      finally { save(); }
    });
    tail = p.catch(() => {});
    return p;
  }
  const txUrl = (h) => (h ? `${explorer}/txns/${h}` : null);

  // Gives a company its Agent ID card and shares. The operator founds on behalf of the payout account owner.
  function found(co, { cardUri = "" } = {}) {
    if (co.chain?.id != null || co.chain?.pending) return null;
    co.chain = { pending: true, agent: agentAccount(co, contractId, agentPrefix) };
    const ch = co.charter || { founderBps: 10_000, saleBps: 0, sharePriceYocto: "0" };
    return queue("found", () => client.call("found", {
      name: chainName(co.name), sector: chainSector(co.sector), agent: co.chain.agent,
      card: { model: String(co.model || "").slice(0, 96), uri: String(cardUri).slice(0, 256), ref_id: co.id },
      charter: { founder_bps: ch.founderBps, sale_bps: ch.saleBps, share_price: String(ch.sharePriceYocto || "0"), supply: String(ch.supply || 1_000_000) },
      owner: co.payoutAccount || null,
    }, FOUND_DEPOSIT)).then((r) => { co.chain = { id: r.value, agent: co.chain.agent, tx: r.txHash }; return r; },
      (e) => { co.chain = { error: e.message.slice(0, 200), agent: co.chain.agent }; });
  }

  const idOf = (co) => co?.chain?.id ?? null;

  // Whether a company is, or will be, on chain. Its id may still be on the way: the queue is serial, so a check made
  // when the transaction's turn comes sees the result of the found that was queued before it.
  const known = (co) => !!co?.chain && !co.chain.error;
  const need = (co, what) => { const id = idOf(co); if (id == null) throw new Error(`${what} has no Agent ID`); return id; };

  // A listing goes on chain only when its buyer has (or is getting) an Agent ID; otherwise it stays app-only.
  function openRound(round, buyer) {
    if (!known(buyer)) { round.chain = { skipped: "the buyer has no chain id" }; return null; }
    round.chain = { seals: {} };
    return queue("open_round", () => client.call("open_round", { round: round.id, buyer: need(buyer, "buyer"), sector: chainSector(round.sector), closes_ms: round.closesAt }))
      .then((r) => { round.chain.open = r.txHash; }, (e) => { round.chain.error = e.message.slice(0, 200); });
  }

  function seal(round, co, bid) {
    if (!round.chain || round.chain.skipped || !known(co)) return null;
    return queue("seal", async () => {
      if (!round.chain.open) throw new Error("round was not opened on chain");
      return client.call("seal", { round: round.id, company: need(co, "supplier"), commit: bid.commit });
    }).then((r) => { round.chain.seals[co.id] = r.txHash; }, () => {});
  }

  // Reveals the sealed bids that made it on chain and compares the contract's verdict with the app's.
  function reveal(round, byId) {
    if (!round.chain || round.chain.skipped) return null;
    let onChain = [];
    return queue("reveal", async () => {
      if (!round.chain.open) throw new Error("round was not opened on chain");
      // The contract refuses a reveal before closes_ms by block time, which can trail this clock by a moment.
      const wait = round.closesAt + revealDelayMs - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      onChain = round.bids.filter((b) => round.chain.seals[b.coId]);
      const reveals = onChain.map((b) => ({ company: idOf(byId(b.coId)), bid: String(b.bid), list: String(b.list), salt: b.salt }));
      const r = await client.call("reveal", { round: round.id, reveals });
      const view = client.view ? await client.view("get_round", { round: round.id }).catch(() => null) : null;
      return { ...r, view };
    }).then((r) => {
      round.chain.reveal = r.txHash;
      const winnerChain = r.view ? r.view.winner : r.value;
      const priceChain = r.view?.price != null ? Number(r.view.price) : null;
      const appWinner = round.winner ? idOf(byId(round.winner.coId)) : null;
      round.chain.winner = winnerChain ?? null;
      round.chain.price = priceChain;
      round.chain.bids = onChain.length;
      // Agreement is only meaningful when every app bid also reached the chain.
      round.chain.agrees = onChain.length === round.bids.length ? winnerChain === appWinner && (priceChain == null || priceChain === round.priceMicros) : null;
    }, (e) => { if (!round.chain.error) round.chain.error = e.message.slice(0, 200); });
  }

  // A delivery is tied to its round on chain only when the contract itself named this seller the winner.
  function delivery(seller, buyer, job, round) {
    if (!known(seller) || !known(buyer)) return null;
    return queue("record_delivery", () => {
      const linked = round?.chain?.reveal && round.chain.winner === idOf(seller) ? round.id : null;
      return client.call("record_delivery", { seller: need(seller, "seller"), buyer: need(buyer, "buyer"), amount: String(job.priceMicros), round: linked });
    }).then((r) => { job.chainTx = r.txHash; }, () => {});
  }

  // Share ownership on chain: an agent company buys shares of another, or a company grants from its pool.
  // `rec` is the investment log entry; it keeps the transaction hash.
  function buyShares(target, buyer, shares, rec) {
    if (!known(target) || !known(buyer)) return null;
    return queue("buy_shares", () => client.call("buy_shares", { id: need(target, "company"), buyer: need(buyer, "buyer"), shares }))
      .then((r) => { rec.tx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 160); });
  }
  function grantShares(co, to, shares, rec) {
    if (!known(co) || !known(to)) return null;
    return queue("grant_shares", () => client.call("grant_shares", { id: need(co, "company"), to: need(to, "partner"), shares }))
      .then((r) => { rec.tx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 160); });
  }

  // Shares as tokens: anyone buys with NEAR from their own wallet (buy_shares_near). The operator keeps the on-chain
  // price in step with the dollar price; the server reads the holders back to keep its books.
  const getCompany = (id) => client.view("get_company", { id });
  function setSharePrice(co, yocto) {
    if (!known(co)) return null;
    return queue("set_share_price", () => client.call("set_share_price", { id: need(co, "company"), price: String(yocto) }))
      .then((r) => { co.chain.sharePriceYocto = String(yocto); co.chain.priceTx = r.txHash; return r; }, () => null);
  }

  // Customer orders: the customer's wallet pays into escrow (place_order); the operator settles or refunds.
  // parts: [{ company: chain id, amount: yocto string }].
  const getOrder = (ref) => client.view("get_order", { order_ref: ref });
  function settleOrder(ref, fuelYocto, parts, rec) {
    return queue("settle_order", () => client.call("settle_order", { order_ref: ref, fuel: String(fuelYocto), parts }))
      .then((r) => { rec.settleTx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 200); });
  }
  function refundOrder(ref, rec) {
    return queue("refund_order", () => client.call("refund_order", { order_ref: ref }))
      .then((r) => { rec.refundTx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 200); });
  }

  // Companies change hands on chain: a handover, or a sale paid into escrow by the buyer's wallet (buy_company).
  function transferCompany(co, newOwner, rec) {
    if (!known(co)) return null;
    return queue("transfer_company", () => client.call("transfer_company", { id: need(co, "company"), new_owner: newOwner }))
      .then((r) => { rec.transferTx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 200); });
  }
  const getSale = (ref) => client.view("get_sale", { sale_ref: ref });
  function completeSale(ref, rec) {
    return queue("complete_sale", () => client.call("complete_sale", { sale_ref: ref }))
      .then((r) => { rec.completeTx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 200); });
  }
  function refundSale(ref, rec) {
    return queue("refund_sale", () => client.call("refund_sale", { sale_ref: ref }))
      .then((r) => { rec.refundTx = r.txHash; }, (e) => { rec.chainError = e.message.slice(0, 200); });
  }

  return { found, openRound, seal, reveal, delivery, buyShares, grantShares, getCompany, setSharePrice, getOrder, settleOrder, refundOrder, transferCompany, getSale, completeSale, refundSale, idOf, txUrl, stats, contractId, explorer, idle: () => tail };
}
