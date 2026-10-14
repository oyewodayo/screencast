// Covers utils/clipTiming.ts - the one source/output time mapping (with speed ramps) everything
// shares - and toKeepSegments' hand-off of a ramp's steps to export.
import { describe, expect, it } from "vitest";
import { RAMP_STEPS, clipOutputDuration, clipSpeedSteps, outputOffsetToSource, sourceToOutputOffset, speedAtSource } from "./clipTiming";
import { cutClipRanges, splitClipAt, toKeepSegments } from "../handlers/videoEditHandlers";
import type { Clip } from "./videoEditTypes";

const plain: Clip = { id: "a", sourcePath: "v.mp4", start: 2, end: 12, speed: 2 };
const ramped: Clip = { ...plain, id: "b", speed: 1, speedRamp: { preset: "slow-mo-moment", amount: 0.8 } };

describe("clipTiming", () => {
  it("matches the plain constant-speed formulas when there's no ramp", () => {
    expect(clipOutputDuration(plain)).toBeCloseTo(5);
    expect(sourceToOutputOffset(plain, 6)).toBeCloseTo(2);
    expect(outputOffsetToSource(plain, 2)).toBeCloseTo(6);
    expect(speedAtSource(plain, 7)).toBe(2);
  });

  it("splits a ramp into steps that cover the clip exactly, slowest in the middle", () => {
    const steps = clipSpeedSteps(ramped);
    expect(steps).toHaveLength(RAMP_STEPS);
    expect(steps[0].sourceStart).toBe(2);
    expect(steps[steps.length - 1].sourceEnd).toBe(12);
    const mid = steps[Math.floor(RAMP_STEPS / 2)].speed;
    expect(mid).toBeLessThan(steps[0].speed);
    expect(clipOutputDuration(ramped)).toBeGreaterThan(10); // slow motion makes it longer
  });

  it("maps source to output and back consistently through a ramp", () => {
    for (const t of [2, 3.3, 7, 9.9, 12]) {
      expect(outputOffsetToSource(ramped, sourceToOutputOffset(ramped, t))).toBeCloseTo(t, 6);
    }
    expect(sourceToOutputOffset(ramped, 12)).toBeCloseTo(clipOutputDuration(ramped), 6);
  });

  it("keeps every step within the export's 0.25x-16x range", () => {
    const extreme: Clip = { ...plain, speed: 16, speedRamp: { preset: "speed-up", amount: 1 } };
    expect(clipSpeedSteps(extreme).every((s) => s.speed <= 16 && s.speed >= 0.25)).toBe(true);
  });
});

describe("toKeepSegments with ramps", () => {
  it("keeps a ramped clip as one segment carrying its steps, covering the clip exactly", () => {
    const clips: Clip[] = [plain, { ...ramped, transitionIn: { type: "fade", duration: 1 }, kenBurns: { preset: "zoom-in" } }];
    const segments = toKeepSegments(clips);
    expect(segments).toHaveLength(2);
    expect(segments[0].speedSteps).toBeUndefined();
    const steps = segments[1].speedSteps!;
    expect(steps).toHaveLength(RAMP_STEPS);
    expect(segments[1].transitionIn).toBeDefined();
    expect(steps[0].sourceStart).toBe(clips[1].start);
    expect(steps[RAMP_STEPS - 1].sourceEnd).toBe(clips[1].end);
    steps.slice(1).forEach((s, i) => expect(s.sourceStart).toBe(steps[i].sourceEnd));
    const total = steps.reduce((sum, s) => sum + (s.sourceEnd - s.sourceStart) / s.speed, 0);
    expect(total).toBeCloseTo(clipOutputDuration(clips[1]), 6);
  });
});

describe("pieces of a ramped / Ken Burns clip play exactly as the whole", () => {
  const whole: Clip = { id: "w", sourcePath: "a.mp4", start: 2, end: 12, speedRamp: { preset: "slow-mo-moment", amount: 1 }, kenBurns: { preset: "zoom-in", intensity: 1 } };

  it("split keeps the curve's own steps on each side", () => {
    const at = 2 + 10 * 0.37; // mid-step
    const [a, b] = splitClipAt([whole], 0, at);
    const original = clipSpeedSteps(whole);
    const pieces = [...clipSpeedSteps(a), ...clipSpeedSteps(b)];
    // Same speeds over the same source time - the step cut at the split shows up as two parts.
    for (const t of [2.1, 4.4, 5.69, 5.71, 7, 11.9]) expect(speedAtSource(t < at ? a : b, t)).toBeCloseTo(speedAtSource(whole, t), 9);
    expect(clipOutputDuration(a) + clipOutputDuration(b)).toBeCloseTo(clipOutputDuration(whole), 9);
    expect(pieces.length).toBe(original.length + 1);
    expect(a.speedRamp!.span![1]).toBeCloseTo(0.37, 9);
    expect(b.speedRamp!.span![0]).toBeCloseTo(0.37, 9);
  });

  it("a cut out of the middle keeps both sides' parts of the curve", () => {
    const [a, b] = cutClipRanges([whole], [{ clipId: "w", start: 6, end: 8 }]);
    expect(a.id).toBe("w");
    expect(a.speedRamp!.span).toEqual([0, 0.4]);
    expect(b.speedRamp!.span![0]).toBeCloseTo(0.6, 9);
    expect(b.kenBurns!.span![0]).toBeCloseTo(0.6, 9);
    expect(b.kenBurns!.span![1]).toBeCloseTo(1, 9);
    expect(clipOutputDuration(a) + clipOutputDuration(b)).toBeCloseTo(
      clipOutputDuration(whole) - (sourceToOutputOffset(whole, 8) - sourceToOutputOffset(whole, 6)),
      9
    );
  });

  it("splitting keeps every setting (grade, stabilize, audio, reverse)", () => {
    const rich: Clip = {
      ...whole,
      grade: { exposure: 0.3 } as Clip["grade"],
      stabilize: { strength: 0.5 },
      noiseReduction: 0.4,
      reversedFrom: { sourcePath: "orig.mp4", start: 0, end: 10 },
      transitionIn: { type: "fade", duration: 1 },
    };
    const [a, b] = splitClipAt([rich], 0, 5);
    for (const piece of [a, b]) {
      expect(piece.grade).toEqual(rich.grade);
      expect(piece.stabilize).toEqual(rich.stabilize);
      expect(piece.noiseReduction).toBe(0.4);
      expect(piece.reversedFrom).toEqual(rich.reversedFrom);
    }
    expect(a.transitionIn).toEqual(rich.transitionIn);
    expect(b.transitionIn).toBeUndefined();
  });
});
