// Taste-aware walking audio guide on a 2D map (Leaflet + OpenStreetMap).
// You walk real streets and the places along the route explain themselves
// (ElevenLabs). The walking area is configured in city.js.
import { playNarration, prefetch, stop as audioStop, pause as audioPause, resume as audioResume, isPlaying } from "./audio.js";
import { initScene, followCam, orbitCam, moveAvatar3d, markVisited, resetPins, render, setEnvironment, updateRoute, setPinActive, addPin, removePin, highlightCourse, resetOrbit, flyTo, beginPeek, endPeekCam } from "./map2d.js";
import { CITY } from "./city.js";

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WALK_SPEED = 12;         // metres / second along the street path
const ROT_SPEED = 4;           // idle overview spin, deg/s
const POI_TRIGGER = 40;        // metres — "you're in front of it"
const FILLER_EVERY_M = 190;
const FILLER_GUARD_M = 90;     // no new story this close to the next stop
const TYPE_GLYPH = { food: "🍜", attraction: "📸", culture: "🎭", shopping: "🛍️", beauty: "💄", custom: "🎯" };

// themed courses — different travellers want different walks
const COURSES = [
  { id: "best", icon: "⭐", name: "Must See", pick: (p) => p.type === "attraction" || p.type === "culture" },
  { id: "food", icon: "🍜", name: "Foodie Tour", pick: (p) => p.type === "food" },
  { id: "shopping", icon: "🛍️", name: "Shopping", pick: (p) => p.type === "shopping" },
  { id: "all", icon: "🌟", name: "Everything", pick: () => true },
  { id: "picks", icon: "🎯", name: "My Picks", pick: (p) => state.picks.has(p.id) },
  // trip journal — every place the guide narrated (or you ✓-marked) lands here,
  // saved on this device so you can relive the trip back home
  { id: "journal", icon: "📒", name: "My Trip", pick: (p) => state.tripLog.has(p.id) },
  // my album — the photos you snapped (location + time tags), and where the
  // Gemini-narrated album is made. Not a route: it lists photos, not POIs.
  { id: "album", icon: "🎞", name: "My Album", pick: () => false },
];

// nearby subway stations — filled at boot from data/area-subway.json
const SUBWAY = [];

// spoken the moment the walk starts
const INTRO = `Welcome to ${CITY.area}! Pop your earphones in, follow the yellow line, and I'll tell you about the places we pass.`;

// photo spots — woven into EVERY course: when you pass one, the guide says why
// it's worth a shot and how to take it. Loaded at boot from data/area-photo-spots.json.
const PHOTO_SPOTS = [];

const state = {
  pois: [], coursePois: [], courseId: "best", picks: new Set(), fillers: [],
  zones: [], usedFacts: new Set(), fi: 0, photoDone: new Set(),
  tips: null, tipI: 0, tipsUsed: new Set(), tripLog: new Map(),
  graph: null, route: [], walkPath: [], cum: [], pathLen: 0, cumI: 1,
  // simulation always begins at CITY.start
  center: { lng: CITY.start.lng, lat: CITY.start.lat }, start: { lng: CITY.start.lng, lat: CITY.start.lat },
  activeId: null, visited: new Set(),
  mode: "sim", walkDist: 0, camHeading: 20, avatarPos: null,
  tour: { running: false, paused: false }, gps: { watchId: null, heading: 0 },
  _played: [], _playedIdx: null,   // ‹ Prev — everything the guide already said this walk
  peek: null,          // POI being "peeked at" mid-walk (camera detour)
  courseMods: {},      // per-course edits: { removed:Set, order:[ids] }
  photos: [],          // stamp-rally: {id, poiId|null, name, lng, lat, ts, dataUrl}
};

// ---------- geo ----------
const lerp = (a, b, t) => a + (b - a) * t;
function metersBetween(a, b, lat) {
  const k = Math.cos((lat * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 111320);
}
function bearingTo(a, b) {
  const dLng = (b.lng - a.lng) * Math.PI / 180, la = a.lat * Math.PI / 180, lb = b.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLng);
  const br = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return Number.isFinite(br) ? br : state.camHeading;
}

// ---------- street graph + routing ----------
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break;[a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (; ;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break;[a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
}
function buildGraph(streets) {
  const coord = new Map(), adj = new Map();
  const add = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, w]); };
  for (const way of streets.ways) for (let i = 0; i < way.length; i++) {
    const [id, lng, lat] = way[i]; coord.set(id, [lng, lat]);
    if (i > 0) { const [pid, plng, plat] = way[i - 1]; const w = metersBetween([lng, lat], [plng, plat], lat); add(id, pid, w); add(pid, id, w); }
  }
  // keep only the LARGEST connected component — snapping to a disconnected
  // island makes Dijkstra fail and the walker cut straight through buildings
  const seen = new Set(); let main = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set([start]), q = [start]; seen.add(start);
    while (q.length) {
      const u = q.pop();
      for (const [v] of (adj.get(u) || [])) if (!seen.has(v)) { seen.add(v); comp.add(v); q.push(v); }
    }
    if (comp.size > main.size) main = comp;
  }
  return { coord, adj, main };
}
function nearestNode(g, lng, lat) {
  let best = null, bd = Infinity;
  for (const id of g.main) {
    const c = g.coord.get(id);
    const d = metersBetween([lng, lat], c, lat);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
function dijkstraPath(g, src, dst) {
  const dist = new Map([[src, 0]]), prev = new Map(), done = new Set(), h = new Heap(); h.push([0, src]);
  while (h.size) {
    const [d, u] = h.pop(); if (done.has(u)) continue; done.add(u); if (u === dst) break;
    for (const [v, w] of (g.adj.get(u) || [])) { const nd = d + w; if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); h.push([nd, v]); } }
  }
  if (src !== dst && !prev.has(dst)) return null;
  const path = []; let cur = dst;
  while (cur !== undefined) { const c = g.coord.get(cur); path.push([c[0], c[1]]); if (cur === src) break; cur = prev.get(cur); }
  return path.reverse();
}
function densify(coords, step = 6) {
  const out = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1], d = metersBetween(a, b, a[1]), n = Math.max(1, Math.round(d / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]); }
  }
  out.push(coords[coords.length - 1]);
  return out;
}
function buildRoute(start, pois) {
  const rem = pois.slice(), route = []; let cur = start;
  while (rem.length) { let bi = 0, bd = Infinity; for (let i = 0; i < rem.length; i++) { const d = metersBetween([cur.lng, cur.lat], [rem[i].lng, rem[i].lat], cur.lat); if (d < bd) { bd = d; bi = i; } } cur = rem[bi]; route.push(rem.splice(bi, 1)[0]); }
  return route;
}
// routing-artifact fix: Dijkstra sometimes circles a tiny block (e.g. the
// cathedral's ring driveway) and pops out where it entered — walking that
// looks silly, so splice out short loops that don't serve any stop
function pruneWalkLoops(path, pois) {
  if (path.length < 8) return path;
  // POI proximity per path point, computed ONCE — the old per-pair scan over
  // every POI was O(points² × pois) and froze boot for ~16s on big courses
  const near40 = path.map(() => null), near42 = path.map(() => null);
  for (let k = 0; k < path.length; k++) {
    for (let pi = 0; pi < pois.length; pi++) {
      const p = pois[pi];
      if (Math.abs(p.lat - path[k][1]) > 0.0005 || Math.abs(p.lng - path[k][0]) > 0.0007) continue; // >~55m away
      const d = metersBetween(path[k], [p.lng, p.lat], p.lat);
      if (d < 40) (near40[k] ??= []).push(pi);
      if (d < 42) (near42[k] ??= []).push(pi);
    }
  }
  let restart = true;
  while (restart) {
    restart = false;
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + metersBetween(path[i - 1], path[i], path[i][1]);
    for (let i = 0; i < path.length - 3 && !restart; i++) {
      for (let j = i + 3; j < path.length && cum[j] - cum[i] < 110; j++) {
        if (metersBetween(path[i], path[j], path[i][1]) >= 14) continue;
        let loopServes = false; // does the loop pass a POI the junction itself doesn't already cover?
        for (let k = i + 1; k < j && !loopServes; k++) {
          if (near40[k]) for (const pi of near40[k]) if (!near42[i]?.includes(pi)) { loopServes = true; break; }
        }
        if (!loopServes) {
          path.splice(i + 1, j - i - 1);
          near40.splice(i + 1, j - i - 1); near42.splice(i + 1, j - i - 1);
          restart = true; break;              // re-scan after the splice
        }
      }
    }
  }
  return path;
}

function buildWalkPath(g, start, ordered) {
  const wps = [start, ...ordered]; let coords = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = nearestNode(g, wps[i].lng, wps[i].lat), b = nearestNode(g, wps[i + 1].lng, wps[i + 1].lat);
    let seg = dijkstraPath(g, a, b);
    if (!seg || seg.length < 2) seg = [[wps[i].lng, wps[i].lat], [wps[i + 1].lng, wps[i + 1].lat]];
    coords.push(...(coords.length ? seg.slice(1) : seg));
  }
  return densify(coords, 6);
}
function pointAlongPath(d) {
  const P = state.walkPath, C = state.cum;
  if (d <= 0) return { pos: P[0], heading: bearingTo({ lng: P[0][0], lat: P[0][1] }, { lng: P[1][0], lat: P[1][1] }) };
  let i = state.cumI; while (i < C.length && C[i] < d) i++; state.cumI = i;
  if (i >= P.length) return { pos: P[P.length - 1], heading: state.camHeading };
  const a = P[i - 1], b = P[i], seg = C[i] - C[i - 1], t = seg > 0 ? (d - C[i - 1]) / seg : 0;
  return { pos: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], heading: bearingTo({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] }) };
}

