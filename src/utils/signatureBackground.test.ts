import { describe, expect, it } from "vitest";
import { analyze, lift } from "./signatureBackground";
import { strokeOutline, strokeSamples, type InkStroke } from "./signatureInk";

// A 240x120 "phone photo": paper lit from the left (bright 245 → shadowed 150 on the right, much
// darker than the ink is relative to its own paper), a blue-black ink stroke across the middle,
// and a few single-pixel dust specks.
function photo(): ImageData {
  const w = 240;
  const h = 120;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const paper = 245 - (x / w) * 95;
      const onStroke = y >= 56 && y <= 63 && x >= 30 && x <= 210;
      const o = (y * w + x) * 4;
      if (onStroke) {
        // Ink is ~35% of the local paper brightness.
        data[o] = paper * 0.3;
        data[o + 1] = paper * 0.32;
        data[o + 2] = paper * 0.45;
      } else {
        data[o] = paper;
        data[o + 1] = paper - 4;
        data[o + 2] = paper - 12;
      }
      data[o + 3] = 255;
    }
  for (const [x, y] of [[15, 15], [200, 100], [120, 20]]) {
    const o = (y * w + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 60;
  }
  return { width: w, height: h, data, colorSpace: "srgb" } as ImageData;
}

const alphaAt = (out: Uint8ClampedArray, w: number, x: number, y: number) => out[(y * w + x) * 4 + 3];

describe("signature background lift", () => {
  it("keeps the ink, clears shadowed paper, drops specks, and crops to the stroke", () => {
    const img = photo();
    const a = analyze(img);
    expect(a.alreadyTransparent).toBe(false);
    const { data, bounds } = lift(a, { strength: 0.5, color: null, despeckle: true });
    // Ink stays opaque on both the bright and the shadowed side.
    expect(alphaAt(data, 240, 40, 60)).toBeGreaterThan(240);
    expect(alphaAt(data, 240, 205, 60)).toBeGreaterThan(240);
    // Paper is gone everywhere - including the shadowed right side, darker than the bright side's ink.
    expect(alphaAt(data, 240, 10, 100)).toBe(0);
    expect(alphaAt(data, 240, 230, 10)).toBe(0);
    // Dust specks are removed.
    expect(alphaAt(data, 240, 15, 15)).toBe(0);
    expect(alphaAt(data, 240, 200, 100)).toBe(0);
    expect(bounds).not.toBeNull();
    expect(bounds!.left).toBeGreaterThanOrEqual(28);
    expect(bounds!.right).toBeLessThanOrEqual(212);
    expect(bounds!.top).toBeGreaterThanOrEqual(54);
    expect(bounds!.bottom).toBeLessThanOrEqual(65);
  });

  it("recolours ink when asked", () => {
    const a = analyze(photo());
    const { data } = lift(a, { strength: 0.5, color: "#1d4ed8", despeckle: true });
    const o = (60 * 240 + 100) * 4;
    expect([data[o], data[o + 1], data[o + 2]]).toEqual([0x1d, 0x4e, 0xd8]);
  });

  it("leaves an already-transparent PNG's alpha as it is", () => {
    const w = 20;
    const h = 10;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) d[i * 4 + 3] = i % 3 === 0 ? 255 : 0;
    const a = analyze({ width: w, height: h, data: d, colorSpace: "srgb" } as ImageData);
    expect(a.alreadyTransparent).toBe(true);
    const { data } = lift(a, { strength: 0.5, color: "#000000", despeckle: true });
    expect(data[3]).toBe(255);
    expect(data[7]).toBe(0);
  });
});

describe("signature ink", () => {
  const line = (pen: boolean, dtMs: number): InkStroke => ({
    pen,
    points: Array.from({ length: 40 }, (_, i) => ({ x: i * 4, y: 50, t: i * dtMs, p: 0.5 })),
  });

  it("swells on slow strokes and thins on fast ones (mouse)", () => {
    const mid = (s: ReturnType<typeof strokeSamples>) => s[Math.floor(s.length / 2)].r;
    const slow = mid(strokeSamples(line(false, 40), 4));
    const fast = mid(strokeSamples(line(false, 2), 4));
    expect(slow).toBeGreaterThan(fast * 1.3);
  });

  it("tapers both ends of a finished stroke", () => {
    const s = strokeSamples(line(false, 16), 4);
    const mid = s[Math.floor(s.length / 2)].r;
    expect(s[0].r).toBeLessThan(mid * 0.6);
    expect(s[s.length - 1].r).toBeLessThan(mid * 0.6);
  });

  it("outlines a stroke as one closed shape around its centre line", () => {
    const outline = strokeOutline(strokeSamples(line(true, 16), 4));
    const ys = outline.map((p) => p[1]);
    expect(Math.min(...ys)).toBeLessThan(50);
    expect(Math.max(...ys)).toBeGreaterThan(50);
    expect(outline.length).toBeGreaterThan(40);
  });
});
