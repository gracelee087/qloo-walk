// Walking routes (fetched from /api/route) + geometry helpers.
// No app state, so main.js stays small.

const lerp = (a, b, t) => a + (b - a) * t;

export function metersBetween(a, b, lat) {
  const k = Math.cos((lat * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * 111320 * k, (a[1] - b[1]) * 111320);
}

export function bearingTo(a, b, fallback = 0) {
  const dLng = (b.lng - a.lng) * Math.PI / 180, la = a.lat * Math.PI / 180, lb = b.lat * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lb);
  const x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dLng);
  const br = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return Number.isFinite(br) ? br : fallback;
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

// greedy nearest-next ordering of the stops
export function orderStops(start, pois) {
  const rem = pois.slice(), route = []; let cur = start;
  while (rem.length) { let bi = 0, bd = Infinity; for (let i = 0; i < rem.length; i++) { const d = metersBetween([cur.lng, cur.lat], [rem[i].lng, rem[i].lat], cur.lat); if (d < bd) { bd = d; bi = i; } } cur = rem[bi]; route.push(rem.splice(bi, 1)[0]); }
  return route;
}

// walking path start → stop1 → stop2 … from /api/route (OSRM foot), densified every ~6 m.
// If routing is down: straight lines, distance-based time, and `fallback: true`.
export async function fetchWalkPath(start, ordered, walkMPerMin) {
  const pts = [start, ...ordered].map((p) => [p.lng, p.lat]);
  try {
    const r = await fetch("/api/route", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ points: pts }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return { path: densify(j.coords, 6), seconds: j.seconds, legs: j.legs, waypoints: j.waypoints || pts, source: j.source, fallback: false };
  } catch {
    const path = densify(pts, 6), cum = cumulative(path);
    return { path, seconds: (cum[cum.length - 1] / walkMPerMin) * 60, legs: [], waypoints: pts, source: "straight", fallback: true };
  }
}

export function cumulative(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + metersBetween(path[i - 1], path[i], path[i][1]);
  return cum;
}

// position + heading at distance d along the path
export function pointAlong(path, cum, d) {
  if (path.length < 2 || d <= 0) return { pos: path[0], heading: path.length > 1 ? bearingTo({ lng: path[0][0], lat: path[0][1] }, { lng: path[1][0], lat: path[1][1] }) : 0 };
  let i = 1; while (i < cum.length && cum[i] < d) i++;
  if (i >= path.length) return { pos: path[path.length - 1], heading: 0 };
  const a = path[i - 1], b = path[i], seg = cum[i] - cum[i - 1], t = seg > 0 ? (d - cum[i - 1]) / seg : 0;
  return { pos: [lerp(a[0], b[0], t), lerp(a[1], b[1], t)], heading: bearingTo({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] }) };
}
