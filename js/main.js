// TasteWalk — pick a walk, follow the route, tap ✕ / ○ at each stop so the
// guide learns your taste, snap a photo and post it straight to Instagram.
// Walking area: city.js. Map: map2d.js. Routing: route.js. Voice: audio.js.
import { playNarration, playFile, stop as audioStop, pause as audioPause, resume as audioResume, isPlaying, prime } from "./audio.js";
import { initMap, setRoute, setStops, markStop, follow, recenter, fitStops, setTheme, setInsets, streetAt } from "./map2d.js";
import { metersBetween, bearingTo, orderStops, fetchWalkPath, cumulative, pointAlong } from "./route.js";
import { CITY } from "./city.js";
import { consent, setConsent, track, deleteMyData } from "./insights.js";

const el = (id) => document.getElementById(id);
const WALK_SPEED = 12;          // m/s — the demo walk is sped up
const ARRIVE_M = 35;            // "you're at the stop"
const OTHER_STOP_M = 40;        // GPS: this close to a later stop → take it now (Myeongdong 3D's POI_TRIGGER)
const GOOD_FIX_M = 50;          // GPS fixes less accurate than this don't trigger arrivals or route warnings
const WALK_M_PER_MIN = 75;      // ~4.5 km/h, for time estimates when routing is down
// assumed minutes spent at each kind of stop — only for the "est." times
const DWELL = { food: 30, culture: 20, attraction: 10, shopping: 10 };
const TYPE_LABEL = { food: "Food & drink", culture: "Culture", attraction: "Sight", shopping: "Shop" };
const TYPE_ICON = { food: "🍽️", culture: "🏛️", attraction: "📸", shopping: "🛍️" };

// stops are picked from Qloo's places around the start (OpenStreetMap places if Qloo is down);
// "For you" asks Qloo to rank them by taste affinity to the places you said Go to
const COURSES = [
  { id: "must", icon: "⭐", name: "Must See", note: "Landmarks and museums", n: 8, pick: (p) => p.type === "attraction" || p.type === "culture" },
  { id: "classic", icon: "🧭", name: "Classic", note: "A bit of everything", n: 6, pick: () => true, mix: true },
  { id: "slow", icon: "☕", name: "Slow Down", note: "Fewer stops, food and coffee", n: 4, pick: (p) => p.type === "food" },
  { id: "foryou", icon: "🎯", name: "For you", note: "Ranked by Qloo for the places you said Go to", n: 6, pick: () => true, mix: true, taste: true },
];

const state = {
  pois: [], sel: null, peek: null, lastLine: "",
  trip: loadTrip(), heading: null, wx: null, fix: null, posGood: true, photoSpot: null, postEdited: false,
  course: null, stops: [], path: [], cum: [], len: 0,
  i: 0, dist: 0, pos: null, atStop: false,
  mode: "sim", running: false, paused: false, gpsWatch: null,
  feedback: loadFeedback(),
};