// ---------- ui ----------
function showError(t, m) { el("overlay").classList.remove("hidden"); el("spinner").style.display = "none"; el("overlayTitle").textContent = t; el("overlayMsg").innerHTML = m; el("overlayEta").textContent = ""; }
const hideOverlay = () => el("overlay").classList.add("hidden");
let toastTimer;
function toast(msg, ms = 3600) { const t = el("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(() => t.classList.remove("show"), ms); }
const toastClear = () => el("toast").classList.remove("show");

// ---------- game HUD ----------
const showHud = (on) => el("hud").classList.toggle("show", on);
function updateHud() {
  el("hudCount").textContent = `${state.visited.size} / ${state.coursePois.length}`;
  const pct = state.pathLen ? Math.min(100, (state.walkDist / state.pathLen) * 100) : 0;
  el("hudFill").style.width = pct.toFixed(1) + "%";
}
function setNowPlaying(text) {
  const n = el("hudNow"); if (!text) { n.hidden = true; return; }
  el("hudNowText").textContent = text; n.hidden = false;
}
let discTimer;
function showDiscovery(poi) {
  el("discName").textContent = poi.enName || poi.title;
  el("discKo").textContent = poi.title;
  const d = el("discovery"); d.classList.remove("show"); void d.offsetWidth; d.classList.add("show");
  clearTimeout(discTimer); discTimer = setTimeout(() => d.classList.remove("show"), 2400);
}

// ---------- Google Maps hand-off (foreigners live in Google Maps) ----------
const gmapsUrl = (p) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.title} ${p.addr || ""} ${CITY.city}`)}`;

// ---------- video preview (know a place BEFORE you walk in) ----------
function openVideo(p) {
  if (p.video) {
    // the video owns the speakers: pause the walk + whatever is talking, and
    // kill any narration still being fetched (it would start OVER the video)
    const wasPlaying = isPlaying();
    if (state.tour.running && !state.tour.paused) {
      state.tour.paused = true; el("pauseBtn").textContent = "Resume";
      state._videoPaused = true;
    }
    if (wasPlaying) { audioPause(); if (!state._videoPaused) state._videoPaused = "audio"; }
    else audioStop(); // nothing audible yet → invalidate in-flight TTS so it stays silent
    el("videoTitle").textContent = p.videoTitle || (p.enName || p.title);
    el("videoFrame").src = `https://www.youtube-nocookie.com/embed/${p.video}?autoplay=1`;
    el("videoModal").classList.add("show");
  } else {
    // no baked video yet — fall back to a YouTube search in a new tab
    window.open("https://www.youtube.com/results?search_query=" +
      encodeURIComponent(`${p.title} ${CITY.city}`), "_blank");
  }
}
function closeVideo() {
  el("videoModal").classList.remove("show");
  el("videoFrame").src = "";
  // resume exactly what we paused (directly — togglePause has peek-mode detours)
  if (state._videoPaused === true && state.tour.running && state.tour.paused) {
    state.tour.paused = false; el("pauseBtn").textContent = "Pause";
    audioResume();
  } else if (state._videoPaused === "audio") audioResume();
  state._videoPaused = false;
}

// ---------- spot card ----------
const fixImg = (u) => (u ? u.replace(/^http:\/\//, "https://") : "");
function showSpot(poi) {
  el("spotType").textContent = poi.type.toUpperCase(); el("spotType").className = "badge " + poi.type;
  el("spotIdx").textContent = `${state.visited.size} / ${state.coursePois.length}`;
  el("spotName").textContent = poi.enName || poi.title;
  el("spotKo").textContent = poi.title + (poi.tel ? " · " + poi.tel : "");
  el("spotBlurb").innerHTML = `<span class="audio-dot"></span>${poi.script || poi.overview || ""}`;
  // address — copyable, made to be shown to a taxi driver / shop staff
  const addr = poi.addr || "";
  el("spotAddrRow").style.display = addr ? "" : "none";
  el("spotAddr").textContent = addr;
  el("spotCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(addr); toast("📋 Address copied"); }
    catch { toast("Couldn't copy — long-press the address to select it"); }
  };
  const img = el("spotPhoto"), src = fixImg(poi.image); if (src) { img.src = src; img.hidden = false; } else img.hidden = true;
  document.querySelector(".spot-actions").style.display = "";
  const vb = el("spotVideo");
  vb.textContent = poi.video ? "▶ Watch preview" : "▶ Preview";
  vb.onclick = () => openVideo(poi);
  // first video spot after picking a course: point out the preview tab
  if (poi.video && !state._videoHintShown) {
    state._videoHintShown = true;
    document.querySelector(".spot-actions .video-hint")?.remove();
    const hint = document.createElement("div");
    hint.className = "video-hint";
    hint.textContent = "🎬 Tap below to watch a YouTube preview of this spot 👇";
    document.querySelector(".spot-actions").appendChild(hint);
    vb.classList.add("pulse");
    const clear = () => { hint.remove(); vb.classList.remove("pulse"); };
    hint.onclick = clear;
    vb.addEventListener("click", clear, { once: true });
    clearTimeout(state._videoHintTimer);
    state._videoHintTimer = setTimeout(clear, 12000);
  }
  el("spotGmap").href = gmapsUrl(poi);
  el("spotCard").classList.add("show"); flagCardUpdate();
}
function showPhotoCard(ps) {
  el("spotType").textContent = "📸 PHOTO SPOT"; el("spotType").className = "badge beauty";
  el("spotIdx").textContent = ""; el("spotName").textContent = ps.enName;
  el("spotKo").textContent = ps.ko || "Photo spot"; el("spotBlurb").innerHTML = `<span class="audio-dot"></span>${ps.tip}`;
  el("spotAddrRow").style.display = "none";
  el("spotPhoto").hidden = true;
  document.querySelector(".spot-actions").style.display = "none";
  el("spotCard").classList.add("show"); flagCardUpdate();
}
function showFillerCard(text, where = "", zoneImg = "") {
  el("spotType").textContent = where ? "LOCAL STORY" : CITY.area.toUpperCase(); el("spotType").className = "badge attraction";
  el("spotIdx").textContent = ""; el("spotName").textContent = where || `About ${CITY.area}`;
  el("spotKo").textContent = "Local story"; el("spotBlurb").innerHTML = `<span class="audio-dot"></span>${text}`;
  el("spotAddrRow").style.display = "none";
  // the zone's own photo — every story shows the place it talks about
  const img = el("spotPhoto");
  const src = zoneImg;
  if (src) { img.src = src; img.hidden = false; } else img.hidden = true;
  document.querySelector(".spot-actions").style.display = "none";
  el("spotCard").classList.add("show"); flagCardUpdate();
}

// ---------- narration ----------
function nearestUnvisitedWithin(lng, lat, r) {
  let best = null, bd = r;
  for (const p of state.coursePois) { if (state.visited.has(p.id)) continue; const d = metersBetween([lng, lat], [p.lng, p.lat], lat); if (d < bd) { bd = d; best = p; } }
  return best;
}
// tiny synthesized arrival chimes — you HEAR what kind of stop this is,
// even before the guide speaks (no audio files, no TTS credits)
let earCtx;
function earcon(kind) {
  try {
    earCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const t0 = earCtx.currentTime;
    const TUNES = {
      arrive: [[784, 0, .16], [1175, .15, .26]],                    // ding-dong — a course stop
      food: [[659, 0, .11], [880, .1, .11], [1319, .2, .24]],       // rising — something tasty
      photo: [[1568, 0, .05], [1046, .07, .1]],                     // camera click-clack
      tip: [[880, 0, .08], [1109, .09, .08], [1480, .18, .2]],      // sparkle — insider tip
    };
    for (const [f, at, dur] of TUNES[kind] || TUNES.arrive) {
      const o = earCtx.createOscillator(), gn = earCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      gn.gain.setValueAtTime(0.0001, t0 + at);
      gn.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(gn).connect(earCtx.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
    }
  } catch { /* no WebAudio — skip the chime */ }
}
// the instant the guide starts talking, the sidebar row gets its green check
function checkOffSidebar(id) {
  document.querySelectorAll(`.side-item[data-id="${id}"]`).forEach((it) => {
    it.classList.add("done", "just");
    it.querySelector(".si-been")?.classList.add("on");
    it.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => it.classList.remove("just"), 1600);
  });
}
async function narratePoi(poi) {
  // Next/Prev bump _navEpoch: a stale narration chain must stop between clips
  const ep = state._navEpoch || 0;
  const alive = () => ep === (state._navEpoch || 0);
  pushPlayed({ kind: "poi", poi });
  state.activeId = poi.id; state.visited.add(poi.id); markVisited(poi.id); logVisit(poi);
  earcon(poi.type === "food" ? "food" : "arrive");
  checkOffSidebar(poi.id);
  const side = sideOf(poi);
  showSpot(poi); updateHud(); showDiscovery(poi); setNowPlaying(`🎧 ${poi.enName || poi.title}`);
  const next = state.coursePois.find((p) => !state.visited.has(p.id));
  if (next) prefetch(next.script);
  if (side) { await playNarration(`Look to your ${side}.`); if (!alive()) return; }
  await playNarration(poi.script || poi.overview || `${poi.enName || poi.title}, a favourite spot in ${CITY.area}.`);
  if (!alive()) return;
  // non-food stops earn an insider tip matched to the live weather/time
  if (poi.type !== "food") {
    const tip = pickLocalTip();
    if (tip) {
      state.tipI++;
      earcon("tip");
      showTipCard(state.tipI, tip); setNowPlaying(`💡 Local tip #${state.tipI}`);
      // separate clips so every part hits the baked-audio cache
      await playNarration(`Local tip number ${state.tipI}.`);
      if (!alive()) return;
      await playNarration(tip.text);
      if (!alive()) return;
      if (tip.rec) {
        await playNarration(`Locals' favourite for this is ${tip.rec.name}, just around here.`);
        if (!alive()) return;
        if (tip.rec.tip) await playNarration(tip.rec.tip);
      }
    }
  }
}
// pick a story about WHERE you are right now: zone facts (real local history)
// first, generic area lines only when the area's stories run out
// ---------- turn-by-turn hints (works on the same route graph in sim & GPS) ----------
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
function sideOf(poi) {
  const a = state.avatarPos, h = state.lastHeading;
  if (!a || h == null) return "";
  const d = angDiff(h, bearingTo(a, [poi.lng, poi.lat]));
  if (Math.abs(d) < 25 || Math.abs(d) > 155) return "";   // ahead/behind — no callout
  return d > 0 ? "right" : "left";
}
// simulation: next sharp corner within 26 m of the avatar's progress
function upcomingTurn() {
  const { cum, walkPath: path } = state;
  for (let i = 1; i < path.length - 1; i++) {
    if (cum[i] <= state.walkDist) continue;
    if (cum[i] - state.walkDist > 26) return null;
    const d = angDiff(bearingTo(path[i - 1], path[i]), bearingTo(path[i], path[i + 1]));
    if (Math.abs(d) < 38) continue;
    return { i, dir: d > 0 ? "right" : "left" };
  }
  return null;
}
// GPS: nearest sharp corner within 28 m of the real position
function gpsUpcomingTurn(a) {
  let bi = -1, bd = 28;
  const path = state.walkPath;
  for (let i = 1; i < path.length - 1; i++) {
    const d = metersBetween(a, path[i], a[1]);
    if (d < bd) { bd = d; bi = i; }
  }
  if (bi < 1) return null;
  const d = angDiff(bearingTo(path[bi - 1], path[bi]), bearingTo(path[bi], path[bi + 1]));
  if (Math.abs(d) < 38) return null;
  return { i: bi, dir: d > 0 ? "right" : "left" };
}

// pick an insider tip matching the REAL current conditions (live weather/time)
function pickLocalTip() {
  if (!state.tips) return null;
  const w = env.weather || {}, hr = envDate().getHours();
  const order = [];
  if (w.kind === "rain") order.push("rain");
  if (w.kind === "snow") order.push("snow");
  if (w.temp != null && w.temp >= 27) order.push("hot");
  if (w.temp != null && w.temp <= 8) order.push("cold");
  if (hr >= 18 || hr < 5) order.push("night");
  if (hr >= 6 && hr < 11) order.push("morning");
  order.push("any");
  for (const k of order)
    for (const t of state.tips[k] || []) {
      const key = t.text || t;
      if (!state.tipsUsed.has(key)) {
        state.tipsUsed.add(key);
        return typeof t === "string" ? { text: t, rec: null } : t;
      }
    }
  return null;
}
function showTipCard(n, tip) {
  el("spotType").textContent = `💡 LOCAL TIP #${n}`; el("spotType").className = "badge custom";
  el("spotIdx").textContent = ""; el("spotName").textContent = "Like a Local";
  el("spotKo").textContent = "Local tip";
  const text = tip.text || tip;                 // tolerate plain-string tips
  const rec = tip.rec
    ? `<br><br>📍 <b>${tip.rec.name}</b>${tip.rec.addr ? " · " + tip.rec.addr : ""}` +
      (tip.rec.tip ? `<br>👉 ${tip.rec.tip}` : "")
    : "";
  // one wrapping button row — order: preview → save → maps (maps may wrap)
  const btns = [];
  if (tip.food?.video) btns.push(`<button class="tip-yt">🎬 Watch preview</button>`);
  if (tip.rec?.lng !== undefined) btns.push(`<button class="tip-save">🎯 Save for later</button>`);
  if (tip.rec?.name) {
    const q = encodeURIComponent(tip.rec.name + (tip.rec.addr ? " " + tip.rec.addr : ""));
    btns.push(`<a class="tip-map" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">🗺️ Google Maps</a>`);
  }
  const btnRow = btns.length ? `<div class="tip-btns">${btns.join("")}</div>` : "";
  el("spotBlurb").innerHTML = `<span class="audio-dot"></span>${text}${rec}${btnRow}`;
  el("spotBlurb").querySelector(".tip-yt")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openVideo({ video: tip.food.video, videoTitle: tip.food.videoTitle, title: tip.food.name, enName: tip.food.name });
  });
  el("spotBlurb").querySelector(".tip-save")?.addEventListener("click", (e) => {
    e.stopPropagation();
    saveTipRec(n, tip);
    e.target.textContent = "✓ Saved to My Picks";
    e.target.disabled = true;
  });
  el("spotAddrRow").style.display = "none";
  const img = el("spotPhoto");
  // food tips show the FOOD itself; a tip never needs the shop's storefront photo
  if (tip.food?.img) { img.src = tip.food.img; img.hidden = false; } else img.hidden = true;
  document.querySelector(".spot-actions").style.display = "none";
  el("spotCard").classList.add("show"); flagCardUpdate();
}
// ---------- mobile: swipe the card sideways → it tucks into an ⓘ chip ----------
// narration keeps playing; new stops pulse the chip instead of re-opening the card
function minimizeCard() { el("spotCard").classList.add("min"); el("cardMini").classList.add("show"); }
function restoreCard() { el("spotCard").classList.remove("min"); el("cardMini").classList.remove("show", "pulse"); }
function flagCardUpdate() {
  if (!el("spotCard").classList.contains("min")) return;
  const m = el("cardMini");
  m.classList.remove("pulse"); void m.offsetWidth; m.classList.add("pulse");
}

// tip recommendation → a real My Picks stop, tagged so you remember why it's there
function saveTipRec(n, tip) {
  const r = tip.rec;
  if (!r || r.lng === undefined) return;
  addGooglePlace({
    id: "tip" + n + "-" + r.name.replace(/\W+/g, "").slice(0, 14),
    name: r.name, kind: `💡 Local tip #${n}`, addr: r.addr || "",
    lng: r.lng, lat: r.lat, image: r.image || "", hours: null,
  }, null);
}
function nearestPhotoSpot(pos, r) {
  let best = null, bd = r;
  for (const p of PHOTO_SPOTS) {
    if (state.photoDone.has(p.id)) continue;
    const d = metersBetween(pos, [p.lng, p.lat], p.lat);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function localStory(pos) {
  let z = null, bd = Infinity;
  for (const zone of state.zones) {
    const d = metersBetween(pos, [zone.lng, zone.lat], zone.lat);
    if (d < zone.r && d < bd) { bd = d; z = zone; }
  }
  if (z) {
    const fact = z.facts.find((t) => !state.usedFacts.has(t));
    if (fact) { state.usedFacts.add(fact); return { text: fact, where: z.name, img: z.image }; }
  }
  if (!state.fillers.length) return null;
  return { text: state.fillers[state.fi++ % state.fillers.length], where: "", img: "" };
}
async function walkNarrationLoop() {
  // on state so a mid-walk reroute (insertStopMidWalk) can reset the pacing
  state._lastNarrate = -FILLER_EVERY_M;
  while (state.tour.running) {
    if (state.tour.paused) { await sleep(150); continue; }
    const a = state.avatarPos;
    if (a) {
      const poi = nearestUnvisitedWithin(a[0], a[1], POI_TRIGGER);
      if (poi) {
        state.tour.paused = true;
        // never cut a story mid-sentence — let it finish before the spot intro
        while (isPlaying() && state.tour.running) await sleep(150);
        if (!state.tour.running) break;
        toast(`📍 ${poi.enName || poi.title}`);
        await narratePoi(poi);
        state.tour.paused = false;
        state._lastNarrate = state.walkDist;
      } else if (!isPlaying()) {
        const turn = upcomingTurn();
        const ps = turn ? null : nearestPhotoSpot(a, 40);
        if (turn && state._turnIdx !== turn.i) {
          state._turnIdx = turn.i;
          playNarration(`Coming up — turn ${turn.dir}.`);
        } else if (ps) {
          state.photoDone.add(ps.id);
          earcon("photo");
          pushPlayed({ kind: "photo", ps });
          showPhotoCard(ps); setNowPlaying(`📸 ${ps.enName}`); playNarration(ps.tip);
          state._lastNarrate = state.walkDist;
        } else if (state.walkDist - state._lastNarrate > FILLER_EVERY_M
                   && !nearestUnvisitedWithin(a[0], a[1], FILLER_GUARD_M)) {
          const story = localStory(a);
          if (story) {
            const { text, where, img } = story;
            pushPlayed({ kind: "story", text, where, img });
            showFillerCard(text, where, img); setNowPlaying(`🎧 ${where || "About " + CITY.area}`); playNarration(text);
          }
          state._lastNarrate = state.walkDist;
        }
      }
    }
    updateHud();
    await sleep(220);
  }
}

// ---------- themed courses ----------
const ROUTE_CACHE = new Map();
function routeOrigin() {
  // GPS: route from wherever you are; simulation: always CITY.start
  return state.mode === "gps" && state.avatarPos
    ? { lng: state.avatarPos[0], lat: state.avatarPos[1] } : state.start;
}
function applyCourse(id) {
  state.courseId = id;
  state._videoHintShown = false; // re-point at Watch preview on each course's first spot
  const course = COURSES.find((c) => c.id === id);
  state.coursePois = state.pois.filter(course.pick);
  // user edits: ✕-removed stops drop out, dragged order wins over auto-routing
  const mods = state.courseMods[id];
  if (mods) {
    state.coursePois = state.coursePois.filter((p) => !mods.removed.has(p.id));
    if (mods.order) {
      const rank = new Map(mods.order.map((x, i) => [x, i]));
      state.coursePois.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    }
  }
  if (state.coursePois.length) {
    const origin = routeOrigin();
    // routing is the expensive part (dijkstra + loop-pruning) — reuse it when
    // the same course is re-picked from the same origin with the same stops
    const key = `${origin.lng.toFixed(5)},${origin.lat.toFixed(5)}|${mods?.order ? "ord|" : ""}${state.coursePois.map((p) => p.id).join(",")}`;
    const hit = ROUTE_CACHE.get(key);
    if (hit) { state.route = hit.route; state.walkPath = hit.walkPath; }
    else {
      state.route = mods?.order ? state.coursePois.slice() : buildRoute(origin, state.coursePois);
      state.walkPath = pruneWalkLoops(buildWalkPath(state.graph, origin, state.route), state.coursePois);
      ROUTE_CACHE.set(key, { route: state.route, walkPath: state.walkPath });
    }
    state.cum = [0]; for (let i = 1; i < state.walkPath.length; i++) state.cum[i] = state.cum[i - 1] + metersBetween(state.walkPath[i - 1], state.walkPath[i], state.walkPath[i][1]);
    state.pathLen = state.cum[state.cum.length - 1];
    updateRoute(state.walkPath);
  } else { state.pathLen = 0; updateRoute([[state.start.lng, state.start.lat], [state.start.lng, state.start.lat]]); }
  state.walkDist = 0; state.cumI = 1; state.visited.clear(); state.activeId = null;
  setPinActive(new Set(state.coursePois.map((p) => p.id)));
  highlightCourse(state.coursePois.map((p) => [p.lng, p.lat]));
  updateHud();
  document.querySelectorAll("#courseBar button").forEach((b) => b.classList.toggle("active", b.dataset.course === id));
  el("courseBar").classList.remove("open");   // mobile: picking a course closes the picker
  syncMobChips();
  renderSidebar();
  el("startBtn").disabled = !state.coursePois.length;
}
// mobile chips mirror the current course + sidebar state
function syncMobChips() {
  const c = COURSES.find((x) => x.id === state.courseId);
  const mc = el("mobCourse");
  if (mc && c) mc.textContent = `${c.icon} ${c.name}`;
  el("mobList")?.classList.toggle("on", !el("sidebar").classList.contains("folded"));
}

// ---------- My Picks — build your own route ----------
function savePicks() {
  const custom = state.pois.filter((p) => p.type === "custom" && state.picks.has(p.id));
  localStorage.setItem("md3d-picks", JSON.stringify({ ids: [...state.picks], custom }));
}
function loadPicks() {
  try {
    const { ids, custom } = JSON.parse(localStorage.getItem("md3d-picks") || "{}");
    for (const p of custom || []) if (!state.pois.find((x) => x.id === p.id)) { state.pois.push(p); addPin(p, TYPE_GLYPH.custom); }
    for (const id of ids || []) if (state.pois.find((p) => p.id === id)) state.picks.add(id);
  } catch { /* fresh start */ }
}
// ---------- trip journal (다녀간 곳) ----------
function saveTrip() { localStorage.setItem("md3d-trip", JSON.stringify([...state.tripLog])); }
function loadTrip() {
  try { for (const [id, ts] of JSON.parse(localStorage.getItem("md3d-trip") || "[]")) state.tripLog.set(id, ts); }
  catch { /* fresh start */ }
}
// ---------- stamp rally: snap a photo, it's tagged to where you are ----------
function savePhotos() {
  // photos are ~100 KB each; if localStorage overflows, drop the oldest
  for (;;) {
    try { localStorage.setItem("md3d-photos", JSON.stringify(state.photos)); return; }
    catch { if (!state.photos.length) return; state.photos.shift(); }
  }
}
function loadPhotos() {
  try { state.photos = JSON.parse(localStorage.getItem("md3d-photos") || "[]"); }
  catch { /* fresh start */ }
}
function compressImage(file, maxW = 720) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxW / im.width);
      const cv = document.createElement("canvas");
      cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL("image/jpeg", 0.72));
    };
    im.onerror = rej;
    im.src = url;
  });
}
function nearestSpotName(pos) {
  let best = null, bd = 130;
  for (const x of state.pois) { const d = metersBetween(pos, [x.lng, x.lat], pos[1]); if (d < bd) { bd = d; best = x; } }
  return best ? "near " + (best.enName || best.title) : CITY.area;
}
function snapPhoto(poi) {
  state._camTarget = poi || null;
  const inp = el("camInput");
  inp.value = "";
  inp.click();          // phone: opens the camera; desktop: file picker
}
async function onCamPick(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  let dataUrl;
  try { dataUrl = await compressImage(f); } catch { toast("Couldn't read that photo"); return; }
  const p = state._camTarget;
  const pos = p ? [p.lng, p.lat] : (state.avatarPos || [state.start.lng, state.start.lat]);
  const entry = {
    id: "shot-" + Date.now(), poiId: p?.id || null,
    name: p ? (p.enName || p.title) : nearestSpotName(pos),
    lng: pos[0], lat: pos[1], ts: Date.now(), dataUrl,
    wx: env.weather ? { kind: env.weather.kind, temp: env.weather.temp } : null,
  };
  state.photos.push(entry);
  savePhotos();
  if (p) logVisit(p);
  earcon("photo");
  toast(`📸 Tagged at ${entry.name}${wxLabel(entry.wx) ? " · " + wxLabel(entry.wx) : ""} — saved to 🎞 My Album`);
  albumChip();
  renderSidebar();
}

