import { describe, expect, it } from "vitest";
import { SPLIT_LAYOUTS, splitCells } from "./splitLayouts";

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
});
