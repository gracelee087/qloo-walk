// 2D map (Leaflet + OpenStreetMap). Muted grey tiles, numbered stops, the
// walking route and a "you" dot — nothing else, so the bottom sheet does the talking.
import * as L from "leaflet";

const S = { map: null, route: null, stops: new Map(), me: null, following: true, lastPan: 0 };

export function initMap(container, center) {
  S.map = L.map(container, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], 16);
  // OSM tile policy: visible attribution, no bulk download / prefetch
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(S.map);
  S.map.on("dragstart", () => { S.following = false; });
  S.me = L.marker([center.lat, center.lng], {
    icon: L.divIcon({ className: "me", html: "<i></i>", iconSize: [20, 20], iconAnchor: [10, 10] }),
    keyboard: false, interactive: false, zIndexOffset: 1000,
  }).addTo(S.map);
}

export function setRoute(path) {
  if (S.route) S.route.remove();
  S.route = L.polyline((path || []).map(([lng, lat]) => [lat, lng]), { className: "route", weight: 4 }).addTo(S.map);
}

// stops: [{id, lng, lat, title}] in walking order; onPick(id) when a dot is tapped
export function setStops(stops, onPick) {
  for (const m of S.stops.values()) m.remove();
  S.stops.clear();
  stops.forEach((p, i) => {
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: "stop", html: `<b>${i + 1}</b>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      keyboard: false, title: p.enName || p.title,
    }).addTo(S.map);
    if (onPick) m.on("click", () => onPick(p.id));
    S.stops.set(p.id, m);
  });
}

// state: "next" | "liked" | "skipped" | "visited" | "" (plain)
export function markStop(id, state) {
  const el = S.stops.get(id)?.getElement();
  if (!el) return;
  el.classList.remove("next", "liked", "skipped", "visited");
  if (state) el.classList.add(state);
}

export function moveMe(lng, lat) { S.me?.setLatLng([lat, lng]); }

// keep "you" in view while walking (throttled so tiles aren't hammered)
export function follow(lng, lat) {
  moveMe(lng, lat);
  if (!S.following) return;
  const now = Date.now();
  if (now - S.lastPan < 500) return;
  S.lastPan = now;
  if (S.map.getZoom() < 17) S.map.setView([lat, lng], 17, { animate: true });
  else S.map.panTo([lat, lng], { animate: true, duration: 0.4 });
}

export function recenter() { S.following = true; S.lastPan = 0; }

export function fitStops(start) {
  const pts = [...S.stops.values()].map((m) => m.getLatLng());
  if (start) pts.push(L.latLng(start.lat, start.lng));
  if (pts.length) S.map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
}
