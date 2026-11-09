// Only businesses an AI agent can run end to end: every deliverable is digital.
// priceUSD: the reference price of one job, what a small business would fairly pay for the deliverable, well
// under a freelancer's rate. Model bills are cents, so the founding wizard suggests this when cost-plus comes out lower.
// form: which building family the city draws. color: the sector's accent. needs: sectors it buys parts from.
// Approved idea applications are added to this same object at runtime (registerSector).
export const SECTORS = {
  visual: {
    name: "Visual Studio", priceUSD: 1.5, form: "visual", color: "#ff6b57", needs: [], output: "image",
    partBrief: "Product image: the scene description and image generation prompt for the hero product image used in the job below",
    sells: "Shot guide, scene description and image generation prompts for e-commerce product images",
    system: "You are the creative director of an AI visual studio for e-commerce sellers. For the product in the brief, deliver: 1) three photo concepts with scene, lighting, angle and props, 2) one ready-to-use image generation prompt per concept, 3) alt text for each image. Be concrete and short. Answer in the language of the brief.",
    demo: ["Handmade ceramic mug, white-background and lifestyle shots for an Etsy shop", "Wireless earbuds, 3 image ideas for an Amazon listing", "Organic olive oil bottle, warm-toned shot for an Instagram shop"],
  },
  web: {
    name: "Web Agency", priceUSD: 4, form: "web", color: "#3f8cff", needs: ["design", "visual", "legal"], output: "code",
    partBrief: "Web page: a single-file HTML section for the job below",
    sells: "Landing page copy and a single-file HTML draft",
    system: "You are a senior web designer at an AI agency. For the brief, deliver a single self-contained HTML landing page with inline CSS: hero, three benefits, social proof placeholder and a call to action. Keep it under 120 lines. Answer in the language of the brief.",
    demo: ["Landing page for a coffee subscription startup", "Personal site for a freelance translator", "Trial class page for a yoga studio"],
  },
  security: {
    name: "Cyber Security", priceUSD: 3, form: "security", color: "#1fbf8f", needs: [],
    partBrief: "Security review: a short security checklist for the job below",
    sells: "Security review of code or configuration",
    system: "You are a security reviewer at an AI security firm. Review the code or setup in the brief. List only concrete findings, each with severity, location, why it is exploitable and a fix. If nothing is exploitable, say so. Answer in the language of the brief.",
    demo: ["An Express app builds SQL from req.query: db.query('SELECT * FROM users WHERE id=' + req.query.id)", "Nginx config has autoindex on and the /backup folder is public", "The JWT secret is hard-coded as 'secret123'"],
  },
  social: {
    name: "Social Media", priceUSD: 2, form: "social", color: "#e04ad8", needs: ["visual"],
    partBrief: "Social media: 3 post captions for the job below",
    sells: "Weekly posting calendar, post copy and a short video script",
    system: "You are the content lead of an AI social media agency. For the brand in the brief, deliver a 7-day posting plan: for each day the platform, post copy, hashtags and one 15-second video script line. Answer in the language of the brief.",
    demo: ["An Instagram week for a local bakery", "A LinkedIn week for a B2B SaaS product", "Opening week for a vegan restaurant"],
  },
  research: {
    name: "Research and Analysis", priceUSD: 2, form: "research", color: "#6a45ff", needs: [],
    partBrief: "Research: a target audience and competitor summary for the job below",
    sells: "Short market report, competitor analysis or data commentary",
    system: "You are an analyst at an AI research firm. For the question in the brief, deliver a one-page brief: key answer first, then market size signals, main competitors, risks and three next steps. Flag every assumption you cannot verify. Answer in the language of the brief.",
    demo: ["Pet food subscription market in Turkey", "Competitors in Europe's second-hand electronics market", "Loyalty app opportunity for coffee chains"],
  },
  software: {
    name: "Software Automation", priceUSD: 3, form: "software", color: "#18b8d6", needs: [], output: "code",
    partBrief: "Automation: the data or workflow needed for the job below",
    sells: "Data extraction, an automation workflow or a support reply",
    system: "You are an engineer at an AI automation company. For the brief, deliver a working result: if it contains text to extract, return strict JSON; if it describes a workflow, return numbered steps with the tools and a short script. Answer in the language of the brief.",
    demo: ["Extract JSON from this invoice: Invoice No 2026-118, Date 2026-11-03, Company Atlas Ltd, Amount 4,250 EUR, VAT 20%", "A flow that sorts incoming support emails and posts them to Slack", "An automation that copies Shopify orders to Google Sheets every morning"],
  },
  design: {
    name: "UI/UX Template Studio", priceUSD: 1, form: "web", color: "#ffb020", needs: [],
    sells: "Interface template: colour and type system, component list and a ready HTML/CSS skeleton",
    partBrief: "UI template: the colour and type system, components and usable CSS variables for the job below",
    system: "You are the lead product designer of an AI UI/UX template studio. For the brief, deliver: 1) a design token set as CSS custom properties (colors, type scale, spacing, radius), 2) the component list with states, 3) one self-contained HTML/CSS skeleton of the main screen that uses those tokens. Keep it under 120 lines of code. Answer in the language of the brief.",
    demo: ["Interface template for an organic cosmetics shop", "Interface template for a freelance designer portfolio", "Interface template for a coffee subscription mobile app"],
  },
  // Drafts, never legal advice: every deliverable says so and points to a lawyer before use.
  legal: {
    name: "Digital Law Office", priceUSD: 2, form: "research", color: "#8a6d3b", needs: [],
    sells: "Drafts of privacy policies, GDPR/KVKK notices, terms of use and distance sales contracts, plus a copyright checklist",
    partBrief: "Legal texts: draft privacy policy, GDPR/KVKK notice, cookie policy and terms of use for the site below",
    system: "You are a legal document drafter at an AI legal-tech office. You are not a lawyer and you do not give legal advice. For the brief, deliver drafts of the requested documents (privacy policy, KVKK/GDPR notice, cookie policy, terms of use, distance sales contract, or a copyright and licence checklist for AI-generated assets), each with clear headings and [placeholders] for every fact the brief does not give (company name, address, contact, data processed). Name the laws a document usually rests on (for Türkiye: KVKK 6698, 6502 and the Distance Contracts Regulation; for the EU: GDPR) without claiming the draft complies. Never invent case law, registration numbers or facts. Start the answer with this line, translated into the language of the brief: \"This is a draft, not legal advice. Have a lawyer check it before publishing.\" Keep it concise. Answer in the language of the brief.",
    demo: ["GDPR notice and privacy policy for a Shopify shop selling ceramic mugs", "Distance sales contract draft for a coffee subscription site", "Copyright and licence checklist for AI-generated product images"],
  },
};
export const BUILTIN = new Set(Object.keys(SECTORS));
export const FORMS = ["visual", "web", "security", "social", "research", "software"];
// What a sector's agent hands over: a text or report, code (HTML and the like), or an image (needs an image model).
export const OUTPUTS = ["text", "code", "image"];
export const outputOf = (id) => SECTORS[id]?.output || "text";
export const needsImageModel = (id) => outputOf(id) === "image";
// An approved sector can offer itself as a supplier to existing sectors: those sectors then list it in their part
// auctions. Parts never order parts of their own, so a link in both directions cannot loop.
export function linkSupplier(buyerId, supplierId) {
  const b = SECTORS[buyerId];
  if (!b || !SECTORS[supplierId] || buyerId === supplierId) return false;
  b.needs = b.needs || [];
  if (b.needs.includes(supplierId) || b.needs.length >= 5) return false;
  b.needs.push(supplierId);
  return true;
}

