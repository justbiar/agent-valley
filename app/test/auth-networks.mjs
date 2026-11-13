// Sign-in with testnet and mainnet accounts: each challenge names its network, the account must match it, and the
// key is checked on that network's RPC. Run: node test/auth-networks.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createAuth, b58encode, nep413Hash } from "../src/auth.mjs";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = "ed25519:" + b58encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const asked = [];
// A chain that knows the key for founder.testnet on testnet and founder.near on mainnet, nothing else.
const fetchImpl = async (url, opt) => {
  const p = JSON.parse(opt.body).params, net = /mainnet/.test(url) ? "mainnet" : "testnet";
  asked.push(net);
  const ok = p.public_key === pub && ((net === "testnet" && p.account_id === "founder.testnet") || (net === "mainnet" && p.account_id === "founder.near"));
  return { json: async () => (ok ? { result: { nonce: 1, permission: "FullAccess" } } : { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } }) };
};
const auth = createAuth({ network: "testnet", networks: ["testnet", "mainnet"], secret: "s", fetchImpl });
const sign = (c, accountId) => ({ accountId, publicKey: pub, signature: crypto.sign(null, nep413Hash({ message: c.message, nonce: Buffer.from(c.nonce, "base64"), recipient: c.recipient }), privateKey).toString("base64") });

const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };

await test("both networks are offered, testnet by default", () => {
  assert.deepEqual(auth.networks, ["testnet", "mainnet"]);
  assert.equal(auth.challenge("v0").network, "testnet");
});
await test("a testnet challenge signs in a .testnet account, checked on testnet", async () => {
  asked.length = 0;
  const c = auth.challenge("v1", "testnet");
  assert.equal(await auth.verify("v1", sign(c, "founder.testnet")), "founder.testnet");
  assert.deepEqual([...new Set(asked)], ["testnet"]);
});
await test("a mainnet challenge signs in a .near account, checked on mainnet", async () => {
  asked.length = 0;
  const c = auth.challenge("v2", "mainnet");
  assert.equal(c.suffix, ".near");
  assert.equal(await auth.verify("v2", sign(c, "founder.near")), "founder.near");
  assert.deepEqual([...new Set(asked)], ["mainnet"]);
});
await test("an account from the other network is refused with the reason", async () => {
  const c = auth.challenge("v3", "testnet");
  await assert.rejects(auth.verify("v3", sign(c, "founder.near")), /NEAR testnet account/);
  const d = auth.challenge("v4", "mainnet");
  await assert.rejects(auth.verify("v4", sign(d, "founder.testnet")), /NEAR mainnet account/);
});
await test("a network the server does not offer falls back to the default", () => {
  const one = createAuth({ network: "testnet", secret: "s", fetchImpl });
  assert.equal(one.challenge("v5", "mainnet").network, "testnet");
});
await test("the session cookie names the account, whatever its network", async () => {
  assert.equal(auth.accountOf(auth.sessionCookie("founder.near")), "founder.near");
});

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
