// Narration: the ElevenLabs voice through our server (/api/tts — the key stays
// server-side). If that fails (no key, today's budget used up, offline) the
// browser's built-in voice (Web Speech API) reads the line instead; the Guide
// tab always shows the same text.

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
const player = typeof Audio !== "undefined" ? new Audio() : null;
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
let current = { resolve: null };
let held = false; // pause() also holds lines that haven't started yet
let seq = 0;      // bumped by stop(), so a line still downloading doesn't start after it
let cloud = true; // false once the server says it has no voice / no budget left
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function englishVoice() {
  const voices = synth?.getVoices() || [];
  return voices.find((v) => v.lang === "en-US" && v.localService) || voices.find((v) => v.lang?.startsWith("en")) || null;
}
const finish = () => { const r = current.resolve; current = { resolve: null }; r && r(); };

async function cloudVoice(text) {
  const r = await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) { if (r.status === 503 || r.status === 429) cloud = false; throw new Error(`tts ${r.status}`); }
  return URL.createObjectURL(await r.blob());
}
// resolves true when the line was played, false if the device refused to play it
function playUrl(url) {
  return new Promise((resolve) => {
    current = { resolve: () => resolve(true) };
    player.onended = finish;
    player.onerror = () => { current = { resolve: null }; resolve(false); };
    player.src = url;
    player.play().catch(() => { current = { resolve: null }; resolve(false); });
  }).finally(() => URL.revokeObjectURL(url));
}
function speakLocal(text) {
  if (!synth) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = englishVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || "en-US";
    u.rate = 1;
    current = { resolve };
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  });
}

export async function playNarration(text) {
  if (!text) return;
  while (held) await wait(120);
  stop();
  const my = seq;
  if (cloud && player) {
    try {
      const url = await cloudVoice(text);
      if (my !== seq) return URL.revokeObjectURL(url);
      if (await playUrl(url)) return;
    } catch { /* fall back to the device's voice */ }
    if (my !== seq) return;
  }
  await speakLocal(text);
}

export function stop() {
  seq++;
  held = false;
  synth?.cancel();
  player?.pause();
  finish();
}
// call inside a tap: iOS Safari only lets audio/speech start from a user gesture,
// and once something has played, later lines (from timers) are allowed too
export function prime() {
  synth?.speak(new SpeechSynthesisUtterance(" "));
  if (player) { player.src = SILENT; player.play().catch(() => {}); }
}
export function pause() { held = true; synth?.pause(); player?.pause(); }
export function resume() {
  held = false; synth?.resume();
  if (player && current.resolve && player.paused && !player.ended) player.play().catch(() => {});
}
export function isPlaying() {
  return (!!synth?.speaking && !synth.paused) || (!!player && !player.paused && !player.ended && player.src !== SILENT);
}
