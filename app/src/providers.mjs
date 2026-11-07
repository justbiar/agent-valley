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

const isFree = (m) => m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);

export function createOpenRouter({ getKey, baseUrl = "https://openrouter.ai/api/v1", referer = "http://localhost" }) {
  let models = null, modelsAt = 0;
  const headers = () => {
    const key = getKey();
    if (!key) throw new ProviderError("OpenRouter anahtarı yok", { code: "no_key" });
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": referer, "X-OpenRouter-Title": "Agent Valley" };
  };
  async function request(path, init = {}) {
    const res = await fetch(baseUrl + path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
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
    configured: () => !!getKey(),
    async status() {
      const { data } = await request("/key");
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
      if (!res.ok) throw new ProviderError("Model listesi alınamadı", { status: res.status });
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
    async chat({ model, system, user, maxTokens = 900 }) {
      const body = await request("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: maxTokens }),
      });
      const text = body.choices?.[0]?.message?.content ?? "";
      // usage.cost is always included and is charged in credits (1 credit = 1 USD).
      const cost = Number(body.usage?.cost || 0);
      return { text, costMicros: Math.round(cost * USD), tokens: { prompt: body.usage?.prompt_tokens || 0, completion: body.usage?.completion_tokens || 0 }, model: body.model || model, generationId: body.id };
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
      if (!res || !res.ok) return { ok: false, reason: "Ollama çalışmıyor" };
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
      }).catch((e) => { throw new ProviderError("Ollama'ya ulaşılamadı: " + e.message, { code: "unreachable" }); });
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
    { id: "mock/small", name: "Demo model (küçük)", free: false, promptPerM: 0.2, completionPerM: 0.8, perRequest: 0, context: 32000 },
    { id: "mock/large", name: "Demo model (büyük)", free: false, promptPerM: 3, completionPerM: 15, perRequest: 0, context: 128000 },
  ];
  return {
    id: "mock",
    label: "Demo model (anahtarsız)",
    configured: () => true,
    async status() { return { ok: true }; },
    async models() { return models; },
    async chat({ model, system, user }) {
      const m = models.find((x) => x.id === model) || models[0];
      const prompt = Math.ceil((system.length + user.length) / 4), completion = 420;
      const text = `[Demo çıktı, gerçek model değil]\n\nİş: ${user}\n\nBu bölümde ${model} gerçek bir sağlayıcıya bağlandığında teslimat yer alacak.`;
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
