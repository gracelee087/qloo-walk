// TasteWalk — pick a walk, follow the route, tap ✕ / ○ at each stop so the
// guide learns your taste, snap a photo and post it straight to Instagram.
// Walking area: city.js. Map: map2d.js. Routing: route.js. Voice: audio.js.
import { playNarration, stop as audioStop, pause as audioPause, resume as audioResume } from "./audio.js";
import { initMap, setRoute, setStops, markStop, follow, recenter, fitStops } from "./map2d.js";
import { metersBetween, buildGraph, orderStops, buildWalkPath, cumulative, pointAlong } from "./route.js";
import { CITY } from "./city.js";

const el = (id) => document.getElementById(id);
const WALK_SPEED = 12;          // m/s — the demo walk is sped up
const ARRIVE_M = 35;            // "you're at the stop"
const WALK_M_PER_MIN = 75;      // ~4.5 km/h, for time estimates
// assumed minutes spent at each kind of stop — only for the "est." times
const DWELL = { food: 30, culture: 20, attraction: 10, shopping: 10 };
const TYPE_LABEL = { food: "Food & drink", culture: "Culture", attraction: "Sight", shopping: "Shop" };

// stop picks are placeholders until Qloo ranks places for the walker's taste
const COURSES = [
  { id: "must", name: "Must See", note: "Landmarks and museums", n: 8, pick: (p) => p.type === "attraction" || p.type === "culture" },
  { id: "classic", name: "Classic", note: "A bit of everything", n: 6, pick: () => true, mix: true },
  { id: "slow", name: "Slow Down", note: "Fewer stops, food and coffee", n: 4, pick: (p) => p.type === "food" },
];

const state = {
  pois: [], graph: null,
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
function pickStops(course) {
  // nearest first, but a place without a description counts as 400 m farther,
  // so walks favour stops the guide can actually tell you about
  const near = state.pois.filter(course.pick)
    .map((p) => ({ p, d: metersBetween([p.lng, p.lat], [CITY.start.lng, CITY.start.lat], p.lat) + (p.about ? 0 : 400) }))
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
function planCourse(course) {
  const stops = orderStops(CITY.start, pickStops(course));
  const path = buildWalkPath(state.graph, CITY.start, stops);
  const cum = cumulative(path);
  const len = cum[cum.length - 1] || 0;
  const minutes = len / WALK_M_PER_MIN + stops.reduce((s, p) => s + (DWELL[p.type] || 10), 0);
  return { course, stops, path, cum, len, minutes };
}
function renderCourses() {
  el("areaName").textContent = CITY.area;
  const box = el("courses"); box.innerHTML = "";
  for (const c of COURSES) {
    const plan = planCourse(c);
    const b = document.createElement("button");
    b.className = "course";
    b.innerHTML = `<b>${c.name}</b><span>${c.note} · ${plan.stops.length} stops · ${fmtDist(plan.len)}</span><em>≈ ${fmtMin(plan.minutes)}</em>`;
    b.title = "Estimated time: walking + an assumed stay at each stop";
    b.addEventListener("click", () => startCourse(plan));
    box.append(b);
  }
}

// ---------- the walk ----------
function startCourse(plan) {
  Object.assign(state, { course: plan.course, stops: plan.stops, path: plan.path, cum: plan.cum, len: plan.len, i: 0, dist: 0, atStop: false, running: true, paused: false });
  state.pos = [CITY.start.lng, CITY.start.lat];
  setRoute(plan.path);
  setStops(plan.stops, peek);
  fitStops(CITY.start);
  recenter();
  show("viewPick", false); show("viewWalk"); show("recenterBtn");
  el("pauseBtn").textContent = "Pause";
  showStop();
  if (state.mode === "gps") startGPS();
  playNarration(`Welcome to ${CITY.area}. Follow the red line. At each stop, tell me if it's for you.`);
}

function current() { return state.stops[state.i]; }
const shown = () => state.peek || current();      // the place on the sheet right now
const sentences = (t, n) => (t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t]).slice(0, n).join("").trim();

// fill the sheet with one place: photo, name, description + its source
function renderPlace(p, kicker) {
  el("stopIdx").textContent = kicker;
  el("stopName").textContent = nameOf(p);
  const img = el("stopImg");
  if (p.image) { img.src = p.image; img.hidden = false; } else { img.hidden = true; img.removeAttribute("src"); }
  const facts = [p.menu && `Serves ${p.menu}.`, p.hours && `Hours: ${p.hours}`].filter(Boolean).join(" ");
  el("stopBlurb").textContent = p.about ? sentences(p.about, 3) : facts;
  const src = el("stopSrc");
  if (p.about && p.aboutUrl) {
    src.innerHTML = `${facts ? facts + " · " : ""}From <a href="${p.aboutUrl}" target="_blank" rel="noopener">${p.aboutSource}</a>`;
    src.hidden = false;
  } else src.hidden = true;
  updateDistance();
}
function showStop() {
  const p = current();
  if (!p) return;
  state.peek = null; show("backBtn", false);
  markStop(p.id, "next");
  renderPlace(p, `${state.atStop ? "Stop" : "Next"} ${state.i + 1} of ${state.stops.length}`);
}
// tap a stop on the map → read about it without leaving the walk
function peek(id) {
  const k = state.stops.findIndex((s) => s.id === id);
  if (k < 0) return;
  if (k === state.i) return showStop();
  state.peek = state.stops[k];
  show("backBtn");
  renderPlace(state.peek, `Stop ${k + 1} of ${state.stops.length}`);
}
function updateDistance() {
  const p = shown();
  if (!p || !state.pos) return;
  const label = TYPE_LABEL[p.type] || "Place";
  el("stopMeta").textContent = !state.peek && state.atStop ? `${label} · you're here`
    : `${label} · ${fmtDist(metersBetween(state.pos, [p.lng, p.lat], p.lat))}`;
}

function arrive() {
  const p = current();
  state.atStop = true;
  state.lastStop = p;
  showStop();
  const about = p.about ? ` ${sentences(p.about, 2)}` : (p.menu ? ` They serve ${p.menu}.` : "");
  playNarration(`${nameOf(p)}.${about} Do you like it? Tap the circle for yes, the cross for no.`);
}

// ✕ / ○ — record taste for the place on the sheet; at the current stop, move on
function judge(liked) {
  const p = shown();
  if (!p) return;
  state.feedback[p.id] = liked ? 1 : 0;
  saveFeedback();
  markStop(p.id, liked ? "liked" : "skipped");
  toast(liked ? `○ Saved — more like ${nameOf(p)}` : "✕ Noted — we'll show you less like this");
  if (state.peek) return showStop();
  advance();
}
function advance() {
  audioStop();
  const p = current();
  if (p && state.feedback[p.id] === undefined) markStop(p.id, "visited");
  state.i++;
  state.atStop = false;
  if (state.i >= state.stops.length) return finish();
  showStop();
}
function finish() {
  state.running = false;
  stopGPS();
  const liked = state.stops.filter((s) => state.feedback[s.id] === 1).length;
  toast(`Walk done — you liked ${liked} of ${state.stops.length} stops`, 5000);
  playNarration(`That's the walk. You liked ${liked} of ${state.stops.length} stops.`);
  show("viewWalk", false); show("viewPick"); show("recenterBtn", false);
}

// ---------- movement: demo walk + live GPS ----------
let lastTs = 0;
function frame(ts) {
  const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05); lastTs = ts;
  if (state.running && state.mode === "sim" && !state.paused && !state.atStop) {
    state.dist = Math.min(state.dist + WALK_SPEED * dt, state.len);
    state.pos = pointAlong(state.path, state.cum, state.dist).pos;
    follow(state.pos[0], state.pos[1]);
    checkArrival();
    if (state.dist >= state.len && !state.atStop) arrive();
  }
  requestAnimationFrame(frame);
}
function checkArrival() {
  const p = current();
  if (p && !state.atStop && metersBetween(state.pos, [p.lng, p.lat], p.lat) < ARRIVE_M) arrive();
}
setInterval(() => { if (state.running) updateDistance(); }, 1000);