// ---------- the album: Gemini narrates your day, ElevenLabs speaks it ----------
const ALBUM_VOICE = "ZF6FPAbjXT4488VcRRnw"; // "Amelia" — same voice as the baked guide clips (paid plan)
function wxLabel(wx) {
  if (!wx) return "";
  return `${WX_EMOJI[wx.kind] || "☀️"} ${wx.temp != null ? wx.temp + "°" : wx.kind}`;
}
function sceneMeta(s) {
  // scrapbook print label: "PLACE NAME · 14:20 · ☀️ 29°" + a small geo line
  const parts = [s.name || CITY.area.toUpperCase()];
  if (s.ts) parts.push(new Date(s.ts).toTimeString().slice(0, 5));
  const w = wxLabel(s.wx);
  if (w) parts.push(w);
  const geo = s.lat != null && s.lng != null ? `<span class="alb-geo">📍 ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</span>` : "";
  return `${parts.join(" · ").toUpperCase()}${geo}`;
}
function albumTimeline() {
  // the album is the traveller's own camera roll — only photos they snapped, in order
  return state.photos
    .filter((s) => s.dataUrl)
    .map((s) => ({ name: s.name, img: s.dataUrl, ts: s.ts, photo: true, lng: s.lng, lat: s.lat, wx: s.wx || null }))
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 14);
}
async function makeAlbum() {
  const scenes = albumTimeline();
  if (!scenes.length) { toast("No photos yet — snap 📷 at the places you visit, then make your album!"); return; }
  toast("🎞 Gemini is writing your album…");
  let story = null;
  try {
    const r = await fetch("/api/album", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // the photos themselves go along — Gemini looks at what's IN each shot
        // and writes the story from that; the location tag is only a hint
        stops: scenes.map((s) => ({
          name: s.name, photo: s.photo, img: s.img,
          time: new Date(s.ts).toTimeString().slice(0, 5),
          weather: s.wx ? `${s.wx.kind}${s.wx.temp != null ? " " + s.wx.temp + "°C" : ""}` : null,
        })),
      }),
    });
    story = (await r.json());
    if (!Array.isArray(story?.scenes) || !story.scenes.length) story = null;
  } catch { /* fall back to the template below */ }
  if (!story) story = {
    title: `Our ${CITY.area} Day`,
    intro: `So — remember this day? We wandered all over ${CITY.area} together.`,
    scenes: scenes.map((s) => `Then we stopped at ${s.name} — such a good call.`),
    outro: "What a day that was. Next time, we eat even more.",
  };
  if (state.tour.running) endPeekMode();
  audioStop();
  state._album = { scenes, story, on: true };
  el("album").hidden = false;
  runAlbum();
}
function albumTitleCard(A, dateTs) {
  const kick = CITY.area.toUpperCase() + " · " + new Date(dateTs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase();
  return `<div class="at-kick">${kick}</div><div class="at-main">${A.story.title}</div><div class="at-rule"></div>`;
}
async function runAlbum() {
  const A = state._album;
  const img = el("albumImg"), cap = el("albumCap"), ttl = el("albumTitle");
  const n = A.scenes.length;
  // no cover card — a one-line scene-setter is spoken OVER the first photo,
  // and the small standing header line carries the title
  el("albumKick").textContent = `${CITY.area.toUpperCase()} TRIP · ${new Date(A.scenes[0].ts || Date.now()).getFullYear()}`;
  el("albumPrint").className = "album-print tilt-l";
  img.src = A.scenes[0].img; img.className = "kb1"; cap.textContent = "";
  el("albumMeta").innerHTML = sceneMeta(A.scenes[0]);
  el("albumPage").textContent = `01 / ${String(n).padStart(2, "0")}`;
  await playNarration(A.story.intro, { voiceId: ALBUM_VOICE });
  if (!A.on) return;
  for (let i = 0; i < n && A.on; i++) {
    el("albumPrint").className = "album-print " + (i % 2 ? "tilt-r" : "tilt-l");
    img.src = A.scenes[i].img; img.className = i % 2 ? "kb2" : "kb1";
    cap.textContent = A.story.scenes[i] || A.scenes[i].name;
    el("albumMeta").innerHTML = sceneMeta(A.scenes[i]);
    el("albumPage").textContent = `${String(i + 1).padStart(2, "0")} / ${String(n).padStart(2, "0")}`;
    await playNarration(A.story.scenes[i] || A.scenes[i].name, { voiceId: ALBUM_VOICE });
    if (!A.on) return;
    await sleep(400);
  }
  if (!A.on) return;
  ttl.innerHTML = albumTitleCard(A, A.scenes[0].ts || Date.now()); ttl.classList.add("show");
  await playNarration(A.story.outro, { voiceId: ALBUM_VOICE });
  await sleep(1200);
  closeAlbum();
}
function closeAlbum() {
  if (state._album) state._album.on = false;
  state._album = null;
  audioStop();
  el("album").hidden = true;
  el("albumTitle").classList.remove("show");
}
function journalChip() {
  const chip = document.querySelector('#courseBar button[data-course="journal"] .cs');
  if (chip) chip.textContent = `${state.tripLog.size} spots`;
}
function logVisit(poi) {
  if (state.tripLog.has(poi.id)) return;
  state.tripLog.set(poi.id, Date.now());
  saveTrip(); journalChip();
}
function toggleBeen(poi) {
  state.tripLog.has(poi.id) ? state.tripLog.delete(poi.id) : state.tripLog.set(poi.id, Date.now());
  saveTrip(); journalChip();
  if (state.courseId === "journal") applyCourse("journal");
  else document.querySelectorAll(`.side-item[data-id="${poi.id}"] .si-been`)
    .forEach((b) => b.classList.toggle("on", state.tripLog.has(poi.id)));
  toast(state.tripLog.has(poi.id) ? `📒 Saved to My Trip (${state.tripLog.size})` : `Removed from My Trip`);
}

function togglePick(poi) {
  const adding = !state.picks.has(poi.id);
  adding ? state.picks.add(poi.id) : state.picks.delete(poi.id);
  savePicks();
  const chip = document.querySelector('#courseBar button[data-course="picks"] .cs');
  if (chip) chip.textContent = `${state.picks.size} spots`;
  if (adding && state.tour.running) {
    // walking: ＋ doesn't just bookmark it — it detours the live route there
    insertStopMidWalk(poi);
    return;
  }
  if (state.courseId === "picks" && !state.tour.running) applyCourse("picks");
  else {
    document.querySelectorAll(`.side-item[data-id="${poi.id}"] .si-add`)
      .forEach((b) => b.classList.toggle("on", state.picks.has(poi.id)));
    toast(state.picks.has(poi.id)
      ? `🎯 Added to My Picks (${state.picks.size}) — tap the 🎯 course to route it`
      : `Removed — My Picks (${state.picks.size})`);
  }
}

// ---------- add ANY place from Google search ----------
const compressHours = (descs) => {
  if (!descs?.length) return "";
  const ranges = descs.map((d) => d.replace(/^[A-Za-z]+:\s*/, "").trim());
  return [...new Set(ranges)].length === 1
    ? (ranges[0] === "Closed" ? "" : "Daily " + ranges[0]) : ranges[0] + " (varies)";
};
async function googleSearch(q) {
  const box = el("gResults");
  box.innerHTML = `<div class="g-hint">Searching Google…</div>`;
  try {
    const { places, error } = await (await fetch("/api/places?q=" + encodeURIComponent(q))).json();
    if (error || !places?.length) { box.innerHTML = `<div class="g-hint">No results — try another name</div>`; return; }
    box.innerHTML = "";
    for (const g of places) {
      const row = document.createElement("div");
      row.className = "g-result";
      const thumb = g.image ? `<img class="g-img" loading="lazy" src="${g.image}" alt="">` : `<div class="g-img si-ph">🎯</div>`;
      row.innerHTML = `${thumb}<div class="g-body">
          <div class="g-name">${g.name}</div>
          <div class="g-meta">${g.kind ? g.kind + " · " : ""}${g.addr.slice(0, 44)}</div>
        </div><button class="si-add">＋</button>`;
      row.querySelector(".si-add").addEventListener("click", () => addGooglePlace(g, row));
      box.append(row);
    }
  } catch { box.innerHTML = `<div class="g-hint">Search failed — is the server up?</div>`; }
}
function addGooglePlace(g, row) {
  // walkable map covers the area only — reject picks the route can't reach
  if (metersBetween([g.lng, g.lat], [state.center.lng, state.center.lat], g.lat) > 1400) {
    toast(`🚫 That place is outside the ${CITY.area} walking map`);
    return;
  }
  const id = "gp-" + g.id;
  if (!state.pois.find((p) => p.id === id)) {
    const poi = {
      id, type: "custom", title: g.name, enName: g.name,
      lng: g.lng, lat: g.lat, addr: g.addr, tel: "", image: g.image || "",
      hours: compressHours(g.hours), menu: g.kind, overview: "",
      script: `${g.name}. ${g.kind ? "A " + g.kind.toLowerCase() + " you picked yourself — " : ""}this is one of your own stops. Take your time here, then follow the route to your next pick.`,
    };
    state.pois.push(poi);
    addPin(poi, TYPE_GLYPH.custom);
    // Gemini writes a real guide script for this place in the background
    fetch("/api/narrate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: g.name, kind: g.kind, addr: g.addr }),
    }).then((r) => r.json()).then(({ script }) => {
      if (script) { poi.script = script; poi.scriptBy = "gemini"; prefetch(script); savePicks(); }
    }).catch(() => { /* template script stays */ });
  }
  state.picks.add(id);
  savePicks();
  row?.querySelector(".si-add")?.classList.add("on");
  if (state.tour.running) {
    insertStopMidWalk(state.pois.find((p) => p.id === id));
    return;
  }
  toast(`🎯 ${g.name} added to My Picks (${state.picks.size})`);
  if (state.courseId === "picks") applyCourse("picks");
}

