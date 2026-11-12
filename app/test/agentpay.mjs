// Agent-to-agent payments on chain: the seller's Ping Agent Pay key and the buyer's Agent Connect wallet,
// against local stand-ins shaped after Ping's reference example. No network, no keys, no money.
// Run: node test/agentpay.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8939, PING = 9951, MCP = 9952, base = `http://127.0.0.1:${PORT}`;
const SELLER_KEY = "ping_live_seller_0123456789", BAD_KEY = "ping_live_misconfigured_0123", WALLET_KEY = "ac_wallet_key_0123456789";
const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "av-agentpay-")), "state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error("timed out"); };
const api = async (p, opt = {}) => { const res = await fetch(base + p, { method: opt.method || "GET", headers: { "Content-Type": "application/json" }, body: opt.body ? JSON.stringify(opt.body) : undefined }); return { status: res.status, data: await res.json().catch(() => ({})) }; };

// Ping Agent Pay facilitator stand-in.
const ping = { prepared: [], settled: [] };
const pingServer = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const key = req.headers["x-api-key"], b = body ? JSON.parse(body) : {};
    if (key === BAD_KEY) return json(400, { code: "agent_pay_misconfigured", error: "No NEAR recipient" });
    if (key !== SELLER_KEY) return json(401, { code: "UNAUTHENTICATED" });
    if (req.url === "/agentpay/x402/offers") return json(200, { x402Version: 2, accepts: [{ extra: { destination: "kadraj.near" } }] });
    if (req.url === "/agentpay/x402/prepare") {
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.refundAddress || "")) return json(400, { code: "refund_address_required" }); // as the real Ping does
      const id = "ch_" + (ping.prepared.length + 1);
      ping.prepared.push(b);
      return json(200, { payTo: "0x" + "ab".repeat(20), amount: b.amountOut, amountOut: b.amountOut, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", scheme: "exact", maxTimeoutSeconds: 60, agentPayChallengeId: id });
    }
    if (req.url === "/agentpay/x402/verify") return json(200, { isValid: true });
    if (req.url === "/agentpay/x402/settle") { ping.settled.push(b.paymentPayload.payload.txHash); return json(200, { success: true, transaction: "near-tx-1" }); }
    json(404, {});
  });
}).listen(PING, "127.0.0.1");

// Agent Connect MCP stand-in: bridged withdrawals lose 3%, operations finish on the second poll.
const wallet = { calls: [], failNext: false, ops: {} };
const mcpServer = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
    if (req.headers.authorization !== `Bearer ${WALLET_KEY}`) { res.writeHead(401); return res.end(); }
    const m = JSON.parse(body);
    const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
    if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26" });
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    const { name, arguments: a } = m.params;
    wallet.calls.push({ name, a });
    const text = (o) => reply({ content: [{ type: "text", text: JSON.stringify(o) }] });
    if (name === "get_accounts") return text({ accounts: [{ name: "Checking" }] });
    if (name === "withdraw_preview") return text({ quote: { amount_out: String(Math.floor(Number(a.amount) * 0.97)) }, warnings: [] });
    if (name === "withdraw") {
      if (wallet.failNext) { wallet.failNext = false; return reply({ isError: true, content: [{ type: "text", text: "insufficient balance" }] }); }
      const id = "op_" + (Object.keys(wallet.ops).length + 1); wallet.ops[id] = 0; return text({ operation_id: id, status: "PENDING" });
    }
    if (name === "get_operation") { const n = ++wallet.ops[a.operation_id]; return text(n < 2 ? { status: "PENDING" } : { status: "SUCCESS", details: { evidence: { destination_tx_hash: "0x" + "cd".repeat(32) } } }); }
    text({});
  });
}).listen(MCP, "127.0.0.1");

