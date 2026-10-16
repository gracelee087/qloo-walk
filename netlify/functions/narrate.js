// Gemini live narration — when a traveller adds ANY place to My Picks from
// Google search, Gemini writes a fresh audio-guide script for it on the spot
// (then ElevenLabs voices it). Key stays server-side.
// POST { name, kind, addr } -> { script }
const MODEL = "gemini-3.5-flash";

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { name, kind, addr } = await req.json().catch(() => ({}));
  if (!name) return Response.json({ error: "name required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "You are a warm, concise walking-tour audio guide in SoHo and the Lower East Side, New York. " +
              "A traveller just added this place to their own route. Reply ONLY as JSON: {\"script\": string}. " +
              "script: 2 spoken sentences (max 45 words) — what this place is, why it's worth the stop, one concrete tip. " +
              "Natural spoken English. No greetings, no emojis.",
          }],
        },
        contents: [{ role: "user", parts: [{ text: `Place: ${name}\nType: ${kind || "shop"}\nAddress: ${addr || "SoHo and the Lower East Side, New York"}` }] }],
        generationConfig: { temperature: 0.7, responseMimeType: "application/json" },
      }),
    }
  );
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    return Response.json({ error: "gemini " + r.status, detail }, { status: 502 });
  }
  const j = await r.json();
  try {
    const { script } = JSON.parse(j.candidates[0].content.parts[0].text);
    return Response.json({ script });
  } catch {
    return Response.json({ error: "bad gemini reply" }, { status: 502 });
  }
};

export const config = { path: "/api/narrate" };
