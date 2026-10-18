// The walking buddy: Gemma 4 (Gemini API, free tier) reads what the walker says
// and answers like a friend — but only decides *what they want*. Distances,
// walking times and route changes are worked out by the app (OSRM), never by
// the model, so it can't make them up. Key stays server-side.
// Free tier: inputs may be used to improve Google's products (the app says so).
// POST { messages: [{ role: "user"|"buddy", text }], context: { area, current, next, walk: [names], nearby: [names] } }
//   -> { reply, intent: "chat"|"want_place"|"skip_current"|"like_current", place, likes[], dislikes[] }
const MODEL = "gemma-4-26b-a4b-it";
const INTENTS = ["chat", "want_place", "skip_current", "like_current"];
const clip = (s, n) => String(s ?? "").slice(0, n);
const list = (a, n) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => clip(x, 80));

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });
  const { messages, context: c = {} } = await req.json().catch(() => ({}));
  if (!Array.isArray(messages) || !messages.length) return Response.json({ error: "messages required" }, { status: 400 });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const talk = messages.slice(-8).map((m) => `${m.role === "user" ? "Walker" : "You"}: ${clip(m.text, 400)}`).join("\n");
  // instructions go in the user turn (kept simple for an open model)
  const prompt =
    `You are TasteWalk, a cheerful local friend walking with a visitor around ${clip(c.area, 40) || "Berlin"}.\n` +
    "Answer in 1–3 short, warm, casual sentences, in the walker's language. Keep them company — they may just be bored.\n" +
    "NEVER state distances, walking times, opening hours or prices: the app adds distances itself.\n" +
    "You may share well-known history, stories and fun facts about Berlin and these places when you're confident; never invent specifics.\n" +
    `Right now: ${c.current ? `at ${clip(c.current, 80)}` : "walking"}${c.next ? `; next stop ${clip(c.next, 80)}` : ""}.\n` +
    `Today's walk: ${list(c.walk, 12).join(", ") || "not started"}.\n` +
    `Other places the app knows nearby: ${list(c.nearby, 25).join(", ") || "none"}.\n` +
    "Decide the walker's intent:\n" +
    '- "want_place": they want to go to a specific place. Put it in "place" — the exact name from the lists above if it matches, else their words. Your reply just reacts happily (e.g. "Ooh, let me check how far that is!").\n' +
    '- "skip_current": they don\'t like the current or next stop.\n' +
    '- "like_current": they clearly like the current or next stop.\n' +
    '- "chat": anything else.\n' +
    'Also pull out short taste tags they reveal, e.g. likes ["vinyl shops"], dislikes ["crowds"]; empty lists if none.\n' +
    'Reply ONLY with JSON: {"reply": string, "intent": string, "place": string|null, "likes": string[], "dislikes": string[]}\n\n' +
    talk;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // "minimal" skips the long think step: ~3.5 s instead of ~13 s (measured)
      generationConfig: { temperature: 0.8, maxOutputTokens: 512, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "minimal" } },
    }),
    signal: AbortSignal.timeout(20000),
  }).catch((e) => ({ ok: false, status: 504, text: async () => e.message }));
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    return Response.json({ error: "gemma " + r.status, detail }, { status: 502 });
  }
  try {
    const j = await r.json();
    const text = j.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("")
      .replace(/^```(?:json)?\s*|\s*```$/g, "");
    const o = JSON.parse(text);
    return Response.json({
      reply: clip(o.reply, 600) || "Hmm, say that again?",
      intent: INTENTS.includes(o.intent) ? o.intent : "chat",
      place: o.place ? clip(o.place, 120) : null,
      likes: list(o.likes, 5), dislikes: list(o.dislikes, 5),
    });
  } catch {
    return Response.json({ error: "bad model reply" }, { status: 502 });
  }
};