// ---------- small ui helpers ----------
let toastTimer;
function toast(msg, ms = 3200) {
  const t = el("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
const show = (id, on = true) => { el(id).hidden = !on; };
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const fmtMin = (min) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);
const nameOf = (p) => p.enName || p.title;

// ---------- taste feedback (this device only) ----------
function loadFeedback() {
  try { return JSON.parse(localStorage.getItem("tw-feedback") || "{}"); } catch { return {}; }
}
function saveFeedback() {
  try { localStorage.setItem("tw-feedback", JSON.stringify(state.feedback)); } catch { /* private mode */ }
}

// ---------- courses ----------
function pickStops(course, from, pool = state.pois) {
  // nearest first, but a place without a description counts as 400 m farther,
  // so walks favour stops the guide can actually tell you about
  const near = pool.filter(course.pick)
    .map((p) => ({ p, d: metersBetween([p.lng, p.lat], [from.lng, from.lat], p.lat) + (p.about ? 0 : 400) }))
    .sort((a, b) => a.d - b.d).map((x) => x.p);
  if (!course.mix) return near.slice(0, course.n);
  // round-robin over place types so "Classic" isn't all restaurants
  const byType = {};
  for (const p of near) (byType[p.type] ??= []).push(p);
  const out = [], types = Object.keys(byType);
  for (let k = 0; out.length < course.n && types.some((t) => byType[t].length); k++) {
    const t = types[k % types.length];
    if (byType[t].length) out.push(byType[t].shift());
  }
  return out;
}
// from = where the walk starts: the demo start, or (GPS) where you are
async function planCourse(course, from = CITY.start) {
  const pool = course.taste ? await tastePool(from) : state.pois;
  const stops = orderStops(from, pickStops(course, from, pool));
  const { path, seconds, fallback, waypoints } = await fetchWalkPath(from, stops, WALK_M_PER_MIN);
  const cum = cumulative(path);
  const len = cum[cum.length - 1] || 0;
  const minutes = seconds / 60 + stops.reduce((s, p) => s + (DWELL[p.type] || 10), 0);
  // where the route reaches each stop (on the footway); a big square's centre can be 40 m+ off the path
  const reach = stops.map((p, k) => waypoints[k + 1] || [p.lng, p.lat]);
  return { course, from, stops, path, cum, len, minutes, fallback, reach };
}
// the places walks are built from: Qloo's places around `from`, or the OSM list if Qloo doesn't answer
async function loadPool(from) {
  try {
    const j = await qget(`/api/qloo/course?lat=${from.lat}&lon=${from.lng}`);
    if (j.places.length >= 8) return { pois: j.places.map(qPlace), poolSource: "qloo" };
  } catch { /* Qloo unavailable — fall back */ }
  return { pois: state.osm, poolSource: "osm" };
}
// Qloo ids of places you said Go to (this visit + earlier visits on this device), newest last
const likedIds = () => [...new Set([...Object.keys(state.feedback).filter((k) => k.startsWith("qloo:") && state.feedback[k] === 1)
  .map((k) => k.slice(5)), ...qlooLikes])].slice(-5);
// "For you": the places around `from` that Qloo ranks highest for your Go's — the top 12 to pick stops from
async function tastePool(from) {
  const j = await qget(`/api/qloo/course?lat=${from.lat}&lon=${from.lng}&ids=${likedIds().join(",")}`);
  const taken = new Set(likedIds());
  return j.places.filter((x) => !taken.has(x.id)).slice(0, 12).map(qPlace);
}
const chipText = (c, plan) => `<b>${c.icon} ${c.name}</b><span>${plan.stops.length} stops · ${fmtDist(plan.len)} · ≈ ${fmtMin(plan.minutes)}</span>`;
// course chips along the bottom; tapping one draws its route and fills the sidebar right away
async function renderCourseBar(pool) {
  const bar = el("courseBar"); bar.innerHTML = "";
  for (const c of COURSES) {
    const b = document.createElement("button");
    b.className = "chip-course"; b.disabled = true; b.dataset.id = c.id;
    b.innerHTML = `<b>${c.icon} ${c.name}</b><span>planning…</span>`;
    bar.append(b);
  }
  Object.assign(state, await pool);
  if (state.poolSource === "osm") toast("Qloo didn't answer — these walks use OpenStreetMap places for now", 5000);
  // one route request per course, in turn (the routing server allows 1 request/s)
  for (const [k, c] of COURSES.entries()) {
    const b = bar.children[k];
    if (c.taste) {
      // planned when tapped, from the Go's you've given so far
      b.innerHTML = `<b>${c.icon} ${c.name}</b><span>Ranked by Qloo for your ○ Go's</span>`;
      b.title = c.note; b.disabled = false;
      b.addEventListener("click", () => planForYou(c, b));
      continue;
    }
    const plan = await planCourse(c);
    b.innerHTML = chipText(c, plan);
    b.title = plan.fallback ? "Routing is unavailable — straight-line estimate" : `${c.note} — walking time + an assumed stay at each stop`;
    b.disabled = false;
    b.addEventListener("click", () => selectPlan(plan));
    if (k === 0) selectPlan(plan);
  }
}
async function planForYou(c, b) {
  if (!likedIds().length) return toast("Tap ○ Go on a few places you like — then Qloo picks a walk for your taste", 4500);
  b.disabled = true; b.querySelector("span").textContent = "asking Qloo…";
  try {
    const from = state.mode === "gps" && state.fix ? { lng: state.fix[0], lat: state.fix[1] } : CITY.start;
    const plan = await planCourse(c, from);
    if (!plan.stops.length) throw new Error("no places");
    b.innerHTML = chipText(c, plan);
    selectPlan(plan);
    say(`Here's a walk for your taste: ${plan.stops.length} places Qloo ranks highest for what you said Go to.`, TASTE_SRC);
  } catch {
    b.innerHTML = `<b>${c.icon} ${c.name}</b><span>Ranked by Qloo for your ○ Go's</span>`;
    toast("Qloo is busy — try For you again in a moment");
  }
  b.disabled = false;
}
function selectPlan(plan) {
  if (state.running) endWalk(true);
  state.sel = plan;
  Object.assign(state, { course: plan.course, stops: plan.stops, path: plan.path, cum: plan.cum, len: plan.len, i: 0, dist: 0, atStop: false, peek: null });
  const from = plan.from || CITY.start;
  state.pos = [from.lng, from.lat];
  follow(state.pos[0], state.pos[1]);
  setRoute(plan.path);
  setStops(plan.stops, peek);
  for (const p of plan.stops) if (state.feedback[p.id] !== undefined) markStop(p.id, state.feedback[p.id] ? "liked" : "skipped");
  fitStops(from);
  document.querySelectorAll(".chip-course").forEach((b) => b.classList.toggle("on", b.dataset.id === plan.course.id));
  show("card", false);
  renderList();
  renderDock();
}

// ---------- sidebar: the course's places ----------
function rowState(p, k) {
  if (state.running && k === state.i) return "now";
  if (state.feedback[p.id] === 1) return "liked";
  if (state.feedback[p.id] === 0) return "skipped";
  return state.running && k < state.i ? "visited" : "";
}
function renderList() {
  const c = state.course;
  el("sideTitle").textContent = c ? `${c.icon} ${c.name}` : "—";
  el("sideCount").textContent = state.stops.length;
  const list = el("sideList"); list.innerHTML = "";
  state.stops.forEach((p, k) => {
    const row = document.createElement("div");
    row.className = `spot ${rowState(p, k)}`.trim(); row.dataset.id = p.id;
    row.innerHTML = `${p.image ? `<img src="${p.image}" alt="" loading="lazy" />` : `<i>${TYPE_ICON[p.type] || "📍"}</i>`}
      <div class="spot-text"><b></b><small><span class="dist"></span> · ${TYPE_LABEL[p.type] || "Place"}</small></div>
      <button class="mini no" title="Skip — not for me">✕</button><button class="mini yes" title="Go — I like this">○</button>`;
    row.querySelector("b").textContent = `${k + 1}. ${nameOf(p)}`;
    row.addEventListener("click", () => peek(p.id));
    row.querySelector(".no").addEventListener("click", (e) => { e.stopPropagation(); judge(p, false); });
    row.querySelector(".yes").addEventListener("click", (e) => { e.stopPropagation(); judge(p, true); });
    list.append(row);
  });
  updateDistance();
}

// ---------- the walk ----------
async function startWalk() {
  if (!state.sel) return;
  prime();                      // still inside the tap, so iOS lets the guide speak later
  keepAwake(true);
  if (state.mode === "gps") {
    // like Myeongdong 3D: in GPS mode the walk starts from where you are
    el("startBtn").disabled = true;
    startGPS();
    const at = await firstFix(12000);
    const away = at && metersBetween(at, [CITY.start.lng, CITY.start.lat], at[1]);
    if (at && away > 150 && away < CITY.maxFromCenterM) {
      toast("📍 Planning the walk from where you are…");
      const here = { lng: at[0], lat: at[1] };
      try {
        if (!state.course.taste) Object.assign(state, await loadPool(here));
        selectPlan(await planCourse(state.course, here));
      } catch { toast("Qloo is busy — keeping the walk you picked"); }
    }
  }
  Object.assign(state, { i: 0, dist: 0, atStop: false, running: true, paused: false, peek: null });
  const from = state.sel.from || CITY.start;
  state.pos = state.mode === "gps" && state.fix ? state.fix : [from.lng, from.lat];
  recenter();
  showStop();
  renderDock();
  say(`Welcome to ${CITY.area}. Follow the yellow line. At each stop, tell me if it's for you.`);
}
const firstFix = (ms) => new Promise((res) => {
  const t0 = Date.now();
  (function wait() { if (state.fix) return res(state.fix); if (Date.now() - t0 > ms) return res(null); setTimeout(wait, 300); })();
});
// keep the screen on during a walk — a web page loses GPS and voice once the phone sleeps
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* refused (e.g. battery saver) — the screen may sleep */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.running) keepAwake(true); });
// end the walk; quiet = switching course / reset, no summary
function endWalk(quiet = false) {
  state.running = false; state.paused = false; state.atStop = false;
  stopGPS(); audioStop(); keepAwake(false);
  if (!quiet) {
    const liked = state.stops.filter((s) => state.feedback[s.id] === 1).length;
    toast(`Walk done — you liked ${liked} of ${state.stops.length} stops`, 5000);
    say(`That's the walk. You liked ${liked} of ${state.stops.length} stops.`);
  }
  renderList();
  renderDock();
}
function renderDock() {
  el("startBtn").disabled = !state.sel;
  el("startBtn").textContent = state.running ? "■ End walk" : "▶ Start Walk";
  for (const id of ["pauseBtn", "nextBtn"]) el(id).disabled = !state.running;
  el("prevBtn").disabled = !state.lastLine;
  el("pauseBtn").textContent = state.paused ? "Resume" : "Pause";
}
// narration + remember it for ‹ Prev + log it in the Guide tab
// recorded once with ElevenLabs into audio/welcome.mp3 — change both together
const WELCOME = "Hi, and welcome to TasteWalk Berlin! I'm your local companion for this walk, and I'm here to show you a Berlin that fits you. " +
  "Pick a walk to begin: Must See for the big landmarks, Classic for a bit of everything, Slow Down for food and coffee, " +
  "or For you, a walk Qloo builds from the places you love. On the way, just tap Go when a place feels right, " +
  "and I'll keep finding new experiences for you. Ready? Tap Start Walk. Let's go!";
function say(text, source, actions) {
  state.lastLine = text; el("prevBtn").disabled = false;
  addMsg("buddy", text, actions, source);
  playNarration(text);
}

function current() { return state.stops[state.i]; }
const shown = () => state.peek || current();      // the place on the card right now
const sentences = (t, n) => (t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t]).slice(0, n).join("").trim();

