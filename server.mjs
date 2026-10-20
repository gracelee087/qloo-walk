// The whole app in one Node process (hackathon kit: backend on a VM/container,
// not serverless). Serves the static app and the /api routes:
//   /api/route -> the handler in netlify/functions/route.js (Request -> Response)
//   GET /api/qloo/search?q=<name>              -> Qloo places in the walking area matching a name
//   GET /api/qloo/similar?ids=<id,id>&take=<n> -> Qloo places in the area with taste affinity to those places
//   GET /api/qloo/nearby?lat=<lat>&lon=<lon>   -> Qloo places within NEARBY_M of a point (stories + tips while walking)
//   GET /api/qloo/course?lat=<lat>&lon=<lon>[&ids=<id,id>] -> Qloo places within COURSE_M to build walks from
//                                               (with ids: ranked by taste affinity to those places — the "For you" walk)
//   GET /api/story?street=<name>               -> the street's English Wikipedia summary, first sentences, read as is (no LLM)
//   GET /api/wiki/near?lat=<lat>&lon=<lon>     -> English Wikipedia articles within WIKI_M (local history), first sentences, read as is
//   POST /api/tts {text}                     -> the guide's line as ElevenLabs speech (audio/mpeg); the key stays here
// Run: node --env-file=.env server.mjs   (PORT, default 8888)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY } from "./js/city.js";
import { qloo } from "./server/qloo.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 8888;
const STATIC_DIRS = ["css", "js", "data", "audio"];
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg" };
const FUNCTIONS = ["route"];
const SOURCE = "Qloo Insights API (hackathon), via the qloo api CLI";
const NEARBY_M = 300;
const COURSE_M = 1500;
// not walk stops: places to stay, everyday shops, stations, bare addresses, members-only clubs
const STAY = /hotel|hostel|motel|lodging|apartment|guest house|\bspa\b|electronics|supermarket|grocery|shopping mall|drugstore|pharmacy|station|^building$|social club/i;

const handlers = {};
for (const f of FUNCTIONS) handlers[f] = (await import(`./netlify/functions/${f}.js`)).default;