function startGPS() {
  if (!navigator.geolocation) { toast("This browser has no location access."); return; }
  stopGPS();
  toast("📍 Finding you… allow location access");
  state.gpsWatch = navigator.geolocation.watchPosition((pos) => {
    const { latitude: lat, longitude: lng } = pos.coords;
    state.pos = [lng, lat];
    follow(lng, lat);
    if (metersBetween(state.pos, [CITY.start.lng, CITY.start.lat], lat) > CITY.maxFromCenterM) {
      toast(`You're outside ${CITY.area} — the guide starts when you get there.`);
      return;
    }
    if (state.running) checkArrival();
  }, (err) => {
    toast(err.code === 1 ? "📍 Location denied — allow it in the browser settings." : "📍 No location signal yet.", 5000);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
}
function stopGPS() {
  if (state.gpsWatch != null) navigator.geolocation.clearWatch(state.gpsWatch);
  state.gpsWatch = null;
}
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#modeToggle button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "gps" && state.running) startGPS(); else stopGPS();
}

// ---------- snap & post ----------
// tag the photo with the stop you're at, or the one you just left
function photoPlace() {
  if (state.atStop && current()) return nameOf(current());
  for (const p of [state.lastStop, current()]) {
    if (p && state.pos && metersBetween(state.pos, [p.lng, p.lat], p.lat) < 150) return nameOf(p);
  }
  return CITY.area;
}
const placeKind = (name) => {
  const p = state.stops.find((s) => nameOf(s) === name);
  return p ? [TYPE_LABEL[p.type], p.menu].filter(Boolean).join(", ") : "";
};
const tagify = (s) => s.replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
function defaultCaption(place) {
  const tags = [place !== CITY.area && tagify(place), ...CITY.hashtags, "TasteWalk"].filter(Boolean);
  const where = place === CITY.area ? place : `${place}, ${CITY.area}`;
  return `📍 ${where}\n\n${tags.map((t) => "#" + t).join(" ")}`;
}
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
  const place = photoPlace();
  state.photo = { dataUrl, place };
  el("postImg").src = dataUrl;
  const ta = el("postText");
  ta.value = defaultCaption(place); ta.dataset.edited = "";
  el("postHint").textContent = "Writing a caption…";
  show("post");
  // AI caption from the photo itself; keep the template if it fails or the user already typed
  try {
    const r = await fetch("/api/caption", {
      method: "POST", headers: { "content-type": "application/json" },
      // text only: the photo stays on the device (Gemma free tier may use inputs to improve Google products)
      body: JSON.stringify({ place, area: CITY.area, kind: placeKind(place), hashtags: CITY.hashtags }),
    });
    const j = await r.json();
    if (r.ok && j.caption && !ta.dataset.edited) ta.value = j.caption;
  } catch { /* template stays */ }
  el("postHint").textContent = "Sharing copies your caption — paste it in Instagram and add the location there.";
}
async function copyCaption() {
  try { await navigator.clipboard.writeText(el("postText").value); return true; } catch { return false; }
}
function savePhoto() {
  const a = document.createElement("a");
  a.href = state.photo.dataUrl; a.download = `tastewalk-${Date.now()}.jpg`; a.click();
}
async function sharePost() {
  const caption = el("postText").value;
  const copied = await copyCaption();
  const blob = await (await fetch(state.photo.dataUrl)).blob();
  const file = new File([blob], "tastewalk.jpg", { type: "image/jpeg" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: caption });
      toast(copied ? "Caption copied — paste it in Instagram" : "Shared");
    } catch (err) { if (err.name !== "AbortError") toast("Couldn't open the share menu"); }
    return;
  }
  // no file sharing here (most desktops): save the photo, caption is on the clipboard
  savePhoto();
  toast(copied ? "Photo saved, caption copied — post it from Instagram" : "Photo saved — copy the caption below", 5000);
}

