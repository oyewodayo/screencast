// utils/clipTiming.ts
//
// How long a clip plays for and where its moments land on the output timeline - in one place,
// because a clip's speed can now vary across it (a speed ramp) and every part of the editor has to
// agree on exactly the same mapping: the timeline's layout, the playhead, the player's live
// playbackRate, captions, the transcript, overlays and export.
//
// A ramp is applied as RAMP_STEPS short constant-speed steps (the curve sampled at each step's
// middle). That's deliberate: export renders exactly these steps (one segment with a piecewise
// time map, speed_steps in conversion.rs), and the preview switches playbackRate at the same step
// boundaries - so the two match frame for frame, with no curve approximation on either side.
//
// A clip cut out of a ramped clip (split, transcript cut, silence removal) keeps the part of the
// curve it covers (`span`), on the original curve's own step grid - so the pieces together play
// exactly as the whole did.
import type { Clip } from "./videoEditTypes";

export type SpeedRampPreset = "slow-mo-moment" | "speed-up" | "slow-down" | "fast-slow-fast";

export interface ClipSpeedRamp {
  preset: SpeedRampPreset;
  // 0..1 - how far the ramp swings from the clip's own speed.
  amount: number;
  // The part of the curve (0..1) this clip covers; undefined = all of it.
  span?: [number, number];
}

export const SPEED_RAMP_PRESETS: { value: SpeedRampPreset; label: string; hint: string }[] = [
  { value: "slow-mo-moment", label: "Slow-mo moment", hint: "Normal speed, slowing into the middle and back out" },
  { value: "fast-slow-fast", label: "Fast → slow → fast", hint: "Rushes in, lingers in the middle, rushes out" },
  { value: "speed-up", label: "Speed up", hint: "Starts normal and accelerates" },
  { value: "slow-down", label: "Slow down", hint: "Starts normal and eases into slow motion" },
];

// Steps across a whole curve (a clip covering part of it has the steps of that part).
export const RAMP_STEPS = 16;
// The range every step's speed is held to - the same 0.25..4 the export's segment_speed allows.
const MIN_SPEED = 0.25;
const MAX_SPEED = 16; // SpeedPopover's MAX_SPEED - see there

export interface SpeedStep {
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const bump = (u: number) => Math.exp(-(((u - 0.5) / 0.2) ** 2));

// The ramp's speed multiplier at position u (0..1 through the clip's source range).
export function rampMultiplier(ramp: ClipSpeedRamp, u: number): number {
  const a = Math.max(0, Math.min(1, ramp.amount));
  const low = 1 - 0.75 * a; // down to 0.25x
  const high = 1 + 2 * a; // up to 3x
  switch (ramp.preset) {
    case "slow-mo-moment":
      return 1 - (1 - low) * bump(u);
    case "fast-slow-fast":
      return low + (high - low) * (1 - bump(u));
    case "speed-up":
      return 1 + (high - 1) * smoothstep(0.1, 0.9, u);
    case "slow-down":
      return 1 - (1 - low) * smoothstep(0.1, 0.9, u);
    default:
      return 1;
  }
}

// The clip as constant-speed steps in source order - one step for an ordinary clip.
export function clipSpeedSteps(clip: Pick<Clip, "start" | "end" | "speed" | "speedRamp">): SpeedStep[] {
  const base = clip.speed ?? 1;
  const clampSpeed = (s: number) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, s));
  const ramp = clip.speedRamp;
  if (!ramp || clip.end - clip.start <= 0) return [{ sourceStart: clip.start, sourceEnd: clip.end, speed: clampSpeed(base) }];
  const [u0, u1] = rampSpan(ramp);
  // Source time of curve position u.
  const sourceAt = (u: number) => (u <= u0 ? clip.start : u >= u1 ? clip.end : clip.start + ((u - u0) / (u1 - u0)) * (clip.end - clip.start));
  const steps: SpeedStep[] = [];
  for (let i = Math.max(0, Math.floor(u0 * RAMP_STEPS)); i < Math.min(RAMP_STEPS, Math.ceil(u1 * RAMP_STEPS)); i++) {
    const a = Math.max(u0, i / RAMP_STEPS);
    const b = Math.min(u1, (i + 1) / RAMP_STEPS);
    if (b - a <= 1e-9) continue;
    steps.push({ sourceStart: sourceAt(a), sourceEnd: sourceAt(b), speed: clampSpeed(base * rampMultiplier(ramp, (i + 0.5) / RAMP_STEPS)) });
  }
  return steps.length > 0 ? steps : [{ sourceStart: clip.start, sourceEnd: clip.end, speed: clampSpeed(base) }];
}

function rampSpan(ramp: ClipSpeedRamp): [number, number] {
  const [a, b] = ramp.span ?? [0, 1];
  const u0 = Math.max(0, Math.min(1, a));
  const u1 = Math.max(0, Math.min(1, b));
  return u1 - u0 > 1e-9 ? [u0, u1] : [0, 1];
}

// The part [from, to] of an effect's 0..1 progress that the source range [a, b] of a clip covers,
// given the part the whole clip covers - what a piece cut out of it keeps. [0, 1] comes back as
// undefined (the whole thing).
export function subSpan(clip: Pick<Clip, "start" | "end">, span: [number, number] | undefined, a: number, b: number): [number, number] | undefined {
  const [u0, u1] = span ?? [0, 1];
  const length = clip.end - clip.start;
  if (length <= 0) return span;
  const at = (t: number) => u0 + ((u1 - u0) * (Math.max(clip.start, Math.min(clip.end, t)) - clip.start)) / length;
  const next: [number, number] = [at(a), at(b)];
  return Math.abs(next[0]) < 1e-9 && Math.abs(next[1] - 1) < 1e-9 ? undefined : next;
}

// Output seconds the clip plays for.
export function clipOutputDuration(clip: Pick<Clip, "start" | "end" | "speed" | "speedRamp">): number {
  return Math.max(0, clipSpeedSteps(clip).reduce((sum, step) => sum + (step.sourceEnd - step.sourceStart) / step.speed, 0));
}

// Output seconds from the clip's own start to `sourceTime` (clamped into the clip).
export function sourceToOutputOffset(clip: Pick<Clip, "start" | "end" | "speed" | "speedRamp">, sourceTime: number): number {
  let out = 0;
  for (const step of clipSpeedSteps(clip)) {
    if (sourceTime <= step.sourceStart) break;
    out += (Math.min(sourceTime, step.sourceEnd) - step.sourceStart) / step.speed;
  }
  return out;
}

// The source time reached `outputOffset` output seconds into the clip (clamped into the clip).
export function outputOffsetToSource(clip: Pick<Clip, "start" | "end" | "speed" | "speedRamp">, outputOffset: number): number {
  let remaining = Math.max(0, outputOffset);
  const steps = clipSpeedSteps(clip);
  for (const step of steps) {
    const stepOut = (step.sourceEnd - step.sourceStart) / step.speed;
    if (remaining <= stepOut) return step.sourceStart + remaining * step.speed;
    remaining -= stepOut;
  }
  return steps[steps.length - 1]?.sourceEnd ?? clip.end;
}

// Playback rate at `sourceTime` - what the preview's <video> plays at there.
export function speedAtSource(clip: Pick<Clip, "start" | "end" | "speed" | "speedRamp">, sourceTime: number): number {
  const steps = clipSpeedSteps(clip);
  return (steps.find((s) => sourceTime < s.sourceEnd) ?? steps[steps.length - 1]).speed;
}
