// Fetches a customer's shop page safely and turns it into a short digest for the research agent.
import dns from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 10_000;

// Blocks loopback, private, link-local and other internal ranges, so a customer link
// cannot make the server read its own network (SSRF).
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export async function checkUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error("Enter a valid site address (https://...)"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http and https addresses are accepted");
  if (u.username || u.password) throw new Error("The address cannot contain a user name or password");
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error("Could not resolve the site address"); });
    if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error("This address points to a private network and is not accepted");
  }
  return u;
}

export async function fetchPage(raw, opts = {}) {
  let u = await checkUrl(raw, opts);
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try { res = await fetch(u, { redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": "AgentValleyResearch/0.1 (+site digest for a cover image order)", Accept: "text/html,application/xhtml+xml" } }); }
    catch (e) { clearTimeout(timer); throw new Error(e.name === "AbortError" ? "The site did not answer in time" : "Could not reach the site"); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      u = await checkUrl(new URL(res.headers.get("location"), u), opts);
      continue;
    }
    if (!res.ok) { clearTimeout(timer); throw new Error(`The site returned ${res.status}`); }
    const type = res.headers.get("content-type") || "";
    if (!/html|xml|text\/plain/.test(type)) { clearTimeout(timer); throw new Error("The address is not a web page"); }
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { ctrl.abort(); break; }
      chunks.push(value);
    }
    clearTimeout(timer);
    return { url: u.toString(), html: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("Too many redirects");
}

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const meta = (html, key) => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, "i"), tag = html.match(re)?.[0];
  return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1]) : "";
};

// Pulls what a designer needs: brand, products, colors, tone. The page text is customer data, not instructions.
export function digest({ url, html }) {
  const clean = html.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const products = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); if (/Product/i.test(n["@type"])) products.push({ name: decode(n.name), brand: decode(n.brand?.name || n.brand), price: n.offers?.price || n.offers?.[0]?.price || null }); Object.values(n).forEach(walk); };
      walk(JSON.parse(m[1]));
    } catch { /* ignore broken JSON-LD */ }
  }
  const headings = [...clean.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, " "))).filter(Boolean).slice(0, 8);
  const text = decode(clean.replace(/<[^>]+>/g, " ")).slice(0, 1500);
  return {
    url,
    title: decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]),
    description: meta(html, "description") || meta(html, "og:description"),
    siteName: meta(html, "og:site_name"),
    themeColor: meta(html, "theme-color"),
    ogImage: meta(html, "og:image"),
    products: products.slice(0, 8),
    headings,
    text,
  };
}
