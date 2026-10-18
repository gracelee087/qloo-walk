// The walking area. Everything city-specific lives here (plus data/area-*.json,
// built by scripts/fetch-area.mjs), so moving to another city means
// changing this file and re-running the data script.
export const CITY = {
  area: "Berlin",                   // spoken / shown name
  short: "Berlin",                  // clock chip label
  city: "Berlin, Germany",          // appended to map / video searches
  tz: "Europe/Berlin",
  // demo walks start at Alexanderplatz station (OSM / Nominatim coordinates)
  start: { lng: 13.41112, lat: 52.52156, name: "Alexanderplatz station" },
  maxFromCenterM: 25000,            // GPS "you're outside the area" threshold — rough radius of Berlin from Alexanderplatz
  hashtags: ["Berlin"],
};
