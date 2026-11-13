/* Agent Valley avatars: every company's agent is a small person in the city. One builder for the console preview
   and the 3D city, so what a founder picks is exactly what walks around. Needs three.js (r147) as THREE.
   A look is { skin, hair, hairColor, top, bottom, extra, build }, each an index into the lists below. */
(function () {
  const SKIN = ["#f6d7bd", "#e9b98f", "#cf9466", "#a86d45", "#7a4b2c", "#4e301d"];
  const HAIR = ["Short", "Long", "Bun", "Curly", "Buzz", "Bald"];
  const HAIR_COLOR = ["#1d1a19", "#4a3022", "#8a5a32", "#d8b36e", "#b8462e", "#c9ced8", "#3fd8ff", "#c6ff2e"];
  const TOP = ["#c6ff2e", "#3fd8ff", "#ff6b6b", "#ffc24d", "#8b6bff", "#f4f6fa", "#2a3245", "#3ee08f"];
  const BOTTOM = ["#232c42", "#1b2540", "#5b6072", "#3f5d7a", "#6b4f3a", "#d7d2c8"];
  const EXTRA = ["None", "Glasses", "Cap", "Headset", "Beanie"];
  const BUILD = ["Slim", "Regular", "Broad"];
  const LISTS = { skin: SKIN, hair: HAIR, hairColor: HAIR_COLOR, top: TOP, bottom: BOTTOM, extra: EXTRA, build: BUILD };

  // A look from any input: known fields are kept (clamped), missing ones come from the seed, so every company has one.
  function normalize(look, seed) {
    let s = (Number(seed) || 1) >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = {};
    for (const k of Object.keys(LISTS)) {
      const n = LISTS[k].length, v = look && Number.isInteger(look[k]) ? look[k] : NaN;
      out[k] = v >= 0 && v < n ? v : Math.floor(rnd() * n);
    }
    if (!look || !Number.isInteger(look.extra)) out.extra = rnd() < 0.45 ? 0 : out.extra; // most agents wear nothing extra
    return out;
  }

  const cache = new Map();
  function mat(THREE, hex, rough = 0.62, extra) {
    const key = hex + "|" + rough + (extra ? JSON.stringify(extra) : "");
    if (!cache.has(key)) { const m = new THREE.MeshStandardMaterial(Object.assign({ color: new THREE.Color(hex).convertSRGBToLinear(), roughness: rough, metalness: 0.02 }, extra || {})); m.userData.lin = true; cache.set(key, m); } // already linear
    return cache.get(key);
  }
  const geos = {};
  function geo(THREE, key, make) { return geos[key] || (geos[key] = make()); }

  // About 1 unit tall, standing on y = 0, facing +z.
  function build(THREE, lookIn, opts = {}) {
    const look = normalize(lookIn, opts.seed);
    const g = new THREE.Group();
    const skin = mat(THREE, SKIN[look.skin], 0.55), top = mat(THREE, TOP[look.top], 0.7), bottom = mat(THREE, BOTTOM[look.bottom], 0.75);
    const hair = mat(THREE, HAIR_COLOR[look.hair === 5 ? 0 : look.hairColor], 0.8), dark = mat(THREE, "#14181f", 0.5), shoe = mat(THREE, "#1a1f2b", 0.6);
    const w = [0.88, 1, 1.14][look.build];
    const add = (geom, m, x, y, z, parent = g) => { const o = new THREE.Mesh(geom, m); o.position.set(x, y, z); o.castShadow = !!opts.shadow; parent.add(o); return o; };

    // legs swing from the hip, arms from the shoulder
    const legG = geo(THREE, "leg", () => new THREE.CylinderGeometry(0.052, 0.046, 0.34, 10).translate(0, -0.17, 0));
    const shoeG = geo(THREE, "shoe", () => new THREE.BoxGeometry(0.09, 0.05, 0.15).translate(0, -0.355, 0.025));
    const legs = [-1, 1].map((sd) => { const p = new THREE.Group(); p.position.set(sd * 0.065 * w, 0.4, 0); g.add(p); add(legG, bottom, 0, 0, 0, p); add(shoeG, shoe, 0, 0, 0, p); return p; });
    add(geo(THREE, "hip", () => new THREE.CylinderGeometry(0.12, 0.125, 0.1, 14)), bottom, 0, 0.42, 0).scale.set(w, 1, 1);
    const torso = add(geo(THREE, "torso", () => new THREE.CylinderGeometry(0.13, 0.115, 0.3, 16)), top, 0, 0.6, 0); torso.scale.set(w, 1, 0.82);
    add(geo(THREE, "chest", () => new THREE.SphereGeometry(0.13, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)), top, 0, 0.745, 0).scale.set(w, 0.5, 0.82);
    const armG = geo(THREE, "arm", () => new THREE.CylinderGeometry(0.038, 0.034, 0.27, 8).translate(0, -0.135, 0));
    const handG = geo(THREE, "hand", () => new THREE.SphereGeometry(0.04, 10, 8).translate(0, -0.29, 0));
    const arms = [-1, 1].map((sd) => { const p = new THREE.Group(); p.position.set(sd * 0.155 * w, 0.74, 0); p.rotation.z = sd * 0.08; g.add(p); add(armG, top, 0, 0, 0, p); add(handG, skin, 0, 0, 0, p); return p; });
    add(geo(THREE, "neck", () => new THREE.CylinderGeometry(0.035, 0.04, 0.06, 8)), skin, 0, 0.79, 0);
    const headY = 0.9;
    add(geo(THREE, "head", () => new THREE.SphereGeometry(0.105, 20, 16)), skin, 0, headY, 0).scale.set(1, 1.08, 1);
    const eyeG = geo(THREE, "eye", () => new THREE.SphereGeometry(0.013, 8, 6));
    add(eyeG, dark, -0.036, headY + 0.01, 0.096); add(eyeG, dark, 0.036, headY + 0.01, 0.096);

    // hair
    const cap = (theta, r = 0.112) => geo(THREE, "cap" + theta + r, () => new THREE.SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, theta));
    if (look.hair === 0) add(cap(Math.PI * 0.52), hair, 0, headY + 0.008, -0.006).rotation.x = -0.18;
    if (look.hair === 1) { add(cap(Math.PI * 0.55), hair, 0, headY + 0.008, -0.008).rotation.x = -0.2; add(geo(THREE, "long", () => new THREE.BoxGeometry(0.2, 0.2, 0.06)), hair, 0, headY - 0.07, -0.075); }
    if (look.hair === 2) { add(cap(Math.PI * 0.5), hair, 0, headY + 0.008, -0.006).rotation.x = -0.15; add(geo(THREE, "bun", () => new THREE.SphereGeometry(0.05, 12, 10)), hair, 0, headY + 0.1, -0.07); }
    if (look.hair === 3) { const cg = geo(THREE, "curl", () => new THREE.SphereGeometry(0.045, 10, 8)); for (let i = 0; i < 11; i++) { const a = (i / 11) * Math.PI * 2, rr = 0.075; add(cg, hair, Math.cos(a) * rr, headY + 0.07 + (i % 2) * 0.02, Math.sin(a) * rr - 0.01); } add(cg, hair, 0, headY + 0.11, 0); }
    if (look.hair === 4) add(cap(Math.PI * 0.42, 0.108), hair, 0, headY + 0.006, -0.004).rotation.x = -0.12;

    // extras
    const extra = mat(THREE, TOP[(look.top + 3) % TOP.length], 0.5);
    if (look.extra === 1) { const ring = geo(THREE, "lens", () => new THREE.TorusGeometry(0.026, 0.006, 6, 16)); add(ring, dark, -0.038, headY + 0.012, 0.104); add(ring, dark, 0.038, headY + 0.012, 0.104); add(geo(THREE, "bridge", () => new THREE.BoxGeometry(0.024, 0.006, 0.006)), dark, 0, headY + 0.014, 0.106); }
    if (look.extra === 2) { add(cap(Math.PI * 0.5, 0.115), extra, 0, headY + 0.012, 0).rotation.x = -0.08; add(geo(THREE, "brim", () => new THREE.BoxGeometry(0.15, 0.012, 0.09)), extra, 0, headY + 0.04, 0.12); }
    if (look.extra === 3) { const band = add(geo(THREE, "band", () => new THREE.TorusGeometry(0.115, 0.01, 6, 24, Math.PI)), dark, 0, headY + 0.01, 0); band.rotation.y = Math.PI / 2; const cup = geo(THREE, "cup", () => new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12).rotateZ(Math.PI / 2)); add(cup, extra, -0.112, headY, 0); add(cup, extra, 0.112, headY, 0); add(geo(THREE, "mic", () => new THREE.BoxGeometry(0.008, 0.008, 0.08)), dark, -0.1, headY - 0.04, 0.05).rotation.y = -0.5; }
    if (look.extra === 4) { add(cap(Math.PI * 0.55, 0.118), extra, 0, headY + 0.016, 0).scale.set(1, 1.18, 1); add(geo(THREE, "fold", () => new THREE.TorusGeometry(0.112, 0.016, 8, 24).rotateX(Math.PI / 2)), extra, 0, headY + 0.03, 0); }

    g.userData.rig = { legs, arms, look };
    return g;
  }

  // Walk cycle: phase in radians; moving 0..1 blends from standing to walking.
  function pose(g, phase, moving = 1) {
    const r = g.userData.rig; if (!r) return;
    const sw = Math.sin(phase) * 0.6 * moving;
    r.legs[0].rotation.x = sw; r.legs[1].rotation.x = -sw;
    r.arms[0].rotation.x = -sw * 0.8; r.arms[1].rotation.x = sw * 0.8;
    g.position.y = (g.userData.baseY || 0) + Math.abs(Math.cos(phase)) * 0.018 * moving;
  }

  window.AVAvatar = { SKIN, HAIR, HAIR_COLOR, TOP, BOTTOM, EXTRA, BUILD, LISTS, normalize, build, pose };
})();
