// TasteWalk — pick a walk, follow the route, tap ✕ / ○ at each stop so the
// guide learns your taste, snap a photo and post it straight to Instagram.
// Walking area: city.js. Map: map2d.js. Routing: route.js. Voice: audio.js.
import { playNarration, stop as audioStop, pause as audioPause, resume as audioResume } from "./audio.js";
import { initMap, setRoute, setStops, markStop, follow, recenter, fitStops, setTheme, setInsets } from "./map2d.js";
import { metersBetween, orderStops, fetchWalkPath, cumulative, pointAlong } from "./route.js";
import { CITY } from "./city.js";
import { consent, setConsent, track, deleteMyData } from "./insights.js";

const el = (id) => document.getElementById(id);
const WALK_SPEED = 12;          // m/s — the demo walk is sped up
const ARRIVE_M = 35;            // "you're at the stop"
const WALK_M_PER_MIN = 75;      // ~4.5 km/h, for time estimates when routing is down
// assumed minutes spent at each kind of stop — only for the "est." times
const DWELL = { food: 30, culture: 20, attraction: 10, shopping: 10 };
const TYPE_LABEL = { food: "Food & drink", culture: "Culture", attraction: "Sight", shopping: "Shop" };
const TYPE_ICON = { food: "🍽️", culture: "🏛️", attraction: "📸", shopping: "🛍️" };

// stop picks are placeholders until Qloo ranks places for the walker's taste
const COURSES = [
  { id: "must", icon: "⭐", name: "Must See", note: "Landmarks and museums", n: 8, pick: (p) => p.type === "attraction" || p.type === "culture" },
  { id: "classic", icon: "🧭", name: "Classic", note: "A bit of everything", n: 6, pick: () => true, mix: true },
  { id: "slow", icon: "☕", name: "Slow Down", note: "Fewer stops, food and coffee", n: 4, pick: (p) => p.type === "food" },
];

