// ElevenLabs text-to-speech proxy. Keeps ELEVENLABS_API_KEY server-side.
// POST { text, voiceId? } -> audio/mpeg
const DEFAULT_VOICE = "ZF6FPAbjXT4488VcRRnw"; // "Amelia" — matches every baked clip (paid Starter plan)
const MODEL = "eleven_multilingual_v2";       // richer prosody than turbo (audio is cached, latency ok)

export default async (req) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  const { text, voiceId } = await req.json().catch(() => ({}));
  if (!text || !text.trim()) return json({ error: "missing text" }, 400);

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return json({ error: "ELEVENLABS_API_KEY not set" }, 500);

  const vid = voiceId || DEFAULT_VOICE;
  let r;
  try {
    r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${vid}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true },
        }),
      }
    );
  } catch (e) {
    return json({ error: "network to elevenlabs failed", detail: String(e) }, 502);
  }

  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 400);
    return json({ error: "elevenlabs error", status: r.status, detail }, 502);
  }

  const buf = await r.arrayBuffer();
  return new Response(buf, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