const app = spawn(process.execPath, [path.join(here, "..", "server.mjs")], {
  env: { ...process.env, PORT: String(PORT), OPENROUTER_API_KEY: "", OLLAMA_URL: "http://127.0.0.1:1", DATA_FILE: dataFile, TICK_MS: "150", AUCTION_WINDOW_MS: "600", NEAR_ACCOUNT_CHECK: "0",
    AGENTPAY_BASE_URL: `http://127.0.0.1:${PING}`, AGENTPAY_REFUND_ADDRESS: "0x" + "ef".repeat(20), AGENT_CONNECT_MCP_URL: `http://127.0.0.1:${MCP}/mcp` },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; app.stdout.on("data", (d) => (out += d)); app.stderr.on("data", (d) => (out += d));
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
const found = async (body) => { const r = await api("/api/companies", { method: "POST", body: { provider: "mock", model: "mock/small", seed: 5, payoutAccount: "kadraj-test.near", ...body } }); return r; };
const jobOf = async (coId, pred) => (await api(`/api/companies/${coId}/jobs`)).data.find(pred);

try {
  await until(async () => (await fetch(base + "/api/status").catch(() => null))?.ok);
  let ui, vis, web;

  await test("a Ping key without Agent Pay set up is refused with the reason", async () => {
    const r = await found({ name: "Yarım UI", sector: "design", price: 0.4, pingKey: BAD_KEY });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Agent Pay is not enabled|NEAR receiving/);
  });

  await test("a seller with Agent Pay, a buyer with a wallet, and a plain seller open", async () => {
    ui = (await found({ name: "Kalıp UI", sector: "design", price: 0.4, pingKey: SELLER_KEY })).data;
    vis = (await found({ name: "Vitrin Görsel", sector: "visual", price: 0.3 })).data;
    web = (await found({ name: "Sitehane", sector: "web", price: 2, agentConnectKey: WALLET_KEY })).data;
    assert.deepEqual([ui.agentPay.sell, ui.agentPay.sellLoaded, web.agentPay.buy, vis.agentPay.sell], [true, true, true, false]);
  });

  let job;
  await test("the UI part is paid on chain: prepared by the seller, withdrawn from the buyer's wallet, settled", async () => {
    job = (await api(`/api/companies/${web.id}/jobs`, { method: "POST", body: { brief: "Seramik kupa e-ticaret sitesi" } })).data;
    const uiJob = await until(() => jobOf(ui.id, (j) => j.source === "b2b" && j.b2bState === "paid"));
    assert.equal(ping.prepared[0].amountOut, "400000");
    assert.match(ping.prepared[0].challengeIdentity, /^agent-valley\/part\//);
    assert.equal(ping.prepared[0].refundAddress, "0x" + "ef".repeat(20), "a failed bridge refunds to the configured Base address");
    const w = wallet.calls.find((c) => c.name === "withdraw");
    assert.equal(w.a.chain, "base");
    assert.ok(Number(w.a.amount) * 0.97 >= 400000, "grossed up to cover the bridge: " + w.a.amount);
    assert.equal(ping.settled[0], "0x" + "cd".repeat(32));
    assert.equal(uiJob.b2bTx, "0x" + "cd".repeat(32));
  });

  await test("the visual part, without Agent Pay, is settled in the books; the site uses both", async () => {
    const done = await until(() => jobOf(web.id, (j) => j.id === job.id && j.status === "done"));
    assert.match(done.output, /Kalıp UI/);
    const city = (await api("/api/city")).data;
    assert.equal(city.trades.length, 2);
    assert.equal(city.trades.find((t) => t.to === ui.id).onchain, "0x" + "cd".repeat(32));
    assert.equal(city.trades.find((t) => t.to === vis.id).onchain, null);
    const st = (await api("/api/status")).data;
    assert.ok(st.check.nerOk && st.check.balanceOk);
  });

  await test("a failed wallet payment leaves the part unpaid and unused", async () => {
    wallet.failNext = true;
    const j2 = (await api(`/api/companies/${web.id}/jobs`, { method: "POST", body: { brief: "İkinci site" } })).data;
    const failed = await until(() => jobOf(ui.id, (j) => j.source === "b2b" && j.b2bState === "failed"));
    assert.match(failed.payError, /insufficient balance/);
    const done = await until(() => jobOf(web.id, (j) => j.id === j2.id && j.status === "done"));
    assert.match(done.output, /on-chain payment failed/);
    const uiCo = (await api("/api/companies")).data.find((c) => c.id === ui.id);
    assert.equal(uiCo.ledger.b2bIn, 400_000, "only the first, paid part counts");
  });

  await test("Agent Pay keys never reach the state file", async () => {
    const disk = fs.readFileSync(dataFile, "utf8");
    assert.ok(!disk.includes(SELLER_KEY) && !disk.includes(WALLET_KEY));
  });
} finally {
  app.kill(); pingServer.close(); mcpServer.close();
}

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("\nserver output:\n" + out.slice(-2000)); process.exit(1); }
