// Staff devices buzz and beep for something new (a request to accept, a help call, an escalation), so nobody has to
// watch the screen. Quiet when nothing changed. A bell in the header turns the sound off. Browsers only allow sound
// after a first tap, so the audio is unlocked by the first touch on the page.
import { newAttention } from '/shared/alerts.js';

const KEY = 'frl.sound';
const BASE_TITLE = document.title;
let ctx = null;
let prev = new Map();
let primed = false;

export const soundOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function toggleSound() {
  try { localStorage.setItem(KEY, soundOn() ? 'off' : 'on'); } catch { /* private mode */ }
  return soundOn();
}

const unlock = () => {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
  ctx?.resume?.();
};
document.addEventListener('pointerdown', unlock, { passive: true });

function beep(times, freq, seconds) {
  if (!ctx || ctx.state !== 'running') return;
  for (let i = 0; i < times; i += 1) {
    const t0 = ctx.currentTime + i * (seconds + 0.09);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + seconds);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + seconds + 0.02);
  }
}
const buzz = (pattern) => { try { navigator.vibrate?.(pattern); } catch { /* not supported */ } };

/** Call after every refresh with this device's attention map (or null when the screen has none). */
export function update(map) {
  if (!map) { prev = new Map(); primed = false; document.title = BASE_TITLE; return; }
  const { added, urgent, count } = newAttention(prev, map);
  if (primed && soundOn()) {
    if (urgent.length) { beep(3, 660, 0.16); buzz([250, 100, 250, 100, 250]); } // something is late or someone needs help
    else if (added.length) { beep(2, 880, 0.12); buzz([180, 80, 180]); }        // something new to do
  }
  prev = map;
  primed = true;
  document.title = `${count ? `(${count}) ` : ''}${BASE_TITLE}`;
}