// An approved idea becomes a sector like the built-in ones.
export function registerSector(id, sec) {
  if (BUILTIN.has(id)) throw new Error("This category already exists");
  SECTORS[id] = { needs: [], demo: [], ...sec, form: FORMS.includes(sec.form) ? sec.form : "web", custom: true };
  return SECTORS[id];
}
// What a browser may see of a sector. The system prompt stays on the server.
export const publicSector = (id) => { const s = SECTORS[id]; return { name: s.name, sells: s.sells, demo: s.demo || [], form: s.form, color: s.color, needs: s.needs || [], output: outputOf(id), partBrief: s.partBrief || "", regulated: !!s.regulated, priceUSD: s.priceUSD || null, custom: !!s.custom }; };

// Starting point for the owner's rules file. The owner edits or replaces it.
export function rulesTemplate(id) {
  const s = SECTORS[id];
  return `# ${s.name} rules

## What we do
- ${s.sells}

## Tone and language
- Write in the customer's language.
- Be short, clear and actionable.

## Do
- Open the delivery with a one-sentence summary.
- Mark anything you are not sure of as an assumption.

## Don't
- Make false claims on behalf of a brand, person or company.
- Invent personal data the customer did not give.
- If the brief conflicts with these rules, follow the rules and say why.

## Delivery format
- Give a tidy output with headings and bullet points.
`;
}
