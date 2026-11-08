// utils/stage/springs.ts
//
// The Stage's motion curve: a damped spring, solved in closed form. A value at rest or already
// moving (position x0, velocity v0) heads for `target`; springAt gives its position and velocity
// any time later directly - no stepping - so a frame sampled while scrubbing backwards, or rendered
// on its own by export, is the same number playback showed. Velocity comes back with the position
// so a beat that arrives mid-move can carry the motion on instead of restarting it from rest.
//
// A spring is described the way designers tune one: `response` is roughly how long a move takes
// (the period of the undamped oscillation, in seconds) and `damping` is the damping ratio - 1 settles
// as fast as possible without overshooting, below 1 overshoots and bounces back, above 1 creeps in.

export type SpringPreset = "slow" | "gentle" | "smooth" | "snappy" | "bouncy";

export interface SpringParams {
  response: number;
  damping: number;
}

export const SPRING_PRESETS: Record<SpringPreset, SpringParams> = {
  // A long, even settle - a picture resolving out of dots, a slow push in.
  slow: { response: 1.6, damping: 1 },
  // Unhurried, no overshoot - titles settling into place.
  gentle: { response: 0.7, damping: 1 },
  // The default: quick with the faintest settle.
  smooth: { response: 0.5, damping: 0.92 },
  snappy: { response: 0.32, damping: 0.86 },
  // A visible overshoot and settle.
  bouncy: { response: 0.55, damping: 0.62 },
};

export interface SpringState {
  x: number;
  v: number;
}

const MIN_RESPONSE = 0.02;

// A spring's constants, worked out once - the engine evaluates thousands of values a frame.
export interface SpringCoeffs {
  w: number;
  z: number;
  // Damped frequency (z < 1), or the two decay rates (z > 1).
  wd: number;
  r1: number;
  r2: number;
}

export function springCoeffs(p: SpringParams): SpringCoeffs {
  const w = (2 * Math.PI) / Math.max(MIN_RESPONSE, p.response);
  const z = Math.max(0, p.damping);
  const root = z > 1 ? Math.sqrt(z * z - 1) : 0;
  return { w, z, wd: z < 1 ? w * Math.sqrt(1 - z * z) : 0, r1: -w * (z - root), r2: -w * (z + root) };
}

// springAt with precomputed constants, writing into `out` instead of allocating.
export function springInto(k: SpringCoeffs, x0: number, v0: number, target: number, t: number, out: SpringState): void {
  const d0 = x0 - target;
  if (t <= 0) {
    out.x = x0;
    out.v = v0;
    return;
  }
  if (d0 === 0 && v0 === 0) {
    out.x = target;
    out.v = 0;
    return;
  }
  const { w, z } = k;
  if (z < 1) {
    const wd = k.wd;
    const decay = Math.exp(-z * w * t);
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t);
    out.x = target + decay * (d0 * c + ((v0 + z * w * d0) / wd) * s);
    out.v = decay * (v0 * c - ((z * w * v0 + w * w * d0) / wd) * s);
    return;
  }
  if (z === 1) {
    const b = v0 + w * d0;
    const decay = Math.exp(-w * t);
    out.x = target + (d0 + b * t) * decay;
    out.v = (v0 - w * b * t) * decay;
    return;
  }
  const { r1, r2 } = k;
  const c2 = (v0 - r1 * d0) / (r2 - r1);
  const c1 = d0 - c2;
  const e1 = Math.exp(r1 * t);
  const e2 = Math.exp(r2 * t);
  out.x = target + c1 * e1 + c2 * e2;
  out.v = r1 * c1 * e1 + r2 * c2 * e2;
}

// Position and velocity `t` seconds after leaving (x0, v0) for `target`.
export function springAt(p: SpringParams, x0: number, v0: number, target: number, t: number): SpringState {
  const out = { x: 0, v: 0 };
  springInto(springCoeffs(p), x0, v0, target, t, out);
  return out;
}

// The same spring with no overshoot - for values that must not swing past their target (opacity,
// blur, colour): a bounce there reads as a flicker, not as motion.
export function withoutOvershoot(p: SpringParams): SpringParams {
  return p.damping >= 1 ? p : { response: p.response, damping: 1 };
}

// Roughly when a move from rest across `distance` comes within `tolerance` of its target and stays
// there - how long the Stage keeps redrawing after a beat. Solved on the envelope, which bounds the
// oscillation from above, so it never reports a spring settled while it still visibly moves.
// Envelope of |x - target|: underdamped d e^{-zwt}/sqrt(1-z^2); critical d (1+wt) e^{-wt};
// overdamped below 2d e^{-r t} with r the slow decay rate.
export function springSettleTime(p: SpringParams, distance: number, tolerance: number): number {
  const d = Math.abs(distance);
  if (!(d > tolerance) || !(tolerance > 0)) return 0;
  const w = (2 * Math.PI) / Math.max(MIN_RESPONSE, p.response);
  const z = Math.max(0, p.damping);
  if (z === 0) return Infinity;
  if (z < 1) return Math.max(0, Math.log(d / (tolerance * Math.sqrt(1 - z * z))) / (z * w));
  if (z > 1) return Math.max(0, Math.log((2 * d) / tolerance) / (w * (z - Math.sqrt(z * z - 1))));
  // Critical: solve wt - ln(1 + wt) = ln(d / tolerance) for u = wt by Newton's method from above
  // (the left side is convex and increasing, so iterates stay above the root and close in on it).
  const target = Math.log(d / tolerance);
  let u = target + Math.log(1 + target) + 1;
  for (let i = 0; i < 8; i++) u -= (u - Math.log(1 + u) - target) / (u / (1 + u));
  return Math.max(0, u / w);
}
