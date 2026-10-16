// Google Places Text Search proxy — lets travellers add ANY place to My Picks.
// Key stays server-side. GET /api/places?q=gentle+monster
export default async (req) => {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return Response.json({ error: "q required" }, { status: 400 });
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return Response.json({ error: "GOOGLE_MAPS_KEY not set" }, { status: 500 });

  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": [
        "places.id", "places.displayName", "places.formattedAddress",
        "places.location", "places.primaryTypeDisplayName",
        "places.regularOpeningHours.weekdayDescriptions", "places.photos",
      ].join(","),
    },
    body: JSON.stringify({
      textQuery: q,
      languageCode: "en",
      maxResultCount: 6,
      // bias to the walking area (keep in sync with js/city.js) so chains find the local branch first
      locationBias: { circle: { center: { latitude: 40.72125, longitude: -73.9945 }, radius: 2000 } },
    }),
  });
  if (!r.ok) return Response.json({ error: "places " + r.status }, { status: 502 });
  const j = await r.json();
  const places = await Promise.all((j.places || []).map(async (p) => {
    // resolve the first photo into a plain googleusercontent URL (no key leaked)
    let image = "";
    const photo = p.photos?.[0]?.name;
    if (photo) {
      try {
        const pr = await fetch(
          `https://places.googleapis.com/v1/${photo}/media?maxWidthPx=520&skipHttpRedirect=true&key=${key}`);
        if (pr.ok) image = (await pr.json()).photoUri || "";
      } catch { /* no photo */ }
    }
    return {
      id: p.id,
      name: p.displayName?.text || q,
      addr: p.formattedAddress || "",
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      kind: p.primaryTypeDisplayName?.text || "",
      hours: p.regularOpeningHours?.weekdayDescriptions || [],
      image,
    };
  }));
  return Response.json({ places });
};

export const config = { path: "/api/places" };
