import { describe, expect, it } from "vitest";
import { KEN_BURNS_PRESETS, affineCssTransform, clipFrameAffine, kenBurnsWindow, playerFraming } from "./videoColorFilters";

describe("kenBurnsWindow - camera motions", () => {
  it("never shows past the frame's edge, for any motion at any moment", () => {
    for (const { value } of KEN_BURNS_PRESETS)
      for (const intensity of [0, 0.5, 1])
        for (let i = 0; i <= 200; i++) {
          const w = kenBurnsWindow({ preset: value, intensity }, i / 200, 6)!;
          const half = 1 / (2 * w.zoom);
          expect(w.zoom, value).toBeGreaterThanOrEqual(1 - 1e-9);
          expect(w.cx - half, value).toBeGreaterThanOrEqual(-1e-9);
          expect(w.cx + half, value).toBeLessThanOrEqual(1 + 1e-9);
          expect(w.cy - half, value).toBeGreaterThanOrEqual(-1e-9);
          expect(w.cy + half, value).toBeLessThanOrEqual(1 + 1e-9);
        }
  });

  it("runs the oscillating motions on the clip's clock in seconds, whatever its length", () => {
    // Breathe repeats every 3s: the same window at 1s into a 6s clip and 4s into it.
    const at = (sec: number, len: number) => kenBurnsWindow({ preset: "breathe", intensity: 1 }, sec / len, len)!.zoom;
    expect(at(1, 6)).toBeCloseTo(at(4, 6), 9);
    // ...and the same 1s in, whether the clip is 6s or 20s long.
    expect(at(1, 6)).toBeCloseTo(at(1, 20), 9);
    // Pulse kicks every half second.
    const pulse = (sec: number) => kenBurnsWindow({ preset: "pulse", intensity: 1 }, sec / 4, 4)!.zoom;
    expect(pulse(1)).toBeCloseTo(1.1, 9);
    expect(pulse(1.25)).toBeCloseTo(1, 9);
  });

  it("punches in fast and settles, and shakes without drifting off", () => {
    const punch = (sec: number) => kenBurnsWindow({ preset: "punch-in", intensity: 1 }, sec / 5, 5)!.zoom;
    expect(punch(0)).toBeCloseTo(1, 9);
    expect(punch(0.25)).toBeGreaterThan(1.4); // overshooting on the way in
    expect(punch(2)).toBeCloseTo(1.4, 9);
    const shake = Array.from({ length: 100 }, (_, i) => kenBurnsWindow({ preset: "shake", intensity: 1 }, i / 100, 5)!);
    expect(new Set(shake.map((w) => w.cx.toFixed(4))).size).toBeGreaterThan(50);
  });
});

const parseMatrix = (t: string) => t.slice(7, -1).split(", ").map(Number);
const apply = (m: ReturnType<typeof clipFrameAffine>, u: number, v: number) => [m.ax * u + m.bx, m.ay * v + m.by];