// mid-walk detour: slot a new stop into the REMAINING route and re-path from
// where you stand — visited stamps and the running narration survive intact
function insertStopMidWalk(poi) {
  const a = state.avatarPos;
  if (!poi || !a || !state.tour.running) return;
  if (state.visited.has(poi.id)) { toast(`✓ Already visited ${poi.enName || poi.title} on this walk`); return; }
  if (!state.coursePois.find((x) => x.id === poi.id)) state.coursePois.push(poi);
  const remaining = state.route.filter((p) => !state.visited.has(p.id) && p.id !== poi.id);
  // nearest-insertion: put the new stop where it adds the least extra walking
  const pts = [a, ...remaining.map((p) => [p.lng, p.lat])];
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const nxt = pts[i + 1] || null;
    const added = metersBetween(pts[i], [poi.lng, poi.lat], poi.lat)
      + (nxt ? metersBetween([poi.lng, poi.lat], nxt, poi.lat) - metersBetween(pts[i], nxt, poi.lat) : 0);
    if (added < bd) { bd = added; best = i; }
  }
  remaining.splice(best, 0, poi);
  state.route = [...state.route.filter((p) => state.visited.has(p.id)), ...remaining];
  state.walkPath = pruneWalkLoops(buildWalkPath(state.graph, { lng: a[0], lat: a[1] }, remaining), remaining);
  state.cum = [0];
  for (let i = 1; i < state.walkPath.length; i++) state.cum[i] = state.cum[i - 1] + metersBetween(state.walkPath[i - 1], state.walkPath[i], state.walkPath[i][1]);
  state.pathLen = state.cum[state.cum.length - 1];
  state.walkDist = 0; state.cumI = 1; state._turnIdx = -1; state._lastNarrate = 0;
  updateRoute(state.walkPath);
  setPinActive(new Set(state.coursePois.map((p) => p.id)));
  highlightCourse(state.coursePois.map((p) => [p.lng, p.lat]));
  updateHud();
  renderSidebar();
  toast(`🧭 Detour! ${poi.enName || poi.title} is now on your route`);
}

