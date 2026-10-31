// utils/stage/stageLoops.ts
//
// Motions an element keeps doing by itself over a run of beats - a pulse, a float, a spin, a
// wiggle - added on top of wherever its springs have put it. Each is a closed-form function of
// time, so scrubbing, playing and exporting agree: it eases in over EASE seconds when its run
// begins and out when it ends (no pop either way), and a spin's speed is scaled so the run ends on
// a whole number of turns - the element comes to rest exactly as it was.
import type { StageLoop, StageLoopKind } from "./stageTypes";

export const LOOP_EASE = 0.45;

export interface LoopInfo {
  label: string;
  hint: string;
  // What `amount` is, its default and range.
  amount: { label: string; default: number; min: number; max: number; step: number; unit: string };
  period: { default: number; min: number; max: number };
}

export const LOOP_INFO: Record<StageLoopKind, LoopInfo> = {
  pulse: { label: "Pulse", hint: "Grows and shrinks gently - something alive, or asking to be noticed", amount: { label: "Size", default: 6, min: 1, max: 40, step: 1, unit: "%" }, period: { default: 1.2, min: 0.2, max: 6 } },
  heartbeat: { label: "Heartbeat", hint: "Two quick beats, then a rest", amount: { label: "Size", default: 10, min: 2, max: 40, step: 1, unit: "%" }, period: { default: 1.1, min: 0.4, max: 4 } },
  float: { label: "Float", hint: "Drifts up and down, as if on water", amount: { label: "Height", default: 12, min: 2, max: 120, step: 1, unit: "" }, period: { default: 3, min: 0.5, max: 10 } },
  bounce: { label: "Bounce", hint: "Hops off the ground and lands again", amount: { label: "Height", default: 28, min: 4, max: 200, step: 1, unit: "" }, period: { default: 0.8, min: 0.2, max: 4 } },
  spin: { label: "Spin", hint: "Turns round and round - comes to rest on a whole turn", amount: { label: "Direction", default: 1, min: -1, max: 1, step: 2, unit: "" }, period: { default: 3, min: 0.3, max: 20 } },
  sway: { label: "Sway", hint: "Rocks side to side about its anchor, like a pendulum", amount: { label: "Angle", default: 6, min: 1, max: 45, step: 1, unit: "°" }, period: { default: 2.4, min: 0.3, max: 8 } },
  wiggle: { label: "Wiggle", hint: "An irregular little wobble - playful, hand-made", amount: { label: "Angle", default: 4, min: 1, max: 30, step: 1, unit: "°" }, period: { default: 1.4, min: 0.2, max: 6 } },
  shake: { label: "Shake", hint: "A quick jitter - an error, a buzz, an alarm", amount: { label: "Distance", default: 6, min: 1, max: 60, step: 1, unit: "" }, period: { default: 0.5, min: 0.1, max: 3 } },
  tilt: { label: "Tilt in 3D", hint: "Turns a little in depth one way and back - a card catching the light", amount: { label: "Angle", default: 12, min: 2, max: 60, step: 1, unit: "°" }, period: { default: 4, min: 0.5, max: 12 } },
  orbit: { label: "Orbit", hint: "Circles round where it is", amount: { label: "Radius", default: 18, min: 2, max: 300, step: 1, unit: "" }, period: { default: 4, min: 0.3, max: 20 } },
  breathe: { label: "Breathe", hint: "Fades a little and back", amount: { label: "Depth", default: 35, min: 5, max: 100, step: 1, unit: "%" }, period: { default: 2.5, min: 0.3, max: 10 } },
  blink: { label: "Blink", hint: "On and off - a cursor, a live light", amount: { label: "Off", default: 100, min: 10, max: 100, step: 1, unit: "%" }, period: { default: 1, min: 0.15, max: 4 } },
};

export interface LoopDelta {
  dx: number;
  dy: number;
  // Multiplied in.
  scale: number;
  opacity: number;
  rotation: number;
  rotateY: number;
}

const TAU = Math.PI * 2;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// How much of the loop is on at `t`: eased up from `start`, down to `end`.
function envelope(t: number, start: number, end: number): number {
  if (t <= start || t >= end) return 0;
  return Math.min(smooth((t - start) / LOOP_EASE), Number.isFinite(end) ? smooth((end - t) / LOOP_EASE) : 1);
}

