/* Agent Valley site bar, shared by the landing page, the city and the console.
   The right end of the bar is the account: "Connect wallet" signs in with a NEAR account (NEP-413: the wallet signs a
   one-time message, nothing is sent to the chain, no password), then it shows the account like a profile, with a menu.
   Pages listen for the "av:account" event to redraw when the account changes. */
(function () {
  const WS = "10.1.4", WS_DEPS = "?deps=@near-js/transactions@2.5.1";
  const WALLETS = [["my-near-wallet", "setupMyNearWallet"], ["meteor-wallet", "setupMeteorWallet"], ["here-wallet", "setupHereWallet"], ["intear-wallet", "setupIntearWallet"],
    ["hot-wallet", "setupHotWallet"], ["sender", "setupSender"], ["nightly", "setupNightly"], ["okx-wallet", "setupOKXWallet"], ["near-mobile-wallet", "setupNearMobileWallet"]];
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

  async function loadSelector() {
    if (selector) return selector;
    const network = status?.viewer?.signIn?.network || "testnet";
    if (!document.querySelector("link[data-ws]")) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.dataset.ws = "1";
      l.href = `https://cdn.jsdelivr.net/npm/@near-wallet-selector/modal-ui@${WS}/styles.css`; document.head.append(l);
    }
    const [{ setupWalletSelector }, { setupModal }, { Buffer }, ...mods] = await Promise.all([
      import(`https://esm.sh/@near-wallet-selector/core@${WS}${WS_DEPS}`),
      import(`https://esm.sh/@near-wallet-selector/modal-ui@${WS}${WS_DEPS}`),
      import("https://esm.sh/buffer@6.0.3"),
      ...WALLETS.map(([pkg]) => import(`https://esm.sh/@near-wallet-selector/${pkg}@${WS}${pkg === "here-wallet" ? "" : WS_DEPS}`).catch(() => null)),
    ]);
    BufferImpl = Buffer;
    const modules = mods.map((m, i) => m?.[WALLETS[i][1]]).filter(Boolean).map((setup) => setup());
    selector = await setupWalletSelector({ network, modules });
    walletModal = setupModal(selector, { theme: "light", description: "Pick your NEAR wallet. It only signs a sign-in message; no money moves." });
    selector.on("signedIn", () => { walletModal.hide(); signWithWallet(); });
    walletModal.on("onHide", ({ hideReason }) => { if (hideReason === "user-triggered") try { localStorage.removeItem(PENDING); } catch {} });
    return selector;
  }

  async function signIn() {
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
      const c = await api("/api/auth/challenge", {});
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
        <div class="avacct-menu" role="menu" hidden><div class="avacct-head"><span>${esc(t("Signed in with NEAR"))}</span><b translate="no">${esc(acct)}</b></div>
          <a role="menuitem" href="${esc(consoleUrl)}?mode=buyer">${esc(t("My orders"))}</a><a role="menuitem" href="${esc(consoleUrl)}?mode=seller">${esc(t("My companies"))}</a>
          <button role="menuitem" type="button" data-av-signout>${esc(t("Sign out"))}</button></div></div>`;
    } else if (status && sameOrigin()) html = `<button type="button" class="av-btn lime" data-av-signin>${esc(t("Connect wallet"))}</button>`;
    else html = `<a class="av-btn lime" href="${esc(consoleUrl)}">${esc(t("Connect wallet"))}</a>`; // another origin: sign in on the console
    if (slot.dataset.html === html) return;
    slot.dataset.html = html; slot.innerHTML = html;
    const b = slot.querySelector("[data-av-signin]");
    // The wallet libraries are large: start loading them as soon as a pointer or a focus reaches the button.
    if (b) { b.onclick = signIn; const warm = () => loadSelector().catch(() => {}); b.addEventListener("pointerenter", warm, { once: true }); b.addEventListener("focus", warm, { once: true }); }
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

  window.AV = { refresh, signIn, signOut, apiBase, get status() { return status; } };
  const start = async () => { await apiBase(); if (sameOrigin()) await finish(); await refresh(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
