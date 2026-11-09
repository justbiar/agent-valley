// NEAR mainnet lookups. Every company receives its customers' payments on its own NEAR account,
// so the account is checked on chain before the company opens: a typo would send money nowhere.
import { isNearAccount } from "./pingpay.mjs";

const RPCS = (process.env.NEAR_RPC_URL || "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org").split(",").map((s) => s.trim()).filter(Boolean);

// true: the account exists. false: the chain says it does not. null: no RPC answered.
export async function accountExists(id) {
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "agent-valley", method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }),
      });
      const body = await res.json();
      if (body.result) return true;
      if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
    } catch { /* try the next RPC */ }
  }
  return null;
}

// Shape and chain checks for a company's payout account. PingPay settles on mainnet, so testnet names are refused.
export async function checkPayoutAccount(raw, { verify = true } = {}) {
  const id = String(raw || "").trim().toLowerCase();
  if (!id) throw new Error("Enter the company's NEAR account: customer payments go straight to it");
  if (id.endsWith(".testnet")) throw new Error("Payouts happen on NEAR mainnet, a .testnet account cannot be used");
  if (!isNearAccount(id)) throw new Error("Enter a valid NEAR account (for example studio.near)");
  if (verify) {
    const ok = await accountExists(id);
    if (ok === false) throw new Error(`${id} was not found on NEAR mainnet. Check the account`);
    if (ok === null) throw Object.assign(new Error("Could not reach NEAR right now. Try again in a moment"), { status: 503 });
  }
  return id;
}
