import { describe, expect, it } from "vitest";
import { IMAGE_REVEAL_FPS, imageRevealSeconds, imageRevealState, wipeMaskCss } from "./imageReveal";

const keys = (settings: Parameters<typeof imageRevealState>[0], duration: number) =>
  new Set(Array.from({ length: Math.ceil(duration * IMAGE_REVEAL_FPS) }, (_, k) => imageRevealState(settings, k / IMAGE_REVEAL_FPS, duration).key));

describe("imageReveal", () => {
  it("wipes from hidden to fully shown over its length", () => {
    const s = { style: "wipe" as const, seconds: 1 };
    expect(imageRevealState(s, 0, 5).wipe).toBe(0);
    expect(imageRevealState(s, 0.5, 5).wipe).toBeGreaterThan(0);
    expect(imageRevealState(s, 1, 5).wipe).toBe(1);
    expect(wipeMaskCss("right", 1, 0.18, 100, 50)).toBeNull();
  });

  it("glare streaks across after the wipe has started, then rests", () => {
    const s = { style: "glare" as const, seconds: 1 };
    expect(imageRevealState(s, 0.2, 5).shine).toBeNull();
    expect(imageRevealState(s, 0.7, 5).shine).not.toBeNull();
    expect(imageRevealState(s, 2, 5).shine).toBeNull();
  });

  it("exports a still logo as one frame after its reveal", () => {
    const s = { style: "wipe" as const, seconds: 1 };
    // 30 reveal frames + 1 settled frame, however long it stays.
    expect(keys(s, 60).size).toBe(31);
  });

  it("repeats its shine on a period - one cycle of frames, whatever the length", () => {
    const s = { style: "glare" as const, seconds: 1, shineEvery: 3 };
    expect(keys(s, 30).size).toBe(keys(s, 300).size);
  });

  it("plays backwards on exit and never takes more than 45% of a short overlay", () => {
    const s = { style: "wipe" as const, seconds: 1, exit: true };
    expect(imageRevealState(s, 4.99, 5).wipe).toBeLessThan(0.05);
    expect(imageRevealSeconds({ style: "fade", seconds: 4 }, 2)).toBeCloseTo(0.9);
  });
});
