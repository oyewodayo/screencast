// The editor-drawn pointer: parsing, smoothing (no lag, clicks pinned), the state at a moment, and
// the export's sprite tracks (sampling grid, sub-pixel phases, reuse) - the painting itself needs a
// canvas and is checked in the app.
import { describe, expect, it, vi } from "vitest";

vi.mock("./spriteTrack", async (importOriginal) => {
  const real = await importOriginal<typeof import("./spriteTrack")>();
  // A sprite "picture" that just names what it was asked to paint.
  return { ...real, encodeSprite: (w: number, h: number) => `sprite ${w}x${h}` };
});

import { DEFAULT_POINTER_STYLE, IDLE_DELAY, POINTER_GRID, RIPPLE_SECONDS, parsePointerSidecar, pointerExportLayers, pointerStateAt, preparePointerPath, type PointerRecording } from "./pointerTrack";

async function recording(extra: Record<string, unknown> = {}): Promise<PointerRecording> {
  const rec = await parsePointerSidecar(JSON.stringify({ version: 1, width: 1000, height: 500, ...extra }));
  if (!rec) throw new Error("didn't parse");
  return rec;
}

// A pointer moving right at `speed` px/s from x=100 for `seconds`, sampled at 240 Hz.
const steady = (seconds: number, speed: number, from = 0): number[] => {
  const flat: number[] = [];
  for (let i = 0; i <= seconds * 240; i++) flat.push(from + i / 240, 100 + (speed * i) / 240, 200);
  return flat;
};

describe("parsing", () => {
  it("rejects what isn't a pointer sidecar, sorts the rest", async () => {
    expect(await parsePointerSidecar("nope")).toBeNull();
    expect(await parsePointerSidecar(JSON.stringify({ width: 0, height: 10 }))).toBeNull();
    const rec = await recording({ moves: [2, 30, 40, 1, 10, 20], clicks: [[3, 1, 1, 0], [1, 2, 2, 1]], keys: [[1, ["Ctrl", "C"]], [0.5, []]] });
    expect(Array.from(rec.t)).toEqual([1, 2]);
    expect(Array.from(rec.x)).toEqual([10, 30]);
    expect(rec.clicks.map((c) => c.t)).toEqual([1, 3]);
    expect(rec.keys).toEqual([{ t: 1, keys: ["Ctrl", "C"] }]);
  });
});

describe("the path", () => {
  it("holds the recorded position between movements when not smoothed", async () => {
    const rec = await recording({ moves: [0, 10, 10, 1, 50, 60] });
    const path = preparePointerPath(rec, 0);
    const at = (s: number) => pointerStateAt(rec, path, { ...DEFAULT_POINTER_STYLE, smoothing: 0 }, s);
    expect(at(0.5)).toMatchObject({ x: 10, y: 10 });
    // Linear between the 240 Hz path points: still until the last 1/240 s before the movement.
    expect(at(1 - 1 / 240).x).toBe(10);
    expect(at(1).x).toBe(50);
    expect(at(1.2)).toMatchObject({ x: 50, y: 60 });
  });

  it("smooths without lag: a steady glide stays where the pointer was", async () => {
    const rec = await recording({ moves: steady(4, 300) });
    const path = preparePointerPath(rec, 1);
    // Away from the ends, a straight steady line is its own Gaussian average.
    for (const s of [1, 2, 2.5, 3]) expect(pointerStateAt(rec, path, DEFAULT_POINTER_STYLE, s).x).toBeCloseTo(100 + 300 * s, 0);
  });

  it("rounds off a jump, and puts every click exactly where it was clicked", async () => {
    // Rests at 100, jumps to 500 at t=1, clicks there at t=1.02, rests.
    const rec = await recording({ moves: [0, 100, 100, 1, 500, 100, 3, 500, 100], clicks: [[1.02, 500, 100, 0]] });
    const path = preparePointerPath(rec, 1);
    const at = (s: number) => pointerStateAt(rec, path, DEFAULT_POINTER_STYLE, s).x;
    // Smoothed: half way across around the jump instead of teleporting...
    expect(at(0.95)).toBeGreaterThan(100);
    expect(at(0.95)).toBeLessThan(500);
    // ...but on the click itself, on the target.
    expect(at(1.02)).toBeCloseTo(500, 0);
  });
});

