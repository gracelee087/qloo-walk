// Narration with the browser's built-in voice (Web Speech API) — free, runs
// on the device, no server or key. If the browser has no speech support the
// line is skipped; the sheet always shows the same text.

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
let current = { resolve: null };
let held = false; // pause() also holds lines that haven't started yet
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function englishVoice() {
  const voices = synth?.getVoices() || [];
  return voices.find((v) => v.lang === "en-US" && v.localService) || voices.find((v) => v.lang?.startsWith("en")) || null;
}

export async function playNarration(text) {
  if (!synth || !text) return;
  while (held) await wait(120);
  stop();
  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = englishVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || "en-US";
    u.rate = 1;
    current = { resolve };
    const done = () => { const r = current.resolve; current = { resolve: null }; r && r(); };
    u.onend = done;
    u.onerror = done;
    synth.speak(u);
  });
}

export function stop() {
  held = false;
  synth?.cancel();
  const r = current.resolve;
  current = { resolve: null };
  if (r) r();
}
// call inside a tap: iOS Safari only lets speech start from a user gesture,
// and once one utterance has played, later ones (from timers) are allowed too
export function prime() { synth?.speak(new SpeechSynthesisUtterance(" ")); }
export function pause() { held = true; synth?.pause(); }
export function resume() { held = false; synth?.resume(); }
export function isPlaying() { return !!synth?.speaking && !synth.paused; }
