// The platform's fuel tank: the model credit it buys from providers (NEAR AI Cloud, OpenRouter) and lends to
// companies that run without a key of their own.
// - spent: every call made with the platform's key, counted at the provider, so job runs, cover orders and idea
//   reviews all show up, whoever asked for them
// - loaded: credit the owner put in by hand (neither provider offers an API to top up)
// - collected: fuel companies paid back on their invoices (taxes.mjs), money that reached the platform account
// The tank warns before it runs dry, so the owner knows when to top up and by how much.

export function createFuel({ store, warnMicros = 2_000_000, now = () => Date.now() }) {
  const tank = () => {
    if (!store.fuel) store.fuel = { spent: {}, loaded: {}, topups: [], collectedMicros: 0, collected: [] };
    return store.fuel;
  };

  // Wraps a provider so calls made with the platform's key (no key passed) are counted against the tank.
  function meter(id, provider) {
    const count = (r) => { if (r?.costMicros > 0) { const t = tank(); t.spent[id] = (t.spent[id] || 0) + r.costMicros; } return r; };
    const wrapped = Object.create(provider);
    if (provider.chat) wrapped.chat = async (a = {}) => { const r = await provider.chat(a); return a.key ? r : count(r); };
    if (provider.image) wrapped.image = async (a = {}) => { const r = await provider.image(a); return a.key ? r : count(r); };
    return wrapped;
  }

  return {
    meter,
    // The owner topped up a provider by hand (card or crypto on the provider's site).
    topup(provider, amountMicros, note = "") {
      if (!["nearai", "openrouter"].includes(provider)) throw new Error("Provider must be nearai or openrouter");
      if (!(amountMicros > 0)) throw new Error("Amount must be positive");
      const t = tank();
      t.loaded[provider] = (t.loaded[provider] || 0) + amountMicros;
      t.topups.unshift({ t: now(), provider, amountMicros, note: String(note).slice(0, 120) });
      t.topups.length = Math.min(t.topups.length, 50);
      store.save();
    },
    // A company paid fuel on its invoice.
    collect(co, micros) {
      const t = tank();
      t.collectedMicros += micros;
      t.collected.unshift({ t: now(), coId: co.id, name: co.name, micros });
      t.collected.length = Math.min(t.collected.length, 50);
    },
    view({ owedMicros = 0 } = {}) {
      const t = tank();
      const providers = Object.fromEntries(["nearai", "openrouter"].map((id) => {
        const loaded = t.loaded[id] || 0, spent = t.spent[id] || 0, remaining = loaded - spent;
        // No top-up recorded means the tank's level is unknown, not empty.
        const level = !loaded ? "unknown" : remaining <= 0 ? "empty" : remaining < warnMicros ? "low" : "ok";
        return [id, { loadedMicros: loaded, spentMicros: spent, remainingMicros: loaded ? remaining : null, level }];
      }));
      const spentAll = Object.values(t.spent).reduce((a, x) => a + x, 0);
      return {
        providers, warnMicros, spentMicros: spentAll, collectedMicros: t.collectedMicros, owedMicros,
        // What has been spent on the platform's key and not yet paid back by companies (idea reviews never are).
        uncoveredMicros: Math.max(0, spentAll - t.collectedMicros - owedMicros),
        topups: t.topups.slice(0, 10), collected: t.collected.slice(0, 10),
      };
    },
  };
}
