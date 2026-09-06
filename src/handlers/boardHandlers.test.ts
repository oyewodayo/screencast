// handlers/boardHandlers.test.ts
//
// Unit tests for the DOM-free pure functions in boardHandlers.ts - geometry, defensive-default
// resolvers, hit-testing, single/group transforms, a representative sample of the auto-layout
// algorithms (not all nine - they share the same commonFootprint/gap-guarding shape, so a few
// exercise that shape well without the file ballooning further), and command round-trips.
// Deliberately does NOT cover the canvas-rendering functions (renderBoardToCanvas/
// renderBoardImage/renderBoardText/renderBoardShape/renderBoardBlur, measureBoardTextContentHeight)
// - see vitest.config.ts's own comment on why this test run has no DOM/canvas.
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  applyGroupResize,
  applyGroupRotate,
  applyMove,
  applyResize,
  applyRotate,
  coverFitRect,
  groupBoundingBox,
  hitTestBoardItem,
  invertCommand,
  layoutImagesInCircle,
  layoutImagesInGrid,
  layoutImagesInRow,
  paddedCanvasSize,
  resizeHandlePoints,
  resolveBackgroundMode,
  resolveBoardGrid,
  resolveBoardPadding,
  rotateHandlePoint,
} from "./boardHandlers";
import { BoardDocument, BoardImage, BoardItem } from "../utils/boardTypes";

function makeImage(overrides: Partial<BoardImage> = {}): BoardImage {
  return {
    id: "img-1", kind: "image", x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, createdAt: 0, updatedAt: 0,
    assetFileName: "a.png", naturalWidth: 200, naturalHeight: 100, padding: 0, borderWidth: 0, borderColor: "#000", cornerRadius: 0, backgroundColor: "#fff",
    ...overrides,
  };
}

function makeDoc(overrides: Partial<BoardDocument> = {}): BoardDocument {
  return {
    version: 1, id: "board-1", name: "Board", canvasWidth: 800, canvasHeight: 600, backgroundColor: "#fff", padding: 20, images: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as BoardDocument;
}

describe("coverFitRect", () => {
  it("crops the sides when the source is relatively wider than the box", () => {
    // 200x100 source (2:1) into a 100x100 box (1:1) - source is wider, crop left/right.
    const rect = coverFitRect(200, 100, 100, 100);
    expect(rect.sh).toBe(100); // full height used
    expect(rect.sw).toBe(100); // width cropped down to match the box's aspect
    expect(rect.sx).toBe(50); // centered crop
    expect(rect.sy).toBe(0);
  });

  it("crops the top/bottom when the source is relatively taller than the box", () => {
    const rect = coverFitRect(100, 200, 100, 100);
    expect(rect.sw).toBe(100);
    expect(rect.sh).toBe(100);
    expect(rect.sy).toBe(50);
  });

  it("falls back to the unscaled source for degenerate (zero/negative) dimensions", () => {
    expect(coverFitRect(0, 100, 50, 50)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 100 });
  });
});

describe("defensive-default resolvers", () => {
  it("resolveBoardPadding treats a missing/NaN padding as 0, never lets NaN through", () => {
    expect(resolveBoardPadding(makeDoc({ padding: undefined as unknown as number }))).toBe(0);
    expect(resolveBoardPadding(makeDoc({ padding: NaN }))).toBe(0);
    expect(resolveBoardPadding(makeDoc({ padding: -5 }))).toBe(0); // clamped, never negative
    expect(resolveBoardPadding(makeDoc({ padding: 10 }))).toBe(10);
  });

  it("paddedCanvasSize adds padding to both sides of each dimension", () => {
    const size = paddedCanvasSize(makeDoc({ canvasWidth: 100, canvasHeight: 50, padding: 10 }));
    expect(size).toEqual({ width: 120, height: 70, padding: 10 });
  });

  it("resolveBoardGrid falls back to the default when spacing is missing or non-positive", () => {
    expect(resolveBoardGrid(makeDoc({ backgroundGrid: undefined })).spacing).toBe(40);
    expect(resolveBoardGrid(makeDoc({ backgroundGrid: { spacing: 0, lineColor: "#000", baseColor: null } })).spacing).toBe(40);
    expect(resolveBoardGrid(makeDoc({ backgroundGrid: { spacing: 25, lineColor: "#000", baseColor: null } })).spacing).toBe(25);
  });

  it("resolveBackgroundMode defaults to 'color' for an old board", () => {
    expect(resolveBackgroundMode(makeDoc({ backgroundMode: undefined }))).toBe("color");
    expect(resolveBackgroundMode(makeDoc({ backgroundMode: "grid" }))).toBe("grid");
  });
});

