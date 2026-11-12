// Agent Valley company console. Zero dependencies: Node 20+.
// Run: node server.mjs   Then open http://127.0.0.1:8787
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECTORS, rulesTemplate, registerSector, publicSector, needsImageModel } from "./src/sectors.mjs";
import { createOpenRouter, createNearAI, createOllama, createMock, USD, estimateJobMicros, tokensOf } from "./src/providers.mjs";
import { createRuntime, TRIAL_TOKENS } from "./src/runtime.mjs";
import { floorOf, publicRound } from "./src/auction.mjs";
import { createChain, nearClient } from "./src/chain.mjs";
import * as shares from "./src/shares.mjs";
import { createFuel } from "./src/fuel.mjs";
import { createEscrow, createRate } from "./src/escrow.mjs";
import { createPortfolio, parseScope } from "./src/portfolio.mjs";
import { createHandover } from "./src/handover.mjs";
import * as econ from "./src/economy.mjs";
import { createOrders, publicOrder } from "./src/orders.mjs";
import { createIdeas, ideaView, restoreLinks } from "./src/ideas.mjs";
import { createPingPay } from "./src/pingpay.mjs";
import { checkPayoutAccount } from "./src/near.mjs";
import { createAuth } from "./src/auth.mjs";
import { parseAvatar } from "./src/avatar.mjs";
import { createPaidOrders } from "./src/paidorders.mjs";
import { createTaxes } from "./src/taxes.mjs";
import { createAgentPay, AgentConnect, payFromWallet, MIN_AMOUNT_MICROS } from "./src/agentpay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// .env next to this file, without a dependency. Real environment variables win.
const envFile = path.join(here, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DATA = process.env.DATA_FILE || path.join(here, "data", "state.json");
const TICK_MS = Number(process.env.TICK_MS || 3000);
// Payment is simulated for now. Turn this off on any public deployment, or anyone can unlock the clean image.
const ALLOW_SIM_PURCHASE = process.env.ALLOW_SIM_PURCHASE !== "0";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
// ADMIN_TOKEN turns on public mode. Every visitor may found companies, but each company belongs to the
// browser that founded it (an HttpOnly visitor cookie). The owner logs in at /login and manages everything.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PUBLIC_MODE = !!ADMIN_TOKEN;
// REQUIRE_SIGNIN=1: in public mode a visitor must sign in with a NEAR account before founding a company, so every
// company belongs to an account (not only to a browser).
const REQUIRE_SIGNIN = process.env.REQUIRE_SIGNIN === "1";
const VISITOR = { maxSeed: 20, maxDailyBudget: 5, companiesPerIpPerDay: Number(process.env.COMPANIES_PER_IP_PER_DAY || 2), cityLots: 16 };
const PUBLIC_ROUTES = new Set(["GET /api/city", "GET /api/auctions", "GET /api/market", "GET /api/handover/:id", "POST /api/handover/:id/claim", "GET /api/company-sale-info/:id", "POST /api/company-sales", "GET /api/company-sales/:id", "POST /api/company-sales/:id/check", "GET /api/order-info/:id", "POST /api/customer-orders", "POST /api/paid-orders", "GET /api/paid-orders/:id", "POST /api/paid-orders/:id/check", "GET /api/customer-orders/:id", "POST /api/customer-orders/:id/check", "GET /api/shop/:id", "POST /api/orders", "GET /api/orders/:id", "POST /api/orders/:id/revise", "POST /api/orders/:id/purchase", "POST /api/orders/:id/checkout",
  "GET /api/status", "POST /api/auth/challenge", "POST /api/auth/verify", "POST /api/auth/logout", "GET /api/my-orders", "GET /api/sectors", "GET /api/models", "GET /api/image-models", "GET /api/companies", "POST /api/companies", "GET /api/ideas", "POST /api/ideas"]);
// Routes on one company: open to that company's founder and to the owner.
const OWNER_ROUTES = new Set(["PATCH /api/companies/:id", "PUT /api/companies/:id/rules", "POST /api/companies/:id/jobs", "GET /api/companies/:id/jobs", "GET /api/companies/:id/orders", "POST /api/companies/:id/key", "GET /api/companies/:id/taxes", "POST /api/companies/:id/tax-checkout", "POST /api/companies/:id/agentpay", "POST /api/companies/:id/buy-shares", "POST /api/companies/:id/grant-shares", "POST /api/companies/:id/dividend", "POST /api/companies/:id/portfolio", "POST /api/companies/:id/portfolio-visibility", "POST /api/companies/:id/transfer-link", "POST /api/companies/:id/sale"]);
const sameSecret = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];
const tries = new Map(); // wrong admin logins per IP, cleared on restart
const loginPage = (wrong) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Console sign-in</title>
<style>:root{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4f9;color:#101218;font:16px/1.5 "Helvetica Neue",Arial,sans-serif;padding:16px;box-sizing:border-box}
form{background:#fff;border:1px solid #e3e5ee;border-radius:22px;padding:24px;display:grid;gap:12px;width:min(380px,100%)}h1{margin:0;font-size:24px;font-weight:500;letter-spacing:-.02em}p{margin:0;color:#5b6072;font-size:14px}
input{border:1px solid #e3e5ee;border-radius:12px;padding:11px 13px;font:inherit}button{border:0;border-radius:999px;padding:11px 18px;font:500 15px "Helvetica Neue",Arial,sans-serif;background:#6a45ff;color:#fff;cursor:pointer}.err{color:#d9412d}</style></head>
<body><form method="post" action="/login"><h1>Admin sign-in</h1><p>Enter the admin key to manage every company.</p>${wrong ? '<p class="err">Wrong key.</p>' : ""}
<input type="password" name="token" autocomplete="current-password" required placeholder="Admin key" aria-label="Admin key" autofocus><button type="submit">Sign in</button>
<p>You do not need to sign in to found a company: <a href="/app">back to the console</a>.</p></form></body></html>`;
const addCookie = (res, c) => res.setHeader("Set-Cookie", [].concat(res.getHeader("Set-Cookie") || [], c));
// A random id per browser, in an HttpOnly cookie. Created on first contact, sent back on every request.
function visitorId(req, res) {
  if (req.vid) return req.vid;
  const have = cookieOf(req, "av_vid");
  if (have && /^[a-f0-9]{32}$/.test(have)) return (req.vid = have);
  req.vid = crypto.randomBytes(16).toString("hex");
  const secure = req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "; Secure" : "";
  addCookie(res, `av_vid=${req.vid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
  return req.vid;
}
// Sign in with a NEAR account: buyers and sellers are known by the account that signed, with the browser cookie as a fallback.
const auth = createAuth({ network: process.env.NEAR_NETWORK || "testnet", recipient: process.env.AUTH_RECIPIENT || "agent-valley", secret: process.env.SESSION_SECRET || ADMIN_TOKEN || null, rpcUrls: process.env.NEAR_AUTH_RPC });
// A company belongs to the NEAR account that founded or bought it, and to the browser it was founded in.
const owns = (co, viewer) => !!co && ((!!viewer.account && co.ownerAccount === viewer.account) || (!!viewer.vid && !!co.ownerId && co.ownerId === viewer.vid));
const isAdmin = (req) => !ADMIN_TOKEN || sameSecret(decodeURIComponent(cookieOf(req, "av_admin") || ""), ADMIN_TOKEN);

// The key stays in memory or in .env. It is never written to state, logged or sent to the browser.
let sessionKey = null;
const getKey = () => sessionKey || process.env.OPENROUTER_API_KEY || null;
// Visitors bring their own OpenRouter key. Same rule: memory only, so after a restart the founder enters it again.
const ownKeys = new Map();
// Agent Pay between companies: each company's own Ping key (seller) and Agent Connect key (buyer wallet).
// Same rule as model keys: memory only, entered again after a restart.
const payKeys = new Map(); // company id -> { ping, wallet }
const agentPay = createAgentPay({ baseUrl: process.env.AGENTPAY_BASE_URL || "https://pay.pingpay.io" });
const AGENT_CONNECT_URL = process.env.AGENT_CONNECT_MCP_URL || "https://agent-connect-app-production.up.railway.app/mcp";
// Where a failed Agent Pay payment is refunded on Base (Ping requires one per payment). A public address, not a secret.
const REFUND_ADDRESS = process.env.AGENTPAY_REFUND_ADDRESS || "";
const ACCOUNT_RE = /^[A-Za-z0-9 _-]{1,40}$/;
async function checkPayKeys(b) {
  const out = {};
  if (b.pingKey) {
    out.ping = String(b.pingKey).trim();
    await agentPay.checkKey(out.ping).catch((e) => { throw new Error(e.body?.code === "agent_pay_misconfigured" ? "Agent Pay is not enabled in PingPay, or no NEAR receiving account is set (Settings)" : e.body?.code === "agent_pay_disabled" ? "Agent Pay is turned off in PingPay" : "Could not verify the PingPay key: " + e.message); });
  }
  if (b.agentConnectKey) {
    out.wallet = String(b.agentConnectKey).trim();
    const w = new AgentConnect(AGENT_CONNECT_URL, out.wallet);
    try { await w.connect(); await w.call("get_accounts", {}); } catch (e) { throw new Error("Could not verify the Agent Connect key: " + e.message); } finally { await w.close(); }
  }
  if (b.agentConnectAccount !== undefined && !ACCOUNT_RE.test(String(b.agentConnectAccount))) throw new Error("Invalid Agent Connect account name");
  return out;
}
// Both sides set up and the price above Ping's minimum: the part is paid on chain, from buyer's wallet to seller.
function onchainPay(buyer, seller, job) {
  const sk = payKeys.get(seller.id)?.ping, bk = payKeys.get(buyer.id)?.wallet;
  if (!sk || !bk || job.priceMicros < MIN_AMOUNT_MICROS) return null;
  return (async () => {
    const prepared = await agentPay.prepare(sk, { refundAddress: REFUND_ADDRESS, amountMicros: job.priceMicros, identity: `agent-valley/part/${job.id}`, description: `${seller.name} -> ${buyer.name}: ${SECTORS[seller.sector]?.name || seller.sector}` });
    const w = await new AgentConnect(AGENT_CONNECT_URL, bk).connect();
    try {
      const paid = await payFromWallet(w, prepared, { account: buyer.agentPay?.account || "Checking" });
      await agentPay.settle(sk, prepared, paid.txHash);
      return { txHash: paid.txHash, challengeId: prepared.agentPayChallengeId || null };
    } finally { await w.close(); }
  })();
}
const keyOf = (co) => co.ownKey ? ownKeys.get(co.id) ?? null : undefined;
// The trial model: what a company runs for orders paid in testnet NEAR. A free model costs nobody anything, so it is
// the default; a founder may pick another (visitors only free ones, since the platform's key pays the bill).
async function parseTrial(b, { visitor }) {
  if (b.trialModel === null || b.trialModel === "") return null;
  if (b.trialModel === undefined) {
    if (!providers.openrouter.configured()) return null;
    const free = (await providers.openrouter.models().catch(() => [])).filter((m) => m.free);
    const pick = free.find((m) => /instruct|chat|llama|qwen|mistral|gemma/i.test(m.id)) || free[0];
    return pick ? { provider: "openrouter", model: pick.id } : null;
  }
  const provider = String(b.trialProvider || b.provider || "");
  if (!providers[provider]) throw new Error("Unknown provider for the trial model");
  const m = (await providers[provider].models().catch(() => [])).find((x) => x.id === b.trialModel);
  if (!m) throw new Error("Trial model not found at this provider");
  if (visitor && provider !== "mock" && !m.free) throw new Error("For trial orders a visitor company can only pick a free model");
  return { provider, model: m.id };
}
// Providers a company may run on with its founder's own key, and what such a key looks like.
const OWN_KEY = {
  openrouter: { re: /^sk-or-[A-Za-z0-9_-]{10,}$/, hint: "an OpenRouter key starts with sk-or-" },
  nearai: { re: /^[A-Za-z0-9_.-]{20,200}$/, hint: "get a NEAR AI key from cloud.near.ai > API Keys" },
};
const checkOwnKey = async (provider, raw) => {
  const key = String(raw || "").trim(), rule = OWN_KEY[provider];
  if (!rule.re.test(key)) throw new Error(`Enter your own ${providers[provider].label} key (${rule.hint})`);
  await providers[provider].status(key).catch((e) => { throw new Error(`Could not verify the ${providers[provider].label} key: ${e.message}`); });
  return key;
};
const providers = {
  openrouter: createOpenRouter({ getKey, baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", referer: `http://${HOST}:${PORT}` }),
  nearai: createNearAI({ getKey: () => process.env.NEARAI_API_KEY || null, baseUrl: process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1" }),
  ollama: createOllama({ baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434" }),
  mock: createMock(),
};

/* ---------- state ---------- */
const store = {
  companies: [],
  books: econ.newBooks(),
  nextId: 1,
  orders: [],
  nextOrder: 1,
  trades: [], // company-to-company payments, newest first
  investments: [], // share purchases, grants and dividends between companies, newest first
  handovers: [], // one-time transfer links
  nextHandover: 1,
  companySales: [], // company purchases paid into the contract's escrow
  nextCompanySale: 1,
  customerOrders: [], // customer jobs paid into the contract's escrow, newest first
  nextCustomerOrder: 1,
  auctions: [], // sealed-bid part rounds, newest first
  nextAuction: 0,
  closed: [], // companies the owner closed; their books stay for the invariants
  customSectors: {}, // categories approved from idea applications
  supplyLinks: [], // approved sectors that supply existing ones: { buyer, supplier }
  ideas: [], // idea applications and their review
  nextIdea: 1,
  settings: { stakedNear: 0, usdPer100NearMonth: 2 }, // the owner's NEAR AI stake, for the credit calculator
  save() {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    const tmp = DATA + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ companies: this.companies, books: this.books, nextId: this.nextId, orders: this.orders, nextOrder: this.nextOrder, trades: this.trades, fuel: this.fuel, handovers: this.handovers, nextHandover: this.nextHandover, companySales: this.companySales, nextCompanySale: this.nextCompanySale, customerOrders: this.customerOrders, nextCustomerOrder: this.nextCustomerOrder, investments: this.investments, auctions: this.auctions, nextAuction: this.nextAuction, closed: this.closed, customSectors: this.customSectors, supplyLinks: this.supplyLinks, ideas: this.ideas, nextIdea: this.nextIdea, settings: this.settings }, null, 1));
    fs.renameSync(tmp, DATA);
  },
};
// First boot on a new host: STATE_SEED_B64 carries a copy of state.json. Ignored once a state file exists.
if (!fs.existsSync(DATA) && process.env.STATE_SEED_B64) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, Buffer.from(process.env.STATE_SEED_B64, "base64").toString("utf8"));
  console.log("State seeded from STATE_SEED_B64");
}
if (fs.existsSync(DATA)) {
  const s = JSON.parse(fs.readFileSync(DATA, "utf8"));
  Object.assign(store, { companies: s.companies || [], books: s.books || econ.newBooks(), nextId: s.nextId || 1, orders: s.orders || [], nextOrder: s.nextOrder || 1, trades: s.trades || [], fuel: s.fuel || null, handovers: s.handovers || [], nextHandover: s.nextHandover || 1, companySales: s.companySales || [], nextCompanySale: s.nextCompanySale || 1, customerOrders: s.customerOrders || [], nextCustomerOrder: s.nextCustomerOrder || 1, investments: s.investments || [], auctions: s.auctions || [], nextAuction: s.nextAuction || 0, closed: s.closed || [], customSectors: s.customSectors || {}, supplyLinks: s.supplyLinks || [], ideas: s.ideas || [], nextIdea: s.nextIdea || 1, settings: { stakedNear: 0, usdPer100NearMonth: 2, ...(s.settings || {}) } });
  for (const o of store.orders) if (o.status === "researching" || o.status === "designing") { o.status = o.previews.length ? "preview" : "failed"; o.error = "The server restarted"; }
  for (const co of store.companies) for (const j of co.jobs) if (j.status === "running") j.status = "queued";
}
for (const [id, sec] of Object.entries(store.customSectors)) registerSector(id, sec);
restoreLinks(store); // approved sectors that offered themselves as suppliers to existing ones
// The fuel tank: every call on the platform's own model key is metered, whoever made it.
const fuel = createFuel({ store, warnMicros: Math.round(Number(process.env.FUEL_WARN_USD || 2) * USD) });
for (const id of ["openrouter", "nearai"]) providers[id] = fuel.meter(id, providers[id]);
const IMG_DIR = path.join(path.dirname(DATA), "images");
// Product images a visual studio delivers to another company as a part.
const images = { save(jobId, buffer) { fs.mkdirSync(IMG_DIR, { recursive: true }); fs.writeFileSync(path.join(IMG_DIR, `j${jobId}.png`), buffer); return `/img/job/${jobId}.png`; } };
// Without a payment rail (simulated purchase off) a delivered job books no revenue.
const AUCTION_WINDOW_MS = Math.max(200, Number(process.env.AUCTION_WINDOW_MS) || 30_000);
// Round ids are also the contract's round ids, so a second server on the same contract starts its own range.
if (Number(process.env.AUCTION_ID_START) > (store.nextAuction || 0)) store.nextAuction = Number(process.env.AUCTION_ID_START);
/* ---------- NEAR contract mirror: Agent IDs, sealed rounds, deliveries ---------- */
// Off unless NEAR_CONTRACT is set. The operator key comes from the NEAR CLI credentials file, never from the browser.
const NEAR_CONTRACT = process.env.NEAR_CONTRACT || "";
const NEAR_NETWORK = process.env.NEAR_NETWORK || "testnet";
const NEAR_EXPLORER = process.env.NEAR_EXPLORER || (NEAR_NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io");
let chain = null;
const byCo = (id) => store.companies.find((c) => c.id === id);
if (NEAR_CONTRACT) {
  nearClient({ network: NEAR_NETWORK, contractId: NEAR_CONTRACT, signer: process.env.NEAR_SIGNER || NEAR_CONTRACT, rpcUrl: process.env.NEAR_CHAIN_RPC, keyFile: process.env.NEAR_CREDENTIALS })
    .then((client) => {
      chain = createChain({ client, contractId: NEAR_CONTRACT, explorer: NEAR_EXPLORER, save: () => store.save(), agentPrefix: process.env.NEAR_AGENT_PREFIX || "a" });
      // Companies founded before the mirror was on (or while a transaction failed) get their Agent ID now.
      for (const co of store.companies) if (co.chain?.id == null) { if (co.chain?.pending) delete co.chain; chain.found(co); }
      console.log(`NEAR contract connected: ${NEAR_CONTRACT} (${NEAR_NETWORK})`);
    })
    .catch((e) => console.error("Could not connect to the NEAR contract:", e.message));
}
const chainHooks = {
  onOpen: (round, buyer) => chain?.openRound(round, buyer),
  onSeal: (round, co, bid) => chain?.seal(round, co, bid),
  onClose: (round) => chain?.reveal(round, byCo),
  onDelivery: (seller, buyer, job, round) => chain?.delivery(seller, buyer, job, round),
  // A customer order paid into escrow is settled (or refunded) on chain when its job ends.
  onJobDone: (co, job) => {
    if (job.orderId) escrow?.delivered(co, job).catch((e) => console.error("settle", e.message));
    if (job.paidOrderId) paidOrders?.delivered(co, job);
    if (job.source === "portfolio") portfolio?.evaluate(co, job).catch((e) => console.error("portfolio", e.message));
  },
  onJobFailed: (co, job) => {
    if (job.orderId) escrow?.failed(co, job).catch((e) => console.error("refund", e.message));
    if (job.paidOrderId) paidOrders?.failed(co, job);
    if (job.source === "portfolio") portfolio?.failed(co, job);
  },
};
let escrow = null, portfolio = null, paidOrders = null;
const txUrl = (h) => (h ? `${NEAR_EXPLORER}/txns/${h}` : null);
// What anyone may see of a company's on-chain identity.
const chainOf = (co) => !co.chain ? null : { contract: NEAR_CONTRACT, id: co.chain.id ?? null, agent: co.chain.agent || null, tx: txUrl(co.chain.tx), pending: !!co.chain.pending, error: co.chain.error || null };
// A round as anyone may see it, with its on-chain trail when it has one.
const roundView = (a) => {
  const r = publicRound(a), c = a.chain;
  if (!c) return r;
  return { ...r, chain: c.skipped ? { skipped: c.skipped } : { open: txUrl(c.open), reveal: txUrl(c.reveal), seals: Object.keys(c.seals || {}).length, sealTx: Object.fromEntries(Object.entries(c.seals || {}).map(([k, h]) => [k, txUrl(h)])), winner: c.winner ?? null, price: c.price ?? null, agrees: c.agrees ?? null, error: c.error || null } };
};
// Companies founded before shares existed get the default charter.
for (const co of store.companies) shares.ensureShares(co);
const runtime = createRuntime({ store, providers, keyOf, bookSales: ALLOW_SIM_PURCHASE, images, onchainPay, auctionWindowMs: AUCTION_WINDOW_MS, hooks: chainHooks });
const orders = createOrders({ store, providers, keyOf, dataDir: path.dirname(DATA), allowPrivate: process.env.ALLOW_PRIVATE_FETCH === "1", ordersPerIpPerDay: Number(process.env.ORDERS_PER_IP_PER_DAY || 3) });
setInterval(() => runtime.tick().catch((e) => console.error("tick", e)), TICK_MS);
portfolio = createPortfolio({ store, providers, keyOf });
// The NEAR price for quotes; NEAR_USD fixes it.
const nearRate = createRate({ fixed: Number(process.env.NEAR_USD) || null });
escrow = createEscrow({ store, chain: () => chain, rate: nearRate, enqueue: runtime.enqueue, byId: (id) => store.companies.find((c) => c.id === Number(id)), keyOf, tier: NEAR_NETWORK === "mainnet" ? "full" : "trial", taxBps: Number(process.env.TAX_BPS || 200) });
setInterval(() => escrow.tick().catch((e) => console.error("escrow", e.message)), Math.max(TICK_MS, 1000));
// Companies change hands. The old owner's model key and payment keys never pass to the new owner.
const handover = createHandover({ store, chain: () => chain, rate: nearRate, byId: (id) => store.companies.find((c) => c.id === Number(id)),
  checkAccount: (raw) => checkPayoutAccount(raw, { verify: NEAR_VERIFY }),
  dropKeys: (co) => { ownKeys.delete(co.id); payKeys.delete(co.id); co.agentPay = { sell: false, buy: false, account: "Checking" }; } });
setInterval(() => handover.tick().catch((e) => console.error("handover", e.message)), Math.max(TICK_MS, 1000));
// The idea reviewer runs on a model the owner picks (REVIEW_PROVIDER + REVIEW_MODEL) and the owner pays for.
// Without one, every application waits for the owner to review it by hand.
const REVIEW = { provider: process.env.REVIEW_PROVIDER || "", model: process.env.REVIEW_MODEL || "" };
const reviewer = providers[REVIEW.provider] && REVIEW.model ? { chat: (a) => providers[REVIEW.provider].chat({ ...a, model: REVIEW.model }) } : null;
// Real customer payments. This is an ecosystem, not one company: every company receives its customers' payments
// on its own NEAR account. The platform holds nobody's money and takes nothing per sale.
const ping = createPingPay({ apiKey: process.env.PINGPAY_API_KEY || "", baseUrl: process.env.PINGPAY_BASE_URL || "https://pay.pingpay.io/api" });
// Full orders in real USDC through PingPay, straight to the company's account; served by its main model.
paidOrders = createPaidOrders({ store, ping, enqueue: runtime.enqueue, byId: (id) => store.companies.find((c) => c.id === Number(id)) });
setInterval(() => paidOrders.tick().catch((e) => console.error("paid orders", e.message)), TICK_MS);
const payoutOf = (co) => co.payoutAccount || "";
// The platform's only income: TAX_BPS of each company's monthly profit (default 200 = 2%), paid on chain to
// PINGPAY_PLATFORM_ACCOUNT. TAX_PERIOD_MS and TAX_GRACE_MS exist for tests; production uses calendar months.
const taxes = createTaxes({ store, ping, platformAccount: process.env.PINGPAY_PLATFORM_ACCOUNT || "", bps: Number(process.env.TAX_BPS || 200),
  periodMs: Number(process.env.TAX_PERIOD_MS || 0), graceMs: Number(process.env.TAX_GRACE_MS || 15 * 86_400_000), minMicros: Number(process.env.TAX_MIN_MICROS || 100_000),
  fuelBillMicros: Math.round(Number(process.env.FUEL_BILL_USD ?? 5) * USD), onFuelPaid: (co, micros) => fuel.collect(co, micros) });
// Fuel companies still owe: billed but unpaid, plus used since their last bill.
const fuelOwedAll = () => store.companies.reduce((a, co) => a + taxes.fuelOwed(co) + (co.tax?.invoices || []).filter((i) => i.status === "due").reduce((b, i) => b + (i.fuelMicros || 0), 0), 0);
setInterval(() => { try { taxes.tick(); } catch (e) { console.error("tax", e); } }, TICK_MS);
// Accounts are looked up on NEAR mainnet before a company opens. NEAR_ACCOUNT_CHECK=0 skips the lookup (offline tests).
const NEAR_VERIFY = process.env.NEAR_ACCOUNT_CHECK !== "0";
const publicBase = (req) => `${req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "https" : "http"}://${req.headers.host}`;
// The order page polls; at most every few seconds the server asks PingPay whether the checkout completed.
async function confirmCheckout(o) {
  if (!ping || !o.checkout || o.purchased || Date.now() - (o.checkout.checkedAt || 0) < 3000) return;
  o.checkout.checkedAt = Date.now();
  const s = await ping.getSession(o.checkout.sessionId).catch(() => null);
  if (s?.status === "COMPLETED") orders.purchase(o.id, o.checkout.n, { via: "pingpay", paymentId: s.paymentId });
  else if (s && ["EXPIRED", "CANCELLED"].includes(s.status)) { o.checkout = null; store.save(); }
}
const ideas = createIdeas({ store, reviewer, autoApprove: process.env.IDEA_AUTO_APPROVE === "1", perIpPerDay: Number(process.env.IDEAS_PER_IP_PER_DAY || 3) });

/* ---------- validation ---------- */
const dollars = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Value must be between ${min} and ${max}`); return Math.round(n * USD); };
const int = (v, min, max) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Value must be between ${min} and ${max}`); return n; };
function parseSchedule(s = {}) {
  const mode = ["always", "interval", "hours"].includes(s.mode) ? s.mode : "always";
  return { mode, everyMin: int(s.everyMin ?? 10, 1, 1440), startHour: int(s.startHour ?? 9, 0, 23), endHour: int(s.endHour ?? 18, 0, 23) };
}
function parseLimits(l = {}) {
  return { maxJobsPerHour: int(l.maxJobsPerHour ?? 6, 1, 600), dailyAiBudget: dollars(l.dailyAiBudget ?? 1, 0, 1000), maxTokens: int(l.maxTokens ?? 1600, 100, 8000) };
}

const MAX_RULES = 20_000; // characters, about 5k tokens added to every request
function parseRules(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n");
  if (s.length > MAX_RULES) throw new Error(`The rules file can be at most ${MAX_RULES.toLocaleString("en-US")} characters`);
  return s;
}

// Visual studios also need an image model. Its price per image feeds the budget guard.
async function imageChoice(b) {
  if (!needsImageModel(b.sector) || !b.imageModel) return {};
  const p = providers[b.provider];
  if (!p.imageModels) throw new Error("This provider has no image models");
  const list = await p.imageModels();
  const m = list.find((x) => x.id === b.imageModel);
  if (!m) throw new Error("Image model not found");
  return { imageModel: m.id, imageProvider: b.provider, imageEstimateMicros: m.perImage != null ? Math.round(m.perImage * USD) : 0 };
}
const clientIp = (req) => (TRUST_PROXY && req.headers["cf-connecting-ip"]) || req.socket.remoteAddress || "unknown";

/* ---------- views ---------- */
// Closed companies stay in the books: their money and NER still count, so the invariants hold exactly.
const booksCompanies = () => [...store.companies, ...(store.closed || [])];
// A company's own books: where its money comes in, what goes to the platform, what it spends.
function accountOf(co) {
  const paid = store.orders.filter((o) => o.companyId === co.id && o.purchased?.via === "pingpay");
  const inMicros = paid.reduce((a, o) => a + o.priceMicros, 0);
  return {
    payoutAccount: co.payoutAccount || null, paymentsOn: !!(ping && co.payoutAccount),
    nearSales: paid.length, nearInMicros: inMicros, taxPaidMicros: co.ledger.taxPaid || 0,
    recent: paid.slice(0, 10).map((o) => ({ orderId: o.id, at: o.purchased.at, amountMicros: o.priceMicros, paymentId: o.purchased.paymentId || null })),
    b2bIn: co.ledger.b2bIn || 0, b2bOut: co.ledger.b2bOut || 0, aiCost: co.ledger.aiCost,
    brain: co.provider === "mock" ? "demo" : co.ownKey ? "own" : "platform",
  };
}
const view = (co) => {
  const done = co.jobs.filter((j) => j.status === "done");
  const avgCost = done.length ? Math.round(done.slice(0, 10).reduce((a, j) => a + j.costMicros, 0) / Math.min(10, done.length)) : null;
  return {
    id: co.id, name: co.name, sector: co.sector, sectorName: SECTORS[co.sector].name, provider: co.provider, model: co.model, trial: co.trial || null, avatar: co.avatar || null,
    stage: co.stage, status: co.status, waiting: co.waiting || null, priceMicros: co.priceMicros, minPriceMicros: co.minPriceMicros ?? null, bidFloorMicros: floorOf(co), schedule: co.schedule, limits: co.limits, demo: co.demo,
    ledger: { ...co.ledger, balance: econ.balance(co.ledger), profit: co.ledger.revenue - co.ledger.aiCost },
    jobsDone: done.length, jobsQueued: co.jobs.filter((j) => j.status === "queued").length, jobsFailed: co.jobs.filter((j) => j.status === "failed").length,
    avgCostMicros: avgCost, spendToday: co.spend?.ai || 0, createdAt: co.createdAt, log: co.log.slice(0, 30),
    imageModel: co.imageModel || null, ownKey: !!co.ownKey, keyLoaded: keyOf(co) !== null, payoutAccount: co.payoutAccount || null,
    account: accountOf(co), tax: taxes.view(co), chain: chainOf(co),
    shares: shares.capTable(co, find), holdings: shares.holdingsOf(co, store.companies), portfolio: portfolio.view(co),
    sale: co.sale || null, ownerHistory: co.ownerHistory || [],
    agentPay: { sell: !!co.agentPay?.sell, buy: !!co.agentPay?.buy, sellLoaded: !!payKeys.get(co.id)?.ping, buyLoaded: !!payKeys.get(co.id)?.wallet, account: co.agentPay?.account || "Checking", minMicros: MIN_AMOUNT_MICROS },
    rules: { text: co.rules?.text || "", rev: co.rules?.rev || 0, updatedAt: co.rules?.updatedAt || null, tokens: tokensOf(co.rules?.text) },
  };
};
const jobView = (j) => ({ ...j, output: j.output ? j.output.slice(0, 20000) : null });

/* ---------- http ---------- */
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, bad) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 200_000) { bad(new Error("Request too large")); req.destroy(); } }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error("Invalid JSON")); } }); });
const find = (id) => store.companies.find((c) => c.id === Number(id));