// ---------- sidebar: the current course as a browsable list ----------
const fmtKm = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
function poiDistance(p) {
  const from = state.avatarPos || [state.start.lng, state.start.lat];
  return metersBetween(from, [p.lng, p.lat], p.lat);
}
function renderSidebar() {
  el("sidebar").classList.toggle("wide", !!state._actsOpen);   // rows remember open/closed across re-renders
  const course = COURSES.find((c) => c.id === state.courseId);
  el("sideTitle").textContent = `${course.icon} ${course.name}`;
  el("sideCount").textContent = `${state.coursePois.length}`;
  const list = el("sideList");
  list.innerHTML = "";
  if (state.courseId === "album") { renderAlbumTab(list); return; }
  // Google search lives in My Picks — and during a walk too, so you can
  // spot a place on the street and detour to it without stopping the tour
  if (state.courseId === "picks" || state.tour.running) {
    const s = document.createElement("div");
    s.className = "side-search";
    s.innerHTML = `<input id="gSearch" type="search" placeholder="${state.tour.running
      ? "🔍 Add a stop mid-walk — Google search" : "🔍 Add any place — Google search"}" autocomplete="off" />
      <div id="gResults"></div>`;
    s.querySelector("#gSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.value.trim()) googleSearch(e.target.value.trim());
    });
    list.append(s);
    if (state.courseId === "picks" && !state.coursePois.length) {
      const h = document.createElement("div");
      h.className = "g-hint";
      h.textContent = "Search Google above, or tap ＋ in any course list.";
      list.append(h);
    }
  }
  if (state.courseId === "journal" && !state.coursePois.length) {
    const h = document.createElement("div");
    h.className = "g-hint";
    h.textContent = "Your trip diary is empty — walk a course and tap ✓ on places you've been. Photos live in 🎞 My Album.";
    list.append(h);
  }
  const pois = (state.courseMods[state.courseId]?.order || state.courseId === "picks") ? state.coursePois
    : state.courseId === "journal"
      ? [...state.coursePois].sort((a, b) => (state.tripLog.get(a.id) || 0) - (state.tripLog.get(b.id) || 0))
      : [...state.coursePois].sort((a, b) => poiDistance(a) - poiDistance(b));
  for (const p of pois) {
    const item = document.createElement("div");
    item.className = "side-item" + (state.visited.has(p.id) ? " done" : "") + (state._actsOpen ? " acts" : "");
    item.dataset.id = p.id;
    const img = p.image ? `<img loading="lazy" draggable="false" src="${fixImg(p.image)}" alt="">`
      : `<div class="si-ph">${TYPE_GLYPH[p.type] || "📍"}</div>`;
    const shots = state.photos.filter((s) => s.poiId === p.id).length;
    item.innerHTML = `<div class="si-stamp">✓</div>${shots ? `<div class="si-shot">📸${shots > 1 ? shots : ""}</div>` : ""}${img}
      <div class="si-body">
        <div class="si-name">${p.enName || p.title}</div>
        <div class="si-ko">${p.title}</div>
        <div class="si-meta">${state.courseId === "journal" && state.tripLog.get(p.id)
          ? "📒 " + new Date(state.tripLog.get(p.id)).toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · "
          : ""}📍 <span class="si-km">${fmtKm(poiDistance(p))}</span>${p.hours ? " · ⏰ " + p.hours.slice(0, 26) : ""}</div>
        ${p.menu ? `<div class="si-menu">${TYPE_GLYPH[p.type] || ""} ${p.menu.slice(0, 34)}</div>` : ""}
      </div>
      <button class="si-more" title="Actions — photo, video, been-here, save, remove">⋯</button>
      <div class="si-acts">
        <button class="si-cam" title="Snap a photo here — stamp this spot for your album">📷</button>
        <button class="si-vid" title="Video preview">🎬</button>
        <button class="si-been${state.tripLog.has(p.id) ? " on" : ""}" title="I've been here — save to My Trip">✓</button>
        <button class="si-add${state.picks.has(p.id) ? " on" : ""}" title="Add to My Picks">＋</button>
        <button class="si-x" title="Remove from this route (been already?)">✕</button>
      </div>`;
    item.querySelector(".si-more").addEventListener("click", (e) => {
      e.stopPropagation();
      // one tap rules them all: every row's actions open and close together
      state._actsOpen = !state._actsOpen;
      document.querySelectorAll(".side-item").forEach((it) => it.classList.toggle("acts", state._actsOpen));
      el("sidebar").classList.toggle("wide", state._actsOpen);
    });
    item.querySelector(".si-cam").addEventListener("click", (e) => { e.stopPropagation(); snapPhoto(p); });
    item.querySelector(".si-vid").addEventListener("click", (e) => { e.stopPropagation(); openVideo(p); });
    item.querySelector(".si-been").addEventListener("click", (e) => { e.stopPropagation(); toggleBeen(p); });
    item.querySelector(".si-add").addEventListener("click", (e) => { e.stopPropagation(); togglePick(p); });
    item.querySelector(".si-x").addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.tour.running) { toast("Finish or ↺ reset the walk to edit the route"); return; }
      const mods = (state.courseMods[state.courseId] ??= { removed: new Set(), order: null });
      mods.removed.add(p.id);
      if (mods.order) mods.order = mods.order.filter((x) => x !== p.id);
      applyCourse(state.courseId);
      toast(`✕ ${p.enName || p.title} removed — route updated`);
    });
    // drag to re-order the walking route (desktop)
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      if (state.tour.running) { e.preventDefault(); return; }
      state._dragOrder = [...document.querySelectorAll("#sideList .side-item")].map((it) => it.dataset.id).join();
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => { item.classList.remove("dragging"); commitSidebarOrder(); });
    item.addEventListener("click", (e) => {
      e.stopPropagation();   // don't bubble to the sidebar's unfold-on-tap handler
      // phones: the list is nearly full-width — get it out of the card's way
      if (matchMedia("(max-width: 900px)").matches) { el("sidebar").classList.add("folded"); syncMobChips(); }
      showSpot(p);
      if (!state.tour.running) {
        // browsing before the walk: fly the camera there + speak the story now
        flyTo(p.lng, p.lat);
        audioStop();
        setNowPlaying(`🎧 ${p.enName || p.title}`);
        playNarration(p.script || p.overview || `${p.enName || p.title}, a favourite spot in ${CITY.area}.`);
      } else {
        // mid-walk: pause the journey, peek at the spot, come back with the button
        startPeek(p);
      }
    });
    list.append(item);
  }
}
// 🎞 My Album — the photos you snapped, with their location/time tags,
// and the button that turns them into the narrated album
function renderAlbumTab(list) {
  el("sideCount").textContent = `${state.photos.length}`;
  const b = document.createElement("button");
  b.className = "album-make";
  b.textContent = "🎞 Make my album — Gemini writes it, Amelia tells it";
  b.disabled = !state.photos.length;
  b.addEventListener("click", makeAlbum);
  list.append(b);
  if (!state.photos.length) {
    const h = document.createElement("div");
    h.className = "g-hint";
    h.textContent = "No photos yet — tap 📷 on any spot (or while walking) and they collect here with time, weather and location.";
    list.append(h);
    return;
  }
  for (const s of [...state.photos].sort((a, b2) => a.ts - b2.ts)) {
    const row = document.createElement("div");
    row.className = "side-item";
    const meta = [new Date(s.ts).toTimeString().slice(0, 5), wxLabel(s.wx)].filter(Boolean).join(" · ");
    row.innerHTML = `<img draggable="false" src="${s.dataUrl}" alt="">
      <div class="si-body">
        <div class="si-name">${s.name}</div>
        <div class="si-meta">${meta}</div>
        <div class="si-meta">📍 ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</div>
      </div>
      <button class="ph-del" title="Delete this photo">🗑</button>`;
    row.querySelector(".ph-del").addEventListener("click", (e) => {
      e.stopPropagation();
      state.photos = state.photos.filter((x) => x.id !== s.id);
      savePhotos(); albumChip(); renderSidebar();
      toast("🗑 Photo removed");
    });
    row.addEventListener("click", () => flyTo(s.lng, s.lat));
    list.append(row);
  }
}
function albumChip() {
  const chip = document.querySelector('#courseBar button[data-course="album"] .cs');
  if (chip) chip.textContent = `${state.photos.length} photos`;
}
// after a drag: whatever order you see is the order you'll walk
function commitSidebarOrder() {
  const ids = [...document.querySelectorAll("#sideList .side-item")].map((it) => it.dataset.id);
  if (ids.join() === state._dragOrder) return;      // dropped back where it was
  const mods = (state.courseMods[state.courseId] ??= { removed: new Set(), order: null });
  mods.order = ids;
  applyCourse(state.courseId);
  toast("↕ Route re-ordered — path rebuilt");
}
function refreshSidebarDistances() {
  for (const item of document.querySelectorAll(".side-item")) {
    const p = state.pois.find((x) => x.id === item.dataset.id);
    if (!p) continue;
    item.querySelector(".si-km").textContent = fmtKm(poiDistance(p));
    item.classList.toggle("done", state.visited.has(p.id));
  }
}
function renderCourseBar() {
  const bar = el("courseBar");
  bar.innerHTML = "";
  for (const c of COURSES) {
    const n = state.pois.filter(c.pick).length;
    const b = document.createElement("button");
    b.dataset.course = c.id;
    b.innerHTML = `<span class="ci">${c.icon}</span><span class="cn">${c.name}</span><span class="cs">${
      c.id === "album" ? `${state.photos.length} photos` : c.id === "picks" && !n ? "build yours" : n + " spots"}</span>`;
    b.addEventListener("click", () => {
      if (state.tour.running) return;
      // paint feedback first — routing a big course blocks the thread for a moment
      document.querySelectorAll("#courseBar button").forEach((x) => x.classList.toggle("active", x === b));
      if (n > 60) toast(`${c.icon} Routing ${n} spots…`, 0);
      requestAnimationFrame(() => setTimeout(() => {
        applyCourse(c.id);
        if (c.id === "album") { toast("🎞 Your photos — snap 📷 at spots, then make your album"); return; }
        const cnt = state.coursePois.length;
        if (c.id === "picks" && !cnt) { toast("🎯 Tap ＋ in the list to build your own route"); return; }
        const min = Math.round(state.pathLen / 70 + cnt * 1.5); // 4.2 km/h + ~90s listening per spot
        toast(`${c.icon} ${c.name} — ${cnt} spots · ~${min} min real walk`);
      }, 20));
    });
    bar.append(b);
  }
}