// fill the card with one place: photo, name, description + its source
function renderPlace(p, kicker) {
  el("stopIdx").textContent = kicker;
  el("stopName").textContent = nameOf(p);
  renderGallery(p);
  const facts = [p.menu && `Serves ${p.menu}.`, p.hours && `Hours: ${p.hours}`].filter(Boolean).join(" ");
  el("stopBlurb").textContent = p.about ? sentences(p.about, 3) : facts;
  const src = el("stopSrc");
  if (p.about && p.aboutUrl) {
    src.innerHTML = `${facts ? facts + " · " : ""}From <a href="${p.aboutUrl}" target="_blank" rel="noopener">${p.aboutSource}</a>`;
    src.hidden = false;
  } else if (p.about && p.q && p.about === p.q.about) {
    src.textContent = "From Qloo";
    src.hidden = false;
  } else src.hidden = true;
  show("card");
  updateDistance();
}
// a plain link to the place's public hashtag page — no Instagram API, nothing sent from our side
const igUrl = (p) => `https://www.instagram.com/explore/tags/${encodeURIComponent(tagify(nameOf(p)).toLowerCase())}/`;

// card photos, swiped sideways: the place's own photo, then Qloo's photos of it, then its Instagram page
function renderGallery(p) {
  const g = el("gallery");
  g.innerHTML = ""; g.scrollLeft = 0;
  const addPhoto = (url, label) => {
    const s = document.createElement("div");
    s.className = "slide"; s.innerHTML = `<img src="${url}" alt="" loading="lazy" /><small>${label}</small>`;
    g.insertBefore(s, g.querySelector(".ig-slide"));
  };
  const ig = Object.assign(document.createElement("a"), { className: "slide ig-slide", href: igUrl(p), target: "_blank", rel: "noopener" });
  ig.innerHTML = `▶ Watch reels on Instagram<span>#${tagify(nameOf(p)).toLowerCase()} — tap to open</span>`;
  g.append(ig);
  if (p.image) addPhoto(p.image, p.q && p.image === p.q.image ? "Photo: Qloo" : `Photo: ${p.aboutSource || "Wikipedia"}`);
  countSlides();
  qlooMatch(p).then((q) => {
    if (!q || shown() !== p) return;
    for (const url of q.images || []) if (url !== p.image) addPhoto(url, "Photo: Qloo");
    countSlides();
  }).catch(() => { /* no Qloo photos this time */ });
}
function countSlides() {
  const g = el("gallery"), n = g.children.length, k = Math.min(Math.round(g.scrollLeft / (g.clientWidth || 1)) + 1, n);
  el("galleryCount").textContent = n > 1 ? `${k} / ${n}` : "";
  show("galPrev", k > 1);
}
// › moves one photo on; on the last slide it opens the place's Instagram reels
function galleryStep(dir) {
  const g = el("gallery"), w = g.clientWidth || 1, n = g.children.length;
  const at = Math.round(g.scrollLeft / w);
  if (dir > 0 && at >= n - 1) return window.open(igUrl(shown()), "_blank", "noopener");
  g.scrollTo({ left: Math.max(0, Math.min(n - 1, at + dir)) * w, behavior: "smooth" });
}
function showStop() {
  const p = current();
  if (!p) return;
  state.peek = null; show("backBtn", false);
  markStop(p.id, "next");
  renderPlace(p, `${state.atStop ? "Stop" : "Next"} ${state.i + 1} of ${state.stops.length}`);
  renderList();
}
// tap a stop on the map or in the list → read about it (before or during the walk)
function peek(id) {
  const k = state.stops.findIndex((s) => s.id === id);
  if (k < 0) return;
  if (state.running && k === state.i) return showStop();
  state.peek = state.stops[k];
  show("backBtn", state.running);
  renderPlace(state.peek, `Stop ${k + 1} of ${state.stops.length}`);
}
function updateDistance() {
  const from = state.pos || [CITY.start.lng, CITY.start.lat];
  const p = shown();
  if (p && !el("card").hidden) {
    const label = TYPE_LABEL[p.type] || "Place";
    el("stopMeta").textContent = !state.peek && state.atStop ? `${label} · you're here`
      : `${label} · ${fmtDist(metersBetween(from, [p.lng, p.lat], p.lat))}`;
  }
  el("sideList").querySelectorAll(".spot").forEach((row, k) => {
    const s = state.stops[k];
    if (s) row.querySelector(".dist").textContent = fmtDist(metersBetween(from, [s.lng, s.lat], s.lat));
  });
}

function arrive() {
  const p = current();
  state.atStop = true;
  state.lastStop = p;
  state.arrivedAt = Date.now();     // for the opt-in "time at this stop" insight
  showStop();
  const about = p.about ? ` ${sentences(p.about, 2)}` : (p.menu ? ` They serve ${p.menu}.` : "");
  const side = sideOf(p.lng, p.lat);
  say(`${side ? `Look to your ${side}. ` : ""}${nameOf(p)}.${about} Do you like it? Tap Go if it's for you, or Skip.`);
}

// ✕ Skip / ○ Go — record taste for a place; for the stop you're walking to, move on
function judge(p, liked) {
  if (!p) return;
  state.feedback[p.id] = liked ? 1 : 0;
  saveFeedback();
  track(liked ? "go" : "skip", p, { course: state.course?.id });
  markStop(p.id, liked ? "liked" : "skipped");
  toast(liked ? `○ Saved — more like ${nameOf(p)}` : "✕ Noted — we'll show you less like this");
  if (liked) suggestFromLike(p);
  if (state.running && p === current()) return advance();
  if (state.running && state.peek) return showStop();
  renderList();
}
function advance() {
  audioStop();
  const p = current();
  if (p && state.feedback[p.id] === undefined) markStop(p.id, "visited");
  if (p && state.atStop && state.arrivedAt) track("dwell", p, { course: state.course?.id, seconds: (Date.now() - state.arrivedAt) / 1000 });
  state.arrivedAt = null;
  state.i++;
  state.atStop = false;
  if (state.i >= state.stops.length) { show("card", false); return endWalk(); }
  showStop();
}

// ---------- the guide: a voice that walks with you (no chat, like Myeongdong 3D) ----------
// What it says comes from the route, the live weather and Qloo place data —
// no language model writes anything. Every line is also logged in the Guide tab.
const TOO_FAR_S = 15 * 60;      // a detour longer than this goes to My Trip instead
const NEAR_M = 300;             // "you're near a place you saved" radius
const PASS_M = 80;              // passing a Qloo place this close → its story
const TIP_M = 250;              // weather tips may point a bit further
const STORY_GAP_MS = 25000, TIP_GAP_MS = 180000;
const QLOO_SRC = { label: "From Qloo" };
const TASTE_SRC = { label: "Qloo taste data — what people with this taste like, not a prediction about you" };

function setTab(tab) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  document.body.classList.remove("side-closed"); show("sideOpen", false);
  if (!matchMedia("(min-width: 900px)").matches) document.body.classList.add("drawer-open");
  layout();
  if (tab === "buddy" && !el("msgs").children.length) {
    addMsg("buddy", `I'm your walking guide in ${CITY.area}. Start a walk and I'll talk you through it — everything I say shows up here.`);
  }
  if (tab === "trip") renderTrip();
}

