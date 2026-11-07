// Company runtime: decides when each company may call its model, runs jobs, books the money.
import { SECTORS } from "./sectors.mjs";
import { USD, estimateJobMicros, tokensOf } from "./providers.mjs";
import * as econ from "./economy.mjs";

const HOUR = 3600_000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

export function createRuntime({ store, providers, now = () => Date.now(), log = () => {} }) {
  const busy = new Set();
  const cooldown = {}; // provider id -> time when calls may resume after a 429
  const freeCalls = []; // timestamps of free-model calls, for the 20 per minute ceiling

  const modelInfo = async (co) => (await providers[co.provider].models().catch(() => [])).find((m) => m.id === co.model);

  // Is the schedule open right now?
  function scheduleOpen(co, t) {
    const s = co.schedule;
    if (s.mode === "hours") { const h = new Date(t).getHours(); return s.startHour <= s.endHour ? h >= s.startHour && h < s.endHour : h >= s.startHour || h < s.endHour; }
    if (s.mode === "interval") return !co.lastRunAt || t - co.lastRunAt >= s.everyMin * 60_000;
    return true;
  }

  function note(co, text, kind = "info") {
    co.log.unshift({ t: now(), kind, text });
    co.log.length = Math.min(co.log.length, 80);
  }

  // Why a company cannot run its next job, or null when it can.
  async function blocker(co, t) {
    if (co.status !== "running") return co.status;
    const p = providers[co.provider];
    if (!p || !p.configured()) return "no_provider";
    if (cooldown[co.provider] > t) return "rate_limited";
    if (!scheduleOpen(co, t)) return "schedule";
    const recent = co.jobs.filter((j) => j.finishedAt && t - j.finishedAt < HOUR).length;
    if (recent >= co.limits.maxJobsPerHour) return "hourly_limit";
    const m = await modelInfo(co);
    const est = estimateJobMicros(m, tokensOf(co.rules?.text));
    const today = dayKey(t);
    if (co.spend.day !== today) co.spend = { day: today, ai: 0 };
    if (co.limits.dailyAiBudget && co.spend.ai + est > co.limits.dailyAiBudget) return "daily_budget";
    if (econ.balance(co.ledger) < est) return "broke";
    if (m && m.free && co.provider === "openrouter") {
      while (freeCalls.length && t - freeCalls[0] > 60_000) freeCalls.shift();
      if (freeCalls.length >= 18) return "rate_limited";
    }
    return null;
  }

  async function runJob(co, job) {
    const t = now();
    busy.add(co.id);
    job.status = "running"; job.startedAt = t;
    co.lastRunAt = t;
    const p = providers[co.provider], m = await modelInfo(co);
    if (m && m.free && co.provider === "openrouter") freeCalls.push(t);
    try {
      const sec = SECTORS[co.sector];
      job.rulesRev = co.rules?.rev || 0;
      const r = await p.chat({ model: co.model, system: systemPrompt(sec, co), user: job.brief, maxTokens: co.limits.maxTokens || 900 });
      const paid = econ.aiCost(store.books, co, r.costMicros);
      co.spend.ai += r.costMicros;
      job.output = r.text; job.costMicros = r.costMicros; job.tokens = r.tokens; job.model = r.model;
      job.status = "done"; job.finishedAt = now();
      if (paid < r.costMicros) note(co, "Model faturasının tamamını ödeyecek para kalmadı", "warn");
      // The customer pays the listed price on delivery. Revenue is simulated until payment rails are wired.
      econ.sale(store.books, co, job.priceMicros);
      const stage = econ.promote(co);
      note(co, `İş teslim edildi: gelir ${fmt(job.priceMicros)}, model maliyeti ${fmt(r.costMicros)}`);
      if (stage) note(co, stage === "market" ? "Ürün satıyor: merkez binasına geçti" : "Yatırım aldı: şirket binasına geçti", "stage");
      unitCheck(co);
    } catch (e) {
      job.status = "failed"; job.error = e.message; job.finishedAt = now();
      if (e.code === "rate_limited") { cooldown[co.provider] = now() + (e.retryAfter || 30) * 1000; job.status = "queued"; job.error = null; note(co, "Sağlayıcı hız sınırına takıldı, bekliyor", "warn"); }
      else if (e.code === "no_credits") { co.status = "no_credits"; job.status = "queued"; note(co, "OpenRouter kredisi bitti. Kredi yükleyince devam eder", "error"); }
      else if (e.code === "bad_key" || e.code === "no_key") { co.status = "no_provider"; job.status = "queued"; note(co, "OpenRouter anahtarı geçersiz ya da yok", "error"); }
      else note(co, "İş başarısız: " + e.message, "error");
    } finally {
      busy.delete(co.id);
      store.save();
    }
  }

  // After a few jobs, stop a company that loses money on every job.
  function unitCheck(co) {
    const done = co.jobs.filter((j) => j.status === "done");
    if (done.length < 3) return;
    const last = done.slice(0, 5);
    const avgCost = last.reduce((a, j) => a + j.costMicros, 0) / last.length;
    if (avgCost > co.priceMicros) {
      co.status = "unprofitable";
      note(co, `Zarar ediyor: iş başı maliyet ${fmt(avgCost)}, fiyat ${fmt(co.priceMicros)}. Fiyatı artır ya da daha ucuz model seç`, "error");
    }
  }

  function demoDemand(co, t) {
    if (!co.demo.on || co.status !== "running") return;
    if (co.demo.lastAt && t - co.demo.lastAt < co.demo.everyMin * 60_000) return;
    if (co.jobs.some((j) => j.status === "queued")) return;
    co.demo.lastAt = t;
    const list = SECTORS[co.sector].demo;
    enqueue(co, list[Math.floor(Math.random() * list.length)], "demo");
  }

  function enqueue(co, brief, source = "manual") {
    const job = { id: `${co.id}-${co.jobs.length + 1}`, brief: String(brief).slice(0, 4000), source, status: "queued", priceMicros: co.priceMicros, createdAt: now() };
    co.jobs.unshift(job);
    co.jobs.length = Math.min(co.jobs.length, 200);
    store.save();
    return job;
  }

  async function tick() {
    const t = now();
    for (const co of store.companies) {
      if (busy.has(co.id)) continue;
      demoDemand(co, t);
      const next = [...co.jobs].reverse().find((j) => j.status === "queued");
      if (!next) { co.waiting = null; continue; }
      const why = await blocker(co, t);
      co.waiting = why;
      if (!why) runJob(co, next);
    }
  }

  return { tick, enqueue, blocker, scheduleOpen, estimate: async (co) => estimateJobMicros(await modelInfo(co), tokensOf(co.rules?.text)) };
}

// The sector's job description, then the owner's rules file, which wins over the brief.
export function systemPrompt(sec, co) {
  const rules = co.rules?.text?.trim();
  if (!rules) return sec.system;
  return `${sec.system}\n\n# Company rules from the owner (version ${co.rules.rev})\nFollow these rules on every job. If the customer's brief conflicts with them, follow the rules and say which rule applied.\n\n${rules}`;
}

export const fmt = (m) => "$" + (m / USD).toFixed(m && Math.abs(m) < 10_000 ? 4 : 2);
