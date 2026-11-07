import { describe, expect, it } from "vitest";
import { SPLIT_LAYOUTS, cardCell, coverWindow, featherMask, framingCrop, snapRatio, splitCells } from "./splitLayouts";

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 1e-9 && b.x < a.x + a.width - 1e-9 && a.y < b.y + b.height - 1e-9 && b.y < a.y + a.height - 1e-9;

describe("splitCells", () => {
  for (const aspect of [16 / 9, 9 / 16, 1]) {
    for (const layout of SPLIT_LAYOUTS) {
      it(`${layout.id} at aspect ${aspect.toFixed(2)}: right count, inside the frame, no overlaps`, () => {
        const cells = splitCells(layout.id, aspect, 0.02);
        expect(cells).toHaveLength(layout.cells);
        for (const c of cells) {
          expect(c.x).toBeGreaterThanOrEqual(0);
          expect(c.y).toBeGreaterThanOrEqual(0);
          expect(c.x + c.width).toBeLessThanOrEqual(1 + 1e-9);
          expect(c.y + c.height).toBeLessThanOrEqual(1 + 1e-9);
          expect(c.width).toBeGreaterThan(0);
          expect(c.height).toBeGreaterThan(0);
        }
        for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(overlaps(cells[i], cells[j])).toBe(false);
      });
    }
  }

  it("keeps gaps the same width in pixels both ways", () => {
    const W = 1080;
    const H = 1920;
    const [a, b] = splitCells("rows2", W / H, 0.02);
    const verticalGapPx = (b.y - (a.y + a.height)) * H;
    const sideGapPx = a.x * W;
    expect(verticalGapPx).toBeCloseTo(sideGapPx);
  });

  it("fills the frame edge to edge with no gap", () => {
    const cells = splitCells("grid4", 16 / 9, 0);
    const area = cells.reduce((sum, c) => sum + c.width * c.height, 0);
    expect(area).toBeCloseTo(1);
  });

  it("moves the divider with the ratio and keeps the gap", () => {
    const [top, bottom] = splitCells("rows2", 9 / 16, 0.02, 0.4);
    const room = top.height + bottom.height;
    expect(top.height / room).toBeCloseTo(0.4);
    expect(bottom.y + bottom.height).toBeCloseTo(1 - top.y);
  });
});

describe("framing", () => {
  it("snaps the divider to thirds and half, and keeps it off the edges", () => {
    expect(snapRatio(0.34)).toBeCloseTo(1 / 3);
    expect(snapRatio(0.51)).toBe(0.5);
    expect(snapRatio(0.42)).toBe(0.42);
    expect(snapRatio(0.02)).toBe(0.2);
  });

  it("crops a wide shot to a short wide cell's own shape", () => {
    // A 16:9 speaker in the bottom 60% of a 9:16 frame: cell is 9/(16*0.6) wide.
    const cellAspect = (1 / 0.6) * (9 / 16);
    const crop = framingCrop(16 / 9, cellAspect, { cx: 0.5, cy: 0.5, zoom: 1 });
    expect(crop.height).toBe(1);
    expect(((crop.width * 16) / (crop.height * 9))).toBeCloseTo(cellAspect);
  });

  it("follows the subject, but never past the shot's edge", () => {
    const left = framingCrop(16 / 9, 1, { cx: 0, cy: 0.5, zoom: 1 });
    expect(left.x).toBe(0);
    const right = framingCrop(16 / 9, 1, { cx: 0.7, cy: 0.5, zoom: 1 });
    expect(right.x + right.width / 2).toBeCloseTo(0.7);
    const zoomed = framingCrop(16 / 9, 1, { cx: 0.5, cy: 0.5, zoom: 2 });
    expect(zoomed.width).toBeCloseTo(coverWindow(16 / 9, 1).w / 2);
  });

  it("keeps a card inside the frame in its shot's shape", () => {
    const card = cardCell(9 / 16, 16 / 9, 0.7, { x: 0.95, y: 0 });
    expect(card.x + card.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(card.y).toBe(0);
    expect((card.width * (9 / 16)) / card.height).toBeCloseTo(16 / 9);
  });

  it("insets a card's soft edge equally in pixels", () => {
    const m = featherMask(1600, 900, 0.06);
    expect(m.x * 1600).toBeCloseTo(m.y * 900);
  });
});
