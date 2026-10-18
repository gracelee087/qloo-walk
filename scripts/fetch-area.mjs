// One-time data build for the walking area (default: central Berlin around
// Alexanderplatz) from OpenStreetMap via Overpass. Writes:
//   data/area-pois.json     (placeholder places until Qloo results replace them)
//   data/area-subway.json   (subway stations shown on the map)
// Run: node scripts/fetch-area.mjs
// OSM data © OpenStreetMap contributors, ODbL — keep the attribution on the map.
import fs from "node:fs";

// south,west,north,east
const BBOX = process.env.AREA_BBOX || "52.5050,13.3700,52.5350,13.4300";
const AREA = { city: "Berlin", area: "Berlin" };
// ONLY=places|subway reruns a single step (Overpass mirrors are flaky)
const ONLY = process.env.ONLY;
const want = (k) => !ONLY || ONLY === k;

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
async function overpass(q) {
  for (const m of MIRRORS) {
    try {
      const r = await fetch(m, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "User-Agent": "qloo-walk/0.1 (hackathon demo)" } });
      if (r.ok) return await r.json();
      console.error(m, "→", r.status);
    } catch (e) { console.error(m, "→", e.message); }
  }
  throw new Error("overpass failed");
}

if (want("places")) {
// ---- places (placeholder until Qloo) ----
console.log("Fetching places…");
const pj = await overpass(`[out:json][timeout:120];
(
  nwr["amenity"~"^(restaurant|cafe|bar|ice_cream)$"]["name"](${BBOX});
  nwr["tourism"~"^(attraction|museum|gallery|viewpoint)$"]["name"](${BBOX});
  nwr["historic"]["name"](${BBOX});
  nwr["shop"~"^(clothes|shoes|boutique|books|department_store|gift|jewelry|art|music|bakery|deli)$"]["name"](${BBOX});
);
out center tags;`);
const typeOf = (t) =>
  /^(restaurant|cafe|bar|ice_cream)$/.test(t.amenity || "") || t.shop === "bakery" || t.shop === "deli" ? "food"
    : t.tourism === "museum" || t.tourism === "gallery" || t.historic ? "culture"
      : t.tourism ? "attraction"
        : "shopping";
const LIMIT = { food: 70, shopping: 50, culture: 40, attraction: 30 };
const all = [];
for (const e of pj.elements) {
  const t = e.tags || {};
  const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
  if (lat == null || lng == null) continue;
  const addr = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  all.push({
    id: `osm-${e.type[0]}${e.id}`, type: typeOf(t), title: t.name, enName: t["name:en"] || t.name,
    lng, lat, addr, hours: t.opening_hours || "", menu: (t.cuisine || "").replace(/;/g, ", "),
    website: t.website || "", source: "osm",
    wikidata: t.wikidata || "", wikipedia: t.wikipedia || "",   // used by scripts/fetch-wiki.mjs
    // places with a Wikidata/website tag are usually the better-known ones
    _rank: (t.wikidata ? 2 : 0) + (t.website ? 1 : 0),
  });
}
const pois = [];
for (const [type, n] of Object.entries(LIMIT)) {
  pois.push(...all.filter((p) => p.type === type).sort((a, b) => b._rank - a._rank).slice(0, n));
}
for (const p of pois) delete p._rank;
const [s, w, n, e] = BBOX.split(",").map(Number);
fs.writeFileSync("data/area-pois.json", JSON.stringify({
  ...AREA, center: { mapX: (w + e) / 2, mapY: (s + n) / 2 }, bbox: BBOX,
  source: "OpenStreetMap (ODbL) — placeholder until Qloo", count: pois.length, pois,
}, null, 1));
console.log("places:", pois.length, Object.fromEntries(Object.keys(LIMIT).map((k) => [k, pois.filter((p) => p.type === k).length])));
}

if (want("subway")) {
// ---- subway stations ----
console.log("Fetching subway stations…");
const tj = await overpass(`[out:json][timeout:60];
(nwr["railway"="station"]["station"="subway"](${BBOX}););
out center tags;`);
const subway = tj.elements.map((e) => ({
  name: e.tags?.name || "", en: e.tags?.name || "",
  lines: (e.tags?.route_ref || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean).map((x) => ({ n: x, c: "#6b7280" })),
  lng: e.lon ?? e.center?.lon, lat: e.lat ?? e.center?.lat,
})).filter((s) => s.name && s.lat != null)
  // one marker per station: OSM often has several nodes for the same stop
  .filter((s, i, arr) => !arr.slice(0, i).some((o) => o.name === s.name && Math.hypot((o.lat - s.lat) * 111320, (o.lng - s.lng) * 84000) < 200));
fs.writeFileSync("data/area-subway.json", JSON.stringify({ stations: subway }, null, 1));
console.log("subway stations:", subway.length, subway.map((s) => s.name).join(" | "));
}
