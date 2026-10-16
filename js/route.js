// Street graph + walking routes on the OSM street data (data/area-streets.json).
// Pure functions — no app state — so main.js stays small.

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

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break;[a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (; ;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break;[a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
}

export function buildGraph(streets) {
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
    const d = metersBetween([lng, lat], g.coord.get(id), lat);
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

// greedy nearest-next ordering of the stops
export function orderStops(start, pois) {
  const rem = pois.slice(), route = []; let cur = start;
  while (rem.length) { let bi = 0, bd = Infinity; for (let i = 0; i < rem.length; i++) { const d = metersBetween([cur.lng, cur.lat], [rem[i].lng, rem[i].lat], cur.lat); if (d < bd) { bd = d; bi = i; } } cur = rem[bi]; route.push(rem.splice(bi, 1)[0]); }
  return route;
}

// street-following path start → stop1 → stop2 …, densified every ~6 m
export function buildWalkPath(g, start, ordered) {
  const wps = [start, ...ordered]; const coords = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = nearestNode(g, wps[i].lng, wps[i].lat), b = nearestNode(g, wps[i + 1].lng, wps[i + 1].lat);
    let seg = dijkstraPath(g, a, b);
    if (!seg || seg.length < 2) seg = [[wps[i].lng, wps[i].lat], [wps[i + 1].lng, wps[i + 1].lat]];
    coords.push(...(coords.length ? seg.slice(1) : seg));
  }
  return densify(coords, 6);
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
