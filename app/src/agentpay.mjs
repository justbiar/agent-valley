// Real money between companies: Ping Agent Pay (x402) on the seller's side, Agent Connect (MCP wallet) on the buyer's.
// Flow, after Ping's reference example (Pingpayio/ping-checkout-example, examples/agent-connect-pay):
//   1. seller key: POST /agentpay/x402/prepare -> a Base USDC deposit address (payTo) and the amount to deliver
//   2. buyer wallet: withdraw_preview, grossed up until the bridged amount_out covers it, then withdraw to payTo
//   3. poll get_operation until SUCCESS, take the Base tx hash
//   4. seller key: POST /agentpay/x402/verify and /settle with that tx -> Ping settles to the seller's NEAR account
// Ping never holds the funds. Payments are real (mainnet); AGENTPAY_BASE_URL can point at Ping staging.
import crypto from "node:crypto";

const X402 = { version: 2, scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
export const MIN_AMOUNT_MICROS = 200_000; // 0.2 USDC: Ping's 1Click minimum per payment
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // Intents USDC, source for withdraw to Base
const POLICY_BLOCKS = new Set(["frozen", "owner_approval_required", "timelock", "destination_not_allowed", "limit_exceeded", "schedule_blocked", "high_fee"]);

async function json(label, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body = text; try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) throw Object.assign(new Error(`${label}: HTTP ${res.status} ${typeof body === "string" ? body.slice(0, 200) : body.code || body.error || body.message || ""}`), { status: res.status, body });
  return body;
}

/* ---------- seller: Ping Agent Pay facilitator ---------- */
export function createAgentPay({ baseUrl = "https://pay.pingpay.io" } = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const post = (label, path, key, body) => json(label, base + path, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  const requirements = (p) => ({ scheme: X402.scheme, network: X402.network, asset: X402.asset, amount: p.amount, payTo: p.payTo, maxTimeoutSeconds: p.maxTimeoutSeconds, extra: {} });
  return {
    // A seller key works when Agent Pay is enabled and a NEAR recipient is saved on its Ping organization.
    async checkKey(key) { await post("Agent Pay", "/agentpay/x402/offers", key, { amountOut: String(MIN_AMOUNT_MICROS), description: "agent-valley/key-check" }); return true; },
    async prepare(key, { amountMicros, identity, description }) {
      const p = await post("Agent Pay prepare", "/agentpay/x402/prepare", key, { amountOut: String(amountMicros), challengeIdentity: identity, pricingMode: "fixed", description });
      if (!/^0x[0-9a-fA-F]{40}$/.test(p.payTo || "") || !p.amount) throw new Error("Agent Pay prepare: unexpected answer");
      if (p.network !== X402.network || String(p.asset).toLowerCase() !== X402.asset.toLowerCase()) throw new Error(`Agent Pay: unexpected network ${p.network}`);
      return p;
    },
    async settle(key, prepared, txHash) {
      const req = requirements(prepared), payload = { x402Version: X402.version, accepted: req, payload: { txHash } };
      const verify = await post("Agent Pay verify", "/agentpay/x402/verify", key, { x402Version: X402.version, paymentPayload: payload, paymentRequirements: req });
      const settle = await post("Agent Pay settle", "/agentpay/x402/settle", key, { x402Version: X402.version, paymentPayload: payload, paymentRequirements: req });
      return { verify, settle };
    },
  };
}

/* ---------- buyer: Agent Connect wallet over MCP (Streamable HTTP) ---------- */
export class AgentConnect {
  constructor(url, key) { this.url = url.replace(/\/$/, ""); this.key = key; this.session = null; this.id = 1; this.version = "2025-03-26"; }
  headers() {
    const h = { Authorization: `Bearer ${this.key}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": this.version };
    if (this.session) h["Mcp-Session-Id"] = this.session;
    return h;
  }
  async rpc(body) {
    const res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const s = res.headers.get("mcp-session-id"); if (s) this.session = s;
    if (res.status === 202) return { result: null };
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Agent Connect: HTTP ${res.status}`), { status: res.status });
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const line of text.split("\n")) if (line.startsWith("data:")) { try { return JSON.parse(line.slice(5).trim()); } catch { /* next line */ } }
      throw new Error("Agent Connect: empty SSE answer");
    }
    return JSON.parse(text);
  }
  async connect() {
    const init = await this.rpc({ jsonrpc: "2.0", id: this.id++, method: "initialize", params: { protocolVersion: this.version, capabilities: {}, clientInfo: { name: "agent-valley", version: "0.1.0" } } });
    if (init.error) throw new Error("Agent Connect: " + init.error.message);
    if (init.result?.protocolVersion) this.version = init.result.protocolVersion;
    await this.rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    return this;
  }
  async call(name, args = {}) {
    const r = await this.rpc({ jsonrpc: "2.0", id: this.id++, method: "tools/call", params: { name, arguments: args } });
    if (r.error) throw new Error(`Agent Connect ${name}: ${r.error.message}`);
    if (r.result?.isError) throw new Error(`Agent Connect ${name}: ${r.result.content?.map((c) => c.text).join(" ") || "hata"}`);
    const text = r.result?.content?.find((c) => c.type === "text")?.text;
    if (!text) return r.result;
    try { return JSON.parse(text); } catch { return text; }
  }
  async close() { if (!this.session) return; await fetch(this.url, { method: "DELETE", headers: this.headers() }).catch(() => {}); this.session = null; }
}