function addMsg(role, text, actions, source) {
  const m = document.createElement("div");
  m.className = `msg ${role}`;
  m.textContent = text;
  if (source) {
    const a = Object.assign(document.createElement(source.url ? "a" : "span"), { className: "msg-src", textContent: source.label });
    if (source.url) Object.assign(a, { href: source.url, target: "_blank", rel: "noopener" });
    m.append(a);
  }
  for (const action of [].concat(actions || [])) {
    const b = document.createElement("button");
    b.className = "msg-act"; b.textContent = action.label;
    b.addEventListener("click", () => { m.querySelectorAll(".msg-act").forEach((x) => { x.disabled = true; }); action.run(); });
    m.append(b);
  }
  el("msgs").append(m);
  el("msgs").scrollTop = el("msgs").scrollHeight;
  return m;
}

function findPlace(name) {
  const q = name.toLowerCase().trim();
  const names = (p) => [p.enName, p.title].filter(Boolean).map((s) => s.toLowerCase());
  return state.pois.find((p) => names(p).includes(q))
    || (q.length >= 4 && state.pois.find((p) => names(p).some((n) => n.includes(q) || (n.length >= 4 && q.includes(n)))))
    || null;
}

// redraw every stop marker's state after the stops were re-ordered
const remark = () => state.stops.forEach((s, j) => markStop(s.id, j < state.i ? "visited" : j === state.i ? "next"
  : state.feedback[s.id] === 1 ? "liked" : state.feedback[s.id] === 0 ? "skipped" : ""));

// add a place to the walk if the detour is short, else save it to My Trip
async function handleWant(place, { force = false } = {}) {
  const p = typeof place === "string" ? findPlace(place) : place;
  if (!p) return say(`I can't find "${place}" on my map yet, sorry!`);
  const k = state.stops.findIndex((s) => s.id === p.id);
  if (k >= (state.running ? state.i : 0) && k >= 0) return say(`${nameOf(p)} is already on our walk — it's stop ${k + 1}.`);
  const from = state.running ? { lng: state.pos[0], lat: state.pos[1] } : CITY.start;
  const done = state.running ? state.stops.slice(0, state.i) : [];
  const rest = state.running ? state.stops.slice(state.i) : state.stops.slice();
  // cheapest place to slot it in, by straight-line detour
  const pt = (s) => [s.lng, s.lat];
  let at = rest.length, best = Infinity;
  for (let j = 0; j <= rest.length; j++) {
    const a = j === 0 ? from : rest[j - 1], b = rest[j];
    const extra = metersBetween(pt(a), pt(p), p.lat) + (b ? metersBetween(pt(p), pt(b), p.lat) - metersBetween(pt(a), pt(b), p.lat) : 0);
    if (extra < best) { best = extra; at = j; }
  }
  const withP = [...rest.slice(0, at), p, ...rest.slice(at)];
  const thinking = addMsg("typing", "checking the walk…");
  const [base, next] = await Promise.all([
    rest.length ? fetchWalkPath(from, rest, WALK_M_PER_MIN) : Promise.resolve({ seconds: 0 }),
    fetchWalkPath(from, withP, WALK_M_PER_MIN),
  ]);
  thinking.remove();
  const extraMin = Math.max(1, Math.round((next.seconds - base.seconds) / 60));
  if (!force && next.seconds - base.seconds > TOO_FAR_S) {
    saveToTrip(p);
    toast(`⭐ ${nameOf(p)} is ~${extraMin} min off the walk — saved to Trip for later`, 5000);
    return say(`${nameOf(p)} is about ${extraMin} min out of the way, so I saved it to your trip list ⭐ — I'll give you a shout when you're near it.`);
  }
  // re-plan from here: walked stops stay, the rest follows the new route
  const stops = [...done, ...withP];
  const reach = [...(state.sel?.reach || []).slice(0, done.length), ...withP.map((s, j) => next.waypoints?.[j + 1] || pt(s))];
  const cum = cumulative(next.path), len = cum[cum.length - 1] || 0;
  if (state.running) {
    Object.assign(state, { stops, path: next.path, cum, len, dist: 0 });
    state.sel = { ...state.sel, stops, reach };
    setRoute(next.path);
    setStops(stops, peek);
    remark();
    renderList();
  } else {
    const minutes = next.seconds / 60 + stops.reduce((s, x) => s + (DWELL[x.type] || 10), 0);
    selectPlan({ ...state.sel, stops, path: next.path, cum, len, minutes, reach });
  }
  removeFromTrip(p.id);
  toast(`＋ ${nameOf(p)} added to the walk (+${extraMin} min)`, 4000);
  say(`Added ${nameOf(p)} — about ${extraMin} more min of walking. It's stop ${done.length + at + 1} now.`);
}

// ---------- My Trip: places saved for later ----------
function loadTrip() { try { return JSON.parse(localStorage.getItem("tw-trip") || "[]"); } catch { return []; } }
function saveTrip() { try { localStorage.setItem("tw-trip", JSON.stringify(state.trip)); } catch { /* private mode */ } renderTrip(); }
function saveToTrip(p) {
  if (!state.trip.some((t) => t.id === p.id)) state.trip.push({ id: p.id, name: nameOf(p), lng: p.lng, lat: p.lat, type: p.type, image: p.image || "", alerted: false });
  saveTrip();
}
function removeFromTrip(id) { state.trip = state.trip.filter((t) => t.id !== id); saveTrip(); }
const tripPlace = (t) => state.pois.find((p) => p.id === t.id) || { id: t.id, enName: t.name, lng: t.lng, lat: t.lat, type: t.type, image: t.image };
function renderTrip() {
  el("tripCount").textContent = state.trip.length;
  const box = el("tripList"); box.innerHTML = "";
  if (!state.trip.length) { box.innerHTML = `<p class="hint empty">Find a place you want to go above: if it's close to your walk it goes in, if it's far it waits here — and I'll tell you when you're near it.</p>`; return; }
  const from = state.pos || [CITY.start.lng, CITY.start.lat];
  for (const t of state.trip) {
    const row = document.createElement("div");
    row.className = "spot";
    row.innerHTML = `${t.image ? `<img src="${t.image}" alt="" loading="lazy" />` : `<i>${TYPE_ICON[t.type] || "📍"}</i>`}
      <div class="spot-text"><b></b><small>${fmtDist(metersBetween(from, [t.lng, t.lat], t.lat))} away</small></div>
      <button class="mini yes" title="Add to this walk">＋</button><button class="mini no" title="Remove">✕</button>`;
    row.querySelector("b").textContent = t.name;
    row.querySelector(".yes").addEventListener("click", () => { setTab("buddy"); handleWant(tripPlace(t), { force: true }); });
    row.querySelector(".no").addEventListener("click", () => removeFromTrip(t.id));
    box.append(row);
  }
}
// walking past a saved place → a popup, once per place; you choose
function checkNearTrip() {
  if (!state.running || !state.pos || !el("tripPop").hidden) return;
  for (const t of state.trip) {
    if (t.alerted) continue;
    const d = metersBetween(state.pos, [t.lng, t.lat], t.lat);
    if (d > NEAR_M) continue;
    t.alerted = true; saveTrip();
    el("tripPopText").textContent = `${t.name} is just ${fmtDist(d)} from here. Add it to this walk now?`;
    el("tripPopAdd").onclick = () => { show("tripPop", false); handleWant(tripPlace(t), { force: true }); };
    el("tripPopLater").onclick = () => { show("tripPop", false); toast(`⭐ ${t.name} stays in your Trip`); };
    show("tripPop");
    say(`Psst — ${t.name}, a place you saved earlier, is just ${fmtDist(d)} from here. Want to add it to the walk?`);
    return;
  }
}

