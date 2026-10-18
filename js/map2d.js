// The map: our own flat, tilted map (MapLibre + OpenFreeMap tiles, styled in
// mapstyle.js), a glowing route, numbered stops — and the walker as a little
// 3D person (three.js, ported from Myeongdong 3D's avatar). Buildings stay flat.
import * as maplibregl from "maplibre-gl";
import * as THREE from "three";
import { buildStyle, applyTheme } from "./mapstyle.js";
import { bearingTo } from "./route.js";

const PITCH = 55, WALK_ZOOM = 16.8;
const S = { map: null, theme: "night", stops: new Map(), me: null, label: null, following: true, lastPan: 0, routeData: null };

export function initMap(container, center, theme = "night") {
  S.theme = theme;
  S.me = { lng: center.lng, lat: center.lat, heading: 0, moving: 0 };
  S.map = new maplibregl.Map({
    container, style: buildStyle(theme), center: [center.lng, center.lat], zoom: 16.5, pitch: PITCH, maxPitch: 70,
    attributionControl: {
      compact: true,
      // FOSSGIS routing policy: credit the routing server + a "fix the map" link
      customAttribution: 'Routes: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">FOSSGIS OSRM</a>'
        + ' · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Fix the map</a>',
    },
    canvasContextAttributes: { antialias: true },
  });
  S.map.on("dragstart", () => { S.following = false; });
  S.label = new maplibregl.Marker({ element: Object.assign(document.createElement("div"), { className: "you", innerHTML: "<span>YOU ARE HERE</span>" }), anchor: "bottom", offset: [0, -44] })
    .setLngLat([center.lng, center.lat]).addTo(S.map);
  return new Promise((res) => S.map.on("load", () => {
    S.map.addSource("route", { type: "geojson", data: line([]) });
    S.map.addLayer({ id: "route-glow", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffc04d", "line-width": 16, "line-blur": 10, "line-opacity": 0.55 } });
    S.map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffd166", "line-width": 5 } });
    S.map.addLayer(avatarLayer());
    if (S.routeData) S.map.getSource("route").setData(S.routeData);
    res();
  }));
}

const line = (coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });

export function setTheme(theme) {
  // called only after initMap resolved (style loaded); isStyleLoaded() is false while tiles stream in
  if (theme === S.theme || !S.map) return;
  S.theme = theme;
  applyTheme(S.map, theme);
  document.documentElement.dataset.theme = theme;
}

export function setRoute(path) {
  S.routeData = line(path || []);
  S.map?.getSource("route")?.setData(S.routeData);
}

// stops: [{id, lng, lat, title}] in walking order; onPick(id) when a dot is tapped
export function setStops(stops, onPick) {
  for (const m of S.stops.values()) m.remove();
  S.stops.clear();
  stops.forEach((p, i) => {
    const el = document.createElement("button");
    el.className = "stop"; el.title = p.enName || p.title; el.innerHTML = `<b>${i + 1}</b>`;
    if (onPick) el.addEventListener("click", (e) => { e.stopPropagation(); onPick(p.id); });
    S.stops.set(p.id, new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(S.map));
  });
}

// state: "next" | "liked" | "skipped" | "visited" | "" (plain)
export function markStop(id, state) {
  const el = S.stops.get(id)?.getElement();
  if (!el) return;
  el.classList.remove("next", "liked", "skipped", "visited");
  if (state) el.classList.add(state);
}

// heading in degrees from north; without one (GPS) it comes from the last move
export function moveMe(lng, lat, heading) {
  const prev = S.me;
  if (heading == null) heading = (prev.lng !== lng || prev.lat !== lat) ? bearingTo(prev, { lng, lat }, prev.heading) : prev.heading;
  if (prev.lng !== lng || prev.lat !== lat) S.me.moving = performance.now();
  Object.assign(S.me, { lng, lat, heading });
  S.label?.setLngLat([lng, lat]);
}

// keep "you" in view while walking (throttled so tiles aren't hammered)
export function follow(lng, lat, heading) {
  moveMe(lng, lat, heading);
  if (!S.following) return;
  const now = Date.now();
  if (now - S.lastPan < 500) return;
  S.lastPan = now;
  S.map.easeTo({ center: [lng, lat], zoom: Math.max(S.map.getZoom(), WALK_ZOOM), pitch: PITCH, duration: 500, easing: (t) => t });
}

export function recenter() { S.following = true; S.lastPan = 0; }

// keep the walker in the visible part of the map, clear of the dock and sidebar
export function setInsets({ bottom = 0, right = 0 }) { S.map?.setPadding({ top: 70, bottom, left: 0, right }); }

export function fitStops(start) {
  const pts = [...S.stops.values()].map((m) => m.getLngLat().toArray());
  if (start) pts.push([start.lng, start.lat]);
  if (!pts.length) return;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  S.map.fitBounds(b, { padding: { top: 40, bottom: 40, left: 40, right: 40 }, maxZoom: 17, pitch: PITCH });
}

// ---------- the 3D walker (a MapLibre custom layer drawn with three.js) ----------
function makeAvatar() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xffd9b8, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2433, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(2.1, 4.2, 4, 10), mat);
  body.position.y = 5.5; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(2, 14, 12), skin);
  head.position.y = 10.7; g.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(2.06, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xff7a59, roughness: 0.6 }));
  cap.position.y = 11.1; g.add(cap);
  // cap peak points where the walker is heading
  const peak = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.35, 1.6), cap.material);
  peak.position.set(0, 11.2, 2.3); g.add(peak);
  const legs = [-0.9, 0.9].map((x) => {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.75, 2.4, 3, 8), dark);
    leg.geometry.translate(0, -1.6, 0);         // swing from the hip
    leg.position.set(x, 3.4, 0); g.add(leg);
    return leg;
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 4.8, 32),
    new THREE.MeshBasicMaterial({ color: 0x4f8cff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.3; g.add(ring);
  return { g, body, legs, ring };
}

function avatarLayer() {
  let camera, scene, renderer, av;
  return {
    id: "walker", type: "custom", renderingMode: "3d",
    onAdd(map, gl) {
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(0.4, 1, 0.6); scene.add(sun);
      av = makeAvatar(); scene.add(av.g);
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, args) {
      const t = performance.now(), walking = t - S.me.moving < 400;
      const swing = walking ? Math.sin(t / 110) * 0.6 : 0;
      av.legs[0].rotation.x = swing; av.legs[1].rotation.x = -swing;
      av.body.position.y = 5.5 + (walking ? Math.abs(Math.sin(t / 110)) * 0.35 : 0);
      av.ring.scale.setScalar(1 + 0.12 * Math.sin(t / 400));
      // keep the walker about the same size on screen at any zoom
      const mc = maplibregl.MercatorCoordinate.fromLngLat([S.me.lng, S.me.lat], 0);
      const meters = 1.4 * Math.pow(2, WALK_ZOOM - S.map.getZoom());
      const s = mc.meterInMercatorCoordinateUnits() * meters;
      const model = new THREE.Matrix4().makeTranslation(mc.x, mc.y, mc.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI - (S.me.heading * Math.PI) / 180));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix).multiply(model);
      renderer.resetState();
      renderer.clearDepth();      // walker shows through buildings (Myeongdong 3D's x-ray), still depth-sorted within itself
      renderer.render(scene, camera);
      S.map.triggerRepaint();
    },
  };
}
