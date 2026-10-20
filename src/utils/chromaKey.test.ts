import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { despill, guessKeyColor, keyAlpha, keyUV, pixelUV, spillType, type ChromaKey } from "./chromaKey";

// A synthetic green-screen shot: a noisy, unevenly lit screen with a subject in the middle whose
// edge is soft, and a green cast on the subject near its edge.
function scene(W: number, H: number): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const light = 0.7 + 0.3 * (x / W); // a shadow across the screen
      const screen = [20 * light + 6 * rnd(), 175 * light + 8 * rnd(), 70 * light + 6 * rnd()];
      const d = Math.hypot(x - W / 2, y - H / 2) / (W / 4);
      const t = Math.max(0, Math.min(1, (1.2 - d) / 0.4)); // subject coverage
      const subject = [200 + 20 * rnd(), 150 + 40 * (1 - t) + 10 * rnd(), 120 + 10 * rnd()];
      const i = (y * W + x) * 3;
      for (let c = 0; c < 3; c++) px[i + c] = Math.max(0, Math.min(255, Math.round(screen[c] * (1 - t) + subject[c] * t)));
    }
  }
  return px;
}

describe("chroma key", () => {
  it("computes the key colour's chroma as ffmpeg does", () => {
    // Pure green in JPEG YUV: U = -0.33126*255 + 128 = 43.5, V = -0.41869*255 + 128 = 21.2.
    expect(keyUV("#00ff00")).toEqual([44, 21]);
    expect(keyUV("#808080")).toEqual([128, 128]);
    expect(pixelUV(0, 255, 0)).toEqual([44, 21]);
  });

  it("keys the screen and keeps the subject", () => {
    const key = keyUV("#00b140");
    const k = { similarity: 0.12, blend: 0.08 };
    const green = pixelUV(0, 177, 64);
    expect(keyAlpha(Array(9).fill(green), key, k)).toBe(0);
    const skin = pixelUV(210, 160, 130);
    expect(keyAlpha(Array(9).fill(skin), key, k)).toBe(1);
  });

  it("pulls the screen's cast out of the subject", () => {
    expect(spillType("#00b140")).toBe("green");
    expect(spillType("#1040d0")).toBe("blue");
    const [r, g, b] = despill(200, 220, 120, 1, "green");
    expect([r, b]).toEqual([200, 120]);
    expect(g).toBeCloseTo(160, 6); // down to the average of red and blue
    expect(despill(200, 150, 120, 1, "green")[1]).toBeCloseTo(150, 6); // nothing sticking out: untouched
  });

  it("guesses the key from the frame's border", () => {
    const W = 48;
    const H = 32;
    const rgb = scene(W, H);
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], 255], 4 * i);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(guessKeyColor(rgba, W, H).slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(110);
    expect(r).toBeLessThan(40);
    expect(b).toBeLessThan(80);
  });

  // The export's chain (chroma_key_filters, conversion.rs) on the same picture: alpha and colour
  // must match what this model - and so the preview shader - computes. Needs the bundled ffmpeg.
  const ffmpeg = join(__dirname, "../../src-tauri/binaries/ffmpeg/ffmpeg.exe");
  it.skipIf(!existsSync(ffmpeg))("matches ffmpeg's chromakey + despill", () => {
    const W = 96;
    const H = 64;
    const k: ChromaKey = { color: "#18a848", similarity: 0.1, blend: 0.12, spill: 0.7 };
    const dir = mkdtempSync(join(tmpdir(), "briefcast-key-"));
    try {
      const rgb = scene(W, H);
      writeFileSync(join(dir, "in.rgb"), rgb);
      const chain = [
        "scale=out_color_matrix=bt601:out_range=pc,format=yuv444p",
        `chromakey=color=0x${k.color.slice(1)}:similarity=${k.similarity}:blend=${k.blend}`,
        "scale=in_color_matrix=bt601:in_range=pc,format=rgba",
        `despill=type=green:mix=0.5:expand=0:red=0:green=${-k.spill}:blue=0:brightness=0:alpha=0`,
      ].join(",");
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-i", join(dir, "in.rgb"), "-vf", chain, "-f", "rawvideo", "-pix_fmt", "rgba", join(dir, "out.rgba")]);
      const out = readFileSync(join(dir, "out.rgba"));
      const key = keyUV(k.color);
      const uv = (x: number, y: number) => {
        const cx = Math.max(0, Math.min(W - 1, x));
        const cy = Math.max(0, Math.min(H - 1, y));
        const i = (cy * W + cx) * 3;
        return pixelUV(rgb[i], rgb[i + 1], rgb[i + 2]);
      };
      let alphaErr = 0;
      let colourErr = 0;
      let partial = 0;
      // Away from the frame's own border, where chromakey reads stale neighbours.
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const hood: [number, number][] = [];
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) hood.push(uv(x + i, y + j));
          const a = keyAlpha(hood, key, k) * 255;
          const o = (y * W + x) * 4;
          alphaErr = Math.max(alphaErr, Math.abs(a - out[o + 3]));
          if (a > 1 && a < 254) partial++;
          const s = (y * W + x) * 3;
          const [r, g, b] = despill(rgb[s], rgb[s + 1], rgb[s + 2], k.spill, "green");
          colourErr = Math.max(colourErr, Math.abs(r - out[o]), Math.abs(g - out[o + 1]), Math.abs(b - out[o + 2]));
        }
      }
      expect(partial).toBeGreaterThan(50); // the soft edge was really exercised
      // Rounding in the YUV round trip moves chroma by a level at most: measured 2.3 alpha levels
      // on the soft edge.
      expect(alphaErr).toBeLessThanOrEqual(4);
      expect(colourErr).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
