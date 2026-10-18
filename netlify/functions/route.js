// Walking route through a list of points, from the FOSSGIS OSRM foot server
// (routing.openstreetmap.de); GraphHopper's free plan is the fallback.
// FOSSGIS usage policy: max 1 request/second, valid User-Agent, attribution,
// no heavy use — so identical requests are answered from a cache and calls
// are spaced 1 s apart (per function instance; Netlify may run several).
// POST { points: [[lng, lat], …] } -> { coords: [[lng, lat], …], meters, seconds, legs: [{ meters, seconds }], source }
const UA = "TasteWalk/0.1 (Qloo Agentic Hackathon demo; https://github.com/gracelee087/qloo-walk)";
const OSRM = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";
const GH = "https://graphhopper.com/api/1/route";
const GH_MAX_POINTS = 5;          // free plan limit per request
const MAX_POINTS = 12;

const cache = new Map();          // key -> result (this instance only)
let nextSlot = 0;                 // earliest time the next OSRM call may start
async function osrmSlot() {
  const now = Date.now(), wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 1000;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function viaOsrm(points) {
  await osrmSlot();
  // the public server sometimes stalls (seen: 27 s) — give up after 12 s and fall back
  const r = await fetch(`${OSRM}${points.map((p) => p.join(",")).join(";")}?overview=full&geometries=geojson`,
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error("osrm " + r.status);
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.[0]) throw new Error("osrm " + j.code);
  const route = j.routes[0];
  return {
    coords: route.geometry.coordinates, meters: route.distance, seconds: route.duration,
    legs: route.legs.map((l) => ({ meters: l.distance, seconds: l.duration })), source: "osrm",
    // each point moved onto the nearest footway — where the route actually reaches a stop
    waypoints: j.waypoints.map((w) => w.location),
  };
}

// one GraphHopper request per ≤5 points; chunks share their end/start point
async function viaGraphHopper(points, key) {
  const out = { coords: [], meters: 0, seconds: 0, legs: [], waypoints: [], source: "graphhopper" };
  for (let i = 0; i < points.length - 1; i += GH_MAX_POINTS - 1) {
    const chunk = points.slice(i, i + GH_MAX_POINTS);
    const q = chunk.map((p) => `point=${p[1]},${p[0]}`).join("&");
    const r = await fetch(`${GH}?${q}&profile=foot&points_encoded=false&instructions=true&key=${key}`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("graphhopper " + r.status);
    const path = (await r.json()).paths?.[0];
    if (!path) throw new Error("graphhopper no path");
    out.coords.push(...(out.coords.length ? path.points.coordinates.slice(1) : path.points.coordinates));
    const snapped = path.snapped_waypoints?.coordinates || chunk;
    out.waypoints.push(...(out.waypoints.length ? snapped.slice(1) : snapped));
    out.meters += path.distance; out.seconds += path.time / 1000;
    // leg split from the instructions: each waypoint ends with a "reached via point" sign (5) or finish (4)
    let leg = { meters: 0, seconds: 0 };
    for (const ins of path.instructions || []) {
      leg.meters += ins.distance; leg.seconds += ins.time / 1000;
      if (ins.sign === 5 || ins.sign === 4) { out.legs.push(leg); leg = { meters: 0, seconds: 0 }; }
    }
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { points } = await req.json().catch(() => ({}));
  const ok = Array.isArray(points) && points.length >= 2 && points.length <= MAX_POINTS
    && points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  if (!ok) return Response.json({ error: `points: 2–${MAX_POINTS} [lng, lat] pairs` }, { status: 400 });

  const pts = points.map(([lng, lat]) => [+lng.toFixed(5), +lat.toFixed(5)]);
  const key = pts.map((p) => p.join(",")).join(";");
  if (cache.has(key)) return Response.json(cache.get(key));

  let result, osrmError;
  try { result = await viaOsrm(pts); } catch (e) { osrmError = e.message; }
  if (!result && process.env.GRAPHHOPPER_API_KEY) {
    try { result = await viaGraphHopper(pts, process.env.GRAPHHOPPER_API_KEY); } catch (e) { osrmError += "; " + e.message; }
  }
  if (!result) return Response.json({ error: "no route", detail: osrmError }, { status: 502 });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return Response.json(result);
};
