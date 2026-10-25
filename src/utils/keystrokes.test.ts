// Shortcut chips on the output timeline: mapping through cuts and speed, repeats, take-overs and the
// appear/disappear animation; plus the sprite-run builder and the Screen Style's layout.
import { describe, expect, it } from "vitest";
import { buildKeyChips, chipAt, CHIP_APPEAR, CHIP_DISAPPEAR } from "./keystrokes";
import { runsFromCells } from "./spriteTrack";
import { DEFAULT_SCREEN_STYLE, screenContentRect } from "./screenStyle";
import type { Clip } from "./videoEditTypes";
import type { PointerRecording } from "./pointerTrack";

const rec = (keys: [number, string[]][]): PointerRecording =>
  ({ keys: keys.map(([t, k]) => ({ t, keys: k })) }) as unknown as PointerRecording;
const clip = (id: string, sourcePath: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath, start, end, ...extra });

describe("key chips", () => {
  it("follows the presses through cuts and speed changes", () => {
    const recordings = new Map([["a.mp4", rec([[1, ["Ctrl", "C"]], [5, ["Ctrl", "V"]], [9, ["Esc"]]])]]);
    // 0-4 s, then 8-10 s at double speed: Ctrl+V (at 5 s) is cut out.
    const chips = buildKeyChips([clip("1", "a.mp4", 0, 4), clip("2", "a.mp4", 8, 10, { speed: 2 })], recordings);
    expect(chips.map((c) => c.keys.join("+"))).toEqual(["Ctrl+C", "Esc"]);
    expect(chips[0].start).toBeCloseTo(1, 9);
    // 4 s of the first clip, then (9 - 8) / 2.
    expect(chips[1].start).toBeCloseTo(4.5, 9);
  });

  it("counts quick repeats as one chip and lets the next press take over", () => {
    const recordings = new Map([["a.mp4", rec([[1, ["Ctrl", "Z"]], [1.4, ["Ctrl", "Z"]], [1.8, ["Ctrl", "Z"]], [2.2, ["Ctrl", "S"]], [10, ["Enter"]]])]]);
    const chips = buildKeyChips([clip("1", "a.mp4", 0, 20)], recordings);
    expect(chips.map((c) => [c.keys.join("+"), c.count])).toEqual([["Ctrl+Z", 3], ["Ctrl+S", 1], ["Enter", 1]]);
    expect(chips[0].end).toBeCloseTo(2.2, 9);
    expect(chips[0].fadesOut).toBe(false);
    expect(chips[1].fadesOut).toBe(true);
    expect(chips[1].end).toBeGreaterThan(3);
  });

  it("pops in and fades out", () => {
    const [chip] = buildKeyChips([clip("1", "a.mp4", 0, 20)], new Map([["a.mp4", rec([[1, ["Ctrl", "K"]]])]]));
    expect(chipAt([chip], 0.99)).toBeNull();
    expect(chipAt([chip], 1)!.alpha).toBe(0);
    expect(chipAt([chip], 1 + CHIP_APPEAR)!.alpha).toBeCloseTo(1, 9);
    expect(chipAt([chip], 1.8)!.scale).toBeCloseTo(1, 9);
    expect(chipAt([chip], chip.end - CHIP_DISAPPEAR / 2)!.alpha).toBeCloseTo(0.5, 6);
    expect(chipAt([chip], chip.end)).toBeNull();
  });
});

describe("sprite runs", () => {
  it("merges repeats and keeps the position through gaps", () => {
    const cells = [null, { sprite: 0, x: 4, y: 6 }, { sprite: 0, x: 4, y: 6 }, null, { sprite: 1, x: 4, y: 6 }, { sprite: 1, x: 8, y: 6 }];
    expect(runsFromCells(cells, (i) => i / 10)).toEqual([
      [0, -1, 0, 0],
      [0.1, 0, 4, 6],
      [0.3, -1, 4, 6],
      [0.4, 1, 4, 6],
      [0.5, 1, 8, 6],
    ]);
  });
});

describe("screen layout", () => {
  it("keeps the frame's shape, padded on every side, on even pixels", () => {
    const r = screenContentRect(1920, 1080, { ...DEFAULT_SCREEN_STYLE, padding: 0.1, radius: 0.02 });
    expect([r.x, r.y, r.width, r.height].every((v) => v % 2 === 0)).toBe(true);
    expect(r.y).toBeGreaterThanOrEqual(108);
    expect(r.x).toBeGreaterThanOrEqual(108);
    expect(r.width / r.height).toBeCloseTo(1920 / 1080, 2);
    expect(r.x * 2 + r.width).toBeLessThanOrEqual(1920);
    expect(r.radius).toBeCloseTo(21.6, 6);
    // No padding: the whole frame.
    expect(screenContentRect(1920, 1080, { ...DEFAULT_SCREEN_STYLE, padding: 0 })).toMatchObject({ x: 0, y: 0, width: 1920, height: 1080 });
  });
});