// Trip tab: find a place you want to go (Qloo search), then it goes in the walk or waits in Trip
async function findForTrip(q) {
  const box = el("tripResults");
  q = q.trim();
  if (!q) { box.innerHTML = ""; return; }
  box.innerHTML = `<p class="hint empty">Looking on Qloo…</p>`;
  let places;
  try { places = (await qget(`/api/qloo/search?q=${encodeURIComponent(q)}`)).places; }
  catch { box.innerHTML = `<p class="hint empty">Couldn't reach Qloo — try again in a moment.</p>`; return; }
  box.innerHTML = places.length ? "" : `<p class="hint empty">No place called “${q.replace(/[<&]/g, "")}” in ${CITY.area} on Qloo.</p>`;
  const from = state.pos || [CITY.start.lng, CITY.start.lat];
  for (const x of places) {
    const p = qPlace(x), row = document.createElement("div");
    row.className = "spot";
    row.innerHTML = `${x.image ? `<img src="${x.image}" alt="" loading="lazy" />` : `<i>${TYPE_ICON[p.type] || "📍"}</i>`}
      <div class="spot-text"><b></b><small>${fmtDist(metersBetween(from, [x.lon, x.lat], x.lat))} away</small></div>
      <button class="mini yes" title="I want to go here">＋</button>`;
    row.querySelector("b").textContent = x.name;
    row.querySelector(".yes").addEventListener("click", () => { box.innerHTML = ""; el("tripQ").value = ""; handleWant(p); });
    box.append(row);
  }
}

// ---------- Qloo ----------
const qget = async (path) => { const r = await fetch(path); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };
const waitQuiet = async () => { while (isPlaying()) await new Promise((r) => setTimeout(r, 300)); };
// in this order: the TV Tower has a restaurant, but it's a landmark first
const TYPE_BY_TAG = [[/museum|gallery|theat|cinema|club|music|\bart\b/i, "culture"],
  [/landmark|monument|memorial|cathedral|church|fountain|plaza|square|palace|tower/i, "attraction"],
  [/restaurant|cafe|coffee|bar|bakery|food|pub|bistro|diner|burger/i, "food"], [/shop|store|market|boutique|mall/i, "shopping"]];
// a Qloo place in the shape the walk uses; its kind of place first (a museum with a café is still a museum)
function qPlace(q) {
  const words = q.kinds?.length ? q.kinds : q.tags;
  const type = (TYPE_BY_TAG.find(([re]) => words.some((t) => re.test(t))) || [, "attraction"])[1];
  return { id: "qloo:" + q.id, qid: q.id, q, enName: q.name, title: q.name, lng: q.lon, lat: q.lat, type, image: q.image || "", about: q.about || "" };
}
// the Qloo entry for one of our places: within 150 m AND the same name (one contains the other) —
// "Fernsehturm Berlin" must not turn into the "Café am Fernsehturm" next door
const normName = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
async function qlooMatch(p) {
  if (p.q !== undefined) return p.q;
  const j = await qget(`/api/qloo/search?q=${encodeURIComponent(nameOf(p))}`);
  const mine = [p.enName, p.title].filter(Boolean).map(normName);
  const same = (q) => mine.some((n) => { const o = normName(q.name); return n === o || (o.length >= 5 && n.includes(o)) || (n.length >= 5 && o.includes(n)); });
  p.q = j.places.find((q) => same(q) && metersBetween([p.lng, p.lat], [q.lon, q.lat], p.lat) < 150) || null;
  if (p.q) p.qid = p.q.id;
  return p.q;
}

// ○ Go → the places Qloo says people with the same taste also like; offer the nearest
const qlooLikes = [];           // Qloo ids of places Go'd on this visit (signals, max 5 sent)
const suggested = new Set();
async function suggestFromLike(p) {
  try {
    const q = await qlooMatch(p);
    if (!q) return;
    if (!qlooLikes.includes(q.id)) qlooLikes.push(q.id);
    const j = await qget(`/api/qloo/similar?ids=${qlooLikes.slice(-5).join(",")}&take=20`);
    const from = state.pos || [CITY.start.lng, CITY.start.lat];
    const taken = new Set([...state.stops.map((s) => s.qid), ...state.trip.map((t) => t.id), ...suggested]);
    const pick = j.places.slice(0, 10).filter((x) => !taken.has(x.id) && !taken.has("qloo:" + x.id))
      .map((x) => ({ x, d: metersBetween(from, [x.lon, x.lat], x.lat) })).filter((c) => c.d < 2500).sort((a, b) => a.d - b.d)[0];
    if (!pick) return;
    suggested.add(pick.x.id);
    const place = qPlace(pick.x);
    await waitQuiet();
    say(`Since you liked ${nameOf(p)}: people with that taste also like ${pick.x.name}, ${fmtDist(pick.d)} from here.${pick.x.about ? " " + sentences(pick.x.about, 1) : ""}`,
      TASTE_SRC, [
        { label: "＋ Add to the walk", run: () => handleWant(place) },
        { label: "⭐ Later", run: () => { saveToTrip(place); toast(`⭐ Saved ${pick.x.name}`); } },
      ]);
  } catch { /* Qloo unavailable — no suggestion this time */ }
}

