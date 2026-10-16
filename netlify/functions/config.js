// Returns the *public* Google Maps key to the frontend.
// The Maps key is meant to be client-side (restrict it by HTTP referrer in
// Google Cloud Console). Keeping it out of the repo is why this indirection exists.
export default async () => {
  const mapsKey = process.env.GOOGLE_MAPS_KEY || "";
  return new Response(JSON.stringify({ mapsKey }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
};
