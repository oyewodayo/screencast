import { describe, expect, it } from "vitest";
import type { Clip } from "./videoEditTypes";
import { HighlightIntroOptions, buildHighlightIntro, introCutLengths, pickIntroMoments } from "./highlightIntro";

const clip = (id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: `${id}.mp4`, start, end, ...extra });
const CLIPS = [clip("a", 0, 20), clip("b", 5, 35), clip("c", 0, 12), clip("photo", 0, 5, { sourcePath: "x.jpg" })];
const base: HighlightIntroOptions = { sourceClipIds: [], cuts: 8, cutSec: 0.3, pace: "steady", order: "story", between: "flash", muteCuts: true, beats: null, everyBeats: 1, seed: 1 };

describe("highlight intro", () => {
  it("cuts exactly on the beat, every Nth beat", () => {
    const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    expect(introCutLengths({ ...base, beats })).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(introCutLengths({ ...base, beats, everyBeats: 2, cuts: 3 })).toEqual([1, 1, 1]);
  });

  it("builds up - each cut shorter than the last, same total", () => {
    const lengths = introCutLengths({ ...base, pace: "build" });
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeLessThan(lengths[i - 1]);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeCloseTo(8 * 0.3);
  });

  it("takes every moment from inside a video clip, never a photo", () => {
    const moments = pickIntroMoments(CLIPS, introCutLengths(base), base);
    expect(moments).toHaveLength(8);
    for (const m of moments) {
      expect(m.clip.sourcePath.endsWith(".mp4")).toBe(true);
      expect(m.start).toBeGreaterThanOrEqual(m.clip.start);
      expect(m.end).toBeLessThanOrEqual(m.clip.end);
      expect(m.end - m.start).toBeCloseTo(0.3);
    }
  });

  it("shuffles without repeating a clip back to back, and re-rolls to new moments", () => {
    const shuffled = pickIntroMoments(CLIPS, introCutLengths(base), { ...base, order: "shuffle" });
    for (let i = 1; i < shuffled.length; i++) expect(shuffled[i].clip.id === shuffled[i - 1].clip.id && CLIPS.length > 2).toBe(false);
    const a = pickIntroMoments(CLIPS, introCutLengths(base), base).map((m) => m.start);
    const b = pickIntroMoments(CLIPS, introCutLengths(base), { ...base, seed: 2 }).map((m) => m.start);
    expect(a).not.toEqual(b);
  });

  it("only uses the chosen clips", () => {
    const moments = pickIntroMoments(CLIPS, introCutLengths(base), { ...base, sourceClipIds: ["c"] });
    expect(moments.every((m) => m.clip.id === "c")).toBe(true);
  });

  it("mutes the cuts and flashes between them, not into the first", () => {
    let n = 0;
    const intro = buildHighlightIntro(CLIPS, base, () => `n${n++}`);
    expect(intro.every((c) => c.muted)).toBe(true);
    expect(intro[0].transitionIn).toBeUndefined();
    expect(intro.slice(1).every((c) => c.transitionIn?.type === "fadewhite")).toBe(true);
  });
});