// ---------- on the way: passing places + weather tips, from nearby Qloo places ----------
const nearbyCache = new Map();  // ~100 m grid cell → Promise of places (the server rounds the same way)
function nearbyPlaces([lng, lat]) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (!nearbyCache.has(key)) nearbyCache.set(key, qget(`/api/qloo/nearby?lat=${lat.toFixed(3)}&lon=${lng.toFixed(3)}`).then((j) => j.places).catch(() => []));
  return nearbyCache.get(key);
}
// what the weather/time asks for → Qloo place tags that answer it
function conditions() {
  const w = state.wx || {}, h = +new Date().toLocaleString("en-US", { timeZone: CITY.tz, hour: "numeric", hour12: false }), out = [];
  if (w.code >= 51) out.push({ why: w.code >= 71 && w.code <= 77 ? "the snow" : "the rain", tags: ["cozy", "hot chocolate", "indoor", "warm atmosphere", "fireplace"] });
  if (w.temp != null && w.temp <= 8) out.push({ why: "a cold day", tags: ["cozy", "hot chocolate", "warm atmosphere", "fireplace"] });
  if (w.temp != null && w.temp >= 26) out.push({ why: "the heat", tags: ["ice cream", "air condition", "garden", "river view", "shade"] });
  if (w.code != null && w.code <= 2 && w.day && w.temp > 12) out.push({ why: "the sunshine", tags: ["outdoor seating", "outdoor terrace", "terrace", "beer garden", "garden", "rooftop"] });
  if (h >= 17 && h < 21) out.push({ why: "this evening", tags: ["sunset view", "evening", "live music"] });
  if (h >= 21 || h < 4) out.push({ why: "tonight", tags: ["late night", "nightlife", "late night food", "live music"] });
  if (h >= 6 && h < 11) out.push({ why: "the morning", tags: ["breakfast", "brunch", "early morning"] });
  return out;
}
function weatherTip(near) {
  for (const c of conditions()) for (const { q, d } of near) {
    const tag = q.tags.find((t) => c.tags.some((k) => t.toLowerCase().includes(k)));
    if (tag) return { q, d, text: `Tip for ${c.why}: ${q.name}, ${fmtDist(d)} away${sideOf(q.lon, q.lat) ? ` on your ${sideOf(q.lon, q.lat)}` : ""} — Qloo tags it “${tag}”.` };
  }
  return null;
}
// 📸 a photo spot = a nearby place Qloo rates as popular and tags for views / photography
// (Qloo's own signals — we never claim it's "popular on Instagram")
const PHOTO_TAGS = ["photography", "scenic", "viewing platform", "panoramic", "skyline", "sunset view", "street art", "landmark view", "river view"];
const PHOTO_M = 120, PHOTO_POP = 0.9, PHOTO_GAP_MS = 120000;
function photoSpot(near) {
  for (const k of PHOTO_TAGS) for (const { q, d } of near) {
    if (d > PHOTO_M || (q.popularity ?? 0) < PHOTO_POP) continue;
    const tag = q.tags.find((t) => t.toLowerCase().includes(k));
    if (tag) return { q, d, tag };
  }
  return null;
}
const told = new Set();
let lastStoryAt = 0, lastTipAt = 0, lastPhotoAt = 0, aroundBusy = false;
async function checkAround() {
  if (!state.running || state.atStop || state.paused || aroundBusy || !state.pos || isPlaying()) return;
  aroundBusy = true;
  try {
    if (state.mode === "sim" && state.path.length) nearbyPlaces(pointAlong(state.path, state.cum, state.dist + 200).pos);   // fetch ahead
    const here = state.pos, places = await nearbyPlaces(here);
    if (!state.running || state.atStop || isPlaying()) return;
    const onWalk = (q) => state.stops.some((s) => s.qid === q.id || metersBetween([s.lng, s.lat], [q.lon, q.lat], q.lat) < 40);
    const near = places.filter((q) => !told.has(q.id) && !onWalk(q))
      .map((q) => ({ q, d: metersBetween(here, [q.lon, q.lat], q.lat) })).sort((a, b) => a.d - b.d);
    const now = Date.now();
    const ps = now - lastPhotoAt > PHOTO_GAP_MS ? photoSpot(near) : null;
    if (ps) {
      told.add(ps.q.id); lastPhotoAt = lastStoryAt = now;
      const spot = qPlace(ps.q), side = sideOf(ps.q.lon, ps.q.lat);
      state.photoSpot = { p: spot, at: now };          // a photo taken soon after gets this place's caption
      toast("📸 Popular photo spot nearby!", 5000);
      return say(`Photo spot! ${ps.q.name}, ${fmtDist(ps.d)} away${side ? ` on your ${side}` : ""}. It's popular on Qloo and tagged “${ps.tag}”.`,
        QLOO_SRC, { label: "📷 Take a photo", run: snapPhoto });
    }
    const tip = now - lastTipAt > TIP_GAP_MS ? weatherTip(near.filter((x) => x.d < TIP_M)) : null;
    if (tip) {
      told.add(tip.q.id); lastTipAt = lastStoryAt = now;
      return say(tip.text, QLOO_SRC, { label: "⭐ Later", run: () => { saveToTrip(qPlace(tip.q)); toast(`⭐ Saved ${tip.q.name}`); } });
    }
    const pass = now - lastStoryAt > STORY_GAP_MS && near.find((x) => x.d < PASS_M && (x.q.story || x.q.about));
    if (pass) {
      told.add(pass.q.id); lastStoryAt = now;
      const side = sideOf(pass.q.lon, pass.q.lat);
      say(`${side ? `On your ${side}, ` : "Right here, "}${pass.q.name}. ${sentences(pass.q.story || pass.q.about, 2)}`, QLOO_SRC);
    }
  } finally { aroundBusy = false; }
}

// ---------- street stories: the street you just turned into, from English Wikipedia (read as is) ----------
const toldStreets = new Set();
let lastStreet = null, streetBusy = false, lastStreetTalk = 0;
async function checkStreet() {
  if (!state.running || state.atStop || state.paused || streetBusy || !state.pos || isPlaying()) return;
  if (state.mode === "gps" && !state.posGood) return;
  const street = streetAt(state.pos[0], state.pos[1]);
  if (!street || street === lastStreet) return;
  lastStreet = street;
  if (toldStreets.has(street)) return;
  toldStreets.add(street);
  streetBusy = true;
  try {
    const j = await qget(`/api/story?street=${encodeURIComponent(street)}`);
    if (!state.running || state.atStop) return;
    await waitQuiet();
    if (j.story) {
      lastStreetTalk = Date.now();
      say(`Now on ${street}. ${j.story}`, { label: `From Wikipedia — ${j.source.title}`, url: j.source.url });
    } else if (Date.now() - lastStreetTalk > 60000) {     // no article: just the name, now and then
      lastStreetTalk = Date.now();
      say(`Now on ${street}.`);
    }
  } catch { /* no story this time */ } finally { streetBusy = false; }
}