describe("hitTestBoardItem", () => {
  it("hits the topmost (last-drawn) item when several overlap", () => {
    const items: BoardItem[] = [makeImage({ id: "bottom", x: 0, y: 0, width: 50, height: 50 }), makeImage({ id: "top", x: 0, y: 0, width: 50, height: 50 })];
    expect(hitTestBoardItem(items, 25, 25)?.id).toBe("top");
  });

  it("skips locked items entirely, even if they're on top", () => {
    const items: BoardItem[] = [makeImage({ id: "bottom", x: 0, y: 0, width: 50, height: 50 }), makeImage({ id: "top-locked", x: 0, y: 0, width: 50, height: 50, locked: true })];
    expect(hitTestBoardItem(items, 25, 25)?.id).toBe("bottom");
  });

  it("returns null when nothing is hit", () => {
    expect(hitTestBoardItem([makeImage({ x: 0, y: 0, width: 10, height: 10 })], 500, 500)).toBeNull();
  });

  it("hits a rotated item by unrotating the query point into its local frame", () => {
    // A square centered at (25,25) - rotation doesn't change its own hit-test footprint for a
    // point exactly at the center, but confirms rotated items are still hittable at all.
    const item = makeImage({ x: 0, y: 0, width: 50, height: 50, rotation: Math.PI / 4 });
    expect(hitTestBoardItem([item], 25, 25)).toBe(item);
  });
});

describe("resizeHandlePoints / rotateHandlePoint", () => {
  it("returns the four unrotated corners for an unrotated item", () => {
    const item = makeImage({ x: 10, y: 10, width: 20, height: 30, rotation: 0 });
    const handles = resizeHandlePoints(item);
    expect(handles.nw).toEqual({ x: 10, y: 10 });
    expect(handles.se).toEqual({ x: 30, y: 40 });
  });

  it("rotates the corners around the item's own center for a rotated item", () => {
    // A 180-degree rotation should swap nw and se, and ne and sw.
    const item = makeImage({ x: 0, y: 0, width: 20, height: 20, rotation: Math.PI });
    const handles = resizeHandlePoints(item);
    expect(handles.nw.x).toBeCloseTo(20, 5);
    expect(handles.nw.y).toBeCloseTo(20, 5);
    expect(handles.se.x).toBeCloseTo(0, 5);
    expect(handles.se.y).toBeCloseTo(0, 5);
  });

  it("rotateHandlePoint sits above the top edge by the given offset for an unrotated item", () => {
    const item = makeImage({ x: 0, y: 0, width: 20, height: 20, rotation: 0 });
    expect(rotateHandlePoint(item, 10)).toEqual({ x: 10, y: -10 });
  });
});

describe("applyMove / applyResize / applyRotate", () => {
  it("applyMove shifts x/y and preserves the item's own kind via the generic type param", () => {
    const image = makeImage({ x: 5, y: 5 });
    const moved = applyMove(image, 10, -5);
    expect(moved).toMatchObject({ x: 15, y: 0, kind: "image" });
  });

  it("applyResize keeps the opposite corner fixed", () => {
    const item = makeImage({ x: 10, y: 10, width: 20, height: 20 }); // corners (10,10)-(30,30)
    const result = applyResize(item, "se", 50, 60);
    expect(result).toMatchObject({ x: 10, y: 10, width: 40, height: 50 });
  });

  it("applyResize enforces a minimum size", () => {
    const item = makeImage({ x: 10, y: 10, width: 20, height: 20 });
    const result = applyResize(item, "se", 5, 5, 24);
    expect(result.width).toBeGreaterThanOrEqual(24);
    expect(result.height).toBeGreaterThanOrEqual(24);
  });

  it("applyRotate points the box toward the pointer", () => {
    const item = makeImage({ x: 0, y: 0, width: 20, height: 20 }); // center (10,10)
    // Pointer directly above the center -> rotation should be 0 (the +PI/2 offset corrects atan2's
    // own "0 = pointing right" convention to "0 = pointing up", matching the rotate handle's start).
    const result = applyRotate(item, 10, -100);
    expect(result.rotation).toBeCloseTo(0, 5);
  });
});

describe("group bounding box / resize / rotate", () => {
  it("groupBoundingBox encloses every item's own (rotated) footprint", () => {
    const items: BoardItem[] = [makeImage({ x: 0, y: 0, width: 10, height: 10 }), makeImage({ x: 50, y: 50, width: 10, height: 10 })];
    expect(groupBoundingBox(items)).toEqual({ x: 0, y: 0, width: 60, height: 60 });
  });

  it("applyGroupResize scales every item's position and size around a fixed anchor", () => {
    const items: BoardItem[] = [makeImage({ id: "a", x: 0, y: 0, width: 10, height: 10 }), makeImage({ id: "b", x: 20, y: 0, width: 10, height: 10 })];
    // Anchor at (0,0), scale x2 - item "b" at x=20 should move to x=40; its width doubles too.
    const result = applyGroupResize(items, 0, 0, 2, 1);
    const b = result.find((i) => i.id === "b")!;
    expect(b.x).toBe(40);
    expect(b.width).toBe(20);
  });

  it("applyGroupRotate spins every item's own rotation AND orbits its position around a shared center", () => {
    const items: BoardItem[] = [makeImage({ x: 0, y: 0, width: 10, height: 10, rotation: 0 })]; // center (5,5)
    // Rotate 90 degrees (PI/2) around (5,5) - the item's own center doesn't move (it IS the pivot),
    // but its rotation increases.
    const result = applyGroupRotate(items, 5, 5, Math.PI / 2);
    expect(result[0].rotation).toBeCloseTo(Math.PI / 2, 5);
    expect(result[0].x + result[0].width / 2).toBeCloseTo(5, 5);
    expect(result[0].y + result[0].height / 2).toBeCloseTo(5, 5);
  });
});

