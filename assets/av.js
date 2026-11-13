/* Agent Valley site bar, shared by the landing page, the city and the console.
   The right end of the bar is the account: "Connect wallet" signs in with a NEAR account (NEP-413: the wallet signs a
   one-time message, nothing is sent to the chain, no password), then it shows the account like a profile, with a menu.
   Pages listen for the "av:account" event to redraw when the account changes. */
(function () {
  const WS = "10.1.4", WS_DEPS = "?deps=@near-js/transactions@2.5.1";
  // [package, setup function, gives testnet accounts]. On testnet the picker lists only wallets that can hand over a
  // .testnet account; the others only show on mainnet. Checked against the NEAR Connect manifest kept by the HOT team
  // (hot-dao/near-selector, repository/manifest.json): HOT declares no testnet, NEAR Mobile declares testnet: false.
  const WALLETS = [["my-near-wallet", "setupMyNearWallet", true], ["meteor-wallet", "setupMeteorWallet", true], ["intear-wallet", "setupIntearWallet", true], ["sender", "setupSender", true],
    ["here-wallet", "setupHereWallet", false], ["hot-wallet", "setupHotWallet", false], ["nightly", "setupNightly", true], ["okx-wallet", "setupOKXWallet", false], ["near-mobile-wallet", "setupNearMobileWallet", false]];
  const PENDING = "av-signin-pending";
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const t = (s) => (window.t ? window.t(s) : s);
  let base = null, status = null, selector = null, walletModal = null, BufferImpl = null;

  // Where the console lives: this origin when the console serves the page, else config.json's address.
  async function apiBase() {
    if (base !== null) return base;
    let a = new URLSearchParams(location.search).get("api") || "";
    if (!a) { try { const r = await fetch("/config.json", { cache: "no-store" }); if (r.ok) a = (await r.json()).api || ""; } catch {} }
    base = a === "same-origin" || !a ? location.origin : a.replace(/\/+$/, "");
    return base;
  }
  const sameOrigin = () => base === location.origin;
  async function api(path, body) {
    const r = await fetch((await apiBase()) + path, { method: body ? "POST" : "GET", credentials: "include", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || r.statusText);
    return d;
  }
  const here = () => location.origin + location.pathname;

  // Which NEAR network the visitor signs in with: their last choice, else the server's default. The wallet list
  // follows it (testnet shows only wallets that give .testnet accounts). The contract and payments do not change.
  const NET_KEY = "av-net", OPEN_KEY = "av-open-wallet";
  let selectorNet = null;
  const networks = () => status?.viewer?.signIn?.networks || [status?.viewer?.signIn?.network || "testnet"];
  function netOf() {
    try { const v = localStorage.getItem(NET_KEY); if (networks().includes(v)) return v; } catch {}
    return status?.viewer?.signIn?.network || "testnet";
  }
  const netName = (n) => (n === "mainnet" ? "Mainnet" : "Testnet");
  const accountNet = (a) => (/\.near$/.test(a) ? "mainnet" : "testnet");

  // NEAR Connect (@hot-labs/near-connect) behind the small part of the near-wallet-selector interface this file uses,
  // so sign-in, payments and share purchases work the same on both networks.
  async function nearConnect(network) {
    const { NearConnector } = await import("https://esm.sh/@hot-labs/near-connect@0.12.0");
    const nc = new NearConnector({ network, features: { signMessage: true }, footerBranding: null });
    let account = null;
    const subs = [], signedIn = [], hidden = [];
    const set = (a) => { account = a || null; subs.forEach((f) => f()); };
    try { const c = await nc.getConnectedWallet(); set(c?.accounts?.[0]?.accountId); } catch { /* nothing connected yet */ }
    nc.on("wallet:signIn", (e) => { set(e?.accounts?.[0]?.accountId); signedIn.forEach((f) => f()); });
    nc.on("wallet:signOut", () => set(null));
    const sel = {
      isSignedIn: () => !!account,
      on: (ev, f) => { if (ev === "signedIn") signedIn.push(f); },
      store: { getState: () => ({ accounts: account ? [{ accountId: account, active: true }] : [] }), observable: { subscribe: (f) => subs.push(f) } },
      // a plain wrapper: the wallet object keeps its own `this`
      wallet: async () => { const w = await nc.wallet(); return { signMessage: (p) => w.signMessage(p), signAndSendTransaction: (p) => w.signAndSendTransaction(p), signOut: () => nc.disconnect() }; },
    };
    const modal = {
      show: () => { nc.connect().catch(() => hidden.forEach((f) => f({ hideReason: "user-triggered" }))); },
      hide: () => {},
      on: (ev, f) => { if (ev === "onHide") hidden.push(f); },
    };
    return { sel, modal };
  }

  // Pages that take payments (orders, shares) use this same connection, so a wallet connected once in the bar is
  // ready everywhere on the site; `force` sets the network when a payment page loads it first.
  let waiters = [];
  async function loadSelector(force) {
    if (selector) return selector;
    const network = force || netOf(); selectorNet = network;
    if (!document.querySelector("link[data-ws]")) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.dataset.ws = "1";
      l.href = `https://cdn.jsdelivr.net/npm/@near-wallet-selector/modal-ui@${WS}/styles.css`; document.head.append(l);
    }
    // Some wallets (HOT, HERE) are written for Node and use a global Buffer, which browsers do not have:
    // provide one before any wallet code loads, or signing fails with "Buffer is not defined".
    const { Buffer } = await import("https://esm.sh/buffer@6.0.3");
    if (!globalThis.Buffer) globalThis.Buffer = Buffer;
    BufferImpl = Buffer;
    if (network === "mainnet") {
      // Mainnet runs on NEAR Connect, the connector the HOT team maintains: today's HOT extension only speaks to it.
      ({ sel: selector, modal: walletModal } = await nearConnect(network));
    } else {
      // Testnet keeps near-wallet-selector, where MyNearWallet, Meteor, Intear, Sender and Nightly give .testnet accounts.
      const list = WALLETS.filter((w) => w[2]);
      const [{ setupWalletSelector }, { setupModal }, ...mods] = await Promise.all([
        import(`https://esm.sh/@near-wallet-selector/core@${WS}${WS_DEPS}`),
        import(`https://esm.sh/@near-wallet-selector/modal-ui@${WS}${WS_DEPS}`),
        ...list.map(([pkg]) => import(`https://esm.sh/@near-wallet-selector/${pkg}@${WS}${pkg === "here-wallet" ? "" : WS_DEPS}`).catch(() => null)),
      ]);
      const modules = mods.map((m, i) => m?.[list[i][1]]).filter(Boolean).map((setup) => setup());
      selector = await setupWalletSelector({ network, modules });
      walletModal = setupModal(selector, { theme: "light", description: "Agent Valley runs on NEAR testnet: sign in with a .testnet account. The wallet only signs a sign-in message; no money moves." });
    }
    selector.on("signedIn", () => {
      walletModal.hide();
      const w = waiters; waiters = []; w.forEach((x) => x.ok());
      if (!status?.viewer?.account) signWithWallet(); // not signed in to the site yet: one sign-in message too
    });
    walletModal.on("onHide", ({ hideReason }) => {
      if (hideReason !== "user-triggered") return;
      try { localStorage.removeItem(PENDING); } catch {}
      const w = waiters; waiters = []; w.forEach((x) => x.no(new Error(t("Wallet connection cancelled"))));
    });
    selector.store.observable.subscribe(() => document.dispatchEvent(new CustomEvent("av:wallet", { detail: { account: walletAccount(selectorNet) } })));
    return selector;
  }
  // The wallet for a payment on `network`: the one already connected, or the picker once.
  async function walletFor(network) {
    if (selector && selectorNet !== network) throw new Error(t(`Your wallet is connected on ${selectorNet}, but this payment is on ${network}. Pick ${network} in the Connect wallet menu`));
    await loadSelector(network);
    if (!selector.isSignedIn()) { try { localStorage.setItem(PENDING, "1"); } catch {} await new Promise((ok, no) => { waiters.push({ ok, no }); walletModal.show(); }); }
    return selector.wallet();
  }
  function walletAccount(network) {
    if (!selector || (network && selectorNet !== network)) return null;
    return selector.store.getState().accounts.find((a) => a.active)?.accountId || null;
  }
  // Loads the connection quietly, so a page can show the connected account without opening anything.
  // It never sets the network on its own: the visitor's sign-in choice (testnet or mainnet) wins, and a payment page
  // on the other network connects only when the visitor pays.
  async function restoreWallet(network) {
    if (selector ? selectorNet !== network : netOf() !== network) return null;
    await loadSelector(network).catch(() => null); return walletAccount(network);
  }
  async function disconnectWallet() { if (!selector) return; try { await (await selector.wallet()).signOut(); } catch {} }

  // signIn("mainnet") or signIn("testnet") picks the network; with no argument it keeps the current one.
  async function signIn(chosen) {
    if (typeof chosen === "string" && networks().includes(chosen)) {
      try { localStorage.setItem(NET_KEY, chosen); } catch {}
      // The wallet libraries are set up for one network per page: switch by reloading, then open the picker again.
      if (selector && selectorNet !== chosen) { try { sessionStorage.setItem(OPEN_KEY, "1"); } catch {} location.reload(); return; }
    }
    const btn = document.querySelector("[data-av-signin]");
    try {
      if (btn) { btn.disabled = true; btn.textContent = t("Opening wallets…"); }
      await loadSelector();
      if (selector.isSignedIn()) return await signWithWallet();
      try { localStorage.setItem(PENDING, "1"); } catch {} // a redirect wallet comes back to a fresh page
      walletModal.show();
    } catch (e) { alert(t("Could not open the wallet picker: ") + e.message); }
    finally { const slot = document.querySelector(".avbar-account"); if (slot) slot.dataset.html = ""; render(); }
  }
  async function signWithWallet() {
    try { localStorage.removeItem(PENDING); } catch {}
    try {
      const wallet = await selector.wallet();
      if (!wallet.signMessage) throw new Error(t("This wallet cannot sign a message. Pick another one"));
      const c = await api("/api/auth/challenge", { network: selectorNet || netOf() });
      const signed = await wallet.signMessage({ message: c.message, nonce: BufferImpl.from(c.nonce, "base64"), recipient: c.recipient, callbackUrl: here() });
      if (!signed) return; // a redirect wallet: the answer comes back in the URL fragment
      await api("/api/auth/verify", { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, callbackUrl: here() });
      await refresh();
    } catch (e) { alert(e.message); }
  }
  async function signOut() {
    await api("/api/auth/logout", {}).catch(() => {});
    if (selector) { try { await (await selector.wallet()).signOut(); } catch {} }
    await refresh();
  }
  // Back from a redirect wallet: either its connect step (now sign) or the signature in the URL fragment.
  async function finish() {
    let pending = false; try { pending = localStorage.getItem(PENDING) === "1"; } catch {}
    if (pending && !/signature=/.test(location.hash)) {
      try { await loadSelector(); if (selector.isSignedIn()) await signWithWallet(); else localStorage.removeItem(PENDING); } catch {}
      return;
    }
    if (!/signature=/.test(location.hash)) return;
    const h = new URLSearchParams(location.hash.slice(1)), fix = (v) => (v || "").replace(/ /g, "+");
    history.replaceState(null, "", location.pathname + location.search);
    try { await api("/api/auth/verify", { accountId: h.get("accountId"), publicKey: h.get("publicKey"), signature: fix(h.get("signature")), callbackUrl: here() }); }
    catch (e) { alert(e.message); }
  }

  // The account button at the right end of the bar.
  function render() {
    const slot = document.querySelector(".avbar-account"); if (!slot) return;
    const acct = status?.viewer?.account || null, consoleUrl = (base || "") + "/app";
    let html;
    if (acct) {
      const short = acct.length > 22 ? acct.slice(0, 10) + "…" + acct.slice(-9) : acct;
      html = `<div class="avacct"><button type="button" class="avacct-btn" aria-haspopup="menu" aria-expanded="false" data-av-menu><span class="avacct-dot" aria-hidden="true">${esc(acct[0].toUpperCase())}</span><span class="avacct-name" translate="no">${esc(short)}</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="avacct-menu" role="menu" hidden><div class="avacct-head"><span>${esc(t("Signed in with NEAR"))} · ${esc(t(netName(accountNet(acct))))}</span><b translate="no">${esc(acct)}</b></div>
          <a role="menuitem" href="${esc(consoleUrl)}?mode=buyer">${esc(t("My orders"))}</a><a role="menuitem" href="${esc(consoleUrl)}?mode=seller">${esc(t("My companies"))}</a>
          <button role="menuitem" type="button" data-av-signout>${esc(t("Sign out"))}</button></div></div>`;
    } else if (status && sameOrigin() && networks().length > 1) {
      // Two networks: the button opens a small menu to pick one; the wallet list then matches it.
      const cur = netOf();
      const opt = (n, hint) => `<button role="menuitemradio" aria-checked="${n === cur}" type="button" data-av-net="${n}"><b>${esc(t(netName(n)))}</b><small>${esc(t(hint))}</small></button>`;
      html = `<div class="avacct"><button type="button" class="av-btn lime" aria-haspopup="menu" aria-expanded="false" data-av-menu data-av-signin>${esc(t("Connect wallet"))}<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
        <div class="avacct-menu" role="menu" hidden><div class="avacct-head"><span>${esc(t("Sign in with a NEAR account on"))}</span></div>
          ${opt("testnet", "A .testnet account: MyNearWallet, Meteor, Intear, Sender, Nightly")}${opt("mainnet", "A .near account: every wallet, HOT included")}</div></div>`;
    } else if (status && sameOrigin()) html = `<button type="button" class="av-btn lime" data-av-signin>${esc(t("Connect wallet"))}</button>`;
    else html = `<a class="av-btn lime" href="${esc(consoleUrl)}">${esc(t("Connect wallet"))}</a>`; // another origin: sign in on the console
    if (slot.dataset.html === html) return;
    slot.dataset.html = html; slot.innerHTML = html;
    const b = slot.querySelector("[data-av-signin]");
    // The wallet libraries are large: start loading them as soon as a pointer or a focus reaches the button.
    if (b) { if (!b.hasAttribute("data-av-menu")) b.onclick = () => signIn(); const warm = () => loadSelector().catch(() => {}); b.addEventListener("pointerenter", warm, { once: true }); b.addEventListener("focus", warm, { once: true }); }
    slot.querySelectorAll("[data-av-net]").forEach((x) => (x.onclick = () => signIn(x.dataset.avNet)));
    const o = slot.querySelector("[data-av-signout]"); if (o) o.onclick = signOut;
    const m = slot.querySelector("[data-av-menu]"), menu = slot.querySelector(".avacct-menu");
    if (m) m.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; m.setAttribute("aria-expanded", String(open)); };
  }
  document.addEventListener("click", () => { const menu = document.querySelector(".avacct-menu"); if (menu && !menu.hidden) { menu.hidden = true; document.querySelector("[data-av-menu]")?.setAttribute("aria-expanded", "false"); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelector(".avacct-menu")?.setAttribute("hidden", ""); });

  async function refresh() {
    const before = status?.viewer?.account || null;
    try { status = await api("/api/status"); } catch { status = null; }
    render();
    const now = status?.viewer?.account || null;
    if (now !== before) document.dispatchEvent(new CustomEvent("av:account", { detail: { account: now, status } }));
    return status;
  }

  window.AV = { refresh, signIn, signOut, apiBase, walletFor, walletAccount, restoreWallet, disconnectWallet, get status() { return status; } };
  const start = async () => {
    await apiBase(); if (sameOrigin()) await finish(); await refresh();
    // After a network switch the page reloads: open the wallet picker again for the new network.
    let reopen = false; try { reopen = sessionStorage.getItem(OPEN_KEY) === "1"; sessionStorage.removeItem(OPEN_KEY); } catch {}
    if (reopen && !status?.viewer?.account) signIn();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