const state = {
  pois: [], sel: null, peek: null, lastLine: "",
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
async function planCourse(course) {
  const stops = orderStops(CITY.start, pickStops(course));
  const { path, seconds, fallback, waypoints } = await fetchWalkPath(CITY.start, stops, WALK_M_PER_MIN);
  const cum = cumulative(path);
  const len = cum[cum.length - 1] || 0;
  const minutes = seconds / 60 + stops.reduce((s, p) => s + (DWELL[p.type] || 10), 0);
  // where the route reaches each stop (on the footway); a big square's centre can be 40 m+ off the path
  const reach = stops.map((p, k) => waypoints[k + 1] || [p.lng, p.lat]);
  return { course, stops, path, cum, len, minutes, fallback, reach };
}
// course chips along the bottom; tapping one draws its route and fills the sidebar right away
async function renderCourseBar() {
  const bar = el("courseBar"); bar.innerHTML = "";
  for (const c of COURSES) {
    const b = document.createElement("button");
    b.className = "chip-course"; b.disabled = true; b.dataset.id = c.id;
    b.innerHTML = `<b>${c.icon} ${c.name}</b><span>planning…</span>`;
    bar.append(b);
  }
  // one route request per course, in turn (the routing server allows 1 request/s)
  for (const [k, c] of COURSES.entries()) {
    const plan = await planCourse(c), b = bar.children[k];
    b.innerHTML = `<b>${c.icon} ${c.name}</b><span>${plan.stops.length} stops · ${fmtDist(plan.len)} · ≈ ${fmtMin(plan.minutes)}</span>`;
    b.title = plan.fallback ? "Routing is unavailable — straight-line estimate" : `${c.note} — walking time + an assumed stay at each stop`;
    b.disabled = false;
    b.addEventListener("click", () => selectPlan(plan));
    if (k === 0) selectPlan(plan);
  }
}
function selectPlan(plan) {
  if (state.running) endWalk(true);
  state.sel = plan;
  Object.assign(state, { course: plan.course, stops: plan.stops, path: plan.path, cum: plan.cum, len: plan.len, i: 0, dist: 0, atStop: false, peek: null });
  state.pos = [CITY.start.lng, CITY.start.lat];
  follow(state.pos[0], state.pos[1]);
  setRoute(plan.path);
  setStops(plan.stops, peek);
  for (const p of plan.stops) if (state.feedback[p.id] !== undefined) markStop(p.id, state.feedback[p.id] ? "liked" : "skipped");
  fitStops(CITY.start);
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
function startWalk() {
  if (!state.sel) return;
  Object.assign(state, { i: 0, dist: 0, atStop: false, running: true, paused: false, peek: null });
  state.pos = [CITY.start.lng, CITY.start.lat];
  recenter();
  showStop();
  renderDock();
  if (state.mode === "gps") startGPS();
  say(`Welcome to ${CITY.area}. Follow the yellow line. At each stop, tell me if it's for you.`);
}
// end the walk; quiet = switching course / reset, no summary
function endWalk(quiet = false) {
  state.running = false; state.paused = false; state.atStop = false;
  stopGPS(); audioStop();
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
// narration + remember it for ‹ Prev
function say(text) { state.lastLine = text; el("prevBtn").disabled = false; playNarration(text); }

function current() { return state.stops[state.i]; }
const shown = () => state.peek || current();      // the place on the card right now
const sentences = (t, n) => (t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t]).slice(0, n).join("").trim();

// fill the card with one place: photo, name, description + its source
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
  show("card");
  updateDistance();
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
  say(`${nameOf(p)}.${about} Do you like it? Tap Go if it's for you, or Skip.`);
}

// ✕ Skip / ○ Go — record taste for a place; for the stop you're walking to, move on
function judge(p, liked) {
  if (!p) return;
  state.feedback[p.id] = liked ? 1 : 0;
  saveFeedback();
  track(liked ? "go" : "skip", p, { course: state.course?.id });
  markStop(p.id, liked ? "liked" : "skipped");
  toast(liked ? `○ Saved — more like ${nameOf(p)}` : "✕ Noted — we'll show you less like this");
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

// ---------- movement: demo walk + live GPS ----------
let lastTs = 0;
function frame(ts) {
  const dt = Math.min((ts - (lastTs || ts)) / 1000, 0.05); lastTs = ts;
  if (state.running && state.mode === "sim" && !state.paused && !state.atStop) {
    state.dist = Math.min(state.dist + WALK_SPEED * dt, state.len);
    const at = pointAlong(state.path, state.cum, state.dist);
    state.pos = at.pos;
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
setInterval(updateDistance, 1000);

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
  const stop = state.stops.find((s) => nameOf(s) === place);
  if (stop) track("photo", stop, { course: state.course?.id });
  el("postImg").src = dataUrl;
  const ta = el("postText");
  ta.value = defaultCaption(place); ta.dataset.edited = "";
  el("postHint").textContent = "Writing a caption…";
  show("post");
  // AI caption from the photo itself; keep the template if it fails or the user already typed
  try {
    const r = await fetch("/api/caption", {
      method: "POST", headers: { "content-type": "application/json" },
      // photo is sent to Gemma (free tier: Google may use inputs to improve its products)
      body: JSON.stringify({ img: dataUrl, place, area: CITY.area, kind: placeKind(place), hashtags: CITY.hashtags }),
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
    setTheme(c.is_day ? "day" : "night");
  } catch { weather = ""; setTheme(guessTheme()); }
  renderEnv();
}

// ---------- wiring + boot ----------
function wire() {
  el("yesBtn").addEventListener("click", () => judge(shown(), true));
  el("noBtn").addEventListener("click", () => judge(shown(), false));
  const snap = () => { el("camInput").value = ""; el("camInput").click(); };
  el("camBtn").addEventListener("click", snap);
  el("snapBtn").addEventListener("click", snap);
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
  // sidebar: fold away on desktop, slide up as a drawer on phones
  const setSide = (open) => { document.body.classList.toggle("side-closed", !open); show("sideOpen", !open); layout(); };
  el("sideFold").addEventListener("click", () => setSide(false));
  el("sideOpen").addEventListener("click", () => setSide(true));
  el("listBtn").addEventListener("click", () => document.body.classList.toggle("drawer-open"));
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
  el("postText").addEventListener("input", (e) => { e.target.dataset.edited = "1"; });
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
    const pois = await fetch("./data/area-pois.json").then((r) => r.json());
    state.pois = pois.pois;
    const theme = guessTheme();
    document.documentElement.dataset.theme = theme;
    await initMap(el("map"), CITY.start, theme);
    wire();
    layout();
    renderCourseBar();
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