describe("clipFrameAffine - the export's framing chain, exactly", () => {
  it("is the identity with no effects", () => {
    expect(clipFrameAffine({}, 0.5)).toEqual({ ax: 1, bx: 0, ay: 1, by: 0 });
    expect(affineCssTransform(clipFrameAffine({}, 0.5))).toBe("");
  });

  it("zooms inside the cropped window, not the source frame (crop runs before Ken Burns)", () => {
    // Left half cropped, then a centred zoom: the cropped window's centre - source x 0.25 - stays put.
    const m = clipFrameAffine({ crop: { x: 0, y: 0, width: 0.5, height: 1 }, kenBurns: { preset: "zoom-in", intensity: 1 } }, 1);
    const [x, y] = apply(m, 0.25, 0.5);
    expect(x).toBeCloseTo(0.5, 9);
    expect(y).toBeCloseTo(0.5, 9);
    expect(m.ax).toBeCloseTo(2 * 1.3, 9);
  });

  it("uses ken_burns_chain's amounts: 1.3x zoom, 1.15x pan at full intensity", () => {
    expect(kenBurnsWindow({ preset: "zoom-in", intensity: 1 }, 1)!.zoom).toBeCloseTo(1.3, 9);
    expect(kenBurnsWindow({ preset: "zoom-out", intensity: 1 }, 1)!.zoom).toBeCloseTo(1, 9);
    expect(kenBurnsWindow({ preset: "pan-left", intensity: 1 }, 0.3)!.zoom).toBeCloseTo(1.15, 9);
  });

  it("keeps a zoom window on-frame like clip(tx*iw-ow/2, 0, iw-ow)", () => {
    const win = kenBurnsWindow({ preset: "zoom-in", intensity: 1, targetX: 1, targetY: 0 }, 1)!;
    expect(win.cx).toBeCloseTo(1 - 1 / 2.6, 9);
    expect(win.cy).toBeCloseTo(1 / 2.6, 9);
  });

  it("pans the window from edge to edge", () => {
    const right0 = clipFrameAffine({ kenBurns: { preset: "pan-right", intensity: 1 } }, 0);
    const right1 = clipFrameAffine({ kenBurns: { preset: "pan-right", intensity: 1 } }, 1);
    expect(apply(right0, 0, 0)[0]).toBeCloseTo(0, 9); // window's left edge at the frame's left
    expect(apply(right1, 1, 0)[0]).toBeCloseTo(1, 9); // ... and its right edge at the end
  });

  it("mirrors before cropping (hflip runs first)", () => {
    const m = clipFrameAffine({ flipHorizontal: true, crop: { x: 0, y: 0, width: 0.5, height: 1 } }, 0);
    // The crop's left half is of the mirrored frame: source x=1 (mirrored to 0) lands at 0.
    expect(apply(m, 1, 0)[0]).toBeCloseTo(0, 9);
    expect(apply(m, 0.5, 0)[0]).toBeCloseTo(1, 9);
  });

  it("clamps a crop inside the frame like crop_chain", () => {
    const m = clipFrameAffine({ crop: { x: 0.9, y: 0, width: 0.5, height: 1 } }, 0);
    expect(apply(m, 0.5, 0)[0]).toBeCloseTo(0, 9);
  });
});

describe("CSS output", () => {
  it("lands the map's points on screen with a centre origin, in px of the letterboxed picture", () => {
    const m = clipFrameAffine({ crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }, 0);
    // translate((b - 0.5 + 0.5a) * size) scale(a): b=-0.5, a=2 -> 0
    expect(affineCssTransform(m, { width: 800, height: 450 })).toBe("translate(0px, 0px) scale(2, 2)");
  });

  it("player: no effects and a matching frame leaves the video alone", () => {
    const f = playerFraming(clipFrameAffine({}, 0), { width: 1000, height: 500 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    expect(f.transform).toBe("");
    expect(f.clipPath).toBe("");
  });

  it("player: fits a clip of another shape into the project frame, like export's fit", () => {
    // Portrait 1080x1920 clip, 16:9 project, square 1000x1000 player element.
    const f = playerFraming(clipFrameAffine({}, 0), { width: 1000, height: 1000 }, { width: 1080, height: 1920 }, { width: 1920, height: 1080 });
    expect(f.frameRect).toEqual({ x: 0, y: 218.75, width: 1000, height: 562.5 });
    const [a, , , d, e, g] = parseMatrix(f.transform);
    // The <video> letterboxes the picture to 562.5x1000 at (218.75, 0); export fits it into the
    // frame at 316.40625x562.5, centred: (341.796875, 218.75).
    expect(a).toBeCloseTo(0.5625, 9);
    expect(d).toBeCloseTo(0.5625, 9);
    expect(a * 218.75 + e).toBeCloseTo(341.796875, 6);
    expect(d * 0 + g).toBeCloseTo(218.75, 6);
    expect(a * (218.75 + 562.5) + e).toBeCloseTo(341.796875 + 316.40625, 6);
  });

  it("player: a crop is taken from the fitted frame and clipped to it", () => {
    const element = { width: 1000, height: 500 };
    const f = playerFraming(clipFrameAffine({ crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }, 0), element, { width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    const F = f.frameRect;
    const [a, , , d, e, g] = parseMatrix(f.transform);
    // The crop window's left edge lands on the frame's left edge, its right edge on the right.
    expect(a * (F.x + 0.25 * F.width) + e).toBeCloseTo(F.x, 6);
    expect(a * (F.x + 0.75 * F.width) + e).toBeCloseTo(F.x + F.width, 6);
    expect(d).toBeCloseTo(1, 9);
    expect(g).toBeCloseTo(0, 6);
    const [top, right, bottom, left] = f.clipPath.slice(6, -1).split(" ").map((v) => parseFloat(v));
    expect(top).toBeCloseTo(0, 6);
    expect(bottom).toBeCloseTo(0, 6);
    expect(left).toBeCloseTo(F.x + 0.25 * F.width, 6);
    expect(right).toBeCloseTo(element.width - (F.x + 0.75 * F.width), 6);
  });
});
