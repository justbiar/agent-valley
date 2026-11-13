// Model providers. Every call returns { text, costMicros, tokens, model }.
// Money is integer micro-dollars (1 USD = 1_000_000) so the ledger never rounds.
export const USD = 1_000_000;

export class ProviderError extends Error {
  constructor(message, { status = 0, code = "error", retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Per-image price from a models listing when one is given, otherwise unknown (null).
const imagePrice = (m) => { const line = (m.pricing || []).find?.((p) => p.billable === "output_image" && p.unit === "image"); return line ? Number(line.cost_usd) : m.pricing?.image_output != null ? Number(m.pricing.image_output) : null; };
const isFree = (m) => m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);

export function createOpenRouter({ getKey, baseUrl = "https://openrouter.ai/api/v1", referer = "http://localhost" }) {
  let models = null, modelsAt = 0;
  // key: undefined uses the server's key; a string is a company's own key; null means the company's key is missing.
  const headers = (own) => {
    const key = own === undefined ? getKey() : own;
    if (!key) throw new ProviderError("No OpenRouter key", { code: "no_key" });
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": referer, "X-OpenRouter-Title": "Agent Valley" };
  };
  async function request(path, init = {}, own) {
    const res = await fetch(baseUrl + path, { ...init, headers: { ...headers(own), ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || res.statusText;
      const code = res.status === 401 ? "bad_key" : res.status === 402 ? "no_credits" : res.status === 429 ? "rate_limited" : "error";
      throw new ProviderError(msg, { status: res.status, code, retryAfter: Number(res.headers.get("retry-after")) || 0 });
    }
    return body;
  }
  return {
    id: "openrouter",
    label: "OpenRouter",
    hasKey: () => !!getKey(),
    configured: () => !!getKey(),
    async status(own) {
      const { data } = await request("/key", {}, own);
      return {
        ok: true,
        label: data.label,
        limitRemaining: data.limit_remaining,
        usage: data.usage,
        usageDaily: data.usage_daily,
        paidBefore: data.is_free_tier,
        freeDaily: data.free_model_daily_requests || null,
      };
    },
    async models() {
      if (models && Date.now() - modelsAt < 3600_000) return models;
      const res = await fetch(baseUrl + "/models");
      if (!res.ok) throw new ProviderError("Could not get the model list", { status: res.status });
      const { data } = await res.json();
      models = data.map((m) => ({
        id: m.id,
        name: m.name,
        free: isFree(m),
        promptPerM: Number(m.pricing?.prompt || 0) * 1e6,
        completionPerM: Number(m.pricing?.completion || 0) * 1e6,
        perRequest: Number(m.pricing?.request || 0),
        context: m.context_length,
      }));
      modelsAt = Date.now();
      return models;
    },
    async imageModels() {
      const res = await fetch(baseUrl + "/images/models").catch(() => null);
      if (!res || !res.ok) throw new ProviderError("Could not get the image model list", { status: res?.status || 0 });
      const { data = [] } = await res.json();
      return data.map((m) => ({ id: m.id, name: m.name || m.id, perImage: imagePrice(m) }));
    },
    // Dedicated Image API: POST /images returns data[].b64_json and usage.cost.
    async image({ model, prompt, aspect = "16:9", key }) {
      const body = await request("/images", { method: "POST", body: JSON.stringify({ model, prompt, aspect_ratio: aspect, output_format: "png", resolution: "1K", n: 1 }) }, key);
      const item = body.data?.[0];
      if (!item?.b64_json) throw new ProviderError("The model returned no image");
      return { buffer: Buffer.from(item.b64_json, "base64"), mime: item.media_type || "image/png", costMicros: Math.round(Number(body.usage?.cost || 0) * USD), model };
    },
    // plain: no reasoning setting at all (a second try, for models that answer empty when it is sent).
    async chat({ model, system, user, maxTokens = 900, key, plain = false }) {
      const req = { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: maxTokens, max_tokens: maxTokens };
      // Reasoning models would otherwise spend the whole token budget thinking and deliver nothing.
      if (!plain) req.reasoning = { effort: "low", exclude: true };
      const body = await request("/chat/completions", { method: "POST", body: JSON.stringify(req) }, key);
      const msg = body.choices?.[0]?.message || {};
      // Some models put the answer in content parts rather than a string.
      const text = Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("") : msg.content ?? "";
      const finish = body.choices?.[0]?.finish_reason || null;
      // Why an answer came back empty, for the company log: never the key, never the prompt.
      const why = !String(text).trim() ? { finish, completion: body.usage?.completion_tokens ?? null, reasoning: body.usage?.completion_tokens_details?.reasoning_tokens ?? null, thought: (msg.reasoning || "").length, upstream: body.provider || null, error: body.choices?.[0]?.error?.message || body.error?.message || null } : null;
      // usage.cost is always included and is charged in credits (1 credit = 1 USD).
      const cost = Number(body.usage?.cost || 0);
      return { text, empty: !String(text).trim(), why, cutOff: finish === "length", costMicros: Math.round(cost * USD), tokens: { prompt: body.usage?.prompt_tokens || 0, completion: body.usage?.completion_tokens || 0 }, model: body.model || model, generationId: body.id };
    },
  };
}

// NEAR AI Cloud: OpenAI-compatible gateway. Open models run in GPU TEEs and can be verified ("verifiable").
// Responses carry token usage but no price, so the cost is computed from the public price list.
export function createNearAI({ getKey, baseUrl = "https://cloud-api.near.ai/v1" }) {
  let catalog = null, catalogAt = 0;
  const NOT_CHAT = /embedding|reranker|whisper|privacy-filter/i;
  const price = (c) => (c ? c.amount / 10 ** c.scale : 0); // USD per token, or per image
  async function list() {
    if (catalog && Date.now() - catalogAt < 3600_000) return catalog;
    const res = await fetch(baseUrl + "/model/list?limit=200").catch(() => null);
    if (!res || !res.ok) throw new ProviderError("Could not get the NEAR AI model list", { status: res?.status || 0 });
    const body = await res.json();
    catalog = (body.models || body.data || body).map((m) => ({
      id: m.modelId, name: m.metadata?.modelDisplayName || m.modelId, verifiable: !!m.metadata?.verifiable, context: m.metadata?.contextLength || null,
      inTok: price(m.inputCostPerToken), outTok: price(m.outputCostPerToken), perImage: price(m.costPerImage),
    }));
    catalogAt = Date.now();
    return catalog;
  }
  async function request(path, body, own) {
    const key = own === undefined ? getKey() : own;
    if (!key) throw new ProviderError("No NEAR AI key", { code: "no_key" });
    const res = await fetch(baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = res.status === 401 ? "bad_key" : res.status === 402 ? "no_credits" : res.status === 429 ? "rate_limited" : "error";
      throw new ProviderError(out?.error?.message || out?.message || res.statusText, { status: res.status, code, retryAfter: Number(res.headers.get("retry-after")) || 0 });
    }
    return out;
  }
  return {
    id: "nearai",
    label: "NEAR AI Cloud",
    hasKey: () => !!getKey(),
    configured: () => !!getKey(),
    async status(own) { await request("/check_api_key", null, own); return { ok: true }; },
    async models() {
      return (await list()).filter((m) => !m.perImage && !NOT_CHAT.test(m.id)).map((m) => ({ id: m.id, name: m.name + (m.verifiable ? " · TEE" : ""), free: false, promptPerM: m.inTok * 1e6, completionPerM: m.outTok * 1e6, perRequest: 0, context: m.context, verifiable: m.verifiable }));
    },
    async imageModels() { return (await list()).filter((m) => m.perImage > 0).map((m) => ({ id: m.id, name: m.name + (m.verifiable ? " · TEE" : ""), perImage: m.perImage, verifiable: m.verifiable })); },
    async chat({ model, system, user, maxTokens = 900, key }) {
      // Low reasoning effort: a reasoning model (GLM and the like) otherwise uses the whole budget to think.
      const body = await request("/chat/completions", { model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, reasoning_effort: "low" }, key);
      const m = (await list()).find((x) => x.id === model) || { inTok: 0, outTok: 0 };
      const prompt = body.usage?.prompt_tokens || 0, completion = body.usage?.completion_tokens || 0;
      const text = body.choices?.[0]?.message?.content ?? "";
      return { text, empty: !String(text).trim(), cutOff: body.choices?.[0]?.finish_reason === "length", costMicros: Math.round((prompt * m.inTok + completion * m.outTok) * USD), tokens: { prompt, completion }, model: body.model || model, generationId: body.id };
    },
    async image({ model, prompt, key }) {
      const body = await request("/images/generations", { model, prompt, n: 1, size: "1024x576", response_format: "b64_json" }, key);
      const item = body.data?.[0];
      if (!item?.b64_json) throw new ProviderError("The model returned no image");
      const m = (await list()).find((x) => x.id === model);
      return { buffer: Buffer.from(item.b64_json, "base64"), mime: "image/png", costMicros: Math.round((m?.perImage || 0) * USD), model };
    },
  };
}

export function createOllama({ baseUrl = "http://127.0.0.1:11434" }) {
  return {
    id: "ollama",
    label: "Yerel model (Ollama)",
    configured: () => true,
    async status() {
      const res = await fetch(baseUrl + "/api/tags").catch(() => null);
      if (!res || !res.ok) return { ok: false, reason: "Ollama is not running" };
      const { models = [] } = await res.json();
      return { ok: true, models: models.length };
    },
    async models() {
      const res = await fetch(baseUrl + "/api/tags").catch(() => null);
      if (!res || !res.ok) return [];
      const { models = [] } = await res.json();
      return models.map((m) => ({ id: m.name, name: m.name, free: true, promptPerM: 0, completionPerM: 0, perRequest: 0, context: null, local: true }));
    },
    async chat({ model, system, user, maxTokens = 900 }) {
      const res = await fetch(baseUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, options: { num_predict: maxTokens }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      }).catch((e) => { throw new ProviderError("Could not reach Ollama: " + e.message, { code: "unreachable" }); });
      if (!res.ok) throw new ProviderError("Ollama hata verdi", { status: res.status });
      const body = await res.json();
      // Local inference has no per-call bill; the owner's hardware pays for it.
      return { text: body.message?.content || "", costMicros: 0, tokens: { prompt: body.prompt_eval_count || 0, completion: body.eval_count || 0 }, model };
    },
  };
}

// Deterministic stand-in so the app runs with no key, no network and no spend.
export function createMock() {
  const models = [
    { id: "mock/small", name: "Demo model (small)", free: false, promptPerM: 0.2, completionPerM: 0.8, perRequest: 0, context: 32000 },
    { id: "mock/large", name: "Demo model (large)", free: false, promptPerM: 3, completionPerM: 15, perRequest: 0, context: 128000 },
  ];
  return {
    id: "mock",
    label: "Demo model (no key)",
    configured: () => true,
    async status() { return { ok: true }; },
    async models() { return models; },
    async imageModels() { return [{ id: "mock/image", name: "Demo image model", perImage: 0.02 }]; },
    async image({ prompt }) {
      const { default: sharp } = await import("sharp");
      const title = String(prompt).slice(0, 60).replace(/[<&>"]/g, "");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1344" height="768"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#efe6ff"/><stop offset="1" stop-color="#ffd9d2"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="1000" cy="380" r="220" fill="#6a45ff" opacity=".25"/><text x="80" y="400" font-family="Helvetica" font-size="44" fill="#14161f">Demo kapak: ${title}</text></svg>`;
      return { buffer: await sharp(Buffer.from(svg)).png().toBuffer(), mime: "image/png", costMicros: 20_000, model: "mock/image" };
    },
    async chat({ model, system, user }) {
      const m = models.find((x) => x.id === model) || models[0];
      const prompt = Math.ceil((system.length + user.length) / 4), completion = 420;
      const text = `[Demo output, not a real model]\n\nJob: ${user}\n\nWhen ${model} is connected to a real provider, the delivery appears here.`;
      const costMicros = Math.round(((prompt * m.promptPerM + completion * m.completionPerM) / 1e6) * USD);
      return { text, costMicros, tokens: { prompt, completion }, model };
    },
  };
}

// Rough cost of one job, used before running it: about 600 input and 700 output tokens,
// plus the tokens of the company's rules, which ride along with every request.
export const tokensOf = (text) => Math.ceil(String(text || "").length / 4);
export function estimateJobMicros(model, extraPromptTokens = 0) {
  if (!model) return 0;
  return Math.round((((600 + extraPromptTokens) * model.promptPerM + 700 * model.completionPerM) / 1e6 + (model.perRequest || 0)) * USD);
}
