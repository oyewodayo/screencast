import { describe, expect, it } from "vitest";
import { EDGE_FADE_SEC, fadeLevel, joinFades } from "./audioJoins";

const piece = (id: string, startTime: number, endTime: number, trimStart: number, extra: Record<string, unknown> = {}) => ({
  id,
  src: "song.wav",
  startTime,
  endTime,
  trimStart,
  sourceDuration: 100,
  ...extra,
});

describe("audio joins", () => {
  it("crossfades two overlapping pieces of one track, equal-power", () => {
    const f = joinFades([piece("a", 0, 10, 0), piece("b", 9, 20, 30)]);
    expect(f.get("a")).toMatchObject({ fadeOut: 1, fadeOutCurve: "equalPower" });
    expect(f.get("b")).toMatchObject({ fadeIn: 1, fadeInCurve: "equalPower" });
    // Power holds through the middle of the overlap: sin² + cos² = 1.
    const mid = 9.5;
    const out = fadeLevel(f.get("a")!, mid, 10);
    const into = fadeLevel(f.get("b")!, mid - 9, 11);
    expect(out * out + into * into).toBeCloseTo(1, 6);
  });

  it("leaves a split that carries straight on alone", () => {
    const f = joinFades([piece("a", 0, 5, 0), piece("b", 5, 10, 5)]);
    expect(f.get("a")!.fadeOut).toBe(0);
    expect(f.get("b")!.fadeIn).toBe(0);
    // The outer edges as before: the file's own start, and a cut 10 s into its 100.
    expect(f.get("a")!.fadeIn).toBe(0);
    expect(f.get("b")!.fadeOut).toBe(EDGE_FADE_SEC);
  });

  it("puts a click-killing edge fade on a jump cut", () => {
    const f = joinFades([piece("a", 0, 5, 0), piece("b", 5, 10, 12)]);
    expect(f.get("a")).toMatchObject({ fadeOut: EDGE_FADE_SEC, fadeOutCurve: "equalPower" });
    expect(f.get("b")).toMatchObject({ fadeIn: EDGE_FADE_SEC, fadeInCurve: "equalPower" });
  });

  it("never crossfades different tracks that overlap (music under a voice)", () => {
    const f = joinFades([piece("music", 0, 10, 0), piece("voice", 5, 15, 0, { src: "voice.wav", label: "Voice" })]);
    expect(f.get("music")!.fadeOut).toBe(EDGE_FADE_SEC);
    expect(f.get("voice")!.fadeIn).toBe(0);
  });

  it("keeps a longer fade set in the panel, with its own shape", () => {
    const f = joinFades([piece("a", 0, 10, 0, { fadeOutSec: 2 }), piece("b", 9.5, 20, 30)]);
    expect(f.get("a")).toMatchObject({ fadeOut: 2, fadeOutCurve: "linear" });
    expect(f.get("b")).toMatchObject({ fadeIn: 0.5, fadeInCurve: "equalPower" });
  });

  it("never fades longer than the piece", () => {
    const f = joinFades([piece("a", 0, 1, 0, { fadeInSec: 2, fadeOutSec: 2 })]);
    expect(f.get("a")!.fadeIn + f.get("a")!.fadeOut).toBeCloseTo(1, 9);
  });
});