// Pays a prepared Agent Pay challenge from the buyer's wallet and returns the Base tx hash.
export async function payFromWallet(wallet, prepared, { account = "Checking", sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 3000 } = {}) {
  const need = BigInt(prepared.amount), base = { account, token: NEAR_USDC, chain: "base", to: prepared.payTo };
  let source = need, preview = null;
  for (let i = 0; i < 3; i++) {
    preview = await wallet.call("withdraw_preview", { ...base, amount: source.toString() });
    const blocks = (preview.warnings || []).filter((w) => POLICY_BLOCKS.has(w.code));
    if (blocks.length) throw new Error("A wallet rule blocks the payment: " + blocks.map((w) => w.code).join(", "));
    const out = BigInt(preview.quote?.amount_out || 0);
    if (out >= need) break;
    if (i === 2 || !out) throw new Error("Not enough left after the bridge fee");
    source = (source * need * 102n) / (out * 100n) + 1n; // proportional bump plus 2%, as in Ping's example
  }
  const sub = await wallet.call("withdraw", { ...base, amount: source.toString(), idempotency_key: `ping:${prepared.agentPayChallengeId}:${crypto.randomUUID()}` });
  if (!sub.operation_id) throw new Error("Agent Connect withdraw: no operation_id");
  const deadline = Date.now() + (prepared.maxTimeoutSeconds || 300) * 1000;
  while (Date.now() < deadline) {
    let op = await wallet.call("get_operation", { operation_id: sub.operation_id });
    let st = String(op.status || "").toUpperCase();
    if (st === "UNCERTAIN") { op = await wallet.call("refresh_operation", { operation_id: sub.operation_id }); st = String(op.status || "").toUpperCase(); }
    if (st === "SUCCESS") {
      const tx = op.details?.evidence?.destination_tx_hash || op.details?.destination_tx_hash;
      if (!/^0x[0-9a-fA-F]{64}$/.test(tx || "")) throw new Error("Agent Connect: no Base transaction hash");
      return { txHash: tx, sourceMicros: Number(source), operationId: sub.operation_id };
    }
    if (st === "FAILED" || st === "REFUNDED") throw new Error(`Agent Connect payment ${st}`);
    await sleep(pollMs);
  }
  throw new Error("Agent Connect payment timed out");
}
