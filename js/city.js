// The walking area. Everything city-specific lives here (plus data/area-*.json,
// built by scripts/fetch-area.mjs), so moving to another neighbourhood means
// changing this file and re-running the data script.
export const CITY = {
  area: "SoHo & Lower East Side",   // spoken / shown name
  short: "New York",                // clock chip label
  city: "New York, NY",             // appended to map / video searches
  tz: "America/New_York",
  // walks start at Spring Street station (Lafayette St), a block from Qloo's office
  start: { lng: -73.99719, lat: 40.7223, name: "Spring Street station" },
  maxFromCenterM: 1600,             // GPS "you're outside the area" threshold
};