// The integral of the envelope from `start` to `t` (the smoothstep's integral is closed form).
function envelopeArea(t: number, start: number, end: number): number {
  const e = LOOP_EASE;
  const ramp = (x: number) => {
    // ∫0^x smoothstep(u/e) du for x in [0, e].
    const u = Math.max(0, Math.min(1, x / e));
    return e * (u * u * u - 0.5 * u * u * u * u);
  };
  if (t <= start) return 0;
  const span = end - start;
  if (!Number.isFinite(end) || span >= 2 * e) {
    const tt = Math.min(t, end);
    let a = ramp(tt - start);
    if (tt - start > e) a = ramp(e) + (tt - start - e);
    if (Number.isFinite(end) && tt > end - e) a -= ramp(e) - ramp(end - tt);
    return a;
  }
  // A run shorter than the two eases: numeric (rare).
  let a = 0;
  const n = 64;
  const tt = Math.min(t, end);
  for (let i = 0; i < n; i++) a += envelope(start + ((i + 0.5) / n) * (tt - start), start, end) * ((tt - start) / n);
  return a;
}

// A smooth, irregular wave in [-1, 1] (three incommensurate sines).
const wobble = (x: number) => (Math.sin(x) * 0.55 + Math.sin(x * 2.17 + 1.3) * 0.3 + Math.sin(x * 3.71 + 2.1) * 0.15);

// The loops' combined change at scene time `t`, and whether any is under way. `beatStarts` and
// `duration` place each loop's run.
export function loopsAt(loops: StageLoop[] | undefined, t: number, beatStarts: number[], duration: number): { delta: LoopDelta; active: boolean } {
  const delta: LoopDelta = { dx: 0, dy: 0, scale: 1, opacity: 1, rotation: 0, rotateY: 0 };
  let active = false;
  for (const loop of loops ?? []) {
    const info = LOOP_INFO[loop.kind];
    if (!info) continue;
    const start = beatStarts[Math.max(0, Math.min(beatStarts.length - 1, loop.from ?? 0))] ?? 0;
    const end = loop.until !== undefined && loop.until < beatStarts.length ? beatStarts[Math.max(0, loop.until)] : duration > 0 ? Infinity : Infinity;
    if (!(end > start)) continue;
    const env = envelope(t, start, end);
    if (env <= 0 && loop.kind !== "spin") continue;
    const a = loop.amount ?? info.amount.default;
    const period = Math.max(0.05, loop.period ?? info.period.default);
    const local = t - start;
    const phase = (loop.phase ?? 0) * TAU;
    const w = (local / period) * TAU + phase;
    if (env > 0) active = true;
    switch (loop.kind) {
      case "pulse":
        delta.scale *= 1 + (a / 100) * env * 0.5 * (1 - Math.cos(w));
        break;
      case "heartbeat": {
        // Two beats in the first 40% of each cycle.
        const c = ((local / period + (loop.phase ?? 0)) % 1 + 1) % 1;
        const beat = (x: number, at: number) => Math.exp(-Math.pow((x - at) / 0.05, 2));
        delta.scale *= 1 + (a / 100) * env * (beat(c, 0.08) + 0.7 * beat(c, 0.26));
        break;
      }
      case "float":
        delta.dy -= a * env * Math.sin(w);
        break;
      case "bounce":
        delta.dy -= a * env * Math.abs(Math.sin(w / 2));
        break;
      case "spin": {
        // Turns at 1/period a second, eased - scaled so a finished run lands on a whole turn.
        const area = envelopeArea(t, start, end);
        let rate = 360 / period;
        if (Number.isFinite(end)) {
          const total = envelopeArea(end, start, end) * rate;
          const turns = Math.max(1, Math.round(total / 360));
          rate = (turns * 360) / Math.max(1e-6, envelopeArea(end, start, end));
        }
        if (t > start && t < end) active = true;
        if (t >= end) break;
        delta.rotation += (a < 0 ? -1 : 1) * rate * area;
        break;
      }
      case "sway":
        delta.rotation += a * env * Math.sin(w);
        break;
      case "wiggle":
        delta.rotation += a * env * wobble(w);
        break;
      case "shake":
        delta.dx += a * env * wobble(w * 3.3);
        delta.dy += a * 0.35 * env * wobble(w * 2.7 + 4);
        break;
      case "tilt":
        delta.rotateY += a * env * Math.sin(w);
        break;
      case "orbit":
        // About where it rests - the radius grows from nothing as the loop eases in.
        delta.dx += a * env * Math.sin(w);
        delta.dy -= a * env * Math.cos(w);
        break;
      case "breathe":
        delta.opacity *= 1 - (a / 100) * env * 0.5 * (1 - Math.cos(w));
        break;
      case "blink": {
        const c = ((local / period + (loop.phase ?? 0)) % 1 + 1) % 1;
        // On for the first half of each cycle, with soft edges (no flicker between frames).
        const edge = Math.min(0.08, 0.04 / period);
        const on = c < 0.5 ? smooth((0.5 - c) / edge) : smooth((c - 1 + edge) / edge);
        delta.opacity *= 1 - (a / 100) * env * (1 - on);
        break;
      }
    }
  }
  return { delta, active };
}
