// Adds a short description + image to places that OpenStreetMap links to
// Wikipedia/Wikidata. Writes back into data/area-pois.json:
//   about, aboutUrl, aboutSource ("Wikipedia"), image
// Run after scripts/fetch-area.mjs:  node scripts/fetch-wiki.mjs
// Text: Wikipedia, CC BY-SA 4.0 — the app shows the source link next to it.
import fs from "node:fs";

const FILE = "data/area-pois.json";
const UA = { "User-Agent": "qloo-walk/0.1 (hackathon demo; https://github.com/gracelee087)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));

// 1) English Wikipedia title for each place: from the wikipedia tag ("en:Title")
//    or via the Wikidata item's enwiki sitelink
const titleOf = new Map();
for (const p of data.pois) {
  const m = /^en:(.+)$/.exec(p.wikipedia || "");
  if (m) titleOf.set(p.id, m[1]);
}
const qids = [...new Set(data.pois.filter((p) => p.wikidata && !titleOf.has(p.id)).map((p) => p.wikidata))];
for (let i = 0; i < qids.length; i += 50) {
  const u = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qids.slice(i, i + 50).join("|")}&props=sitelinks&sitefilter=enwiki&format=json`;
  const j = await (await fetch(u, { headers: UA })).json();
  for (const p of data.pois) {
    const t = j.entities?.[p.wikidata]?.sitelinks?.enwiki?.title;
    if (t && !titleOf.has(p.id)) titleOf.set(p.id, t);
  }
}
console.log("places with an English Wikipedia article:", titleOf.size);

// 2) page summary (lead text + thumbnail) for each
let ok = 0;
for (const p of data.pois) {
  const t = titleOf.get(p.id);
  if (!t) continue;
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`, { headers: UA });
    if (!r.ok) { console.error(t, r.status); continue; }
    const s = await r.json();
    if (s.type === "disambiguation" || !s.extract) continue;
    p.about = s.extract;
    p.aboutUrl = s.content_urls?.desktop?.page || "";
    p.aboutSource = "Wikipedia";
    if (s.thumbnail?.source) p.image = s.thumbnail.source;
    ok++;
  } catch (e) { console.error(t, e.message); }
  await sleep(120);   // be gentle with the API
}
fs.writeFileSync(FILE, JSON.stringify(data, null, 1));
console.log("descriptions added:", ok, "· with image:", data.pois.filter((p) => p.image).length);
