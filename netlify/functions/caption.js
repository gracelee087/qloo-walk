// Instagram caption for a photo the walker just took. Gemini SEES the photo
// (inline base64) and writes a short caption + hashtags. Key stays server-side.
// POST { img: dataURL, place, area, hashtags[] } -> { caption }
const MODEL = "gemini-3.5-flash";

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { img, place, area, hashtags } = await req.json().catch(() => ({}));
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(img || "");
  if (!m) return Response.json({ error: "img (data URL) required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const tags = (Array.isArray(hashtags) ? hashtags : []).slice(0, 6).map((t) => "#" + String(t).replace(/^#/, ""));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: "You write Instagram captions for a traveller's own photo. Reply ONLY JSON {\"caption\": string}. " +
            "caption: 1–2 short, warm first-person sentences about what is actually IN the photo, then a blank line, " +
            "then 4–7 hashtags. Mention the place name if given. Do NOT invent facts about the place " +
            "(no history, prices, awards, opening years) — describe only what the photo shows. " +
            "Always include these hashtags: " + (tags.join(" ") || "#travel") + ". At most 2 emojis.",
        }],
      },
      contents: [{
        role: "user",
        parts: [
          { text: `Place: ${place || "unknown"}\nArea: ${area || ""}` },
          { inline_data: { mime_type: m[1], data: m[2] } },
        ],
      }],
      generationConfig: { temperature: 0.8, responseMimeType: "application/json", maxOutputTokens: 1024 },
    }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    return Response.json({ error: "gemini " + r.status, detail }, { status: 502 });
  }
  try {
    const j = await r.json();
    const text = j.candidates[0].content.parts.map((p) => p.text || "").join("");
    const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (typeof out.caption !== "string" || !out.caption.trim()) throw new Error("empty");
    return Response.json({ caption: out.caption.trim() });
  } catch {
    return Response.json({ error: "bad gemini reply" }, { status: 502 });
  }
};
