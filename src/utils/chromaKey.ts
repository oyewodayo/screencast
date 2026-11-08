// utils/chromaKey.ts
//
// Green/blue-screen keying for video-track layers (PipOverlay.chromaKey).
//
// Export keys with ffmpeg (chroma_key_filters, conversion.rs): the layer is turned into full-range
// BT.601 YUV 4:4:4, `chromakey` makes each pixel's alpha from how far the chroma (U,V) of it and its
// 3x3 neighbours sits from the key colour's, then `despill` pulls the screen's colour cast out of
// what's left. The preview runs the very same maths per pixel in a WebGL shader (ChromaKeyCanvas.tsx)
// - this module is that maths in plain TS, which the shader mirrors line for line and the tests check
// against ffmpeg itself (chromaKey.test.ts).
//
// Keying works on chroma only (not brightness), so a shadow on the screen keys as well as its lit
// part - the reason it's chosen over an RGB-distance key.
export interface ChromaKey {
  // The screen's colour, "#rrggbb".
  color: string;
  // How far from the key colour still counts as screen (ffmpeg chromakey `similarity`, 0.01..1).
  similarity: number;
  // Soft edge: the distance past `similarity` over which a pixel goes from clear to solid (`blend`).
  blend: number;
  // How much of the screen's colour cast to remove from the subject, 0..1 (0 = none).
  spill: number;
}

export const DEFAULT_CHROMA_KEY: ChromaKey = { color: "#00b140", similarity: 0.12, blend: 0.08, spill: 0.6 };

export function parseHex(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  const n = m ? parseInt(m[1], 16) : 0x00ff00;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The key colour's chroma, exactly as vf_chromakey.c computes it (fixed point, JPEG coefficients).
export function keyUV(color: string): [number, number] {
  const [r, g, b] = parseHex(color);
  const fix = (x: number) => Math.round(x * 1024);
  const u = ((-fix(0.16874) * r - fix(0.33126) * g + fix(0.5) * b + 511) >> 10) + 128;
  const v = ((fix(0.5) * r - fix(0.41869) * g - fix(0.08131) * b + 511) >> 10) + 128;
  return [u, v];
}

// A pixel's chroma in full-range BT.601 (what swscale's RGB -> yuv444p conversion with
// out_color_matrix=bt601, out_range=pc gives), 0..255.
export function pixelUV(r: number, g: number, b: number): [number, number] {
  const u = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
  const v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return [clamp(u), clamp(v)];
}

// Alpha (0..1) for a pixel from its 3x3 neighbourhood's chroma - do_chromakey_pixel.
export function keyAlpha(neighbourhood: [number, number][], key: [number, number], k: Pick<ChromaKey, "similarity" | "blend">): number {
  let diff = 0;
  for (const [u, v] of neighbourhood) {
    const du = u - key[0];
    const dv = v - key[1];
    diff += Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
  }
  diff /= neighbourhood.length;
  const { similarity, blend } = clampKey(k);
  if (blend > 0.0001) return Math.max(0, Math.min(1, (diff - similarity) / blend));
  return diff > similarity ? 1 : 0;
}

// Green screen or blue screen - whichever the key colour leans to (despill's `type`).
export const spillType = (color: string): "green" | "blue" => {
  const [, g, b] = parseHex(color);
  return b > g ? "blue" : "green";
};

// despill with mix 0.5, expand 0 and the screen channel's scale at -spill: the screen channel is
// pulled down toward the average of the other two, by `spill` of how far it sticks out above it.
// Channels 0..255 in and out (ffmpeg rounds to 8 bits after).
export function despill(r: number, g: number, b: number, spill: number, type: "green" | "blue"): [number, number, number] {
  const s = Math.max(0, Math.min(1, spill));
  if (s <= 0) return [r, g, b];
  const [R, G, B] = [r / 255, g / 255, b / 255];
  if (type === "green") {
    const map = Math.max(G - (R * 0.5 + B * 0.5), 0);
    return [r, Math.max(G - map * s, 0) * 255, b];
  }
  const map = Math.max(B - (R * 0.5 + G * 0.5), 0);
  return [r, g, Math.max(B - map * s, 0) * 255];
}

export function clampKey<T extends Partial<ChromaKey>>(k: T): T & { similarity: number; blend: number; spill: number } {
  return {
    ...k,
    similarity: Math.max(0.01, Math.min(1, k.similarity ?? DEFAULT_CHROMA_KEY.similarity)),
    blend: Math.max(0, Math.min(1, k.blend ?? DEFAULT_CHROMA_KEY.blend)),
    spill: Math.max(0, Math.min(1, k.spill ?? 0)),
  };
}

// What export_trimmed_video takes for a keyed layer.
export function chromaKeyForExport(k: ChromaKey | undefined): ChromaKey | null {
  if (!k) return null;
  const c = clampKey(k);
  const [r, g, b] = parseHex(k.color);
  return { color: `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, similarity: c.similarity, blend: c.blend, spill: c.spill };
}

// A good key colour for a frame: the median of its border pixels (a green screen fills the edges
// of the shot; the subject is in the middle). `rgba` is ImageData-style.
export function guessKeyColor(rgba: Uint8ClampedArray, width: number, height: number): string {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    rs.push(rgba[i]);
    gs.push(rgba[i + 1]);
    bs.push(rgba[i + 2]);
  };
  const step = Math.max(1, Math.floor(Math.min(width, height) / 40));
  for (let x = 0; x < width; x += step) {
    take(x, 0);
    take(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    take(0, y);
    take(width - 1, y);
  }
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1] ?? 0;
  return `#${[median(rs), median(gs), median(bs)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
