// Covers utils/colorGrade.ts - the baked grading LUT shared by preview (WebGL) and export (lut3d).
import { describe, expect, it } from "vitest";
import { bakeGradeLut, gradePixel, hasGrade, identityLut, lutToCube, parseCubeLut, sampleLut } from "./colorGrade";

describe("gradePixel", () => {
  it("leaves pixels untouched with no grade", () => {
    const [r, g, b] = gradePixel(0.2, 0.5, 0.8, {}, null);
    expect(r).toBeCloseTo(0.2);
    expect(g).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.8);
  });

  it("brightens with exposure, and +1 stop doubles linear light", () => {
    const [r] = gradePixel(0.5, 0.5, 0.5, { exposure: 1 }, null);
    expect(Math.pow(r, 2.2)).toBeCloseTo(2 * Math.pow(0.5, 2.2));
  });

  it("warms with temperature and desaturates to grey", () => {
    const [r, , b] = gradePixel(0.5, 0.5, 0.5, { temperature: 1 }, null);
    expect(r).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.5);
    const [gr, gg, gb] = gradePixel(0.9, 0.2, 0.1, { saturation: -1 }, null);
    expect(gr).toBeCloseTo(gg);
    expect(gg).toBeCloseTo(gb);
  });

  it("lifts shadows more than highlights", () => {
    const dark = gradePixel(0.1, 0.1, 0.1, { shadows: 1 }, null)[0] - 0.1;
    const bright = gradePixel(0.9, 0.9, 0.9, { shadows: 1 }, null)[0] - 0.9;
    expect(dark).toBeGreaterThan(bright * 5);
  });

  it("applies an imported LUT by its intensity", () => {
    const invert = { size: 2, data: new Float32Array([1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0]) };
    expect(gradePixel(0.25, 0.25, 0.25, { lut: { path: "x", name: "x", intensity: 1 } }, invert)[0]).toBeCloseTo(0.75);
    expect(gradePixel(0.25, 0.25, 0.25, { lut: { path: "x", name: "x", intensity: 0.5 } }, invert)[0]).toBeCloseTo(0.5);
  });
});

describe("LUTs", () => {
  it("bakes an identity grade to an identity table that samples back exactly", () => {
    const lut = identityLut(17);
    const [r, g, b] = sampleLut(lut, 0.33, 0.66, 0.1);
    expect(r).toBeCloseTo(0.33, 4);
    expect(g).toBeCloseTo(0.66, 4);
    expect(b).toBeCloseTo(0.1, 4);
  });

  it("round-trips through .cube text with red changing fastest", () => {
    const lut = bakeGradeLut({ contrast: 0.4, saturation: 0.3 }, null, 5);
    const text = lutToCube(lut);
    expect(text).toContain("LUT_3D_SIZE 5");
    const parsed = parseCubeLut(text);
    expect(parsed.size).toBe(5);
    for (let i = 0; i < lut.data.length; i++) expect(parsed.data[i]).toBeCloseTo(lut.data[i], 5);
    // Second entry is (r=1/4, g=0, b=0) - red fastest.
    const second = text.split("\n")[5].split(" ").map(Number);
    expect(second[0]).toBeGreaterThan(second[1]);
  });

  it("normalizes DOMAIN_MAX and rejects broken files", () => {
    const cube = ["LUT_3D_SIZE 2", "DOMAIN_MAX 2 2 2", ...Array.from({ length: 8 }, () => "2 1 0")].join("\n");
    expect(parseCubeLut(cube).data.slice(0, 3)).toEqual(new Float32Array([1, 0.5, 0]));
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0")).toThrow(/incomplete/);
    expect(() => parseCubeLut("LUT_1D_SIZE 4")).toThrow(/1D/);
  });

  it("knows when a grade does nothing", () => {
    expect(hasGrade(undefined)).toBe(false);
    expect(hasGrade({ exposure: 0, saturation: 0 })).toBe(false);
    expect(hasGrade({ tint: 0.2 })).toBe(true);
    expect(hasGrade({ lut: { path: "a", name: "a", intensity: 0 } })).toBe(false);
  });
});
