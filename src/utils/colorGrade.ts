// utils/colorGrade.ts
//
// Color grading for a clip: manual corrections (exposure, contrast, saturation, temperature, tint,
// highlights, shadows) plus an optional imported .cube LUT - all BAKED into one 3D lookup table.
// That single table is what keeps preview and export identical: the preview's WebGL layer
// (VideoPlayer's grade canvas) samples it as a 3D texture, and export hands the very same table to
// ffmpeg's `lut3d` filter as a .cube file. Same numbers, same trilinear interpolation, so what you
// grade is exactly what you get - unlike the older color presets, whose CSS-filter preview only
// approximates their ffmpeg `eq` export.
//
// Pure functions only; values are 0..1 RGB as decoded (gamma-encoded), which is also what lut3d
// operates on.
import type { ClipGrade } from "./videoEditTypes";
import { applyLook } from "./gradeLooks";

export interface Lut3D {
  size: number;
  // size^3 RGB triplets, red changing fastest (the .cube file order).
  data: Float32Array;
}

// Grid size of a baked LUT. 33 is the industry-standard resolution for grading LUTs: smooth enough
// that trilinear interpolation is invisible, small enough to rebuild on every slider move.
export const BAKED_LUT_SIZE = 33;

export const GRADE_SLIDERS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const;
export type GradeSlider = (typeof GRADE_SLIDERS)[number];

export const hasGrade = (grade: ClipGrade | undefined): grade is ClipGrade =>
  !!grade &&
  (GRADE_SLIDERS.some((k) => Math.abs(grade[k] ?? 0) > 1e-4) || (!!grade.lut && grade.lut.intensity > 0) || (!!grade.look && grade.look.intensity > 0));

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toLinear = (c: number) => Math.pow(c, 2.2);
const toGamma = (c: number) => Math.pow(Math.max(0, c), 1 / 2.2);

// Trilinear lookup into a LUT - the same interpolation lut3d's default (`interp=trilinear`) and
// WebGL's LINEAR-filtered 3D texture both use.
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1;
  const fr = clamp01(r) * n;
  const fg = clamp01(g) * n;
  const fb = clamp01(b) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const at = (ri: number, gi: number, bi: number, ch: number) => lut.data[((bi * lut.size + gi) * lut.size + ri) * 3 + ch];
  const out: [number, number, number] = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const c00 = at(r0, g0, b0, ch) * (1 - dr) + at(r1, g0, b0, ch) * dr;
    const c10 = at(r0, g1, b0, ch) * (1 - dr) + at(r1, g1, b0, ch) * dr;
    const c01 = at(r0, g0, b1, ch) * (1 - dr) + at(r1, g0, b1, ch) * dr;
    const c11 = at(r0, g1, b1, ch) * (1 - dr) + at(r1, g1, b1, ch) * dr;
    out[ch] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

// One pixel through the grade. Order mirrors a grading suite: the imported LUT first (typically a
// log -> Rec.709 conversion, which must see the camera's original values), then exposure and white
// balance in linear light, then contrast, tone (shadows/highlights) and saturation.
export function gradePixel(r: number, g: number, b: number, grade: ClipGrade, userLut: Lut3D | null): [number, number, number] {
  if (userLut && grade.lut && grade.lut.intensity > 0) {
    const [lr, lg, lb] = sampleLut(userLut, r, g, b);
    const k = clamp01(grade.lut.intensity);
    r += (lr - r) * k;
    g += (lg - g) * k;
    b += (lb - b) * k;
  }

  // Exposure (stops) and white balance, in linear light so they behave like a camera's.
  let lr = toLinear(clamp01(r)), lg = toLinear(clamp01(g)), lb = toLinear(clamp01(b));
  const gain = Math.pow(2, grade.exposure ?? 0);
  const temperature = grade.temperature ?? 0; // + warmer, - cooler
  const tint = grade.tint ?? 0; // + magenta, - green
  lr *= gain * (1 + 0.18 * temperature) * (1 + 0.06 * tint);
  lg *= gain * (1 - 0.12 * tint);
  lb *= gain * (1 - 0.18 * temperature) * (1 + 0.06 * tint);
  r = toGamma(lr);
  g = toGamma(lg);
  b = toGamma(lb);

  // Contrast around mid-grey.
  const contrast = 1 + (grade.contrast ?? 0);
  r = (r - 0.5) * contrast + 0.5;
  g = (g - 0.5) * contrast + 0.5;
  b = (b - 0.5) * contrast + 0.5;

  // Shadows/highlights lift or pull the dark and bright ends, leaving the middle mostly alone.
  const luma = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const tone = 0.35 * (grade.shadows ?? 0) * (1 - luma) * (1 - luma) + 0.35 * (grade.highlights ?? 0) * luma * luma;
  r += tone;
  g += tone;
  b += tone;

  // Saturation around each pixel's own luma.
  const sat = 1 + (grade.saturation ?? 0);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = y + (r - y) * sat;
  g = y + (g - y) * sat;
  b = y + (b - y) * sat;

  // The creative look last, over the corrected picture.
  if (grade.look && grade.look.intensity > 0) return applyLook(grade.look.name, clamp01(grade.look.intensity), clamp01(r), clamp01(g), clamp01(b));

  return [clamp01(r), clamp01(g), clamp01(b)];
}

// The whole grade as one table - evaluated once per grid point.
export function bakeGradeLut(grade: ClipGrade, userLut: Lut3D | null, size = BAKED_LUT_SIZE): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  const n = size - 1;
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = gradePixel(ri / n, gi / n, bi / n, grade, userLut);
        data[i++] = r;
        data[i++] = g;
        data[i++] = b;
      }
    }
  }
  return { size, data };
}

// Parses a .cube file (Adobe/Resolve 3D LUT format). DOMAIN_MIN/MAX other than 0..1 are
// normalized away; 1D LUTs aren't supported (rare for grading, and not what "import a LUT" means).
export function parseCubeLut(text: string): Lut3D {
  let size = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) continue;
    if (upper.startsWith("LUT_1D_SIZE")) throw new Error("This is a 1D LUT - only 3D LUTs (.cube with LUT_3D_SIZE) can be used for grading.");
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      domainMin = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      domainMax = line.split(/\s+/).slice(1, 4).map(Number);
      continue;
    }
    if (/^[A-Z_]/.test(upper)) continue; // other keywords (LUT_IN_VIDEO_RANGE, ...)
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || size < 2 || size > 256) throw new Error("Not a valid 3D LUT file (missing or unusable LUT_3D_SIZE).");
  if (values.length !== size * size * size * 3) throw new Error(`The LUT file is incomplete: expected ${size ** 3} entries, found ${values.length / 3}.`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const ch = i % 3;
    data[i] = clamp01((values[i] - domainMin[ch]) / Math.max(1e-6, domainMax[ch] - domainMin[ch]));
  }
  return { size, data };
}

// A LUT as .cube text - what export writes for ffmpeg's lut3d.
export function lutToCube(lut: Lut3D, title = "Briefcast grade"): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`, "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  }
  return lines.join("\n") + "\n";
}

// Identity check helper for tests and for skipping no-op grades.
export function identityLut(size: number): Lut3D {
  return bakeGradeLut({}, null, size);
}
