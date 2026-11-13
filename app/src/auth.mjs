// Sign in with a NEAR account. No passwords and no accounts table: the wallet signs a one-time message (NEP-413),
// the server checks the signature and asks the chain whether that key really belongs to the account.
// A signed-in buyer or seller is then known by the account name in an HMAC-signed, HttpOnly cookie.
import crypto from "node:crypto";

const TAG = 2147484061; // 2^31 + 413, the NEP-413 prefix that keeps a signed message from ever being a valid transaction
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const NETWORKS = {
  testnet: { suffix: ".testnet", wallet: "https://testnet.mynearwallet.com", rpc: "https://rpc.testnet.fastnear.com,https://rpc.testnet.near.org" },
  mainnet: { suffix: ".near", wallet: "https://app.mynearwallet.com", rpc: "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org" },
};

export function b58decode(s) {
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) throw new Error("Not a base58 string"); n = n * 58n + BigInt(i); }
  let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
  const lead = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
}
export function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0")), out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b) break; out = "1" + out; }
  return out;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s) => { const b = Buffer.from(String(s), "utf8"); return Buffer.concat([u32(b.length), b]); };

// The exact bytes a NEP-413 wallet signs: sha256(borsh(tag) ++ borsh({ message, nonce, recipient, callbackUrl })).
export function nep413Hash({ message, nonce, recipient, callbackUrl = null }) {
  const cb = callbackUrl ? Buffer.concat([Buffer.from([1]), str(callbackUrl)]) : Buffer.from([0]);
  return crypto.createHash("sha256").update(Buffer.concat([u32(TAG), str(message), nonce, str(recipient), cb])).digest();
}
export function verifySignature({ publicKey, signature, hash }) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(publicKey || ""));
  if (!m) return false;
  const raw = b58decode(m[1]), sig = Buffer.from(String(signature || ""), "base64");
  if (raw.length !== 32 || sig.length !== 64) return false;
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  return crypto.verify(null, hash, key, sig);
}

// `network` is the default; `networks` lists every network a visitor may sign in with (each challenge names one).
// rpcUrls overrides the RPC of the default network only (tests use a local stand-in).
export function createAuth({ network = "testnet", networks = [network], recipient = "agent-valley", secret, rpcUrls, fetchImpl = fetch, now = () => Date.now(), challengeMs = 10 * 60_000, sessionMs = 30 * 86_400_000 } = {}) {
  if (!NETWORKS[network]) network = "testnet";
  networks = [...new Set([network, ...networks.filter((n) => NETWORKS[n])])];
  const net = NETWORKS[network];
  const rpcsOf = (n) => String((n === network && rpcUrls) || NETWORKS[n].rpc).split(",").map((s) => s.trim()).filter(Boolean);
  const key = crypto.createHash("sha256").update("agent-valley-session:" + (secret || crypto.randomBytes(32).toString("hex"))).digest();
  const pending = new Map(); // visitor id -> the one challenge that visitor may answer

  const validAccount = (id, n) => /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id) && (id.endsWith(NETWORKS[n].suffix) || /^[a-f0-9]{64}$/.test(id));

  function challenge(vid, wanted) {
    for (const [k, c] of pending) if (now() - c.t > challengeMs) pending.delete(k);
    const n = networks.includes(wanted) ? wanted : network;
    const nonce = crypto.randomBytes(32);
    const c = { nonce, network: n, message: `Sign in to Agent Valley as a buyer or seller. This signature moves no money.`, t: now() };
    pending.set(vid, c);
    return { message: c.message, nonce: nonce.toString("base64"), recipient, network: n, walletUrl: NETWORKS[n].wallet, suffix: NETWORKS[n].suffix };
  }

  // true: the key is a full-access key of the account. false: the chain says it is not. null: no RPC answered.
  async function keyBelongs(accountId, publicKey, n = network) {
    for (const url of rpcsOf(n)) {
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(6000),
          body: JSON.stringify({ jsonrpc: "2.0", id: "agent-valley", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }) });
        const body = await res.json();
        if (body.result && !body.result.error) return body.result.permission === "FullAccess";
        if (body.result?.error || body.error) return false;
      } catch { /* try the next RPC */ }
    }
    return null;
  }

  async function verify(vid, { accountId, publicKey, signature, callbackUrl } = {}) {
    const c = pending.get(vid);
    if (!c || now() - c.t > challengeMs) throw new Error("The sign-in request expired. Start again");
    const id = String(accountId || "").trim().toLowerCase();
    if (!validAccount(id, c.network)) throw new Error(`Sign in with a NEAR ${c.network} account (it ends with ${NETWORKS[c.network].suffix})`);
    const fits = [callbackUrl || null, null].some((cb) => verifySignature({ publicKey, signature, hash: nep413Hash({ message: c.message, nonce: c.nonce, recipient, callbackUrl: cb }) }));
    if (!fits) throw new Error("The signature does not match this sign-in request");
    pending.delete(vid); // one answer per challenge, right or wrong key
    const ok = await keyBelongs(id, publicKey, c.network);
    if (ok === null) throw Object.assign(new Error("Could not reach NEAR right now. Try again in a moment"), { status: 503 });
    if (!ok) throw new Error(`This key is not a full-access key of ${id}`);
    return id;
  }

  const mac = (body) => crypto.createHmac("sha256", key).update(body).digest("base64url");
  function sessionCookie(account) {
    const body = Buffer.from(JSON.stringify({ a: account, e: now() + sessionMs })).toString("base64url");
    return `${body}.${mac(body)}`;
  }
  function accountOf(cookie) {
    const [body, sig] = String(cookie || "").split(".");
    if (!body || !sig) return null;
    const want = mac(body);
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    try { const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return s.e > now() && typeof s.a === "string" ? s.a : null; } catch { return null; }
  }

  return { challenge, verify, sessionCookie, accountOf, keyBelongs, network, networks, sessionMs, wallet: net.wallet, suffix: net.suffix };
}