describe("auto-layout algorithms", () => {
  it("layoutImagesInRow preserves each image's own aspect ratio at a shared row height", () => {
    const images = [makeImage({ id: "a", width: 200, height: 100 }), makeImage({ id: "b", width: 100, height: 100 })]; // aspects 2:1 and 1:1
    const result = layoutImagesInRow(images, 1000, 10);
    const a = result.images.find((i) => i.id === "a")!;
    const b = result.images.find((i) => i.id === "b")!;
    expect(a.height).toBe(b.height); // same row height
    expect(a.width / a.height).toBeCloseTo(2, 5); // aspect preserved
    expect(a.rotation).toBe(0); // rotation reset
  });

  it("layoutImagesInRow wraps to a new row when the next image would overflow maxWidth", () => {
    const images = [makeImage({ id: "a", width: 100, height: 100 }), makeImage({ id: "b", width: 100, height: 100 })];
    const result = layoutImagesInRow(images, 150, 10); // too narrow for both side by side
    const a = result.images.find((i) => i.id === "a")!;
    const b = result.images.find((i) => i.id === "b")!;
    expect(b.y).toBeGreaterThan(a.y); // wrapped to a new row
    expect(b.x).toBe(a.x); // both start at the row's own left gap
  });

  it("layoutImagesInGrid places images at a uniform square size in row-major order", () => {
    const images = [makeImage({ id: "a" }), makeImage({ id: "b" }), makeImage({ id: "c" })]; // 3 images -> 2 columns
    const result = layoutImagesInGrid(images, 10);
    const [a, b, c] = result.images;
    expect(a.width).toBe(a.height); // square cells
    expect(a.width).toBe(b.width); // uniform across the batch
    expect(b.y).toBe(a.y); // same row (columns=2, so a and b are both row 0)
    expect(c.y).toBeGreaterThan(a.y); // third image wraps to row 1
  });

  it("layoutImagesInCircle spaces every image evenly around a ring, starting at 12 o'clock", () => {
    const images = [makeImage({ id: "a" }), makeImage({ id: "b" }), makeImage({ id: "c" }), makeImage({ id: "d" })];
    const result = layoutImagesInCircle(images, 10);
    const first = result.images[0];
    const centerX = result.canvasWidth / 2;
    // First image starts at angle -90deg (straight up from center) - its center x should align
    // with the canvas's own horizontal center.
    expect(first.x + first.width / 2).toBeCloseTo(centerX, 5);
    expect(first.y + first.height / 2).toBeLessThan(result.canvasHeight / 2); // above center = "up"
  });

  it("every layout is a no-op returning an empty result for zero images", () => {
    expect(layoutImagesInRow([], 500, 10)).toEqual({ images: [], canvasWidth: 0, canvasHeight: 0 });
    expect(layoutImagesInGrid([], 10)).toEqual({ images: [], canvasWidth: 0, canvasHeight: 0 });
  });
});

describe("applyCommand / invertCommand", () => {
  it("add appends and delete's inverse adds it back", () => {
    const doc = makeDoc();
    const item = makeImage();
    const afterAdd = applyCommand(doc, { type: "add", item });
    expect(afterAdd.images).toEqual([item]);
    const deleteCmd: Parameters<typeof applyCommand>[1] = { type: "delete", item };
    expect(applyCommand(afterAdd, deleteCmd).images).toEqual([]);
    expect(invertCommand(deleteCmd)).toEqual({ type: "add", item });
  });

  it("padding command round-trips through invertCommand", () => {
    const cmd: Parameters<typeof applyCommand>[1] = { type: "padding", before: 10, after: 30 };
    const doc = applyCommand(makeDoc({ padding: 10 }), cmd);
    expect(doc.padding).toBe(30);
    expect(invertCommand(cmd)).toEqual({ type: "padding", before: 30, after: 10 });
  });

  it("canvas-size command updates both dimensions together", () => {
    const cmd: Parameters<typeof applyCommand>[1] = { type: "canvas-size", before: { width: 800, height: 600 }, after: { width: 1000, height: 500 } };
    const doc = applyCommand(makeDoc(), cmd);
    expect(doc.canvasWidth).toBe(1000);
    expect(doc.canvasHeight).toBe(500);
  });
});
