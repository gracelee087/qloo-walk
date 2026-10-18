// Opt-in walk insights for the TasteWalk team: which places a walker skips or
// chooses, whether they took a photo there and how long they stayed.
// Nothing is sent until the walker says yes. No coordinates, no name — just a
// random id made on this device, which also lets them delete their rows.
// Stored in Supabase (EU, Frankfurt): the table only accepts inserts; nobody can
// read it through the public API. The publishable key is meant to be public.
const SUPABASE = "https://oehvywshuweyygkpyemk.supabase.co";
const KEY = "sb_publishable_MAWJbCB3QAq7wkPlbn9lYQ_NSr1cPPv";
const headers = { apikey: KEY, "content-type": "application/json" };

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const consent = () => store.get("tw-share");          // "yes" | "no" | null (not asked yet)
export function setConsent(yes) { store.set("tw-share", yes ? "yes" : "no"); }

function sessionId() {
  let id = store.get("tw-session");
  if (!id) { id = crypto.randomUUID(); store.set("tw-session", id); }
  return id;
}

let queue = [], timer = null;
// event: "go" | "skip" | "photo" | "dwell"
export function track(event, place, { course = null, seconds = null, city = "Berlin" } = {}) {
  if (consent() !== "yes" || !place) return;
  // every row carries every key — the REST API rejects batches with mixed keys
  queue.push({
    session_id: sessionId(), city, course, place_id: String(place.id).slice(0, 80),
    place_name: (place.enName || place.title || "").slice(0, 160), event,
    dwell_seconds: seconds == null ? null : Math.max(0, Math.min(86400, Math.round(seconds))),
  });
  clearTimeout(timer);
  timer = setTimeout(flush, 2000);
}
export async function flush() {
  if (!queue.length) return;
  const rows = queue; queue = [];
  try {
    await fetch(`${SUPABASE}/rest/v1/walk_events`, {
      method: "POST", headers: { ...headers, prefer: "return=minimal" }, body: JSON.stringify(rows), keepalive: true,
    });
  } catch { /* offline: these rows are dropped, the walk goes on */ }
}
addEventListener("pagehide", flush);

// "Delete my data": removes this device's rows on the server, then forgets the id
export async function deleteMyData() {
  const id = store.get("tw-session");
  queue = [];
  if (!id) return 0;
  const r = await fetch(`${SUPABASE}/rest/v1/rpc/delete_my_events`, { method: "POST", headers, body: JSON.stringify({ p_session: id }) });
  if (!r.ok) throw new Error("delete failed " + r.status);
  store.set("tw-session", null);
  return r.json();
}