// ---------- the walk ----------
function startWalk() {
  if (state.tour.running) return;
  state.walkDist = 0; state.cumI = 1; state.visited.clear(); state.activeId = null; resetPins();
  state.usedFacts.clear(); state.fi = 0;
  state._played = []; state._playedIdx = null;
  state.tour.running = true; state.tour.paused = false;
  updateHud(); setNowPlaying(""); showHud(true);
  el("courseBar").classList.add("hidden");
  el("courseBar").classList.remove("open");
  el("mobCourse").style.display = "none";     // course is locked while walking
  setControls(true);
  toast(`🚶 ${CITY.start.name} — let's walk`);
  // the guide greets you at the exit before you start moving
  (async () => {
    state.tour.paused = true;
    setNowPlaying("🎧 Your guide");
    await playNarration(INTRO);
    if (state.tour.running) state.tour.paused = false;
  })();
  walkNarrationLoop();
}
function endWalk() {
  endPeekMode();
  restoreCard();
  state.tour.running = false; state.tour.paused = false; audioStop();
  state.activeId = null; setNowPlaying(""); showHud(false);
  el("courseBar").classList.remove("hidden");
  el("mobCourse").style.display = "";
  el("startBtn").disabled = false; el("startBtn").textContent = "▶ Restart Walk";
  el("pauseBtn").disabled = true; el("skipBtn").disabled = true; el("pauseBtn").textContent = "Pause";
  el("prevBtn").disabled = !state._played.length;   // after the walk you can still re-listen
  if (state.mode === "gps") startGPS();
}
function setControls(on) {
  el("startBtn").disabled = on; el("startBtn").textContent = on ? "▶ Walking…" : "▶ Start Walk";
  el("pauseBtn").disabled = !on; el("skipBtn").disabled = !on;
  el("prevBtn").disabled = !state._played.length;
}

// ---------- per-frame loop ----------
let lastTs = 0;
function frame(ts) {
  if (!lastTs) lastTs = ts; const dt = Math.min((ts - lastTs) / 1000, 0.05); lastTs = ts;
  if (state.peek) {
    orbitCam(dt, 0);                     // free camera while peeking at a spot
  } else if (state.mode === "sim" && state.tour.running) {
    if (!state.tour.paused) {
      state.walkDist += WALK_SPEED * dt;
      if (state.walkDist >= state.pathLen) { state.walkDist = state.pathLen; endWalk(); }
    }
    const { pos, heading } = pointAlongPath(state.walkDist);
    state.avatarPos = pos;
    state.lastHeading = heading;
    const diff = ((heading - state.camHeading + 540) % 360) - 180;
    state.camHeading = (state.camHeading + diff * 0.12 + 360) % 360;
    followCam(pos[0], pos[1], state.camHeading, dt);
  } else if (state.mode === "gps" && state.avatarPos) {
    state.lastHeading = state.gps.heading;
    followCam(state.avatarPos[0], state.avatarPos[1], state.gps.heading, dt);
  } else {
    orbitCam(dt, ROT_SPEED);
  }
  render(dt);
  requestAnimationFrame(frame);
}

