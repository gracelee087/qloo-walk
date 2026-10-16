// 2D map layer (Leaflet + OpenStreetMap) — drop-in replacement for scene.js.
// Exposes the same functions main.js already calls, so GPS, audio, tips and
// simulation keep working unchanged. Works for any city.
import * as L from "leaflet";

const TYPE_PIN = { food: "#ff7a59", attraction: "#4f8cff", culture: "#7c5cff", shopping: "#35c88b", beauty: "#f25c9a", custom: "#ffd27a", photo: "#ff8ac2" };
const ROUTE = "#ffd27a";
const HL = "#8f7cf5";

const S = {
  map: null, center: null, glyphs: {},
  pins: new Map(),          // id -> L.Marker
  pinActive: null,
  route: null, hl: null, avatar: null,
  following: true,          // camera follows the avatar unless the user is peeking
  lastPan: 0,
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function pinIcon(poi, glyph) {
  const color = TYPE_PIN[poi.type] || "#4f8cff";
  const name = poi.enName || poi.title || "";
  return L.divIcon({
    className: "pin2d",
    html: `<div class="pin2d-box" style="border-color:${color}"><span class="pin2d-glyph">${glyph}</span><span class="pin2d-name">${esc(name)}</span></div>`,
    iconSize: null,
    iconAnchor: [14, 14],
  });
}

function makePin(poi, glyph) {
  const m = L.marker([poi.lat, poi.lng], { icon: pinIcon(poi, glyph), keyboard: false });
  m.addTo(S.map);
  S.pins.set(poi.id, m);
  return m;
}

function setPinState(id, cls, on) {
  const el = S.pins.get(id)?.getElement();
  if (el) el.classList.toggle(cls, on);
}

export function initScene({ container, walkPath, pois, center, glyphs, subway }) {
  S.center = center;
  S.glyphs = glyphs || {};
  S.map = L.map(container, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 16);
  // OSM tile policy: visible attribution, no bulk download / prefetch
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(S.map);

  // any manual drag pauses auto-follow until the walk camera is handed back
  S.map.on("dragstart", () => { S.following = false; });

  makeRoute(walkPath);
  for (const p of pois) makePin(p, S.glyphs[p.type] || "📍");
  for (const st of subway || []) {
    L.marker([st.lat, st.lng], {
      icon: L.divIcon({ className: "pin2d", html: `<div class="pin2d-box pin2d-subway">🚇 <span class="pin2d-name">${esc(st.en)}</span></div>`, iconSize: null, iconAnchor: [14, 14] }),
      keyboard: false, interactive: false,
    }).addTo(S.map);
  }
  S.avatar = L.marker([center.lat, center.lng], {
    icon: L.divIcon({ className: "avatar2d", html: `<div class="avatar2d-dot"></div><div class="avatar2d-label">YOU</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }),
    keyboard: false, interactive: false, zIndexOffset: 1000,
  }).addTo(S.map);
}

function makeRoute(walkPath) {
  if (S.route) S.route.remove();
  const ll = (walkPath || []).map(([lng, lat]) => [lat, lng]);
  S.route = L.layerGroup([
    L.polyline(ll, { color: ROUTE, weight: 10, opacity: 0.25 }),
    L.polyline(ll, { color: ROUTE, weight: 4, opacity: 0.95 }),
  ]).addTo(S.map);
}

export function updateRoute(walkPath) { makeRoute(walkPath); }

export function highlightCourse(lngLats) {
  if (S.hl) S.hl.remove();
  S.hl = L.layerGroup((lngLats || []).map(([lng, lat]) =>
    L.circle([lat, lng], { radius: 22, color: HL, weight: 2, fillColor: HL, fillOpacity: 0.18, interactive: false }))).addTo(S.map);
}

export function moveAvatar3d(lng, lat) {
  S.avatar?.setLatLng([lat, lng]);
}

// walking camera: keep the avatar in view (throttled so tiles aren't hammered)
export function followCam(lng, lat) {
  moveAvatar3d(lng, lat);
  if (!S.following) return;
  const now = Date.now();
  if (now - S.lastPan < 400) return;
  S.lastPan = now;
  if (S.map.getZoom() < 17) S.map.setView([lat, lng], 17, { animate: true });
  else S.map.panTo([lat, lng], { animate: true, duration: 0.4 });
}

export function flyTo(lng, lat) {
  S.following = false;
  S.map.flyTo([lat, lng], 18, { duration: 0.8 });
}

export function beginPeek() { S.following = false; }
export function endPeekCam() { S.following = true; S.lastPan = 0; }

// no orbiting in 2D — idle view simply stays where the user left it
export function orbitCam() {}

export function resetOrbit() {
  S.following = true;
  S.map.setView([S.center.lat, S.center.lng], 16, { animate: true });
}

export function markVisited(id) { setPinState(id, "pin2d-visited", true); }

// dim every pin that isn't part of the chosen course (photo spots stay on)
export function setPinActive(ids) {
  S.pinActive = ids;
  for (const id of S.pins.keys()) {
    const on = !ids || ids.has(id) || String(id).startsWith("ps-");
    setPinState(id, "pin2d-dim", !on);
  }
}

export function resetPins() { setPinActive(S.pinActive); }

export function removePin(id) {
  S.pins.get(id)?.remove();
  S.pins.delete(id);
}

export function addPin(poi, glyph) {
  if (S.pins.has(poi.id)) return;
  makePin(poi, glyph);
  if (S.pinActive) setPinActive(S.pinActive);
}

// 3D lighting/weather has no 2D equivalent; kept so main.js can call it
export function setEnvironment() {}

export function render() {}
