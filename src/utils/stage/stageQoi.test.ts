import { describe, expect, it } from "vitest";
import { qoiFromPremultiplied } from "./stageQoi";

// The reference QOI decoder (qoiformat.org), straight from the spec.
function decode(q: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const v = new DataView(q.buffer, q.byteOffset);
  const width = v.getUint32(4);
  const height = v.getUint32(8);
  const out = new Uint8Array(width * height * 4);
  const index = Array.from({ length: 64 }, () => [0, 0, 0, 0]);
  let px = [0, 0, 0, 255];
  let p = 14;
  let run = 0;
  for (let i = 0; i < out.length; i += 4) {
    if (run > 0) run--;
    else {
      const b = q[p++];
      if (b === 0xfe) px = [q[p++], q[p++], q[p++], px[3]];
      else if (b === 0xff) px = [q[p++], q[p++], q[p++], q[p++]];
      else if (b >> 6 === 0) px = index[b].slice();
      else if (b >> 6 === 1) px = [(px[0] + ((b >> 4) & 3) - 2) & 255, (px[1] + ((b >> 2) & 3) - 2) & 255, (px[2] + (b & 3) - 2) & 255, px[3]];
      else if (b >> 6 === 2) {
        const b2 = q[p++];
        const vg = (b & 63) - 32;
        px = [(px[0] + vg - 8 + ((b2 >> 4) & 15)) & 255, (px[1] + vg) & 255, (px[2] + vg - 8 + (b2 & 15)) & 255, px[3]];
      } else run = b & 63;
      index[(px[0] * 3 + px[1] * 5 + px[2] * 7 + px[3] * 11) % 64] = px.slice();
    }
    out.set(px, i);
  }
  return { width, height, pixels: out };
}

describe("export frames as QOI", () => {
  it("round-trips a frame exactly - flipped top first, straight alpha", () => {
    const w = 37, h = 23;
    const src = new Uint8Array(w * h * 4);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    for (let i = 0; i < w * h; i++) {
      // Flat runs, small steps, big jumps and soft premultiplied edges, all mixed.
      const kind = i % 11;
      const a = kind < 6 ? 255 : kind < 8 ? 0 : rnd() | 1;
      const base = kind < 3 ? 200 : rnd();
      const c = [base, (base + kind) & 255, (base * 3) & 255].map((x) => Math.round((x * a) / 255));
      src.set([c[0], c[1], c[2], a], i * 4);
    }
    const q = qoiFromPremultiplied(src, w, h);
    const { width, height, pixels } = decode(q);
    expect([width, height]).toEqual([w, h]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4;
        const a = src[s + 3];
        const want = a === 0 ? [0, 0, 0, 0] : a === 255 ? [src[s], src[s + 1], src[s + 2], 255] : [0, 1, 2].map((k) => Math.min(255, Math.floor((src[s + k] * 255 + (a >> 1)) / a))).concat(a);
        expect(Array.from(pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 4))).toEqual(want);
      }
    }
  });

  it("makes a flat 1080p frame tiny", () => {
    const src = new Uint8Array(1920 * 1080 * 4).fill(255);
    expect(qoiFromPremultiplied(src, 1920, 1080).length).toBeLessThan(40_000);
  });
});