// ---------- live GPS ----------
function startGPS() {
  if (!navigator.geolocation) { toast("This browser has no geolocation."); return; }
  toast("📍 Getting your location… (allow location access)");
  state.tour.running = false; updateHud(); showHud(true);
  state.gps.watchId = navigator.geolocation.watchPosition(onGPS, onGPSErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
  if (!state._gpsLoop) { state._gpsLoop = true; gpsNarrationLoop(); }
}
function stopGPS() { if (state.gps.watchId != null) { navigator.geolocation.clearWatch(state.gps.watchId); state.gps.watchId = null; } state._gpsLoop = false; }
function onGPS(pos) {
  const { latitude: lat, longitude: lng } = pos.coords, prev = state.avatarPos;
  if (prev) state.gps.heading = bearingTo({ lng: prev[0], lat: prev[1] }, { lng, lat }) || state.gps.heading;
  state.avatarPos = [lng, lat]; moveAvatar3d(lng, lat, state.gps.heading); toastClear();
  if (metersBetween([lng, lat], [state.center.lng, state.center.lat], lat) > CITY.maxFromCenterM) toast(`You're outside ${CITY.area} — the guide starts when you arrive.`);
}
function onGPSErr(err) {
  const m = err.code === 1 ? "Location denied. Enable it from the address-bar location icon." : err.code === 2 ? "No location signal (indoors / desktop can be inaccurate)." : "Location timed out.";
  toast("📍 " + m, 6000);
}
// distance from a point to the planned route (walkPath is densified every ~6 m)
function distToRoute(lng, lat) {
  let bd = Infinity;
  for (const p of state.walkPath) { const d = metersBetween([lng, lat], p, lat); if (d < bd) bd = d; }
  return bd;
}
const nextStop = () => state.coursePois.find((p) => !state.visited.has(p.id));

// live navigation voice — off-route warnings, back-on-track, gentle progress pings
async function gpsNarrationLoop() {
  let offRoute = false, lastNavTalk = 0, lastPing = Date.now();
  const say = async (text) => { lastNavTalk = Date.now(); setNowPlaying("🎧 Guide"); await playNarration(text); };
  while (state._gpsLoop) {
    const a = state.avatarPos;
    if (a && !isPlaying()) {
      const poi = nearestUnvisitedWithin(a[0], a[1], POI_TRIGGER);
      if (poi) { toast(`📍 ${poi.enName || poi.title}`); await narratePoi(poi); lastPing = Date.now(); }
      else if (nearestPhotoSpot(a, 40)) {
        const ps = nearestPhotoSpot(a, 40);
        state.photoDone.add(ps.id);
        earcon("photo");
        showPhotoCard(ps); setNowPlaying(`📸 ${ps.enName}`);
        await playNarration(ps.tip); lastPing = Date.now();
      } else {
        const turn = gpsUpcomingTurn(a);
        if (turn && state._turnIdx !== turn.i) {
          state._turnIdx = turn.i;
          await say(`Coming up — turn ${turn.dir}.`);
          await sleep(700); continue;
        }
        const next = nextStop();
        const d = state.walkPath.length ? distToRoute(a[0], a[1]) : 0;
        if (d > 45 && !offRoute && Date.now() - lastNavTalk > 25000) {
          offRoute = true;
          toast("↩️ Off the route");
          await say(`Looks like you've wandered off the route. ${next ? `Head back toward ${next.enName || next.title} — it's about ${Math.round(metersBetween(a, [next.lng, next.lat], a[1]))} metres away.` : "Follow the yellow line on the map to get back."}`);
        } else if (d < 28 && offRoute) {
          offRoute = false;
          toast("✅ Back on the route");
          await say(`Nice — you're back on the route.${next ? ` Keep going, ${next.enName || next.title} is coming up.` : ""}`);
        } else if (!offRoute && next && Date.now() - lastPing > 90000 && Date.now() - lastNavTalk > 30000) {
          lastPing = Date.now();
          await say(`You're doing great. ${next.enName || next.title} is about ${Math.round(metersBetween(a, [next.lng, next.lat], a[1]))} metres ahead.`);
        }
      }
    }
    await sleep(700);
  }
}

// ---------- real-time environment: local clock + live weather ----------
const WX_KIND = (code) =>
  code >= 95 ? "rain" : code >= 71 && code <= 77 ? "snow" : code >= 51 ? "rain" :
  code >= 45 ? "fog" : code >= 1 ? "clouds" : "clear";
const WX_EMOJI = { clear: "☀️", clouds: "⛅", fog: "🌫️", rain: "🌧️", snow: "❄️" };
const env = { weather: null, override: new URLSearchParams(location.search) };

function localNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: CITY.tz }));
}
function envDate() {
  const d = localNow(), t = env.override.get("time");
  if (t === "day") d.setHours(13, 0);
  if (t === "night") d.setHours(22, 0);
  return d;
}
async function fetchWeather() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${state.center.lat}&longitude=${state.center.lng}&current=temperature_2m,weather_code,cloud_cover,is_day&timezone=${encodeURIComponent(CITY.tz)}`;
    const { current } = await (await fetch(u)).json();
    env.weather = {
      kind: WX_KIND(current.weather_code), cloud: (current.cloud_cover ?? 0) / 100,
      temp: Math.round(current.temperature_2m), isDay: !!current.is_day,
    };
  } catch { env.weather = { kind: "clear", cloud: 0, temp: null, isDay: true }; }
  const wx = env.override.get("wx");
  if (wx) env.weather = { ...env.weather, kind: wx, cloud: wx === "clear" ? 0 : 0.85 };
  applyEnv();
}
function applyEnv() {
  const d = envDate(), w = env.weather || { kind: "clear", cloud: 0 };
  setEnvironment(d, w);
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  const night = d.getHours() < 6 || d.getHours() >= 19;
  const icon = w.kind === "clear" ? (night ? "🌙" : "☀️") : WX_EMOJI[w.kind];
  el("envChip").textContent =
    `${icon} ${hh}:${mm} ${CITY.short} · ${w.kind}${w.temp != null ? " " + w.temp + "°" : ""}` +
    (env.override.get("time") || env.override.get("wx") ? " (demo)" : " · live");
}
function startEnv() {
  fetchWeather();                                  // weather now + every 10 min
  setInterval(fetchWeather, 600000);
  setInterval(applyEnv, 60000);                    // clock every minute
}

// ---------- controls ----------
function resetAll() {
  // stop everything
  endPeekMode();
  state.tour.running = false; state.tour.paused = false; audioStop(); stopGPS();
  state.courseMods = {};                 // undo list removals / re-ordering
  // clear picks (incl. Google-added custom places) + progress
  localStorage.removeItem("md3d-picks");
  state.picks.clear();
  for (const p of state.pois) if (p.type === "custom") removePin(p.id);
  state.pois = state.pois.filter((p) => p.type !== "custom");
  state.visited.clear(); state.photoDone.clear(); state.tipsUsed.clear(); state.tipI = 0;
  state.activeId = null; state.avatarPos = null;
  // back to defaults
  el("spotCard").classList.remove("show"); closeVideo(); setNowPlaying(""); showHud(false);
  setControls(false); el("startBtn").textContent = "▶ Start Walk";
  moveAvatar3d(state.start.lng, state.start.lat, 20);
  resetOrbit();
  renderCourseBar();
  setMode("sim");
  applyCourse("best");
  toast(`↺ Reset — back to ${CITY.start.name}`);
}
function startExperience() { if (state.mode === "gps") startGPS(); else startWalk(); }
// mid-walk peek: pause the journey, fly to a list spot, tell its story now
function startPeek(p) {
  const wasPeeking = !!state.peek;
  state.peek = p;
  if (state.mode === "sim") { state.tour.paused = true; el("pauseBtn").textContent = "Resume"; }
  audioStop();
  if (!wasPeeking) beginPeek();          // seamless follow-cam → orbit-cam handoff
  flyTo(p.lng, p.lat);
  setNowPlaying(`🎧 ${p.enName || p.title}`);
  playNarration(p.script || p.overview || `${p.enName || p.title}, a favourite spot in ${CITY.area}.`);
  el("peekBackBtn").classList.remove("hidden");
}
function endPeekMode() {
  if (!state.peek) return;
  state.peek = null;
  audioStop(); setNowPlaying("");
  endPeekCam();                          // glide back behind the walker
  el("peekBackBtn").classList.add("hidden");
  if (state.mode === "sim" && state.tour.running) { state.tour.paused = false; el("pauseBtn").textContent = "Pause"; }
}
function togglePause() { if (state.peek) { endPeekMode(); return; } const t = state.tour; if (!t.running) return; t.paused = !t.paused; el("pauseBtn").textContent = t.paused ? "Resume" : "Pause"; if (t.paused) audioPause(); else audioResume(); }
function skip() { if (state.mode === "sim" && state.tour.running) { audioStop(); state.tour.paused = false; } }
// ---------- Next / Prev teleport the sim walker straight to the spot ----------
function pathDistNear(poi) {
  const P = state.walkPath, C = state.cum;
  let best = 0, bd = Infinity;
  for (let i = 0; i < P.length; i++) {
    const d = metersBetween(P[i], [poi.lng, poi.lat], poi.lat);
    if (d < bd) { bd = d; best = C[i]; }
  }
  return best;
}
// teleport, then narrate the spot directly — course order and the 40 m trigger
// can't be trusted (some stops sit further off the pruned route)
function teleportAndNarrate(poi, at) {
  const ep = state._navEpoch;
  state.walkDist = Math.min(at, state.pathLen);
  state.cumI = 1; state._turnIdx = -1;
  state.tour.paused = true;
  (async () => {
    await narratePoi(poi);
    if (ep === state._navEpoch) { state.tour.paused = false; state._lastNarrate = state.walkDist; }
  })();
}
function jumpNext() {
  if (!(state.mode === "sim" && state.tour.running)) { skip(); return; }
  state._navEpoch = (state._navEpoch || 0) + 1;
  audioStop();
  // the next stop = the unvisited one closest AHEAD along the path
  const ahead = state.coursePois.filter((p) => !state.visited.has(p.id))
    .map((p) => ({ p, at: pathDistNear(p) }))
    .filter((x) => x.at > state.walkDist - 30)
    .sort((a, b) => a.at - b.at);
  if (!ahead.length) { state.tour.paused = false; return; }
  toast(`⏭ ${ahead[0].p.enName || ahead[0].p.title}`);
  teleportAndNarrate(ahead[0].p, ahead[0].at);
}
function jumpPrev() {
  if (!(state.mode === "sim" && state.tour.running)) { playPrev(); return; }
  const vis = [...state.visited];
  if (!vis.length) { playPrev(); return; }
  const findP = (id) => state.coursePois.find((p) => p.id === id) || state.pois.find((p) => p.id === id);
  const last = findP(vis[vis.length - 1]);
  // standing at the last spot → go one further back; mid-leg → return to that spot
  let target = last;
  if (last && state.walkDist <= pathDistNear(last) + 60 && vis.length >= 2) {
    target = findP(vis[vis.length - 2]) || last;
  }
  state._navEpoch = (state._navEpoch || 0) + 1;
  audioStop();
  state.visited.delete(vis[vis.length - 1]); // current spot: Next can come back to it
  if (!target) { state.tour.paused = false; return; }
  state.visited.delete(target.id);           // narratePoi re-adds it on arrival
  toast(`⏮ ${target.enName || target.title}`);
  teleportAndNarrate(target, pathDistNear(target));
}
// ---------- ‹ Prev: replay what the guide already said ----------
function pushPlayed(seg) {
  state._played.push(seg);
  if (state._played.length > 40) state._played.shift();
  state._playedIdx = null;                 // a fresh segment resets the rewind cursor
  el("prevBtn").disabled = false;
}
async function playPrev() {
  const h = state._played;
  if (!h.length) return;
  // while something is talking, ‹ goes to the item BEFORE it; when idle it
  // replays the last thing said; pressing again keeps walking further back
  const base = state._playedIdx ?? (isPlaying() ? h.length - 1 : h.length);
  const idx = Math.max(0, base - 1);
  state._playedIdx = idx;
  const seg = h[idx];
  audioStop();
  if (seg.kind === "poi") {
    setNowPlaying(`⏪ ${seg.poi.enName || seg.poi.title}`);
    showSpot(seg.poi);
    await playNarration(seg.poi.script || seg.poi.overview || (seg.poi.enName || seg.poi.title));
  } else if (seg.kind === "photo") {
    setNowPlaying(`⏪ ${seg.ps.enName}`);
    showPhotoCard(seg.ps);
    await playNarration(seg.ps.tip);
  } else {
    setNowPlaying(`⏪ ${seg.where || "About " + CITY.area}`);
    showFillerCard(seg.text, seg.where, seg.img);
    await playNarration(seg.text);
  }
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#modeToggle button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  if (mode === "gps") toast(`Live GPS — press Start, then walk ${CITY.area} with earphones.`);
  else { stopGPS(); state.tour.running = false; state.activeId = null; state.visited.clear(); resetPins(); setNowPlaying(""); showHud(false); setControls(false); }
}

// ---------- boot ----------
async function boot() {
  try {
    const [pois, streets, subway, zones, photoTips, localTips] = await Promise.all([
      fetch("./data/area-pois.json").then((r) => r.json()),
      fetch("./data/area-streets.json").then((r) => r.json()),
      fetch("./data/area-subway.json").then((r) => r.json()).catch(() => ({ stations: [] })),
      fetch("./data/area-zones.json").then((r) => r.json()).catch(() => ({ zones: [] })),
      fetch("./data/area-photo-spots.json").then((r) => r.json()).catch(() => null),
      fetch("./data/area-tips.json").then((r) => r.json()).catch(() => null),
    ]);
    state.pois = pois.pois; state.fillers = [];
    SUBWAY.push(...(subway.stations || []));
    state.zones = zones.zones || [];
    if (photoTips?.spots?.length) { PHOTO_SPOTS.length = 0; PHOTO_SPOTS.push(...photoTips.spots); }
    state.tips = localTips?.tips || null;
    state.center = pois.center ? { lng: pois.center.mapX, lat: pois.center.mapY } : state.center;

    state.graph = buildGraph(streets);
    // initial path: default course only — applyCourse() below recomputes the
    // real route anyway, and routing ALL POIs here blocked boot for ~16s
    const pois0 = state.pois.filter(COURSES.find((c) => c.id === state.courseId).pick);
    state.coursePois = pois0;
    state.walkPath = pruneWalkLoops(buildWalkPath(state.graph, state.start, buildRoute(state.start, pois0)), pois0);

    initScene({
      container: el("map"),
      walkPath: state.walkPath, pois: state.pois,
      center: state.center, glyphs: TYPE_GLYPH, subway: SUBWAY,
    });
    moveAvatar3d(state.start.lng, state.start.lat, 20);

    window.__s = state;
    startEnv();
    loadPicks();                          // restore saved My Picks (incl. Google adds)
    loadTrip();                           // restore the trip journal (다녀간 곳)
    loadPhotos();                         // restore stamp-rally photos
    for (const ps of PHOTO_SPOTS) addPin(ps, "📸");   // photo spots live on every course
    renderCourseBar();
    applyCourse(state.courseId);          // default: Must See
    setInterval(refreshSidebarDistances, 4000); // live km while walking
    wireControls(); setMode("sim");
    el("startBtn").disabled = false;
    el("overlayMsg").textContent = `${state.pois.length} places · ${CITY.area}`;
    hideOverlay();
    requestAnimationFrame(frame);
  } catch (err) { console.error(err); showError("Couldn't load the map", `${err.message}`); }
}
function wireControls() {
  el("startBtn").addEventListener("click", startExperience);
  el("pauseBtn").addEventListener("click", togglePause);
  el("skipBtn").addEventListener("click", jumpNext);
  el("prevBtn").addEventListener("click", jumpPrev);
  // phones: tapping the open map (anything outside the sidebar/chips) folds the list
  document.addEventListener("pointerdown", (e) => {
    if (!matchMedia("(max-width: 900px)").matches) return;
    const sb = el("sidebar");
    if (sb.classList.contains("folded")) return;
    if (sb.contains(e.target) || e.target.closest("#mobChips")) return;
    sb.classList.add("folded");
    syncMobChips();
  });
  el("resetBtn").addEventListener("click", resetAll);
  el("peekBackBtn").addEventListener("click", endPeekMode);
  el("snapBtn").addEventListener("click", () => snapPhoto(null));
  el("camInput").addEventListener("change", onCamPick);
  el("albumClose").addEventListener("click", closeAlbum);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && state._album) closeAlbum(); });
  // drag-sorting: move the dragged card under the cursor as it travels
  el("sideList").addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = el("sideList").querySelector(".side-item.dragging");
    if (!dragging) return;
    const after = [...el("sideList").querySelectorAll(".side-item:not(.dragging)")]
      .find((it) => e.clientY < it.getBoundingClientRect().top + it.offsetHeight / 2);
    after ? el("sideList").insertBefore(dragging, after) : el("sideList").append(dragging);
  });
  el("sideFold").addEventListener("click", (e) => { e.stopPropagation(); el("sidebar").classList.toggle("folded"); syncMobChips(); });
  // phones: start with the sidebar folded to its edge tab so the map breathes
  if (matchMedia("(max-width: 900px)").matches) el("sidebar").classList.add("folded");
  syncMobChips();
  el("sidebar").addEventListener("click", () => {
    if (el("sidebar").classList.contains("folded")) { el("sidebar").classList.remove("folded"); syncMobChips(); }
  });
  // mobile chips: ⭐ opens the course picker, 📋 opens the spot list
  el("mobCourse").addEventListener("click", () => {
    if (state.tour.running) return;
    el("courseBar").classList.toggle("open");
  });
  el("mobList").addEventListener("click", () => {
    el("sidebar").classList.toggle("folded");
    syncMobChips();
  });
  el("homeBtn").addEventListener("click", () => location.reload());
  el("spotClose").addEventListener("click", (e) => {
    e.stopPropagation();
    el("spotCard").classList.remove("show");
    // closing dismisses the narration too — kill the current clip AND the
    // rest of its chain (tips); the walk itself keeps going
    state._navEpoch = (state._navEpoch || 0) + 1;
    audioStop();
    // narration holds release the walk; an explicit user Pause (label says
    // "Resume") stays paused
    if (state.tour.running && el("pauseBtn").textContent === "Pause") state.tour.paused = false;
  });
  // mobile: horizontal swipe tucks the card into the ⓘ chip; vertical scroll untouched
  {
    const card = el("spotCard");
    let sx = null, sy = null, dragging = false;
    card.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; dragging = false; }, { passive: true });
    card.addEventListener("touchmove", (e) => {
      if (sx == null) return;
      const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
      if (!dragging && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.3) dragging = true;
      if (dragging) {
        card.style.transition = "none";
        card.style.transform = `translateX(${dx}px)`;
        card.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 260));
      }
    }, { passive: true });
    card.addEventListener("touchend", (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      card.style.transition = ""; card.style.transform = ""; card.style.opacity = "";
      if (dragging && Math.abs(dx) > 70) minimizeCard();
      sx = sy = null; dragging = false;
    });
    el("cardMini").addEventListener("click", restoreCard);
    el("spotMin").addEventListener("click", (e) => { e.stopPropagation(); minimizeCard(); });
  }
  el("videoClose").addEventListener("click", closeVideo);
  el("videoModal").addEventListener("click", (e) => { if (e.target === el("videoModal")) closeVideo(); });
  document.querySelectorAll("#modeToggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
}

boot();
