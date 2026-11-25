// Tiny WebAudio synth: ring and end-call tones, no asset files.
let ctx;
const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());

function tone(freqs, start, dur, gain = 0.06) {
  const a = ac();
  const g = a.createGain();
  g.gain.setValueAtTime(0, a.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.03);
  g.gain.setValueAtTime(gain, a.currentTime + start + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, a.currentTime + start + dur);
  g.connect(a.destination);
  for (const f of freqs) {
    const o = a.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(a.currentTime + start);
    o.stop(a.currentTime + start + dur);
  }
}

export function startRing() {
  ac().resume();
  const burst = () => tone([440, 480], 0, 0.9);
  burst();
  const id = setInterval(burst, 2200);
  return () => clearInterval(id);
}

export const playConnected = () => tone([660, 880], 0, 0.18);

export function playEnd() {
  ac().resume();
  tone([480, 620], 0, 0.18);
  tone([400, 500], 0.22, 0.28);
}
