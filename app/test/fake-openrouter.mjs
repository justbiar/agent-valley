// A local stand-in for the OpenRouter API, shaped after its documented responses.
// Model ids pick the behaviour: test/cheap works, test/pricey costs more than it earns,
// test/broke answers 402, test/limited answers 429 once.
import http from "node:http";

export function startFake(port, key) {
  const seen = [];
  let limitedOnce = false;
  const models = [
    { id: "test/cheap", name: "Test cheap", pricing: { prompt: "0.0000002", completion: "0.0000008", request: "0" }, context_length: 32000 },
    { id: "test/pricey", name: "Test pricey", pricing: { prompt: "0.00003", completion: "0.00006", request: "0" }, context_length: 32000 },
    { id: "test/broke", name: "Test broke", pricing: { prompt: "0.000001", completion: "0.000002", request: "0" }, context_length: 32000 },
    { id: "test/limited", name: "Test limited", pricing: { prompt: "0", completion: "0", request: "0" }, context_length: 32000 },
    { id: "test/free:free", name: "Test free", pricing: { prompt: "0", completion: "0", request: "0" }, context_length: 32000 },
  ];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/models") return json(200, { data: models });
      if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { code: 401, message: "No auth credentials found" } });
      if (req.url === "/api/v1/key") return json(200, { data: { label: "test", limit: 5, limit_remaining: 4.2, usage: 0.8, usage_daily: 0.1, is_free_tier: false, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } });
      if (req.url === "/api/v1/chat/completions" && req.method === "POST") {
        const b = JSON.parse(body);
        seen.push({ model: b.model, system: b.messages[0].content, user: b.messages[1].content, headers: { title: req.headers["x-openrouter-title"], referer: req.headers["http-referer"] }, maxTokens: b.max_completion_tokens });
        if (b.model === "test/broke") return json(402, { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } });
        if (b.model === "test/limited" && !limitedOnce) { limitedOnce = true; return json(429, { error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } } }, { "Retry-After": "1" }); }
        const cost = b.model === "test/pricey" ? 0.05 : b.model === "test/cheap" ? 0.0021 : 0;
        return json(200, { id: "gen-test-" + seen.length, object: "chat.completion", model: b.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Teslimat: ${b.messages[1].content}` } }], usage: { prompt_tokens: 120, completion_tokens: 300, total_tokens: 420, cost } });
      }
      json(404, { error: { code: 404, message: "Not found" } });
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, seen })));
}