// ---------- clock + weather chip ----------
const WX = (c) => (c >= 71 && c <= 77 ? "❄️" : c >= 51 ? "🌧️" : c >= 45 ? "🌫️" : c >= 1 ? "⛅" : "☀️");
let weather = "";
function renderEnv() {
  const t = new Date().toLocaleTimeString("en-US", { timeZone: CITY.tz, hour: "2-digit", minute: "2-digit", hour12: false });
  el("envChip").textContent = `${weather} ${t} ${CITY.short}`.trim();
}
async function fetchWeather() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${CITY.start.lat}&longitude=${CITY.start.lng}&current=temperature_2m,weather_code&timezone=${encodeURIComponent(CITY.tz)}`;
    const { current: c } = await (await fetch(u)).json();
    weather = `${WX(c.weather_code)} ${Math.round(c.temperature_2m)}°`;
  } catch { weather = ""; }
  renderEnv();
}

// ---------- wiring + boot ----------
function wire() {
  el("yesBtn").addEventListener("click", () => judge(true));
  el("noBtn").addEventListener("click", () => judge(false));
  el("camBtn").addEventListener("click", () => { el("camInput").value = ""; el("camInput").click(); });
  el("camInput").addEventListener("change", onPhoto);
  el("pauseBtn").addEventListener("click", () => {
    state.paused = !state.paused;
    el("pauseBtn").textContent = state.paused ? "Resume" : "Pause";
    state.paused ? audioPause() : audioResume();
  });
  el("endBtn").addEventListener("click", finish);
  el("backBtn").addEventListener("click", showStop);
  el("recenterBtn").addEventListener("click", () => { recenter(); if (state.pos) follow(state.pos[0], state.pos[1]); });
  document.querySelectorAll("#modeToggle button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  el("postText").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
  el("shareBtn").addEventListener("click", sharePost);
  el("copyBtn").addEventListener("click", async () => toast((await copyCaption()) ? "Caption copied" : "Select the text to copy it"));
  el("saveBtn").addEventListener("click", savePhoto);
  el("postClose").addEventListener("click", () => show("post", false));
  // keep the recenter button just above the sheet
  new ResizeObserver(([e]) => document.documentElement.style.setProperty("--sheet-h", `${e.contentRect.height + 30}px`)).observe(el("sheet"));
}

async function boot() {
  try {
    const [pois, streets] = await Promise.all([
      fetch("./data/area-pois.json").then((r) => r.json()),
      fetch("./data/area-streets.json").then((r) => r.json()),
    ]);
    state.pois = pois.pois;
    state.graph = buildGraph(streets);
    initMap(el("map"), CITY.start);
    wire();
    renderCourses();
    renderEnv(); fetchWeather();
    setInterval(renderEnv, 30000); setInterval(fetchWeather, 600000);
    el("overlay").classList.add("hidden");
    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    el("overlayMsg").textContent = `Couldn't load the map: ${err.message}`;
  }
}
boot();
