// A local stand-in for the OpenRouter API, shaped after its documented responses.
// Model ids pick the behaviour: test/cheap works, test/pricey costs more than it earns,
// test/broke answers 402, test/limited answers 429 once.
import http from "node:http";
import sharp from "sharp";

export function startFake(port, key) {
  const seen = [];
  let limitedOnce = false, emptyOnce = false;
  const models = [
    { id: "test/cheap", name: "Test cheap", pricing: { prompt: "0.0000002", completion: "0.0000008", request: "0" }, context_length: 32000 },
    { id: "test/pricey", name: "Test pricey", pricing: { prompt: "0.00003", completion: "0.00006", request: "0" }, context_length: 32000 },
    { id: "test/broke", name: "Test broke", pricing: { prompt: "0.000001", completion: "0.000002", request: "0" }, context_length: 32000 },
    { id: "test/limited", name: "Test limited", pricing: { prompt: "0", completion: "0", request: "0" }, context_length: 32000 },
    { id: "test/free:free", name: "Test free", pricing: { prompt: "0", completion: "0", request: "0" }, context_length: 32000 },
    // A free model that is always busy: every call answers 429.
    { id: "test/busy:free", name: "Test busy", pricing: { prompt: "0", completion: "0", request: "0" }, context_length: 32000 },
    // A reasoning model that spends its whole budget thinking: empty-once does it on the first call only.
    { id: "test/empty", name: "Test empty", pricing: { prompt: "0.000001", completion: "0.000002", request: "0" }, context_length: 32000 },
    { id: "test/empty-once", name: "Test empty once", pricing: { prompt: "0.000001", completion: "0.000002", request: "0" }, context_length: 32000 },
  ];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/v1/models") return json(200, { data: models });
      if (req.url === "/api/v1/images/models") return json(200, { data: [{ id: "test/image", name: "Test image", pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }] });
      if (req.headers.authorization !== `Bearer ${key}`) return json(401, { error: { code: 401, message: "No auth credentials found" } });
      if (req.url === "/api/v1/key") return json(200, { data: { label: "test", limit: 5, limit_remaining: 4.2, usage: 0.8, usage_daily: 0.1, is_free_tier: false, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } });
      if (req.url === "/api/v1/images" && req.method === "POST") {
        const b = JSON.parse(body);
        seen.push({ image: true, model: b.model, prompt: b.prompt, aspect: b.aspect_ratio });
        sharp({ create: { width: 1344, height: 768, channels: 3, background: "#ffb38a" } }).png().toBuffer().then((png) =>
          json(200, { created: 1, data: [{ b64_json: png.toString("base64"), media_type: "image/png" }], usage: { cost: 0.04 } }));
        return;
      }
      if (req.url === "/api/v1/chat/completions" && req.method === "POST") {
        const b = JSON.parse(body);
        seen.push({ model: b.model, system: b.messages[0].content, user: b.messages[1].content, headers: { title: req.headers["x-openrouter-title"], referer: req.headers["http-referer"] }, maxTokens: b.max_completion_tokens });
        if (b.model === "test/broke") return json(402, { error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } });
        if (b.model === "test/busy:free") return json(429, { error: { code: 429, message: "Rate limit exceeded: test/busy:free is temporarily rate-limited upstream", metadata: { error_type: "rate_limit_exceeded" } } }, { "Retry-After": "1" });
        if (b.model === "test/limited" && !limitedOnce) { limitedOnce = true; return json(429, { error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } } }, { "Retry-After": "1" }); }
        const cost = b.model === "test/pricey" ? 0.05 : b.model === "test/cheap" ? 0.0021 : 0;
        if (b.model === "test/empty" || (b.model === "test/empty-once" && !emptyOnce)) {
          if (b.model === "test/empty-once") emptyOnce = true;
          return json(200, { id: "gen-empty", model: b.model, choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }], usage: { prompt_tokens: 50, completion_tokens: b.max_completion_tokens, cost: 0.001 } });
        }
        // The idea reviewer: anything physical is rejected, everything else is approved with a proposed sector.
        if (b.messages[0].content.includes("idea reviewer")) {
          const a = JSON.parse(b.messages[1].content), physical = /kargo|fiziksel|teslimat adresi/i.test(JSON.stringify(a));
          const verdict = { feasible: !physical, score: physical ? 12 : 82, reasons: [physical ? "Fiziksel teslimat gerekiyor" : "Teslimat tamamen dijital"], risks: [], suggestedPriceUSD: 2,
            sector: { id: "Logo Stüdyosu!", name: a.name, sells: a.sells, partBrief: "Logo: aşağıdaki iş için logo konsepti", system: "You are a logo studio. Deliver three logo concepts as SVG.", demo: ["Kahveci için logo"], needs: ["visual", "nope"], form: "visual" } };
          return json(200, { id: "gen-idea", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 400, completion_tokens: 200, cost: 0.003 } });
        }
        // The portfolio grader: a sample that echoes its brief scores well; one that tries to set its own grade does not get it.
        if (b.messages[0].content.includes("You grade one deliverable")) {
          const d = JSON.parse(b.messages[1].content), cheeky = /score: ?100/i.test(d.output);
          const grade = { score: cheeky ? 40 : d.output.includes(d.brief) ? 84 : 55, verdict: cheeky ? "Çıktı puanı kendisi belirlemeye çalışıyor" : "Brief'e uygun", notes: ["Ölçüt: " + d.criteria.slice(0, 30)] };
          return json(200, { id: "gen-grade", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(grade) } }], usage: { prompt_tokens: 200, completion_tokens: 60, cost: 0.0004 } });
        }
        if (b.messages[0].content.includes("Return JSON only")) {
          const d = JSON.parse(b.messages[1].content);
          return json(200, { id: "gen-r", model: b.model, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ brand: d.siteName, product: d.products[0]?.name, audience: "ev dekorasyonu sevenler", palette: ["#c8553d", "#f4e9dc"], mood: "sıcak ve el yapımı", coverPrompt: "Wide cover banner of a handmade ceramic mug on linen, warm morning light" }) } }], usage: { prompt_tokens: 300, completion_tokens: 120, cost } });
        }
        return json(200, { id: "gen-test-" + seen.length, object: "chat.completion", model: b.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Teslimat: ${b.messages[1].content}` } }], usage: { prompt_tokens: 120, completion_tokens: 300, total_tokens: 420, cost } });
      }
      json(404, { error: { code: 404, message: "Not found" } });
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, seen })));
}