// metres between two {lat, lon}
function dist(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const center = { lat: CITY.start.lat, lon: CITY.start.lng };
const inArea = (e) => e.location && dist(center, e.location) <= CITY.maxFromCenterM;

// only what the app shows — never pass the full Qloo response through
const place = (e) => ({
  id: e.entity_id, name: e.name,
  lat: e.location.lat, lon: e.location.lon,
  address: e.properties?.address ?? null,
  affinity: e.query?.affinity ?? null,
  popularity: e.popularity ?? null,
  tags: (e.tags || []).map((t) => t.name),
  kinds: (e.tags || []).filter((t) => /^urn:tag:(category|genre):place/.test(t.type || "")).map((t) => t.name),
  about: e.properties?.short_description || e.properties?.description || null,
  story: e.properties?.unique_selling_points || e.properties?.neighborhood_description || null,
  area: e.properties?.neighborhood_description || null,
  // what visitors mention most (Qloo counts them)
  keywords: [...(e.properties?.keywords || [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, 6).map((k) => k.name),
  image: e.properties?.image?.url ?? null,
  images: [...new Set([e.properties?.image?.url, ...(e.properties?.images || []).map((i) => i.url)].filter(Boolean))].slice(0, 5),
});

const idList = (u) => (u.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter((s) => /^[0-9A-F-]{36}$/i.test(s)).slice(0, 5);
// ~100 m grid so walkers on the same block share one cached Qloo call
const gridPoint = (u) => ({ lat: Math.round(Number(u.searchParams.get("lat")) * 1000) / 1000,
  lon: Math.round(Number(u.searchParams.get("lon")) * 1000) / 1000 });

async function qlooRoute(path, u) {
  if (path === "search") {
    const q = (u.searchParams.get("q") || "").trim().slice(0, 80);
    if (!q) return Response.json({ error: "q required" }, { status: 400 });
    const j = await qloo(["search", "-q", q, "-t", "place", "-n", "10"]);
    return Response.json({ places: j.filter(inArea).slice(0, 5).map(place), source: SOURCE });
  }
  if (path === "similar") {
    const ids = idList(u);
    if (!ids.length) return Response.json({ error: "ids required" }, { status: 400 });
    const take = Math.min(Math.max(Number(u.searchParams.get("take")) || 10, 1), 20);
    const j = await qloo(["insights", "-t", "place", "--signal-entities", ids.join(","), "--filter-location", CITY.area, "-n", String(take)]);
    const places = j.filter(inArea).filter((e) => !ids.includes(e.entity_id)).map(place);
    return Response.json({ places, source: SOURCE,
      note: "Affinity is aggregate taste data from Qloo, not a prediction about one person." });
  }
  if (path === "nearby") {
    const { lat, lon } = gridPoint(u);
    if (!inArea({ location: { lat, lon } })) return Response.json({ error: "outside the walking area" }, { status: 400 });
    const j = await qloo(["insights", "-t", "place", "-n", "20",
      "--params", JSON.stringify({ "filter.location": `POINT(${lon} ${lat})`, "filter.location.radius": NEARBY_M })]);
    return Response.json({ places: j.filter((e) => e.location).map(place), source: SOURCE });
  }
  if (path === "course") {
    const { lat, lon } = gridPoint(u), ids = idList(u);
    if (!inArea({ location: { lat, lon } })) return Response.json({ error: "outside the walking area" }, { status: 400 });
    const j = await qloo(["insights", "-t", "place", "-n", ids.length ? "30" : "50",
      ...(ids.length ? ["--signal-entities", ids.join(",")] : []),
      "--params", JSON.stringify({ "filter.location": `POINT(${lon} ${lat})`, "filter.location.radius": COURSE_M })]);
    const seen = new Set();      // Qloo can list one place twice under the same name
    const places = j.filter((e) => e.location && !ids.includes(e.entity_id)).map(place)
      .filter((p) => !p.kinds.some((k) => STAY.test(k)) && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()));
    return Response.json({ places, source: SOURCE,
      ...(ids.length && { note: "Affinity is aggregate taste data from Qloo, not a prediction about one person." }) });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

// ---------- street stories: English Wikipedia, CC BY-SA 4.0 (the app shows the source link) ----------
// "<street> (Berlin)" first — many street names exist in several cities; the
// text must mention Berlin. No English article → no story (the app says the name only).
const UA = { "User-Agent": "TasteWalk/0.1 (Qloo Agentic Hackathon demo; https://github.com/gracelee087/qloo-walk)" };
const stories = new Map();       // street -> Promise of { story, source } | { story: null }
async function wikiSummary(title) {
  const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    { headers: UA, signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!r?.ok) return null;
  const s = await r.json();
  return s.type === "disambiguation" || !s.extract ? null : s;
}
async function streetStory(street) {
  for (const title of [`${street} (${CITY.area})`, street]) {
    const s = await wikiSummary(title);
    if (!s || !s.extract.includes(CITY.area)) continue;
    const story = (s.extract.match(/[^.!?]+[.!?]+(\s|$)/g) || [s.extract]).slice(0, 2).join("").trim();
    return { story, source: { title: s.title, url: s.content_urls?.desktop?.page } };
  }
  return { story: null };
}

// ---------- the guide's voice: ElevenLabs (voice "Amelia", as in Myeongdong 3D) ----------
// The demo is public, so a daily character budget caps what strangers can spend;
// over budget (or no key) the app falls back to the browser's own voice.
const VOICE = "ZF6FPAbjXT4488VcRRnw", TTS_MODEL = "eleven_v4_turbo";
const TTS_DAILY_CHARS = Number(process.env.TTS_DAILY_CHARS) || 20000;
const voiced = new Map();        // text -> Promise of mp3 Buffer (the same lines repeat a lot)
let budget = { day: "", used: 0 };
async function tts(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_64`, {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.5, use_speaker_boost: true } }),   // upbeat
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function speech(req) {
  if (!process.env.ELEVENLABS_API_KEY) return Response.json({ error: "no voice configured" }, { status: 503 });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = String(JSON.parse(Buffer.concat(chunks).toString() || "{}").text || "").trim().slice(0, 600);
  if (!text) return Response.json({ error: "text required" }, { status: 400 });
  if (!voiced.has(text)) {
    const day = new Date().toISOString().slice(0, 10);
    if (budget.day !== day) budget = { day, used: 0 };
    if (budget.used + text.length > TTS_DAILY_CHARS) return Response.json({ error: "voice budget used up for today" }, { status: 429 });
    budget.used += text.length;
    if (voiced.size > 300) voiced.delete(voiced.keys().next().value);
    voiced.set(text, tts(text).catch((e) => { voiced.delete(text); throw e; }));
  }
  try {
    return new Response(await voiced.get(text), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    console.error("tts:", e.message);
    return Response.json({ error: "voice unavailable" }, { status: 502 });
  }
}

// ---------- local history: Wikipedia articles near a point (geosearch), first two sentences ----------
const WIKI_M = 400;
// stations aren't stories; accidents and crimes don't suit an upbeat walk
const SKIP_WIKI = /U-Bahn|S-Bahn|station|disambiguation|^List of|crash|accident|shooting|murder|attack|bombing|stabbing/i;
const nearWiki = new Map();      // ~100 m grid cell -> Promise of items
const first2 = (t) => (t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t]).slice(0, 2).join("").trim();
async function wikiNear({ lat, lon }) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=${WIKI_M}&gslimit=12&format=json`,
    { headers: UA, signal: AbortSignal.timeout(6000) });
  const hits = ((await r.json()).query?.geosearch || []).filter((x) => !SKIP_WIKI.test(x.title)).slice(0, 8);
  const items = await Promise.all(hits.map(async (x) => {
    const s = await wikiSummary(x.title);
    return s && { title: s.title, lat: x.lat, lon: x.lon, story: first2(s.extract), url: s.content_urls?.desktop?.page };
  }));
  return items.filter(Boolean);
}

async function api(req, u) {
  const [, , name, sub] = u.pathname.split("/");     // /api/<name>[/<sub>]
  if (name === "wiki" && sub === "near" && req.method === "GET") {
    const p = gridPoint(u), key = `${p.lat},${p.lon}`;
    if (!inArea({ location: p })) return Response.json({ error: "outside the walking area" }, { status: 400 });
    if (!nearWiki.has(key)) nearWiki.set(key, wikiNear(p).catch(() => { nearWiki.delete(key); return []; }));
    return Response.json({ items: await nearWiki.get(key), source: "English Wikipedia (CC BY-SA 4.0)" });
  }
  if (name === "tts" && req.method === "POST") return speech(req);
  if (name === "story" && req.method === "GET") {
    const street = (u.searchParams.get("street") || "").trim().slice(0, 80);
    if (!street) return Response.json({ error: "street required" }, { status: 400 });
    if (!stories.has(street)) stories.set(street, streetStory(street).catch(() => { stories.delete(street); return { story: null }; }));
    return Response.json(await stories.get(street));
  }
  if (name === "qloo" && req.method === "GET") {
    try { return await qlooRoute(sub, u); }
    catch (e) { console.error("qloo:", e.message); return Response.json({ error: "qloo unavailable" }, { status: 502 }); }
  }
  if (!handlers[name]) return Response.json({ error: "not found" }, { status: 404 });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(u, { method: req.method, headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  return handlers[name](request);
}

async function file(u) {
  const rel = u.pathname === "/" ? "index.html" : normalize(decodeURIComponent(u.pathname)).replace(/^[\\/]+/, "");
  const top = rel.split(sep)[0].split("/")[0];
  if (rel !== "index.html" && !STATIC_DIRS.includes(top)) return null;
  if (rel.includes("..") || rel.includes("qloo-cache")) return null;
  try { return { body: await readFile(join(ROOT, rel)), type: TYPES[extname(rel)] || "application/octet-stream" }; }
  catch { return null; }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (u.pathname.startsWith("/api/")) {
      const r = await api(req, u);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const f = await file(u);
    if (!f) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "content-type": f.type });
    res.end(f.body);
  } catch (e) {
    console.error(u.pathname, e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "server error" }));
  }
}).listen(PORT, () => {
  console.log(`TasteWalk on http://localhost:${PORT}`);
});