// ---------- navigation voice: turns, off-route, progress (from Myeongdong 3D) ----------
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
// "left"/"right" for a point beside the walker; "" when it's ahead or behind
function sideOf(lng, lat) {
  if (!state.pos || state.heading == null) return "";
  const d = angDiff(state.heading, bearingTo({ lng: state.pos[0], lat: state.pos[1] }, { lng, lat }));
  if (Math.abs(d) < 25 || Math.abs(d) > 155) return "";
  return d > 0 ? "right" : "left";
}
const segBearing = (a, b) => bearingTo({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
function turnAt(i) {
  const p = state.path, d = angDiff(segBearing(p[i - 1], p[i]), segBearing(p[i], p[i + 1]));
  return Math.abs(d) < 38 ? null : { i, dir: d > 0 ? "right" : "left" };
}
// demo walk: the next sharp corner within 26 m ahead
function upcomingTurn() {
  for (let i = 1; i < state.path.length - 1; i++) {
    if (state.cum[i] <= state.dist) continue;
    if (state.cum[i] - state.dist > 26) return null;
    const t = turnAt(i);
    if (t) return t;
  }
  return null;
}
// GPS: the nearest corner within 28 m of the real position
function gpsUpcomingTurn(a) {
  let bi = -1, bd = 28;
  for (let i = 1; i < state.path.length - 1; i++) {
    const d = metersBetween(a, state.path[i], a[1]);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi < 1 ? null : turnAt(bi);
}
const distToRoute = (a) => state.path.reduce((m, p) => Math.min(m, metersBetween(a, p, a[1])), Infinity);
let turnIdx = -1, offRoute = false, lastNavTalk = 0, lastPing = Date.now();
function navTick() {
  if (!state.running || state.paused || state.atStop || !state.pos || isPlaying() || !state.path.length) return;
  if (state.mode === "gps" && !state.posGood) return;
  const turn = state.mode === "gps" ? gpsUpcomingTurn(state.pos) : upcomingTurn();
  if (turn && turn.i !== turnIdx) { turnIdx = turn.i; playNarration(`Coming up — turn ${turn.dir}.`); return; }
  if (state.mode !== "gps") return;
  const next = current(), now = Date.now(), d = distToRoute(state.pos);
  const ahead = next ? ` ${nameOf(next)} is about ${fmtDist(metersBetween(state.pos, [next.lng, next.lat], next.lat))} away.` : "";
  if (d > 45 && !offRoute && now - lastNavTalk > 25000) {
    offRoute = true; lastNavTalk = now; toast("↩️ Off the route");
    say(`Looks like you've wandered off the route.${next ? ` Head back toward ${nameOf(next)} — it's about ${fmtDist(metersBetween(state.pos, [next.lng, next.lat], next.lat))} away.` : ""}`);
  } else if (d < 28 && offRoute) {
    offRoute = false; lastNavTalk = now; toast("✅ Back on the route");
    say(`Nice — you're back on the route.${ahead}`);
  } else if (!offRoute && next && now - lastPing > 90000 && now - lastNavTalk > 30000) {
    lastPing = lastNavTalk = now;
    say(`You're doing great.${ahead}`);
  }
}

// ---------- movement: demo walk + live GPS ----------
let lastTs = 0;
function frame(ts) {
  const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05); lastTs = ts;
  if (state.running && state.mode === "sim" && !state.paused && !state.atStop) {
    state.dist = Math.min(state.dist + WALK_SPEED * dt, state.len);
    const at = pointAlong(state.path, state.cum, state.dist);
    state.pos = at.pos;
    state.heading = at.heading;
    follow(state.pos[0], state.pos[1], at.heading);
    checkArrival();
    if (state.dist >= state.len && !state.atStop) arrive();
  }
  requestAnimationFrame(frame);
}
function checkArrival() {
  const p = current();
  if (!p || state.atStop) return;
  const at = state.sel?.reach?.[state.i];
  const d = Math.min(metersBetween(state.pos, [p.lng, p.lat], p.lat), at ? metersBetween(state.pos, at, p.lat) : Infinity);
  if (d < ARRIVE_M) arrive();
}
setInterval(() => { updateDistance(); checkNearTrip(); }, 1000);
setInterval(checkAround, 3000);
setInterval(checkStreet, 3000);
setInterval(navTick, 700);

function startGPS() {
  if (!navigator.geolocation) { toast("This browser has no location access."); return; }
  stopGPS();
  toast("📍 Finding you… allow location access");
  state.fix = null;
  state.gpsWatch = navigator.geolocation.watchPosition((pos) => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    state.posGood = accuracy <= GOOD_FIX_M;   // a jumpy fix moves the dot but triggers nothing
    // heading from the last good fix, once you've moved a few metres (for "on your left/right")
    if (state.posGood && state.pos && metersBetween(state.pos, [lng, lat], lat) > 4) state.heading = bearingTo({ lng: state.pos[0], lat: state.pos[1] }, { lng, lat });
    state.pos = state.fix = [lng, lat];
    follow(lng, lat);
    if (metersBetween(state.pos, [CITY.start.lng, CITY.start.lat], lat) > CITY.maxFromCenterM) {
      toast(`You're outside ${CITY.area} — the guide starts when you get there.`);
      return;
    }
    if (state.running && state.posGood) { checkOtherStops(); checkArrival(); }
  }, (err) => {
    toast(err.code === 1 ? "📍 Location denied — allow it in the browser settings." : "📍 No location signal yet.", 5000);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}
function stopGPS() {
  if (state.gpsWatch != null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
}
// GPS: you reached a later stop first (like Myeongdong 3D) → take it now, re-plan the rest from here
function checkOtherStops() {
  if (state.atStop) return;
  const k = state.stops.findIndex((s, j) => j > state.i && metersBetween(state.pos, [s.lng, s.lat], s.lat) < OTHER_STOP_M);
  if (k < 0) return;
  const stops = state.stops.slice(), reach = (state.sel.reach || []).slice();
  stops.splice(state.i, 0, ...stops.splice(k, 1));
  reach.splice(state.i, 0, ...reach.splice(k, 1));
  state.stops = stops; state.sel = { ...state.sel, stops, reach };
  setStops(stops, peek); remark();
  toast(`📍 You found ${nameOf(stops[state.i])} first — re-planning the rest`);
  arrive();
  replanRest();
}
async function replanRest() {
  const rest = state.stops.slice(state.i + 1);
  if (!rest.length || !state.pos) return;
  const next = await fetchWalkPath({ lng: state.pos[0], lat: state.pos[1] }, rest, WALK_M_PER_MIN);
  if (!state.running) return;
  const cum = cumulative(next.path);
  Object.assign(state, { path: next.path, cum, len: cum[cum.length - 1] || 0, dist: 0 });
  state.sel = { ...state.sel, reach: [...state.sel.reach.slice(0, state.i + 1), ...rest.map((s, j) => next.waypoints?.[j + 1] || [s.lng, s.lat])] };
  setRoute(next.path);
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#modeToggle button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "gps" && state.running) startGPS(); else stopGPS();
}

// ---------- snap & post ----------
function snapPhoto() { el("camInput").value = ""; el("camInput").click(); }
// the place a photo belongs to: the stop you're at, a photo spot the guide just pointed out,
// or the stop you just left — null when you're nowhere in particular
function photoTarget() {
  if (state.atStop && current()) return current();
  const near = (p, m) => p && state.pos && metersBetween(state.pos, [p.lng, p.lat], p.lat) < m;
  const ps = state.photoSpot;
  if (ps && Date.now() - ps.at < 10 * 60000 && near(ps.p, 200)) return ps.p;
  return [state.lastStop, current()].find((p) => near(p, 150)) || null;
}
const tagify = (s) => s.replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
// Qloo tags that say nothing about a place (payments, access, amenities…) stay out of the hashtags
const BORING = /wheelchair|accessib|credit|debit|card|payment|nfc|cash|parking|restroom|toilet|elevator|minibar|towel|laundry|hair dryer|wi-?fi|onsite|reservation|ticket|morning|afternoon|evening|^night|foot traffic|destination|tourist attraction|city center|^place$|\d/i;
function hashtags(place, q) {
  const words = [...(q?.tags || []), ...(q?.keywords || [])]
    .filter((w) => !BORING.test(w) && !place.toLowerCase().includes(w.toLowerCase())).slice(0, 4);
  const seen = new Set();
  return [place !== CITY.area && place, ...words, ...CITY.hashtags, "TasteWalk"].filter(Boolean).map(tagify)
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}
// title / content / tags, filled from Qloo's data for the place (q) when Qloo knows it
function fillPost(place, q) {
  el("postTitle").value = place === CITY.area ? `📍 ${CITY.area}` : `📍 ${place}, ${CITY.area}`;
  el("postBody").value = q?.about ? sentences(q.about, 1) : "";
  el("postTags").value = hashtags(place, q).map((t) => "#" + t).join(" ");
}
const caption = () => [[el("postTitle").value, el("postBody").value].map((s) => s.trim()).filter(Boolean).join("\n"), el("postTags").value.trim()]
  .filter(Boolean).join("\n\n");
function compressImage(file, maxW = 1080) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(1, maxW / im.width), cv = document.createElement("canvas");
      cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      res(cv.toDataURL("image/jpeg", 0.85));
    };
    im.onerror = rej; im.src = url;
  });
}
async function onPhoto(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  let dataUrl;
  try { dataUrl = await compressImage(f); } catch { toast("Couldn't read that photo"); return; }
  const target = photoTarget(), place = target ? nameOf(target) : CITY.area;
  state.photo = { dataUrl, place };
  if (target && state.stops.includes(target)) track("photo", target, { course: state.course?.id });
  el("postImg").src = dataUrl;
  fillPost(place, target?.q);
  state.postEdited = false;
  show("post");
  // fill from Qloo's data for the place (the photo itself never leaves the device);
  // keep what's there if Qloo doesn't know it or the user already typed
  if (target && target.q === undefined) {
    el("postHint").textContent = "Looking the place up on Qloo…";
    try {
      const q = await qlooMatch(target);
      if (q && !state.postEdited) fillPost(place, q);
    } catch { /* template stays */ }
  }
  el("postHint").textContent = "Post to Instagram opens your share menu with the photo — the caption is copied, paste it in Instagram.";
}
async function copyCaption() {
  try { await navigator.clipboard.writeText(caption()); return true; } catch { return false; }
}
function savePhoto() {
  const a = document.createElement("a");
  a.href = state.photo.dataUrl; a.download = `tastewalk-${Date.now()}.jpg`; a.click();
}
async function sharePost() {
  const text = caption();
  const copied = await copyCaption();
  const blob = await (await fetch(state.photo.dataUrl)).blob();
  const file = new File([blob], "tastewalk.jpg", { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      toast(copied ? "Caption copied — paste it in Instagram" : "Shared");
    } catch (err) { if (err.name !== "AbortError") toast("Couldn't open the share menu"); }
    return;
  }
  // no file sharing here (most desktops): save the photo, caption is on the clipboard
  savePhoto();
  toast(copied ? "Photo saved, caption copied — post it from Instagram" : "Photo saved — copy the caption below", 5000);
}

// ---------- clock + weather chip ----------
const WX = (c, day) => (c >= 71 && c <= 77 ? "❄️" : c >= 51 ? "🌧️" : c >= 45 ? "🌫️" : c >= 1 ? "⛅" : day ? "☀️" : "🌙");
// map palette follows the city's real day/night (Open-Meteo is_day); until that answers, guess from the clock
const guessTheme = () => {
  const h = +new Date().toLocaleString("en-US", { timeZone: CITY.tz, hour: "numeric", hour12: false });
  return h >= 7 && h < 19 ? "day" : "night";
};
let weather = "";
function renderEnv() {
  const t = new Date().toLocaleTimeString("en-US", { timeZone: CITY.tz, hour: "2-digit", minute: "2-digit", hour12: false });
  el("envChip").textContent = `${weather} ${t} ${CITY.short}`.trim();
}
async function fetchWeather() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${CITY.start.lat}&longitude=${CITY.start.lng}&current=temperature_2m,weather_code,is_day&timezone=${encodeURIComponent(CITY.tz)}`;
    const { current: c } = await (await fetch(u)).json();
    weather = `${WX(c.weather_code, c.is_day)} ${Math.round(c.temperature_2m)}°`;
    state.wx = { code: c.weather_code, temp: c.temperature_2m, day: !!c.is_day };   // for the guide's weather tips
    setTheme(c.is_day ? "day" : "night");
  } catch { weather = ""; setTheme(guessTheme()); }
  renderEnv();
}

// ---------- wiring + boot ----------
function wire() {
  el("yesBtn").addEventListener("click", () => judge(shown(), true));
  el("noBtn").addEventListener("click", () => judge(shown(), false));
  el("camBtn").addEventListener("click", snapPhoto);
  el("snapBtn").addEventListener("click", snapPhoto);
  el("camInput").addEventListener("change", onPhoto);
  el("startBtn").addEventListener("click", () => (state.running ? endWalk() : startWalk()));
  el("pauseBtn").addEventListener("click", () => {
    state.paused = !state.paused;
    state.paused ? audioPause() : audioResume();
    renderDock();
  });
  el("prevBtn").addEventListener("click", () => playNarration(state.lastLine));
  el("nextBtn").addEventListener("click", advance);
  el("resetBtn").addEventListener("click", () => state.sel && selectPlan(state.sel));
  el("backBtn").addEventListener("click", showStop);
  el("cardClose").addEventListener("click", () => { state.peek = null; show("card", false); });
  el("gallery").addEventListener("scroll", countSlides, { passive: true });
  el("galPrev").addEventListener("click", () => galleryStep(-1));
  el("galNext").addEventListener("click", () => galleryStep(1));
  // sidebar: fold away on desktop, slide up as a drawer on phones
  const setSide = (open) => { document.body.classList.toggle("side-closed", !open); show("sideOpen", !open); layout(); };
  el("sideFold").addEventListener("click", () => setSide(false));
  el("sideOpen").addEventListener("click", () => setSide(true));
  el("listBtn").addEventListener("click", () => {
    if (document.body.classList.contains("drawer-open")) document.body.classList.remove("drawer-open");
    else setTab("spots");
  });
  // sidebar tabs: spots · the guide's log · My Trip
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  el("tripSearch").addEventListener("submit", (e) => { e.preventDefault(); findForTrip(el("tripQ").value); });
  renderTrip();
  // opt-in insights: ask once, changeable + deletable from the sidebar
  const renderShare = () => { el("shareState").textContent = consent() === "yes" ? "on" : "off"; };
  const answer = (yes) => { setConsent(yes); show("consent", false); renderShare(); toast(yes ? "Thanks — sharing is on" : "Sharing is off"); };
  el("consentYes").addEventListener("click", () => answer(true));
  el("consentNo").addEventListener("click", () => answer(false));
  el("shareToggle").addEventListener("click", () => answer(consent() !== "yes"));
  el("deleteData").addEventListener("click", async () => {
    if (!confirm("Delete everything this device has shared with TasteWalk?")) return;
    try { const n = await deleteMyData(); toast(`Deleted ${n} record${n === 1 ? "" : "s"} from the server`); }
    catch { toast("Couldn't reach the server — try again later"); }
  });
  renderShare();
  show("consent", consent() === null);
  el("recenterBtn").addEventListener("click", () => { recenter(); if (state.pos) follow(state.pos[0], state.pos[1]); });
  document.querySelectorAll("#modeToggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  for (const id of ["postTitle", "postBody", "postTags"]) el(id).addEventListener("input", () => { state.postEdited = true; });
  el("shareBtn").addEventListener("click", sharePost);
  el("copyBtn").addEventListener("click", async () => toast((await copyCaption()) ? "Caption copied" : "Select the text to copy it"));
  el("saveBtn").addEventListener("click", savePhoto);
  el("postClose").addEventListener("click", () => show("post", false));
  new ResizeObserver(layout).observe(el("bottom"));
  window.addEventListener("resize", layout);
}
// keep the map's visible centre clear of the dock (and the sidebar on desktop),
// so the walker is never hidden under a panel
function layout() {
  const bottom = el("bottom").offsetHeight + 24;
  const wide = matchMedia("(min-width: 900px)").matches;
  const right = wide && !document.body.classList.contains("side-closed") ? el("sidebar").offsetWidth + 24 : 0;
  document.documentElement.style.setProperty("--bottom-h", `${bottom}px`);
  setInsets({ bottom, right });
}

async function boot() {
  try {
    state.osm = (await fetch("./data/area-pois.json").then((r) => r.json())).pois;
    const pool = loadPool(CITY.start);     // ~5 s — asked while the map loads
    const theme = guessTheme();
    document.documentElement.dataset.theme = theme;
    await initMap(el("map"), CITY.start, theme);
    wire();
    layout();
    renderCourseBar(pool);
    renderEnv(); fetchWeather();
    setInterval(renderEnv, 30000); setInterval(fetchWeather, 600000);
    requestAnimationFrame(frame);
    // browsers only let a page make sound after a tap — so the welcome waits for one
    el("overlayMsg").hidden = true; show("tapNote"); show("tapStart");
    el("tapStart").addEventListener("click", () => {
      el("overlay").classList.add("hidden");
      prime();
      addMsg("buddy", WELCOME);
      playFile("./audio/welcome.mp3", WELCOME);
    }, { once: true });
  } catch (err) {
    console.error(err);
    el("overlayMsg").textContent = `Couldn't load the map: ${err.message}`;
  }
}
boot();
