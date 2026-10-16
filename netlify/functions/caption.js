// Instagram caption for the walker's photo, written by Gemma 4 through the
// Gemini API (free tier). Key stays server-side.
// The free tier's content may be used to improve Google's products, so by
// default only text is sent (place, area, place type); the photo itself is sent
// only if the client includes `img`.
// POST { place, area, kind?, hashtags[], img? } -> { caption }
const MODEL = "gemma-4-26b-a4b-it";

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { img, place, area, kind, hashtags } = await req.json().catch(() => ({}));
  if (!place && !img) return Response.json({ error: "place or img required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const tags = (Array.isArray(hashtags) ? hashtags : []).slice(0, 6).map((t) => "#" + String(t).replace(/^#/, ""));
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(img || "");
  // instructions go in the user turn (kept simple for an open model)
  const prompt =
    "Write an Instagram caption for a traveller's photo.\n" +
    `Place: ${place || "unknown"}\nArea: ${area || ""}\n${kind ? `Type of place: ${kind}\n` : ""}` +
    (m ? "The photo is attached — describe only what it shows.\n" : "") +
    "Rules: 1–2 short, warm first-person sentences, then a blank line, then 4–7 hashtags. " +
    "Do NOT invent facts about the place (no history, prices, awards, dishes, opening years). " +
    `Always include these hashtags: ${tags.join(" ") || "#travel"}. At most 2 emojis. ` +
    "Reply with the caption text only — no quotes, no preamble.";
  const parts = [{ text: prompt }];
  if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.8, maxOutputTokens: 512 } }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    return Response.json({ error: "gemma " + r.status, detail }, { status: 502 });
  }
  try {
    const j = await r.json();
    const caption = j.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("").trim().replace(/^"|"$/g, "");
    if (!caption) throw new Error("empty");
    return Response.json({ caption });
  } catch {
    return Response.json({ error: "bad model reply" }, { status: 502 });
  }
};
