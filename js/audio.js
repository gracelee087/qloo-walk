// ElevenLabs narration playback with per-text caching.
// If TTS fails (no key / quota / network), the line is SKIPPED silently —
// the card still shows its text, and silence beats the OS default voice
// (often a robotic voice) reading the script.

const cache = new Map(); // text -> objectURL
let current = { audio: null, resolve: null };
let gen = 0; // bumped by stop(): a narration still fetching when stop() ran must never play
let held = false; // pause() holds NEW clips too — multi-clip sequences must not talk through a pause
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// pre-baked clips (audio/manifest.json) — demo path plays without spending credits
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
let baked = {};
fetch("./audio/manifest.json").then((r) => (r.ok ? r.json() : {})).then((m) => { baked = m; }).catch(() => {});
const bakedUrl = (text) => { const f = baked[hash(text)]; return f ? "./audio/" + f : null; };

export async function playNarration(text, { voiceId } = {}) {
  const g = gen;
  let url = cache.get(text) || bakedUrl(text);
  if (!url) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, voiceId }),
      });
      if (!res.ok) throw new Error("tts " + res.status);
      url = URL.createObjectURL(await res.blob());
      cache.set(text, url);
    } catch (e) {
      console.warn("[audio] TTS unavailable — skipping this line:", e.message);
      return;
    }
  }
  if (g !== gen) return; // stopped while loading (e.g. a video opened) — stay silent
  while (held && g === gen) await wait(120); // paused → hold the next clip until resume
  if (g !== gen) return;
  await new Promise((resolve) => {
    stop();
    const a = new Audio(url);
    current = { audio: a, resolve };
    const done = () => { const r = current.resolve; current = { audio: null, resolve: null }; r && r(); };
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

// Warm the cache in the background so the next stop starts instantly.
export function prefetch(text, { voiceId } = {}) {
  if (!text || cache.has(text) || bakedUrl(text)) return;
  fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voiceId }),
  })
    .then((res) => (res.ok ? res.blob() : Promise.reject()))
    .then((blob) => cache.set(text, URL.createObjectURL(blob)))
    .catch(() => {});
}

export function stop() {
  gen++;
  held = false;
  if (current.audio) current.audio.pause();
  const r = current.resolve;
  current = { audio: null, resolve: null };
  if (r) r();
}
export function pause() {
  held = true;
  current.audio && current.audio.pause();
}
export function resume() {
  held = false;
  current.audio && current.audio.play().catch(() => {});
}
export function isPlaying() { return !!current.audio && !current.audio.paused; }