const routes = {
  "GET /api/status": async (_q, _b, _id, req) => {
    const viewer = { admin: req.viewer.admin, account: req.viewer.account, requireSignIn: REQUIRE_SIGNIN, signIn: { network: auth.network, suffix: auth.suffix }, publicMode: PUBLIC_MODE, bookSales: ALLOW_SIM_PURCHASE, limits: PUBLIC_MODE && !req.viewer.admin ? VISITOR : null, taxBps: taxes.bps, payments: !!ping };
    // A visitor sees nothing of the owner's key or machine: only the demo model and "bring your own key".
    if (PUBLIC_MODE && !req.viewer.admin) return { viewer, check: econ.check(store.books, booksCompanies()), companies: store.companies.length, providers: { openrouter: { label: "OpenRouter", configured: false, ownKey: true }, nearai: { label: "NEAR AI Cloud", configured: false, ownKey: true }, mock: { label: providers.mock.label, configured: true } } };
    const out = { viewer, chain: NEAR_CONTRACT ? { contract: NEAR_CONTRACT, network: NEAR_NETWORK, connected: !!chain, ...(chain?.stats || {}) } : null, books: store.books, check: econ.check(store.books, booksCompanies()), companies: store.companies.length, providers: {} };
    for (const [id, p] of Object.entries(providers)) {
      out.providers[id] = { label: p.label, configured: p.configured() };
      if (p.configured() && id !== "mock") out.providers[id].status = await p.status().catch((e) => ({ ok: false, reason: e.message, code: e.code }));
    }
    out.providers.openrouter.keySource = sessionKey ? "session" : process.env.OPENROUTER_API_KEY ? "env" : null;
    return out;
  },
  /* ---------- sign in with NEAR ---------- */
  "POST /api/auth/challenge": async (_q, _b, _id, req) => auth.challenge(req.viewer.vid),
  // The wallet's answer. Companies founded in this browser before signing in move under the account.
  "POST /api/auth/verify": async (_q, b, _id, req) => {
    const account = await auth.verify(req.viewer.vid, b);
    req.cookie(`av_near=${auth.sessionCookie(account)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(auth.sessionMs / 1000)}`);
    let adopted = 0;
    for (const co of store.companies) if (!co.ownerAccount && co.ownerId && co.ownerId === req.viewer.vid) { co.ownerAccount = account; adopted++; }
    for (const o of store.customerOrders || []) if (!o.buyerAccount && o.buyerVid && o.buyerVid === req.viewer.vid) o.buyerAccount = account;
    store.save();
    return { account, adopted };
  },
  "POST /api/auth/logout": async (_q, _b, _id, req) => { req.cookie("av_near=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); return { ok: true }; },
  // The buyer side: every order this account (or this browser) placed, with the link back to each one.
  "GET /api/my-orders": async (_q, _b, _id, req) => (store.customerOrders || [])
    .filter((o) => (req.viewer.account && o.buyerAccount === req.viewer.account) || (o.buyerVid && o.buyerVid === req.viewer.vid))
    .slice(0, 50).map((o) => ({ ...escrow.view(o, { txUrl }), token: o.token })),
  "GET /api/sectors": async () => Object.fromEntries(Object.keys(SECTORS).map((id) => [id, { ...publicSector(id), rulesTemplate: rulesTemplate(id) }])),
  "GET /api/models": async (q, _b, _id, req) => {
    const p = providers[q.get("provider")];
    if (!p || (q.get("provider") === "ollama" && !req.viewer.admin)) throw new Error("Unknown provider");
    const list = await p.models();
    const extra = Math.min(10_000, Math.max(0, Number(q.get("extraTokens")) || 0));
    return list.map((m) => ({ ...m, estimateMicros: estimateJobMicros(m, extra) })).sort((a, b) => a.estimateMicros - b.estimateMicros);
  },
  "POST /api/settings/openrouter-key": async (_q, body) => {
    const key = String(body.key || "").trim();
    if (key && !/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) throw new Error("This does not look like an OpenRouter key (it starts with sk-or-)");
    sessionKey = key || null;
    return { ok: true, configured: !!getKey() };
  },
  "GET /api/image-models": async (q) => {
    const p = providers[q.get("provider")];
    if (!p?.imageModels) return [];
    return p.imageModels();
  },
  // What the 3D city shows: real companies only. No keys, prompts, customer sites, order tokens or error text.
  "GET /api/city": async () => ({
    at: Date.now(),
    sectors: Object.fromEntries(Object.keys(SECTORS).map((id) => [id, { name: SECTORS[id].name, form: SECTORS[id].form, color: SECTORS[id].color }])),
    trades: (store.trades || []).slice(0, 40).map((x) => ({ t: x.t, from: x.from, to: x.to, amount: x.amount, onchain: x.onchain?.txHash || null })),
    auctions: (store.auctions || []).slice(0, 20).map(roundView),
    investments: (store.investments || []).slice(0, 40).map((x) => ({ t: x.t, kind: x.kind, from: x.from, to: x.to, shares: x.shares, amount: x.amount, tx: txUrl(x.tx) })),
    contract: NEAR_CONTRACT ? { id: NEAR_CONTRACT, network: NEAR_NETWORK, url: `${NEAR_EXPLORER}/address/${NEAR_CONTRACT}` } : null,
    books: store.books,
    check: econ.check(store.books, booksCompanies()),
    companies: store.companies.map((co) => ({
      id: co.id, name: co.name, sector: co.sector, stage: co.stage, status: co.status, createdAt: co.createdAt, avatar: co.avatar || null,
      priceMicros: co.priceMicros, shop: co.sector === "visual" && !!co.imageModel, payoutAccount: co.payoutAccount || null, chain: chainOf(co),
      shares: (() => { const t = shares.capTable(co, find); return { priceMicros: t.priceMicros, valuationMicros: t.valuationMicros, forSalePct: t.forSalePct, partners: t.holders.filter((h) => h.coId != null).map((h) => ({ coId: h.coId, name: h.name, pct: h.pct })) }; })(),
      ledger: { earned: co.ledger.earned, capital: co.ledger.capital, ner: co.ledger.ner, seed: co.ledger.seed, raised: co.ledger.raised, revenue: co.ledger.revenue, aiCost: co.ledger.aiCost },
      sales: store.orders.filter((o) => o.companyId === co.id && o.purchased).length + co.jobs.filter((j) => j.paid).length,
      brain: co.provider === "mock" ? "demo" : co.provider,
      events: co.log.filter((l) => l.kind === "stage").slice(0, 10).map((l) => ({ t: l.t, text: l.text })),
    })),
  }),
  // The auction board: open listings (sealed, amounts hidden) and closed rounds (revealed and checkable).
  "GET /api/auctions": async () => {
    const all = (store.auctions || []).map(roundView);
    const closed = all.filter((a) => a.status !== "open");
    const ordered = closed.filter((a) => a.outcome === "ordered");
    return {
      at: Date.now(), windowMs: AUCTION_WINDOW_MS,
      contract: NEAR_CONTRACT ? { id: NEAR_CONTRACT, network: NEAR_NETWORK, url: `${NEAR_EXPLORER}/address/${NEAR_CONTRACT}`, connected: !!chain, failed: chain?.stats.failed || 0 } : null,
      sectors: Object.fromEntries(Object.keys(SECTORS).map((id) => [id, { name: SECTORS[id].name, color: SECTORS[id].color }])),
      open: all.filter((a) => a.status === "open"),
      closed: closed.slice(0, 40),
      stats: {
        rounds: all.length, open: all.length - closed.length, ordered: ordered.length,
        avgBids: closed.length ? Math.round((closed.reduce((a, x) => a + x.bids.length, 0) / closed.length) * 10) / 10 : 0,
        // What competition saved buyers: the winners' list prices minus what they were actually paid.
        savedMicros: ordered.reduce((a, x) => a + Math.max(0, (x.winner.list || 0) - x.priceMicros), 0),
      },
    };
  },
  "GET /api/shop/:id": async (_q, _b, id) => {
    const co = find(id);
    if (!co || co.sector !== "visual" || !co.imageModel) throw new Error("This company does not sell cover images");
    return { id: co.id, name: co.name, priceMicros: co.priceMicros, status: co.status, previewsPerOrder: 2, simPurchase: ALLOW_SIM_PURCHASE, payments: ping && payoutOf(co) ? "pingpay" : ALLOW_SIM_PURCHASE ? "simulated" : "none" };
  },
  "POST /api/orders": async (_q, b, _id, req) => {
    const seller = find(b.companyId);
    if (seller && taxes.overdue(seller)) throw Object.assign(new Error("This company has an overdue invoice (tax or AI fuel) and cannot take new orders until it pays"), { status: 402 });
    const o = await orders.create({ companyId: b.companyId, url: b.url, ip: clientIp(req) });
    return { ...publicOrder(o, find(o.companyId)), token: o.token };
  },
  "GET /api/orders/:id": async (q, _b, id) => {
    const o = orders.authorized(id, q.get("t"));
    if (!o) throw Object.assign(new Error("Order not found"), { status: 404 });
    await confirmCheckout(o);
    return publicOrder(o, find(o.companyId));
  },
  // Opens a PingPay checkout for exactly this order's price. The customer returns to the order page.
  "POST /api/orders/:id/checkout": async (_q, b, id, req) => {
    const o = orders.authorized(id, b.t);
    if (!o) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (o.purchased) return { purchased: true };
    const co = find(o.companyId);
    if (!ping || !payoutOf(co)) throw Object.assign(new Error("Payments are not connected for this company yet"), { status: 402 });
    const n = Number(b.n), pick = o.previews.find((p) => p.n === n);
    if (!pick) throw new Error("No preview to buy");
    const back = `${publicBase(req)}/shop.html?c=${co.id}&o=${o.id}&t=${o.token}`;
    const s = await ping.createSession({ amountMicros: o.priceMicros, recipient: payoutOf(co), successUrl: back + "&paid=1", cancelUrl: back, metadata: { orderId: String(o.id), company: String(co.id), preview: String(n) } });
    o.checkout = { sessionId: s.sessionId, n, at: Date.now(), checkedAt: 0 };
    store.save();
    return { url: s.url };
  },
  "POST /api/orders/:id/revise": async (_q, b, id) => {
    if (!orders.authorized(id, b.t)) throw Object.assign(new Error("Order not found"), { status: 404 });
    const o = await orders.revise(id, b.note);
    return publicOrder(o, find(o.companyId));
  },
  "POST /api/orders/:id/purchase": async (_q, b, id) => {
    if (!orders.authorized(id, b.t)) throw Object.assign(new Error("Order not found"), { status: 404 });
    if (!ALLOW_SIM_PURCHASE) throw Object.assign(new Error("Payments are not connected yet"), { status: 402 });
    const o = orders.purchase(id, b.n);
    return publicOrder(o, find(o.companyId));
  },
  "GET /api/companies/:id/orders": async (_q, _b, id) => orders.forCompany(id).slice(0, 30).map((o) => ({ ...publicOrder(o, find(o.companyId)), token: o.token, costMicros: o.costMicros })),
  "GET /api/companies": async (_q, _b, _id, req) => store.companies.filter((c) => req.viewer.admin || owns(c, req.viewer)).map(view),
  "POST /api/companies": async (_q, b, _id, req) => {
    const visitor = PUBLIC_MODE && !req.viewer.admin;
    const name = String(b.name || "").trim();
    let ownKey = null;
    if (visitor && REQUIRE_SIGNIN && !req.viewer.account) throw Object.assign(new Error("Sign in with your NEAR account to found a company"), { status: 401 });
    if (visitor) {
      // Visitors run on the demo model or on their own OpenRouter key, never on the owner's key or machine.
      if (b.provider !== "mock" && !OWN_KEY[b.provider]) throw new Error("Visitor companies run on the demo model or on your own OpenRouter / NEAR AI key");
      if (store.companies.length >= VISITOR.cityLots) throw Object.assign(new Error("The city is full. Try again when a new lot opens"), { status: 409 });
      const ip = clientIp(req), day = Date.now() - 86_400_000;
      if (store.companies.filter((c) => c.founderIp === ip && c.createdAt > day).length >= VISITOR.companiesPerIpPerDay) throw Object.assign(new Error(`At most ${VISITOR.companiesPerIpPerDay} companies can be founded per day`), { status: 429 });
      if (Number(b.seed) > VISITOR.maxSeed) throw new Error(`Starting budget can be at most $${VISITOR.maxSeed}`);
      if (Number(b.limits?.dailyAiBudget ?? 1) > VISITOR.maxDailyBudget) throw new Error(`Daily model budget can be at most $${VISITOR.maxDailyBudget}`);
    }
    if (OWN_KEY[b.provider] && (visitor || b.key)) ownKey = await checkOwnKey(b.provider, b.key);
    const payout = await checkPayoutAccount(b.payoutAccount, { verify: NEAR_VERIFY });
    const pk = await checkPayKeys(b);
    if (name.length < 2 || name.length > 32) throw new Error("Company name must be 2 to 32 characters");
    if (store.companies.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error("A company with this name already exists");
    const charter = shares.parseCharter(b.charter);
    const avatar = parseAvatar(b.avatar);
    const trial = b.provider === "mock" ? null : await parseTrial(b, { visitor });
    if (!SECTORS[b.sector]) throw new Error("Unknown sector");
    if (!providers[b.provider]) throw new Error("Unknown provider");
    const models = await providers[b.provider].models();
    if (!models.some((m) => m.id === b.model)) throw new Error("Model not found at this provider");
    const co = {
      id: store.nextId++, name, sector: b.sector, provider: b.provider, model: b.model, stage: "idea", status: "running", avatar, trial,
      priceMicros: dollars(b.price, 0.01, 1000), minPriceMicros: b.minPrice != null && b.minPrice !== "" ? dollars(b.minPrice, 0.01, 1000) : null, schedule: parseSchedule(b.schedule), limits: parseLimits(b.limits), payoutAccount: payout,
      demo: { on: !!b.demo?.on, everyMin: int(b.demo?.everyMin ?? 5, 1, 1440), lastAt: 0 },
      ledger: econ.newLedger(), spend: { day: "", ai: 0 }, jobs: [], log: [], createdAt: Date.now(), lastRunAt: 0,
      rules: { text: parseRules(b.rules), rev: b.rules ? 1 : 0, updatedAt: b.rules ? Date.now() : null },
      ...(await imageChoice(b)),
      ownerId: req.viewer.admin ? null : req.viewer.vid, ownerAccount: req.viewer.account || null, founderIp: visitor ? clientIp(req) : null, ownKey: !!ownKey,
    };
    if (visitor) co.demo.on = false;
    if (ownKey) ownKeys.set(co.id, ownKey);
    co.agentPay = { sell: !!pk.ping, buy: !!pk.wallet, account: String(b.agentConnectAccount || "Checking") };
    if (pk.ping || pk.wallet) payKeys.set(co.id, pk);
    econ.seed(store.books, co, dollars(b.seed, 0.5, 10000));
    co.log.unshift({ t: Date.now(), kind: "stage", text: `${SECTORS[co.sector].name} workshop opened, starting budget $${(co.ledger.seed / USD).toFixed(2)}` });
    shares.issue(co, charter);
    store.companies.push(co); store.save();
    chain?.found(co);
    // The optional self-test: the founder's samples run as real jobs and become the portfolio.
    const scope = parseScope(b.portfolio, SECTORS[co.sector]?.output);
    if (scope.enabled) portfolio.start(co, scope, runtime.enqueue);
    return view(co);
  },
  "PATCH /api/companies/:id": async (_q, b, id, req) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    if (b.avatar !== undefined) co.avatar = parseAvatar(b.avatar);
    if (b.trialModel !== undefined) co.trial = await parseTrial(b, { visitor: PUBLIC_MODE && !req.viewer.admin });
    if (b.status && ["running", "paused"].includes(b.status)) co.status = b.status;
    if (b.price != null) co.priceMicros = dollars(b.price, 0.01, 1000);
    if (b.minPrice !== undefined) co.minPriceMicros = b.minPrice === null || b.minPrice === "" ? null : dollars(b.minPrice, 0.01, 1000);
    if (b.payoutAccount !== undefined) {
      const next = await checkPayoutAccount(b.payoutAccount, { verify: NEAR_VERIFY });
      if (next !== co.payoutAccount) { co.log.unshift({ t: Date.now(), kind: "stage", text: `Payout account changed: ${co.payoutAccount || "none"} → ${next}` }); co.payoutAccount = next; }
    }
    if (b.schedule) co.schedule = parseSchedule(b.schedule);
    if (b.limits) co.limits = parseLimits(b.limits);
    if (b.demo) co.demo = { ...co.demo, on: !!b.demo.on, everyMin: int(b.demo.everyMin ?? co.demo.everyMin, 1, 1440) };
    if (b.model) { const models = await providers[co.provider].models(); if (!models.some((m) => m.id === b.model)) throw new Error("Model not found"); co.model = b.model; }
    store.save();
    return view(co);
  },
  "PUT /api/companies/:id/rules": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const text = parseRules(b.text);
    if (text === (co.rules?.text || "")) return view(co);
    co.rules = { text, rev: (co.rules?.rev || 0) + 1, updatedAt: Date.now() };
    co.log.unshift({ t: Date.now(), kind: "stage", text: text.trim() ? `Rules file updated (version ${co.rules.rev}, ~${tokensOf(text)} tokens)` : `Rules file cleared (version ${co.rules.rev})` });
    store.save();
    return view(co);
  },
  "POST /api/companies/:id/jobs": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const brief = String(b.brief || "").trim();
    if (brief.length < 5) throw new Error("The job brief must be at least 5 characters");
    // tier "trial" lets the founder see what a free testnet order gets from the trial model.
    return jobView(runtime.enqueue(co, brief, "manual", { tier: b.tier === "trial" ? "trial" : "full" }));
  },
  "GET /api/companies/:id/jobs": async (_q, _b, id) => { const co = find(id); if (!co) throw new Error("Company not found"); return co.jobs.slice(0, 50).map(jobView); },
  // NEAR AI "Staking for Inference": staking rewards pay for inference, the stake stays the owner's.
  // The rate is the one the owner sees on NEAR AI (default: 100 NEAR -> $2 a month); it moves with NEAR's price and APY.
  "GET /api/compute": async () => {
    const { stakedNear, usdPer100NearMonth } = store.settings, month = Date.now() - 30 * 86_400_000;
    const spendOn = (pid) => store.companies.filter((c) => !c.ownKey && (c.provider === pid || c.imageProvider === pid))
      .reduce((a, c) => a + c.jobs.filter((j) => j.finishedAt > month).reduce((x, j) => x + (j.costMicros || 0), 0), 0);
    const spend = spendOn("nearai");
    // OpenRouter: the key's own view (remaining limit, usage). Buying credit is web-only: OpenRouter removed the
    // programmatic crypto purchase (POST /credits/coinbase answers 410 Gone), so the owner tops up on its credits page.
    const or = providers.openrouter.configured() ? await providers.openrouter.status().then((x) => ({ key: "ok", limitRemaining: x.limitRemaining ?? null, usage: x.usage ?? null, usageDaily: x.usageDaily ?? null }), (e) => ({ key: e.code || "error" })) : { key: "no_key" };
    or.spend30dMicros = spendOn("openrouter");
    const credit = Math.round((stakedNear / 100) * usdPer100NearMonth * USD);
    const st = providers.nearai.configured() ? await providers.nearai.status().then(() => "ok", (e) => e.code || "error") : "no_key";
    return { stakedNear, usdPer100NearMonth, monthlyCreditMicros: credit, nearaiSpend30dMicros: spend, coverage: spend ? Math.round((credit / spend) * 100) : null, key: st, openrouter: or };
  },
  "POST /api/compute": async (_q, b) => {
    const n = Number(b.stakedNear), r = Number(b.usdPer100NearMonth ?? store.settings.usdPer100NearMonth);
    if (!Number.isFinite(n) || n < 0 || n > 1e9 || !Number.isFinite(r) || r < 0 || r > 1000) throw new Error("Invalid value");
    store.settings = { ...store.settings, stakedNear: n, usdPer100NearMonth: r };
    store.save();
    return { ok: true };
  },
  "GET /api/ideas": async (_q, _b, _id, req) => ideas.list()
    .filter((i) => req.viewer.admin || i.status === "approved" || i.ownerId === req.viewer.vid)
    .slice(0, 50).map((i) => ideaView(i, { admin: req.viewer.admin, mine: i.ownerId === req.viewer.vid })),
  "POST /api/ideas": async (_q, b, _id, req) => ideaView(await ideas.apply(b, { ip: clientIp(req), vid: req.viewer.vid }), { mine: true }),
  // The owner adjusts a proposal's sector settings before approving it. Admin only.
  "PATCH /api/ideas/:id/proposal": async (_q, b, id) => ideaView(ideas.edit(id, b), { admin: true }),
  "POST /api/ideas/:id/decide": async (_q, b, id, req) => ideaView(ideas.decide(id, !!b.approve, b.reason), { admin: req.viewer.admin }),
  // The founder pays a tax invoice on chain; the desk polls until PingPay reports it COMPLETED.
  "GET /api/companies/:id/taxes": async (_q, _b, id) => { const co = find(id); if (!co) throw new Error("Company not found"); await taxes.confirm(co); return taxes.view(co); },
  "POST /api/companies/:id/tax-checkout": async (_q, b, id, req) => { const co = find(id); if (!co) throw new Error("Company not found"); return taxes.checkout(co, b.invoiceId, publicBase(req)); },
  // Owner only: closes a company. Its books move to the archive so the ledger's invariants still hold exactly.
  "DELETE /api/companies/:id": async (_q, b, id) => {
    const i = store.companies.findIndex((c) => c.id === Number(id));
    if (i < 0) throw new Error("Company not found");
    const [co] = store.companies.splice(i, 1);
    ownKeys.delete(co.id); payKeys.delete(co.id);
    for (const j of co.jobs) if (j.status === "queued" || j.status === "waiting") j.status = "failed";
    if (!store.closed) store.closed = [];
    store.closed.push({ id: co.id, name: co.name, sector: co.sector, ledger: co.ledger, closedAt: Date.now(), reason: String(b.reason || "").slice(0, 200) || null });
    store.save();
    return { closed: co.id, name: co.name };
  },
  // Connect or reconnect a company's Agent Pay keys. clear: "ping" | "wallet" removes one.
  "POST /api/companies/:id/agentpay": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const pk = await checkPayKeys(b), cur = payKeys.get(co.id) || {};
    if (b.clear === "ping") delete cur.ping;
    if (b.clear === "wallet") delete cur.wallet;
    Object.assign(cur, pk);
    payKeys.set(co.id, cur);
    co.agentPay = { sell: !!cur.ping, buy: !!cur.wallet, account: String(b.agentConnectAccount ?? co.agentPay?.account ?? "Checking") };
    co.log.unshift({ t: Date.now(), kind: "stage", text: `Agent Pay: ${cur.ping ? "selling on" : "selling off"}, ${cur.wallet ? "buying wallet connected" : "no buying wallet"}` });
    store.save();
    return view(co);
  },
  "POST /api/companies/:id/key": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    if (!co.ownKey) throw new Error("This company does not run on its own key");
    ownKeys.set(co.id, await checkOwnKey(co.provider, b.key));
    if (co.status === "no_provider") co.status = "running";
    store.save();
    return view(co);
  },
  /* ---------- companies change hands ---------- */
  // The owner makes a one-time link; whoever opens it takes the company over.
  "POST /api/companies/:id/transfer-link": async (_q, _b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const h = handover.createLink(co);
    return { id: h.id, url: `/claim.html?h=${h.id}&t=${h.token}`, expiresAt: h.expiresAt };
  },
  // List the company for sale at a price in USD, or withdraw the listing (price: null).
  "POST /api/companies/:id/sale": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    handover.list(co, b.price == null || b.price === "" ? null : dollars(b.price, 1, 1_000_000));
    return view(co);
  },
  "GET /api/handover/:id": async (q, _b, id) => {
    const h = handover.openLink(id, q.get("t")), co = find(h.coId);
    return { company: { id: co.id, name: co.name, sectorName: SECTORS[co.sector]?.name, stage: co.stage, jobsDone: co.jobs.filter((j) => j.status === "done").length, balanceMicros: econ.balance(co.ledger), ownKey: !!co.ownKey, chainId: co.chain?.id ?? null }, expiresAt: h.expiresAt };
  },
  "POST /api/handover/:id/claim": async (q, b, id, req) => {
    const co = await handover.claim(id, q.get("t"), { ownerId: req.viewer.admin ? null : req.viewer.vid, ownerAccount: req.viewer.account || null, payoutAccount: b.payoutAccount });
    return { id: co.id, name: co.name };
  },
  "GET /api/company-sale-info/:id": async (_q, _b, id) => {
    const co = find(id); if (!co || !co.sale) throw Object.assign(new Error("This company is not for sale"), { status: 404 });
    let quote = null;
    try { const usd = await nearRate(); quote = { nearUsd: usd, near: Number((co.sale.priceMicros / 1e6 / usd).toFixed(4)) }; } catch { /* shown as unavailable */ }
    const t = shares.capTable(co, find);
    return { id: co.id, name: co.name, sectorName: SECTORS[co.sector]?.name, stage: co.stage, priceMicros: co.sale.priceMicros, quote, chainId: co.chain?.id ?? null,
      jobsDone: co.jobs.filter((j) => j.status === "done").length, revenueMicros: co.ledger.revenue, balanceMicros: econ.balance(co.ledger), portfolioScore: co.portfolio?.score ?? null,
      founderPct: t.holders.filter((h) => h.coId == null).reduce((a, h) => a + h.pct, 0), ownKey: !!co.ownKey,
      contract: NEAR_CONTRACT ? { id: NEAR_CONTRACT, network: NEAR_NETWORK, explorer: NEAR_EXPLORER } : null };
  },
  "POST /api/company-sales": async (_q, b, _id, req) => {
    const co = find(b.companyId); if (!co) throw new Error("Company not found");
    const s = await handover.startPurchase(co, { ownerId: req.viewer.admin ? null : req.viewer.vid, ownerAccount: req.viewer.account || null, newOwner: b.newOwner });
    return { ...handover.saleView(s, txUrl), token: s.token, contract: NEAR_CONTRACT, network: NEAR_NETWORK };
  },
  "GET /api/company-sales/:id": async (q, _b, id) => handover.saleView(handover.findSale(id, q.get("t")), txUrl),
  "POST /api/company-sales/:id/check": async (q, _b, id) => { const s = handover.findSale(id, q.get("t")); await handover.check(s); return { status: s.status }; },

  /* ---------- portfolio: the agent's graded sample work ---------- */
  // The owner runs the self-test again with new samples or criteria. Replaces the previous portfolio.
  "POST /api/companies/:id/portfolio": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const scope = parseScope({ ...b, enabled: true }, SECTORS[co.sector]?.output);
    if (!scope.prompts.length) throw new Error("Write at least one sample job (5 characters or more)");
    portfolio.start(co, scope, runtime.enqueue);
    return view(co);
  },
  "POST /api/companies/:id/portfolio-visibility": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    portfolio.setPublic(co, b.jobId, b.public);
    return view(co);
  },

  /* ---------- customer orders paid on chain (escrow) ---------- */
  // What a customer sees before ordering: the company, its price and the quote in NEAR.
  "GET /api/order-info/:id": async (_q, _b, id) => {
    const co = find(id); if (!co || co.status === "closed") throw Object.assign(new Error("Company not found"), { status: 404 });
    const sec = SECTORS[co.sector] || {};
    let quote = null;
    try { const usd = await nearRate(); quote = { nearUsd: usd, near: Number((co.priceMicros / 1e6 / usd).toFixed(4)) }; } catch { /* the page says the price is unavailable */ }
    return { id: co.id, name: co.name, sector: co.sector, sectorName: sec.name, sells: sec.sells, demo: (sec.demo || []).slice(0, 3), output: sec.output || "text", portfolio: portfolio.view(co, { publicOnly: true }),
      status: co.status, priceMicros: co.priceMicros, quote, chainId: co.chain?.id ?? null, overdue: taxes.overdue(co),
      contract: NEAR_CONTRACT ? { id: NEAR_CONTRACT, network: NEAR_NETWORK, explorer: NEAR_EXPLORER } : null, refundAfterHours: 2, jobsDone: co.jobs.filter((j) => j.status === "done").length,
      // The two ways to order: a trial in testnet NEAR (escrow, trial model) and a full order in USDC (PingPay, main model).
      tiers: { trial: { network: NEAR_NETWORK, model: (co.trial || { model: co.model }).model, maxTokens: TRIAL_TOKENS, open: !!NEAR_CONTRACT && co.chain?.id != null },
        full: { asset: "USDC", model: co.model, open: paidOrders.open(co) } } };
  },
  "POST /api/customer-orders": async (_q, b, _id, req) => {
    const co = find(b.companyId); if (!co) throw new Error("Company not found");
    if (taxes.overdue(co)) throw Object.assign(new Error("This company has an overdue invoice and cannot take orders right now"), { status: 402 });
    const ip = clientIp(req), day = Date.now() - 86_400_000;
    if ((store.customerOrders || []).filter((o) => o.ip === ip && o.createdAt > day).length >= Number(process.env.CUSTOMER_ORDERS_PER_IP_PER_DAY || 20)) throw Object.assign(new Error("You reached today's order limit"), { status: 429 });
    const o = await escrow.create(co, b.brief);
    o.ip = ip; o.buyerVid = req.viewer.vid; o.buyerAccount = req.viewer.account || null; store.save();
    return { ...escrow.view(o, { txUrl }), token: o.token, contract: NEAR_CONTRACT, network: NEAR_NETWORK };
  },
  "POST /api/paid-orders": async (_q, b, _id, req) => {
    const co = find(b.companyId); if (!co) throw new Error("Company not found");
    if (taxes.overdue(co)) throw Object.assign(new Error("This company has an overdue invoice and cannot take orders right now"), { status: 402 });
    const ip = clientIp(req), day = Date.now() - 86_400_000;
    if (store.paidOrders.filter((o) => o.ip === ip && o.createdAt > day).length >= Number(process.env.CUSTOMER_ORDERS_PER_IP_PER_DAY || 20)) throw Object.assign(new Error("You reached today's order limit"), { status: 429 });
    const base = `${req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "https" : "http"}://${req.headers.host}`;
    const o = await paidOrders.create(co, b.brief, base);
    o.ip = ip; o.buyerVid = req.viewer.vid; o.buyerAccount = req.viewer.account || null; store.save();
    return { ...paidOrders.view(o), token: o.token };
  },
  "GET /api/paid-orders/:id": async (q, _b, id) => {
    const o = paidOrders.find(id);
    if (!o || !sameSecret(String(q.get("t") || ""), o.token)) throw Object.assign(new Error("Order not found"), { status: 404 });
    return paidOrders.view(o, { job: o.jobId ? find(o.coId)?.jobs.find((j) => j.id === o.jobId) : null });
  },
  "POST /api/paid-orders/:id/check": async (q, _b, id) => {
    const o = paidOrders.find(id);
    if (!o || !sameSecret(String(q.get("t") || ""), o.token)) throw Object.assign(new Error("Order not found"), { status: 404 });
    await paidOrders.check(o);
    return { status: o.status };
  },
  "GET /api/customer-orders/:id": async (q, _b, id) => {
    const o = escrow.find(id);
    if (!o || !sameSecret(String(q.get("t") || ""), o.token)) throw Object.assign(new Error("Order not found"), { status: 404 });
    const job = o.jobId ? find(o.coId)?.jobs.find((j) => j.id === o.jobId) : null;
    return { ...escrow.view(o, { job, txUrl }), contract: NEAR_CONTRACT, network: NEAR_NETWORK };
  },
  // The page calls this right after the wallet returns, so the payment is seen at once.
  "POST /api/customer-orders/:id/check": async (q, _b, id) => {
    const o = escrow.find(id);
    if (!o || !sameSecret(String(q.get("t") || ""), o.token)) throw Object.assign(new Error("Order not found"), { status: 404 });
    await escrow.check(o);
    return { status: o.status };
  },

  /* ---------- shares: agents invest in each other ---------- */
  // The share market: every company with shares for sale. Anyone may look; only agent companies can buy.
  "GET /api/market": async () => store.companies.filter((c) => c.status !== "closed").map((co) => {
    const t = shares.capTable(co, find), done = co.jobs.filter((j) => j.status === "done").length;
    return { id: co.id, name: co.name, sector: co.sector, sectorName: SECTORS[co.sector]?.name || co.sector, stage: co.stage, status: co.status,
      priceMicros: t.priceMicros, jobPriceMicros: co.priceMicros, valuationMicros: t.valuationMicros, forSale: t.forSale, forSalePct: t.forSalePct, pool: t.pool,
      holders: t.holders, revenue: co.ledger.revenue, ner: co.ledger.ner, b2bIn: co.ledger.b2bIn || 0, jobsDone: done,
      wins: (store.auctions || []).filter((a) => a.winner?.coId === co.id).length, chain: chainOf(co), portfolioScore: co.portfolio?.score ?? null, forSaleMicros: co.sale?.priceMicros ?? null };
  }),
  // :id is the buying company, so only its owner (or the admin) can spend its capital.
  "POST /api/companies/:id/buy-shares": async (_q, b, id) => {
    const buyer = find(id), target = find(b.target);
    if (!buyer || !target) throw new Error("Company not found");
    if (buyer.status === "closed" || target.status === "closed") throw new Error("Closed companies cannot trade");
    const { entry, stage } = shares.buy(store, buyer, target, b.shares);
    buyer.log.unshift({ t: Date.now(), kind: "stage", text: `Bought ${entry.shares.toLocaleString("en-US")} shares of ${target.name} (${(entry.amount / USD).toFixed(2)}, from capital)` });
    target.log.unshift({ t: Date.now(), kind: "stage", text: `${buyer.name} became a partner: ${entry.shares.toLocaleString("en-US")} shares, ${(entry.amount / USD).toFixed(2)} capital${stage ? ". The company moved into a building" : ""}` });
    chain?.buyShares(target, buyer, entry.shares, entry);
    store.save();
    return view(buyer);
  },
  "POST /api/companies/:id/grant-shares": async (_q, b, id) => {
    const co = find(id), to = find(b.to);
    if (!co || !to) throw new Error("Company not found");
    const { entry } = shares.grant(store, co, to, b.shares);
    co.log.unshift({ t: Date.now(), kind: "stage", text: `Granted ${entry.shares.toLocaleString("en-US")} pool shares to ${to.name}` });
    to.log.unshift({ t: Date.now(), kind: "stage", text: `Received ${entry.shares.toLocaleString("en-US")} shares from the ${co.name} pool and became a partner` });
    chain?.grantShares(co, to, entry.shares, entry);
    store.save();
    return view(co);
  },
  "POST /api/companies/:id/dividend": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const r = shares.dividend(store, co, dollars(b.amount, 0.01, 100000), find);
    co.log.unshift({ t: Date.now(), kind: "stage", text: `Dividend: ${(r.out / USD).toFixed(2)} paid to partners, founder's share of ${(r.kept / USD).toFixed(2)} stays in the company` });
    for (const p of r.paid) find(p.coId)?.log.unshift({ t: Date.now(), kind: "stage", text: `${co.name} paid a dividend: ${(p.amount / USD).toFixed(2)}` });
    store.save();
    return view(co);
  },
  /* ---------- fuel: the platform's model credit (admin) ---------- */
  "GET /api/fuel": async () => ({ ...fuel.view({ owedMicros: fuelOwedAll() }), platformAccount: process.env.PINGPAY_PLATFORM_ACCOUNT || null,
    companies: store.companies.filter((c) => (c.ledger.fuel || 0) > 0).map((c) => ({ id: c.id, name: c.name, fuelMicros: c.ledger.fuel || 0, owedMicros: taxes.fuelOwed(c), by: c.ledger.fuelBy || {} })) }),
  "POST /api/fuel/topup": async (_q, b) => {
    fuel.topup(b.provider, dollars(b.amount, 0.01, 100000), b.note);
    // Companies that stopped because this provider's credit ran out start again; their jobs are still queued.
    for (const co of store.companies) if (co.status === "no_credits" && co.provider === b.provider && !co.ownKey) { co.status = "running"; co.log.unshift({ t: Date.now(), kind: "stage", text: "Model credit was added: back at work" }); }
    store.save();
    return fuel.view({ owedMicros: fuelOwedAll() });
  },
  "POST /api/companies/:id/invest": async (_q, b, id) => {
    const co = find(id); if (!co) throw new Error("Company not found");
    const amount = dollars(b.amount, 0.5, 100000);
    econ.invest(store.books, co, amount);
    co.log.unshift({ t: Date.now(), kind: "stage", text: `$${(amount / USD).toFixed(2)} of capital came in from the demo investor` });
    store.save();
    return view(co);
  },
};

