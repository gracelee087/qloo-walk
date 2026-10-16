// Trip album narration — Gemini plays your local friend recapping the day
// you spent together ("So, remember this morning..."), one line per stop,
// then ElevenLabs speaks it over the traveller's own photos. Key stays
// server-side. Gemini SEES each photo (sent as inline base64) and writes the
// story from what's actually in the frame — the location tag is only a hint,
// since travellers snap freely while walking.
// POST { stops: [{name, time, weather, img?}] } -> { title, intro, scenes[], outro }
const MODEL = "gemini-3.5-flash";

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { stops } = await req.json().catch(() => ({}));
  if (!Array.isArray(stops) || !stops.length) return Response.json({ error: "stops required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  // interleave: a text header per stop, then the photo itself so Gemini can look at it
  const userParts = [{ text: "Our day, one photo per stop, in order:" }];
  for (const [i, s] of stops.slice(0, 14).entries()) {
    userParts.push({
      text: `\nPhoto ${i + 1} — around ${s.time}${s.weather ? `, ${s.weather}` : ""}${s.name ? `, tagged near ${s.name}` : ""}:`,
    });
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(s.img || "");
    if (m) userParts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  // Gemini's JSON mode misfires ~25% of the time (stray "}" after the object,
  // unescaped quotes inside strings) — retry up to 3 attempts on a bad reply.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are the traveller's playful New Yorker friend, recapping the day you spent together in SoHo and the Lower East Side " +
                "as a spoken photo-album voiceover over their own photos. Reply ONLY JSON " +
                "{\"title\": string, \"intro\": string, \"scenes\": string[], \"outro\": string}. " +
                "title: a short album title, max 6 words. " +
                "intro: ONE short punchy spoken sentence (max 18 words) that sets what kind of day it was — " +
                "weather, mood, why it mattered. Like: 'It was a boiling hot day, but between all the laughing " +
                "and everything new we tried, it turned into one for the books!'. No 'remember this day?' preamble. " +
                "scenes: EXACTLY one entry per numbered photo, in the same order — each ONE casual spoken sentence " +
                "(max 20 words). LOOK at each photo and talk about what is actually IN the frame — the food they're " +
                "holding, the pose, the street, the sign, the mood. The location tag is only a rough hint and may be " +
                "wrong: trust the photo over the tag. Use the time of day and weather naturally sometimes " +
                "('that sunny afternoon...') without reciting numbers. " +
                "outro: ONE short excited closing line promising to go even bigger next time — " +
                "like: 'New York! Next time we're going even bigger!'. " +
                "Natural spoken English, like a close friend talking. No emojis, no lists.",
            }],
          },
          contents: [{ role: "user", parts: userParts }],
          generationConfig: { temperature: 0.85, responseMimeType: "application/json", maxOutputTokens: 4096 },
        }),
      }
    );
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      return Response.json({ error: "gemini " + r.status, detail }, { status: 502 });
    }
    const j = await r.json();
    try {
      // Gemini sometimes splits the reply across parts (thinking) — gather all text
      const text = j.candidates[0].content.parts.map((p) => p.text || "").join("");
      const out = parseFirstJson(text);
      if (!Array.isArray(out.scenes)) throw new Error("bad shape");
      // keep scenes aligned with the stops — pad or trim if Gemini miscounts
      while (out.scenes.length < stops.length) out.scenes.push("");
      out.scenes = out.scenes.slice(0, stops.length);
      return Response.json(out);
    } catch { /* malformed — try again */ }
  }
  return Response.json({ error: "bad gemini reply" }, { status: 502 });
};

// Gemini's JSON mode occasionally appends stray text after the object
// (e.g. an extra "}") — parse just the first balanced JSON object.
function parseFirstJson(t) {
  const s = t.indexOf("{");
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i >= 0 && i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = inStr; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr) {
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return JSON.parse(t.slice(s, i + 1));
    }
  }
  return JSON.parse(t);
}

export const config = { path: "/api/album" };
