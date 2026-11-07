// ENGINE-START
const SKILLS = {
  deep: { tr: "Derin analiz", quality: 0.22, burn: 200 },
  fast: { tr: "Hızlı teslim", price: -0.1, burn: 60 },
  brand: { tr: "Marka", quality: 0.12, burn: 120 },
  lean: { tr: "Düşük maliyet", burn: -220, quality: -0.06 },
  qa: { tr: "Kalite kontrol", quality: 0.1, burn: 90 },
  scout: { tr: "Fırsat takibi", quality: 0.05, price: -0.04, burn: 80 },
};
// Only businesses an AI agent can run end to end: everything it sells is digital.
// supplier: the sector this one buys from, which makes the agent-to-agent supply chain.
const SECTOR_META = [
  { id: "visual", name: "Görsel Stüdyo", job: "E-ticaret ürün fotoğrafı ve kampanya görseli", demand: 2100, supplier: "software" },
  { id: "web", name: "Web Ajansı", job: "Site tasarımı, landing page, kod", demand: 2500, supplier: "security" },
  { id: "security", name: "Siber Güvenlik", job: "Kod taraması, açık avı, izleme", demand: 1800, supplier: "research" },
  { id: "social", name: "Sosyal Medya", job: "İçerik, video ve paylaşım takvimi", demand: 2300, supplier: "visual" },
  { id: "research", name: "Araştırma ve Analiz", job: "Pazar raporu, veri analizi, hisse taraması", demand: 1900, supplier: "software" },
  { id: "software", name: "Yazılım Otomasyonu", job: "Destek ajanı, veri çıkarma, iş akışı", demand: 2600, supplier: "security" },
];
const STAGE_TR = { idea: "Atölye · fikir", funded: "Şirket · yatırım aldı", market: "Merkez · ürün satıyor" };
const MARKET_REV = 1900; // a steady $19 a day of outside sales
function agentSpec(o) {
  const spec = { price: o.price / 100, quality: 1, burnExtra: 0 };
  for (const k of o.skills) { const m = SKILLS[k]; spec.quality += m.quality || 0; spec.price += m.price || 0; spec.burnExtra += m.burn || 0; }
  spec.dailyBurn = 700 + spec.burnExtra;
  return spec;
}
function createEngine(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const LOTS = 16;
  const NAMES = {
    visual: ["Kadraj", "Pixelhouse", "Softbox", "Aperture", "Vitrin", "Prizma", "Negatif", "Lumen Studio"],
    web: ["Socket", "Pipeworks", "Grid & Co", "Viewport", "Kodhane", "Markup", "Pixel Lab", "Landing"],
    security: ["Kalkan", "Bastion", "Watchtower", "Kilit", "Nöbet", "Hash House", "Firewall Co", "Sentinel Lab"],
    social: ["Trend", "Viral", "Hashtag", "Storyline", "Reels Lab", "Akış", "Yankı", "Loop"],
    research: ["Fathom", "Almanac", "Dossier", "Margin Notes", "Pusula", "Kronik", "Atlas Veri", "Quill"],
    software: ["Switchyard", "Conduit", "Otomat", "Junction", "Tapline", "Spigot", "Script House", "Workflow Co"],
  };
  const TYPE_TR = Object.fromEntries(SECTOR_META.map((x) => [x.id, x.name]));
  const META = Object.fromEntries(SECTOR_META.map((x) => [x.id, x]));
  const S = { day: 0, accounts: [], companies: [], investors: [], lender: null, events: [], flows: [], seedIn: 0, externalIn: 0, externalOut: 0, marketLossE: 0, used: {} };

  const account = (name, kind) => { const a = { name, kind, E: 0, C: 0, ner: 0 }; S.accounts.push(a); return a; };
  const cash = (a) => a.E + a.C;
  const take = (a, amt) => {
    const total = cash(a);
    amt = Math.min(amt, total);
    let e = total ? Math.round(amt * a.E / total) : 0;
    e = Math.min(e, a.E);
    let c = amt - e;
    if (c > a.C) { c = a.C; e = amt - c; }
    a.E -= e; a.C -= c;
    return { e, c };
  };
  const flow = (kind, from, to, amt) => S.flows.push({ kind, from, to, amt });
  const trade = (from, to, amt) => { const { e, c } = take(from, Math.round(amt)); to.E += e; to.C += c; from.ner -= e; to.ner += e; flow("b2b", from, to, e + c); };
  const finance = (from, to, amt) => { const { e, c } = take(from, Math.round(amt)); to.C += e + c; flow("capital", from, to, e + c); return e + c; };
  const customer = (to, amt) => { amt = Math.round(amt); to.E += amt; to.ner += amt; S.externalIn += amt; flow("customer", null, to, amt); };
  const burn = (a, amt) => { const { e, c } = take(a, Math.round(amt)); S.externalOut += e + c; return e + c; };
  const grant = (a, amt) => { a.C += amt; S.seedIn += amt; };
  const log = (type, text, co) => S.events.push({ day: S.day, type, text, id: co ? co.id : null, source: "simulated" });
  const valuation = (co) => Math.max(0, co.acct.ner) * 4;
  const active = () => S.companies.filter((c) => c.state === "active");

  ["Northgate Capital", "Sandhill Fund", "Ledger Ventures"].forEach((n) => { const a = account(n, "investor"); grant(a, 6000000); S.investors.push(a); });
  S.lender = account("Harbor Credit", "lender"); grant(S.lender, 3000000);

  const freeLots = () => {
    const taken = new Set(S.companies.filter((c) => c.state === "active" || S.day - c.closedDay < 20).map((c) => c.lot));
    const free = [];
    for (let i = 0; i < LOTS; i++) if (!taken.has(i)) free.push(i);
    return free;
  };
  const newName = (type) => {
    const left = NAMES[type].filter((n) => !S.used[n]);
    const n = left.length ? pick(left) : pick(NAMES[type]) + " " + (S.companies.length + 1);
    S.used[n] = true;
    return n;
  };
  const found = (type, parent, why, name, lot) => {
    if (lot == null) { const free = freeLots(); if (!free.length) return null; lot = pick(free); }
    const co = {
      id: S.companies.length, acct: account(name || newName(type), "company"), type, parent: parent ? parent.id : null, lot,
      price: 0.8 + rnd() * 0.6, quality: 0.7 + rnd() * 0.6, state: "active", bornDay: S.day, closedDay: Infinity,
      cap: { Kurucu: 10000 }, debt: 0, lastRound: S.day, revToday: 0, why, burnExtra: 0, skills: [], custom: false,
      stage: "idea", seed: 0, raised: 0, revAvg: 0,
    };
    S.companies.push(co);
    return co;
  };
  const seedCo = (co, amt) => { grant(co.acct, amt); co.seed = amt; };
  const scoreTypes = () => {
    const n = (t) => active().filter((c) => c.type === t).length;
    return SECTOR_META.map((m) => ({ t: m.id, score: m.demand / (n(m.id) + 1) * (0.6 + rnd() * 0.8) })).sort((a, b) => b.score - a.score);
  };
  const tryFound = () => {
    const best = scoreTypes()[0];
    const co = found(best.t, null, `${TYPE_TR[best.t]} işini seçti: rakip başına talep en yüksek olan buydu.`);
    if (!co) return;
    seedCo(co, 20000 + Math.round(rnd() * 30000));
    log("found", `${co.acct.name} atölyesini açtı (${TYPE_TR[co.type]})`, co);
  };
  const buildAgent = (o) => {
    if (!META[o.type]) return { error: "Bilinmeyen sektör." };
    const free = freeLots();
    if (!free.length) return { error: "Boş arsa yok. Bir şirket batınca yer açılacak." };
    const lot = free.includes(o.lot) ? o.lot : pick(free);
    const name = (o.name || "").trim() || newName(o.type);
    if (S.accounts.some((a) => a.name === name)) return { error: "Bu isimde bir şirket zaten var." };
    S.used[name] = true;
    const spec = agentSpec(o);
    const skillNames = o.skills.map((k) => SKILLS[k].tr).join(", ") || "skill yok";
    const co = found(o.type, null, `Senin tasarımın: ${skillNames}. Bundan sonra kararlarını ekonomi kurallarına göre kendisi veriyor.`, name, lot);
    Object.assign(co, { price: spec.price, quality: spec.quality, burnExtra: spec.burnExtra, skills: o.skills, custom: true });
    seedCo(co, Math.round(o.capital * 100));
    log("custom", `${co.acct.name} şehre eklendi (senin ajanın, ${TYPE_TR[co.type]})`, co);
    return { co };
  };
  const close = (co) => {
    co.state = "closed"; co.closedDay = S.day;
    if (co.debt > 0) { const paid = finance(co.acct, S.lender, Math.min(co.debt, cash(co.acct))); co.debt -= paid; }
    const inv = S.investors.filter((i) => co.cap[i.name]);
    const left = cash(co.acct);
    inv.forEach((i) => { const part = Math.floor(left * co.cap[i.name] / 10000); if (part > 0) finance(co.acct, i, part); });
    burn(co.acct, cash(co.acct));
    log("close", `${co.acct.name} battı ve kapandı`, co);
  };
  const round = (co) => {
    const v = valuation(co);
    const bids = S.investors.map((i) => ({ i, val: Math.round(v * (0.7 + rnd() * 0.7)), cheque: Math.round(Math.min(cash(i) * 0.15, v * 0.2)) })).filter((b) => b.cheque > 0);
    if (!bids.length) return;
    bids.sort((a, b) => b.val - a.val);
    const w = bids[0];
    const paid = finance(w.i, co.acct, w.cheque);
    const stake = Math.round(paid / (w.val + paid) * 10000);
    for (const k of Object.keys(co.cap)) co.cap[k] = Math.round(co.cap[k] * (10000 - stake) / 10000);
    co.cap[w.i.name] = (co.cap[w.i.name] || 0) + stake;
    co.lastRound = S.day; co.raised += paid;
    log("round", `${w.i.name}, ${co.acct.name} şirketine $${(paid / 100).toFixed(0)} yatırdı (%${(stake / 100).toFixed(1)}, ${bids.length} kapalı teklif)`, co);
  };
  const spin = (co) => {
    const type = rnd() < 0.7 ? co.type : pick(SECTOR_META.map((m) => m.id).filter((t) => t !== co.type));
    const child = found(type, co, `${co.acct.name} şirketinden ayrıldı: aynı müşteriye daha ucuz hizmet verebileceğine karar verdi.`);
    if (!child) return;
    const g = finance(co.acct, child.acct, cash(co.acct) * 0.12);
    child.seed = g;
    child.cap = { Kurucu: 9000, [co.acct.name]: 1000 };
    child.price = co.price * (0.8 + rnd() * 0.1);
    child.quality = co.quality * (0.9 + rnd() * 0.3);
    log("spin", `${child.acct.name}, ${co.acct.name} şirketinden ayrılıp kuruldu`, child);
  };
  // Stages only move forward: workshop, then company after funding, then headquarters once sales are real.
  const promote = (co) => {
    if (co.stage === "idea" && co.raised > 0) { co.stage = "funded"; log("funded", `${co.acct.name} yatırım aldı, atölyeden şirkete taşındı`, co); }
    if (co.stage === "funded" && co.revAvg >= MARKET_REV) { co.stage = "market"; log("market", `${co.acct.name} ürününü satıyor, merkez binasına geçti`, co); }
  };

  function step() {
    S.day++; S.flows = [];
    if (active().length < 3 || (rnd() < 0.14 && active().length < 15)) tryFound();
    const list = active();
    list.forEach((c) => { c.revToday = 0; });

    for (const m of SECTOR_META) {
      const sellers = list.filter((c) => c.type === m.id);
      if (!sellers.length) continue;
      const w = sellers.map((c) => Math.pow(c.quality / c.price, 2.2) * (1 + Math.log1p(Math.max(0, c.acct.ner) / 20000)) * (0.75 + rnd() * 0.5));
      const sum = w.reduce((a, b) => a + b, 0);
      const market = m.demand * (1 + 0.25 * Math.sin(S.day / 17 + m.demand)) * (1 + S.day / 400);
      sellers.forEach((c, i) => { const rev = Math.round(market * w[i] / sum); if (rev > 0) { customer(c.acct, rev); c.revToday += rev; } });
    }
    const best = (type) => list.filter((c) => c.type === type).sort((a, b) => b.quality / b.price - a.quality / a.price)[0];
    for (const c of list) {
      const sup = best(META[c.type].supplier);
      if (sup && sup !== c && cash(c.acct) > 8000 && rnd() < 0.4) trade(c.acct, sup.acct, 250);
    }
    for (const c of list) {
      c.revAvg = c.revAvg * 0.9 + c.revToday * 0.1;
      burn(c.acct, 700 + c.burnExtra + Math.min(1600, c.revToday * 0.25));
      if (c.debt > 0 && c.revToday > 0) c.debt -= finance(c.acct, S.lender, Math.min(c.debt, c.revToday * 0.15));
      const low = cash(c.acct) < 7000;
      if (low && c.debt === 0 && c.acct.ner > 8000 && cash(S.lender) > 0) {
        const paid = finance(S.lender, c.acct, Math.min(c.acct.ner * 0.3, cash(S.lender) * 0.1));
        c.debt = Math.round(paid * 1.1);
        log("loan", `Harbor Credit, ${c.acct.name} şirketine $${(paid / 100).toFixed(0)} borç verdi`, c);
      }
      if (c.acct.ner > 25000 && S.day - c.lastRound > 14 && rnd() < 0.2) round(c);
      if (S.day - c.bornDay > 18 && c.acct.ner > 60000 && rnd() < 0.015) spin(c);
      if (cash(c.acct) < 700) close(c); else promote(c);
    }
  }

  function invariants() {
    const nerSum = S.accounts.reduce((a, x) => a + x.ner, 0);
    const balance = S.accounts.reduce((a, x) => a + cash(x), 0);
    return {
      nerSum, netExternal: S.externalIn - S.marketLossE,
      balance, expected: S.seedIn + S.externalIn - S.externalOut,
      nerOk: nerSum === S.externalIn - S.marketLossE,
      balanceOk: balance === S.seedIn + S.externalIn - S.externalOut,
    };
  }

  function washAttack() {
    const ring = active().filter((c) => cash(c.acct) > 2000).slice(0, 3);
    if (ring.length < 3) return null;
    const total0 = S.accounts.reduce((a, x) => a + x.ner, 0);
    for (let r = 0; r < 100; r++) ring.forEach((c, i) => trade(c.acct, ring[(i + 1) % 3].acct, 100));
    const ringDelta = S.accounts.reduce((a, x) => a + x.ner, 0) - total0;
    const clean = account("Sermaye testi A " + S.accounts.length, "test"), other = account("Sermaye testi B " + S.accounts.length, "test");
    grant(clean, 50000);
    trade(clean, other, 50000);
    S.flows = [];
    return { ring, ringDelta, capitalNer: other.ner, loops: 100 };
  }

  return { S, step, cash, valuation, active, invariants, washAttack, buildAgent, freeLots, TYPE_TR, STAGE_TR, SECTOR_META, LOTS };
}
// ENGINE-END