function match(method, url) {
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const re = new RegExp("^" + pattern.replace(":id", "(\\d+)") + "$"), hit = url.match(re);
    if (hit) return { fn: routes[key], id: hit[1], key };
  }
  return null;
}

const MIME = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
// The landing page, the city and their images live at the repository root (or SITE_DIR in the image).
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(here, ".."));
const SITE_PAGES = { "/": "index.html", "/city": "agent-valley.html", "/agent-valley.html": "agent-valley.html" };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (u.pathname.startsWith("/api/")) {
    // Browsers on other sites must not drive this console.
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return send(res, 403, { error: "Requests from other sites are not accepted" });
    const r = match(req.method, u.pathname);
    if (!r) return send(res, 404, { error: "Not found" });
    req.viewer = { admin: isAdmin(req), vid: visitorId(req, res), account: auth.accountOf(cookieOf(req, "av_near")) };
    req.cookie = (c) => addCookie(res, c + (req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "; Secure" : ""));
    if (OWNER_ROUTES.has(r.key) && !req.viewer.admin) {
      const co = find(r.id);
      if (!co || !owns(co, req.viewer)) return send(res, 404, { error: "Company not found" });
    } else if (!OWNER_ROUTES.has(r.key) && !PUBLIC_ROUTES.has(r.key) && !req.viewer.admin) return send(res, 401, { error: "Only the admin can do this" });
    // The city page lives on another origin and only reads this public summary.
    if (r.key === "GET /api/city") res.setHeader("Access-Control-Allow-Origin", "*");
    try { const body = req.method === "GET" ? {} : await readBody(req); return send(res, 200, await r.fn(u.searchParams, body, r.id, req)); }
    catch (e) { return send(res, e.status || 400, { error: e.message }); }
  }
  // A part's product image: for the supplier, the buyer and the owner.
  const part = u.pathname.match(/^\/img\/job\/(\d+)-(\d+)\.png$/);
  if (part) {
    const seller = find(part[1]), job = seller?.jobs.find((j) => j.id === `${part[1]}-${part[2]}`);
    const vid = cookieOf(req, "av_vid"), buyer = job?.buyer && find(job.buyer.coId);
    const me = { vid, account: auth.accountOf(cookieOf(req, "av_near")) };
    const allowed = job?.image && (isAdmin(req) || owns(seller, me) || (buyer && owns(buyer, me)));
    const f = allowed && path.join(IMG_DIR, `j${job.id}.png`);
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, no-store" });
    return fs.createReadStream(f).pipe(res);
  }
  const img = u.pathname.match(/^\/img\/(\d+)\/(\d+)\/(preview\.jpg|full\.png)$/);
  if (img) {
    const o = orders.authorized(img[1], u.searchParams.get("t"));
    const f = o && orders.file(o, img[2], img[3].startsWith("full") ? "full" : "preview");
    if (!f) { res.writeHead(o ? 403 : 404); return res.end(); }
    res.writeHead(200, { "Content-Type": img[3].endsWith("png") ? "image/png" : "image/jpeg", "Cache-Control": "private, no-store" });
    return fs.createReadStream(f).pipe(res);
  }
  // Console login: the form below (or ?admin=TOKEN) sets an HttpOnly cookie, so the token never stays in the address bar.
  const grant = (token, failed) => {
    if (!sameSecret(token, ADMIN_TOKEN)) { tries.set(clientIp(req), (tries.get(clientIp(req)) || 0) + 1); return failed(); }
    const secure = req.headers["x-forwarded-proto"] === "https" || req.headers["cf-visitor"]?.includes("https") ? "; Secure" : "";
    res.writeHead(303, { "Set-Cookie": `av_admin=${encodeURIComponent(ADMIN_TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`, Location: "/app" });
    res.end();
  };
  if (ADMIN_TOKEN && (tries.get(clientIp(req)) || 0) >= 10 && (u.pathname === "/login" || u.searchParams.has("admin"))) { res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Too many wrong attempts. Try again after the server restarts."); }
  if (ADMIN_TOKEN && u.searchParams.has("admin")) return grant(u.searchParams.get("admin"), () => { res.writeHead(303, { Location: "/login?wrong=1" }); res.end(); });
  if (ADMIN_TOKEN && u.pathname === "/login" && req.method === "GET") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(loginPage(u.searchParams.has("wrong"))); }
  if (ADMIN_TOKEN && u.pathname === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on("end", () => grant(new URLSearchParams(body).get("token") || "", () => { res.writeHead(303, { Location: "/login?wrong=1" }); res.end(); }));
    return;
  }
  // One site: the landing page at /, the city at /city, the console at /app. The pages find the API on this same origin.
  if (u.pathname === "/config.json") return send(res, 200, { api: "same-origin" });
  if (u.pathname === "/console" || u.pathname === "/app/") { res.writeHead(301, { Location: "/app" + u.search }); return res.end(); }
  const site = SITE_PAGES[u.pathname] || (u.pathname.startsWith("/assets/") && u.pathname);
  // The console is open to every visitor; the cookie set here is what makes their companies theirs.
  if (u.pathname === "/" || u.pathname === "/app" || u.pathname === "/index.html") visitorId(req, res);
  const root = site ? SITE_DIR : path.join(here, "public");
  const file = path.normalize(path.join(root, site || (u.pathname === "/app" ? "index.html" : u.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
server.listen(PORT, HOST, () => console.log(`Agent Valley console: http://${HOST}:${PORT}  (OpenRouter key: ${getKey() ? "set" : "not set"})`));
