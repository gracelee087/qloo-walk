// Our own map look, drawn from OpenFreeMap vector tiles (OpenMapTiles schema).
// Two palettes — "night" (the Myeongdong 3D mood) and "day" — picked from
// Berlin's real time. Street labels show the real street name (OSM `name`).
const PALETTE = {
  night: {
    bg: "#0d1220", park: "#11251f", water: "#0a2742", building: "#161d2e", buildingLine: "#222c44",
    minor: "#1f2840", major: "#2c3756", casing: "#0a0f1a", path: "#2b3550", rail: "#2a3350",
    label: "#a9b8d6", labelHalo: "#0d1220", place: "#d7def0", waterLabel: "#5f8fbf",
  },
  day: {
    bg: "#f1ede4", park: "#cfe2bf", water: "#a7cae6", building: "#e2dccf", buildingLine: "#d2c9b8",
    minor: "#ffffff", major: "#ffe7a8", casing: "#d8d0bf", path: "#cbbfa6", rail: "#b9b2a5",
    label: "#5a5448", labelHalo: "#ffffff", place: "#3b372f", waterLabel: "#3f74a8",
  },
};

const z = (stops) => ["interpolate", ["exponential", 1.5], ["zoom"], ...stops];
const ROAD = ["match", ["get", "class"],
  ["motorway", "trunk", "primary"], 1, ["secondary", "tertiary"], 0.75, ["minor"], 0.5, 0.35];
const MAJOR = ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary"], true, false];

// layers in draw order; `paint(p)` takes the palette so the theme can be swapped live
const LAYERS = [
  { id: "bg", type: "background", paint: (p) => ({ "background-color": p.bg }) },
  { id: "landcover", type: "fill", "source-layer": "landcover", filter: ["match", ["get", "class"], ["grass", "wood", "farmland"], true, false],
    paint: (p) => ({ "fill-color": p.park, "fill-opacity": 0.7 }) },
  { id: "park", type: "fill", "source-layer": "park", paint: (p) => ({ "fill-color": p.park }) },
  { id: "water", type: "fill", "source-layer": "water", paint: (p) => ({ "fill-color": p.water }) },
  { id: "waterway", type: "line", "source-layer": "waterway", paint: (p) => ({ "line-color": p.water, "line-width": z([12, 1, 18, 6]) }) },
  { id: "building", type: "fill", "source-layer": "building", minzoom: 14,
    paint: (p) => ({ "fill-color": p.building, "fill-outline-color": p.buildingLine }) },
  { id: "rail", type: "line", "source-layer": "transportation", filter: ["match", ["get", "class"], ["rail", "transit"], true, false],
    paint: (p) => ({ "line-color": p.rail, "line-width": z([12, 0.6, 18, 2]), "line-dasharray": [3, 2] }) },
  { id: "path", type: "line", "source-layer": "transportation", minzoom: 14, filter: ["match", ["get", "class"], ["path", "track"], true, false],
    paint: (p) => ({ "line-color": p.path, "line-width": z([14, 0.6, 18, 2]), "line-dasharray": [2, 1.5] }) },
  { id: "road-casing", type: "line", "source-layer": "transportation", filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: (p) => ({ "line-color": p.casing, "line-width": z([12, ["*", ROAD, 3], 18, ["*", ROAD, 34]]) }) },
  { id: "road", type: "line", "source-layer": "transportation", filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service"], true, false],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: (p) => ({ "line-color": ["case", MAJOR, p.major, p.minor], "line-width": z([12, ["*", ROAD, 2], 18, ["*", ROAD, 30]]) }) },
  { id: "water-name", type: "symbol", "source-layer": "water_name",
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Italic"], "text-size": 13 },
    paint: (p) => ({ "text-color": p.waterLabel, "text-halo-color": p.labelHalo, "text-halo-width": 1.2 }) },
  { id: "street-name", type: "symbol", "source-layer": "transportation_name", minzoom: 13.5,
    layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 14, 11, 18, 15], "text-max-angle": 30, "symbol-spacing": 280 },
    paint: (p) => ({ "text-color": p.label, "text-halo-color": p.labelHalo, "text-halo-width": 1.6 }) },
  { id: "place-name", type: "symbol", "source-layer": "place", maxzoom: 16,
    filter: ["match", ["get", "class"], ["suburb", "quarter", "neighbourhood"], true, false],
    layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 13, "text-transform": "uppercase", "text-letter-spacing": 0.12 },
    paint: (p) => ({ "text-color": p.place, "text-halo-color": p.labelHalo, "text-halo-width": 1.6, "text-opacity": 0.8 }) },
];

export function buildStyle(theme) {
  const p = PALETTE[theme];
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: { omt: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
    layers: LAYERS.map(({ paint, ...l }) => ({ ...l, ...(l.type === "background" ? {} : { source: "omt" }), paint: paint(p) })),
  };
}

// swap palettes without reloading the style (keeps the route + avatar layers)
export function applyTheme(map, theme) {
  const p = PALETTE[theme];
  for (const l of LAYERS) for (const [k, v] of Object.entries(l.paint(p))) map.setPaintProperty(l.id, k, v);
}
