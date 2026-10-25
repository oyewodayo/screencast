// Afro instruments for the Briefcast Originals: the amapiano log drum. Same note signature as
// instruments.mjs: inst(out, { t, dur, midi, vel, pan }, options).
import { SR, TAU, Biquad, clamp, fsin, mtof, panGains, rng } from "./dsp.mjs";

// Log drum: the amapiano bass voice. A woody knock that starts well sharp and snaps to pitch, a
// round body with fast-dying overtones that droops a little as it rings (the "bwomp"), and drive
// that growls on the loud ones. `slide` bends the note in from a few semitones away.
export function logDrum(out, { t, dur, midi, vel = 0.9, pan = 0, glideFrom = 0 }, { knock = 1, decay = 0.42, drive = 2.4, droop = 0.7, tone = 0.6, slide = 0 } = {}) {
  const f = mtof(midi);
  const start = Math.max(0, Math.round(t * SR));
  const n = Math.max(0, Math.min(out.length - start, Math.round((Math.min(dur, decay * 3) + 0.12) * SR)));
  const [gl, gr] = panGains(pan);
  const r = rng(midi * 389 + Math.round(t * 2203));
  const click = new Biquad("bandpass", 1500, 2.5);
  const norm = Math.tanh(drive);
  const from = glideFrom || slide;
  const endS = dur * SR;
  let ph = 0;
  let rel = 1;
  const relK = Math.exp(-1 / (0.04 * SR));
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const semi = 7 * Math.exp(-tt / 0.011) + from * Math.exp(-tt / 0.07) - droop * Math.min(1, tt / 0.35);
    ph += (TAU * f * 2 ** (semi / 12)) / SR;
    const body = fsin(ph) + tone * (0.4 * fsin(2 * ph) * Math.exp(-tt / 0.09) + 0.18 * fsin(3 * ph + 0.4) * Math.exp(-tt / 0.05));
    const amp = Math.min(1, tt / 0.0015) * Math.exp(-tt / decay);
    if (i > endS) {
      rel *= relK;
      if (rel < 1e-4) break;
    }
    const k = click.process(r.bi()) * knock * 0.5 * Math.exp(-tt / 0.007);
    const v = (Math.tanh((body * amp + k) * drive * clamp(vel, 0.2, 1.2)) / norm) * rel * 0.6;
    out.L[start + i] += v * gl;
    out.R[start + i] += v * gr;
  }
}
