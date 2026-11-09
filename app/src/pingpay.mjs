// PingPay hosted checkout: the customer pays in any token PingPay supports, settled through NEAR Intents
// into USDC on NEAR at the recipient's account. The server creates the session with the exact price and later
// asks PingPay whether it completed, so a customer's own claim of payment is never trusted.
// Docs: https://pingpay.gitbook.io/docs/pingpay-api/hosted-checkout
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isNearAccount = (s) => NEAR_ACCOUNT.test(String(s || ""));

export function createPingPay({ apiKey, baseUrl = "https://pay.pingpay.io/api" }) {
  if (!apiKey) return null;
  async function call(method, path, body) {
    // The docs show both header names for the publishable key, so both are sent.
    const res = await fetch(baseUrl + path, { method, headers: { "Content-Type": "application/json", "x-api-key": apiKey, "x-publishable-key": apiKey }, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error("PingPay: " + (out.message || res.statusText)), { status: 502 });
    return out;
  }
  return {
    // amountMicros: USDC has 6 decimals, the same unit as the ledger's micro-dollars.
    async createSession({ amountMicros, recipient, successUrl, cancelUrl, metadata }) {
      if (!isNearAccount(recipient)) throw new Error("No NEAR account is set to receive payments");
      const out = await call("POST", "/checkout/sessions", {
        amount: String(amountMicros), asset: { chain: "NEAR", symbol: "USDC" }, recipient: { address: recipient },
        successUrl, cancelUrl, metadata, paymentMethods: ["wallet", "deposit"],
      });
      return { sessionId: out.session?.sessionId, url: out.sessionUrl, expiresAt: out.session?.expiresAt || null };
    },
    async getSession(id) {
      const out = await call("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
      return { status: out.session?.status, paymentId: out.session?.paymentId || null, amount: out.session?.amount || null };
    },
  };
}
