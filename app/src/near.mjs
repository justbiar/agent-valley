// NEAR mainnet lookups. Every company receives its customers' payments on its own NEAR account,
// so the account is checked on chain before the company opens: a typo would send money nowhere.
import { isNearAccount } from "./pingpay.mjs";

const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
const RPCS = list(process.env.NEAR_RPC_URL || "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org");
const TESTNET_RPCS = list(process.env.NEAR_TESTNET_RPC_URL || process.env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org");

// true: the account exists. false: the chain says it does not. null: no RPC answered.
export async function accountExists(id, network = "mainnet") {
  for (const url of network === "testnet" ? TESTNET_RPCS : RPCS) {
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
// A mainnet company is paid in USDC on mainnet, so it needs a mainnet account. A testnet company only takes trials
// in testnet NEAR, so its own .testnet account is fine too; each account is checked on its own network.
export async function checkPayoutAccount(raw, { verify = true, network = "mainnet" } = {}) {
  const id = String(raw || "").trim().toLowerCase();
  if (!id) throw new Error("Enter the company's NEAR account: customer payments go straight to it");
  const onTestnet = id.endsWith(".testnet");
  if (onTestnet && network !== "testnet") throw new Error("A mainnet company is paid on NEAR mainnet: use a .near account, not a .testnet one");
  if (!(onTestnet ? /^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$/.test(id) && id.length <= 64 : isNearAccount(id))) throw new Error("Enter a valid NEAR account (for example studio.near)");
  if (verify) {
    const net = onTestnet ? "testnet" : "mainnet";
    const ok = await accountExists(id, net);
    if (ok === false) throw new Error(`${id} was not found on NEAR ${net}. Check the account`);
    if (ok === null) throw Object.assign(new Error("Could not reach NEAR right now. Try again in a moment"), { status: 503 });
  }
  return id;
}
