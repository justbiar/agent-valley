// NEAR AI Cloud provider against a local stand-in shaped after its OpenAPI spec: price list, key check,
// chat with token usage (no price in the response) and image generation. No network, no key, no spend.
// Run: node test/nearai.mjs
import http from "node:http";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createNearAI } from "../src/providers.mjs";

const KEY = "nearai-test-key-0123456789abcdef";
const usd = (dollarsPerUnit) => ({ amount: Math.round(dollarsPerUnit * 1e9), scale: 9, currency: "USD" });
const catalog = { models: [
  { modelId: "z-ai/glm-5.3-flash", inputCostPerToken: usd(0.08e-6), outputCostPerToken: usd(0.5e-6), costPerImage: usd(0), metadata: { verifiable: true, modelDisplayName: "GLM 5.3 Flash", contextLength: 200000 } },
  { modelId: "openai/gpt-5-nano", inputCostPerToken: usd(0.05e-6), outputCostPerToken: usd(0.4e-6), costPerImage: usd(0), metadata: { verifiable: false, modelDisplayName: "GPT-5 nano" } },
  { modelId: "Qwen/Qwen3-Embedding-0.6B", inputCostPerToken: usd(0.01e-6), outputCostPerToken: usd(0.01e-6), costPerImage: usd(0), metadata: { verifiable: true } },
  { modelId: "black-forest-labs/FLUX.2-klein-4B", inputCostPerToken: usd(1e-6), outputCostPerToken: usd(1e-6), costPerImage: usd(0.012), metadata: { verifiable: true, modelDisplayName: "FLUX.2 Klein" } },
] };
const png = await sharp({ create: { width: 1024, height: 576, channels: 3, background: "#ffb38a" } }).png().toBuffer();
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/v1/model/list")) return json(200, catalog);
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "Invalid API key" } });
    if (req.url === "/v1/check_api_key") return json(200, { valid: true });
    if (req.url === "/v1/chat/completions") return json(200, { id: "chat-1", model: JSON.parse(body).model, choices: [{ message: { role: "assistant", content: "merhaba" } }], usage: { prompt_tokens: 3000, completion_tokens: 700 } });
    if (req.url === "/v1/images/generations") return json(200, { created: 1, data: [{ b64_json: png.toString("base64") }] });
    json(404, {});
  });
}).listen(9931, "127.0.0.1");

const p = createNearAI({ getKey: () => KEY, baseUrl: "http://127.0.0.1:9931/v1" });
const results = [];
const test = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } };
try {
  await test("chat models exclude embeddings and image models, and mark TEE models", async () => {
    const m = await p.models();
    assert.deepEqual(m.map((x) => x.id), ["z-ai/glm-5.3-flash", "openai/gpt-5-nano"]);
    assert.equal(m[0].verifiable, true);
    assert.ok(Math.abs(m[0].promptPerM - 0.08) < 1e-9 && Math.abs(m[0].completionPerM - 0.5) < 1e-9);
  });
  await test("image models carry the per-image price", async () => {
    assert.deepEqual((await p.imageModels()).map((x) => [x.id, x.perImage]), [["black-forest-labs/FLUX.2-klein-4B", 0.012]]);
  });
  await test("chat cost is tokens times the listed price", async () => {
    const r = await p.chat({ model: "z-ai/glm-5.3-flash", system: "s", user: "u" });
    assert.equal(r.text, "merhaba");
    assert.equal(r.costMicros, 590); // 3000 x $0.08/M + 700 x $0.50/M = $0.00059
  });
  await test("image cost is the per-image price", async () => {
    const r = await p.image({ model: "black-forest-labs/FLUX.2-klein-4B", prompt: "kupa" });
    assert.equal(r.costMicros, 12_000);
    assert.equal((await sharp(r.buffer).metadata()).width, 1024);
  });
  await test("a company's own key is used, a bad one is refused", async () => {
    await p.status(KEY);
    await assert.rejects(() => p.status("wrong-key-0123456789abcdef"), (e) => e.code === "bad_key");
    await assert.rejects(() => createNearAI({ getKey: () => null, baseUrl: "http://127.0.0.1:9931/v1" }).chat({ model: "x", system: "", user: "" }), (e) => e.code === "no_key");
  });
} finally { server.close(); }

for (const [s, n] of results) console.log(s.padEnd(4), n);
const failed = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