describe("the state at a moment", () => {
  it("takes each look from when it was set, hidden as -1, and plays ripples", async () => {
    const rec = await recording({ moves: [0, 10, 10], shapes: [[0, -1], [1, 5]], clicks: [[2, 30, 40, 1]] });
    const path = preparePointerPath(rec, 0);
    const st = (s: number) => pointerStateAt(rec, path, DEFAULT_POINTER_STYLE, s);
    expect(st(0.5).cursorId).toBe(-1);
    // Cursor 5 has no bitmap in this recording: the built-in arrow (null).
    expect(st(1.5).cursorId).toBeNull();
    expect(st(1.99).ripple).toBeNull();
    expect(st(2.1).ripple).toMatchObject({ x: 30, y: 40, button: 1 });
    expect(st(2.1).ripple!.age).toBeCloseTo(0.1, 9);
    expect(st(2 + RIPPLE_SECONDS + 0.01).ripple).toBeNull();
    expect(pointerStateAt(rec, path, { ...DEFAULT_POINTER_STYLE, ripples: false }, 2.1).ripple).toBeNull();
  });

  it("fades out a resting pointer and back in when it moves", async () => {
    const rec = await recording({ moves: [0, 10, 10, 0.1, 12, 10, 6, 20, 10, 6.1, 22, 10] });
    const path = preparePointerPath(rec, 0);
    const op = (s: number) => pointerStateAt(rec, path, { ...DEFAULT_POINTER_STYLE, hideIdle: true }, s).opacity;
    expect(op(0.5)).toBe(1);
    expect(op(0.1 + IDLE_DELAY + 1)).toBe(0);
    // Moving again: fading in, then fully back.
    expect(op(6.05)).toBeGreaterThan(0);
    expect(op(6.05)).toBeLessThan(1);
    expect(op(6.3)).toBe(1);
    expect(pointerStateAt(rec, path, DEFAULT_POINTER_STYLE, 4).opacity).toBe(1);
  });
});

describe("export layers", () => {
  it("samples on cells centred on the source's frames, in half-pixel phases on even pixels", async () => {
    // 2x2 video pixels per capture pixel: a 1000 px-wide capture in a 2000 px-wide video.
    const rec = await recording({ moves: steady(2, 30) });
    const style = { ...DEFAULT_POINTER_STYLE, smoothing: 0, ripples: false, size: 1 };
    const [cursor] = pointerExportLayers(rec, style, { start: 0.5, end: 1, mirrored: false }, 2000);
    expect(cursor.width % 2).toBe(0);
    expect(cursor.height % 2).toBe(0);
    // Every run starts half a cell before a k/60 moment (times travel rounded to microseconds) and
    // lands on even pixels.
    for (const [at, sprite, x, y] of cursor.runs) {
      const k = at * POINTER_GRID + 0.5;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-3);
      expect(sprite).toBeGreaterThanOrEqual(0);
      expect(x % 2).toBe(0);
      expect(y % 2).toBe(0);
    }
    // It covers the clip's first frame (0.5 s = cell 30).
    expect(cursor.runs[0][0]).toBeLessThanOrEqual((30 - 0.5) / 60);
    // 30 capture px/s = 1 video px per frame: two phases per even step, reused - not a sprite per frame.
    expect(cursor.sprites.length).toBeLessThanOrEqual(4);
    expect(cursor.runs.length).toBeGreaterThan(25);
  });

  it("adds a ripple track under the pointer, and nothing when the pointer is off", async () => {
    const rec = await recording({ moves: steady(2, 0), clicks: [[1, 100, 200, 0]] });
    const layers = pointerExportLayers(rec, DEFAULT_POINTER_STYLE, { start: 0, end: 2, mirrored: false }, 1000);
    expect(layers).toHaveLength(2);
    const [ripple] = layers;
    expect(ripple.sprites.length).toBe(Math.ceil(RIPPLE_SECONDS * POINTER_GRID));
    const shown = ripple.runs.filter((r) => r[1] >= 0);
    expect(shown[0][0]).toBeCloseTo((60 - 0.5) / 60, 5);
    expect(shown[0][1]).toBe(0);
    expect(pointerExportLayers(rec, { ...DEFAULT_POINTER_STYLE, show: false }, { start: 0, end: 2, mirrored: false }, 1000)).toEqual([]);
  });
});
