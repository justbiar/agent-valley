// Language layer. English is the source text everywhere; Turkish comes from a dictionary (window.AV_TR, English -> Turkish).
// The choice lives in localStorage ("av-lang") and can be forced with ?lang=en or ?lang=tr. Default: English.
(function () {
  let lang = "en";
  const q = new URLSearchParams(location.search).get("lang");
  try { if (q === "en" || q === "tr") localStorage.setItem("av-lang", q); lang = localStorage.getItem("av-lang") === "tr" ? "tr" : "en"; } catch { lang = q === "tr" ? "tr" : "en"; }
  window.AV_LANG = lang;
  window.AV_LOC = lang === "tr" ? "tr-TR" : "en-US";
  document.documentElement.lang = lang;

  const D = window.AV_TR || {};
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  // Multi-word phrases are also replaced inside longer text (for sentences built around numbers and names).
  const phrases = Object.keys(D).filter((k) => k.includes(" ") && k.length >= 8).sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const RE = phrases.length ? new RegExp(phrases.map(esc).join("|"), "g") : null;
  function tr(s) {
    const t = norm(s);
    if (!t) return s;
    if (D[t] != null) return s.replace(s.trim(), D[t]);
    const m = t.match(/^([-+≈~$#%·\d.,:/()\s]+)(.+)$/); // "3 companies", "$1.20 revenue"
    if (m && D[m[2]] != null) return s.replace(s.trim(), m[1] + D[m[2]]);
    const m2 = t.match(/^(.+?)([\s:]*[-+≈~$#%·\d.,/()\s]+)$/); // "companies: 3"
    if (m2 && D[m2[1]] != null) return s.replace(s.trim(), D[m2[1]] + m2[2]);
    return RE ? s.replace(RE, (x) => D[x]) : s;
  }
  window.t = (s) => (lang === "tr" ? tr(String(s)) : String(s));

  const SKIP = new Set(["SCRIPT", "STYLE", "PRE", "CODE", "TEXTAREA", "NOSCRIPT"]);
  const ATTRS = ["placeholder", "aria-label", "title", "alt"];
  const skip = (el) => !el || SKIP.has(el.tagName) || el.closest?.("[translate=no],[data-noi18n]");
  function run(root) {
    if (root.nodeType === 3) { if (!skip(root.parentElement)) { const v = tr(root.data); if (v !== root.data) root.data = v; } return; }
    if (root.nodeType !== 1 || skip(root)) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (w.nextNode()) nodes.push(w.currentNode);
    for (const n of nodes) if (!skip(n.parentElement)) { const v = tr(n.data); if (v !== n.data) n.data = v; }
    const els = [root, ...root.querySelectorAll("[placeholder],[aria-label],[title],[alt],input[type=submit],input[type=button]")];
    for (const el of els) {
      if (!el.getAttribute || skip(el)) continue;
      for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const x = tr(v); if (x !== v) el.setAttribute(a, x); } }
      if (el.tagName === "INPUT" && /submit|button/.test(el.type) && el.value) { const x = tr(el.value); if (x !== el.value) el.value = x; }
    }
  }

  function toggle() {
    const b = document.createElement("div");
    b.setAttribute("data-noi18n", "");
    b.setAttribute("role", "group");
    b.setAttribute("aria-label", "Language");
    b.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;border:1px solid rgba(255,255,255,.2);border-radius:999px;overflow:hidden;background:rgba(15,22,38,.86);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:600 12px/1 \"Inter Tight\",system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)";
    for (const l of ["en", "tr"]) {
      const x = document.createElement("button");
      x.type = "button"; x.textContent = l.toUpperCase(); x.setAttribute("aria-pressed", String(l === lang));
      x.style.cssText = `border:0;min-width:40px;min-height:34px;padding:0 12px;cursor:pointer;background:${l === lang ? "#f4f6fa" : "transparent"};color:${l === lang ? "#0f1626" : "rgba(244,246,250,.74)"};font:inherit`;
      x.onclick = () => { if (l === lang) return; try { localStorage.setItem("av-lang", l); } catch {} const u = new URL(location.href); u.searchParams.delete("lang"); location.href = u.toString(); };
      b.appendChild(x);
    }
    document.body.appendChild(b);
  }

  function start() {
    if (!window.AV_NO_TOGGLE) toggle();
    if (lang !== "tr") return;
    document.title = tr(document.title);
    run(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") run(m.target);
        else if (m.type === "attributes") run(m.target);
        else for (const n of m.addedNodes) run(n);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
