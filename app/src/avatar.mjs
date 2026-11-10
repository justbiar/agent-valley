// The look of a company's agent: small integers, one per choice. The lists themselves live in assets/avatar.js;
// the server only keeps numbers in range, so nothing a founder sends can reach the page as markup.
export const AVATAR_SIZES = { skin: 6, hair: 6, hairColor: 8, top: 8, bottom: 6, extra: 5, build: 3 };

export function parseAvatar(x) {
  if (!x || typeof x !== "object") return null;
  const out = {};
  for (const [k, n] of Object.entries(AVATAR_SIZES)) {
    const v = Number(x[k]);
    if (!Number.isInteger(v) || v < 0 || v >= n) throw new Error(`Agent look: ${k} must be a whole number from 0 to ${n - 1}`);
    out[k] = v;
  }
  return out;
}
