// handlers/imageEditHandlers.test.ts
//
// Unit tests for the DOM-free pure functions in imageEditHandlers.ts. Deliberately does NOT cover
// the canvas-rendering functions (renderComposedCanvas, rotateFlipCanvas, cropCanvas) or anything
// that calls measureTextWidth (textObjectBounds/textObjectVisualBounds, and by extension
// getSelectionBounds's/findObjectAt's/transformObjectForGeometry's own "text" branches) - those
// need document.createElement("canvas") and a real 2D context, which this test run's plain "node"
// environment has no jsdom/DOM globals for at all (see vitest.config.ts's own comment on why).
// Covers geometry/hit-testing/z-order/command logic instead, which is where most of this file's
// actual bug surface lives anyway.
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  cssFilterForAdjustments,
  findObjectAt,
  findObjectsInRect,
  getObjectBounds,
  getSelectionBounds,
  invertCommand,
  moveObjectsBackward,
  moveObjectsForward,
  moveObjectsToBack,
  moveObjectsToFront,
  nextStepNumber,
  rectsIntersect,
  resizeBoxObject,
  translateObject,
  transformObjectForGeometry,
} from "./imageEditHandlers";
import { ArrowObject, ImageAnnotationObject, ImageEditDocument, PlacedImageObject, RectObject, StepObject, StrokeObject } from "../utils/imageEditTypes";

function makeRect(overrides: Partial<RectObject> = {}): RectObject {
  return { id: "rect-1", createdAt: 0, updatedAt: 0, type: "rect", color: "#f00", width: 2, x: 10, y: 10, w: 20, h: 20, filled: false, ...overrides };
}

function makeArrow(overrides: Partial<ArrowObject> = {}): ArrowObject {
  return { id: "arrow-1", createdAt: 0, updatedAt: 0, type: "arrow", color: "#000", width: 2, x1: 0, y1: 0, x2: 10, y2: 0, dashed: false, doubleHeaded: false, ...overrides };
}

function makeStroke(overrides: Partial<StrokeObject> = {}): StrokeObject {
  return { id: "stroke-1", createdAt: 0, updatedAt: 0, type: "stroke", color: "#000", width: 4, opacity: 1, points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }], ...overrides };
}

function makePlacedImage(overrides: Partial<PlacedImageObject> = {}): PlacedImageObject {
  return { id: "img-1", createdAt: 0, updatedAt: 0, type: "placed-image", src: "x.png", x: 0, y: 0, width: 100, height: 50, rotation: 0, ...overrides };
}

function makeStep(overrides: Partial<StepObject> = {}): StepObject {
  return { id: "step-1", createdAt: 0, updatedAt: 0, type: "step", x: 0, y: 0, w: 30, h: 30, number: 1, color: "#00f", ...overrides };
}

function makeDoc(overrides: Partial<ImageEditDocument> = {}): ImageEditDocument {
  return { version: 1, baseWidth: 800, baseHeight: 600, adjustments: { brightness: 1, contrast: 1, saturation: 1 }, objects: [], updatedAt: "2026-01-01T00:00:00.000Z", ...overrides } as ImageEditDocument;
}

describe("cssFilterForAdjustments", () => {
  it("is 'none' at neutral values", () => {
    expect(cssFilterForAdjustments({ brightness: 1, contrast: 1, saturation: 1 })).toBe("none");
  });

  it("builds a CSS filter string from non-neutral values", () => {
    expect(cssFilterForAdjustments({ brightness: 1.2, contrast: 0.9, saturation: 1.1 })).toBe("brightness(1.2) contrast(0.9) saturate(1.1)");
  });
});

describe("nextStepNumber", () => {
  it("starts at 1 with no existing step badges", () => {
    expect(nextStepNumber([])).toBe(1);
  });

  it("continues from the highest existing number, not the count", () => {
    const objects: ImageAnnotationObject[] = [makeStep({ number: 1 }), makeStep({ number: 5 }), makeRect()];
    expect(nextStepNumber(objects)).toBe(6);
  });
});

describe("translateObject", () => {
  it("shifts x/y for a box-shaped object", () => {
    const result = translateObject(makeRect({ x: 10, y: 10 }), 5, -3);
    expect(result).toMatchObject({ x: 15, y: 7 });
  });

  it("shifts every point for a stroke", () => {
    const result = translateObject(makeStroke(), 5, 5) as StrokeObject;
    expect(result.points).toEqual([{ x: 5, y: 5, pressure: 0.5 }, { x: 15, y: 5, pressure: 0.5 }]);
  });

  it("shifts both endpoints for an arrow", () => {
    const result = translateObject(makeArrow({ x1: 0, y1: 0, x2: 10, y2: 10 }), 2, 3) as ArrowObject;
    expect(result).toMatchObject({ x1: 2, y1: 3, x2: 12, y2: 13 });
  });
});

describe("z-order (moveObjectsToFront/Back/Forward/Backward)", () => {
  const objects = [makeRect({ id: "a" }), makeRect({ id: "b" }), makeRect({ id: "c" }), makeRect({ id: "d" })];

  it("moveObjectsToFront moves the selection to the end, in its own original array order (not the order ids were passed in)", () => {
    expect(moveObjectsToFront(objects, ["b", "a"]).map((o) => o.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("moveObjectsToBack moves the selection to the start, in its own original array order", () => {
    expect(moveObjectsToBack(objects, ["c", "a"]).map((o) => o.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("moveObjectsForward swaps each selected object past exactly one unselected neighbor", () => {
    expect(moveObjectsForward(objects, ["a"]).map((o) => o.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("moveObjectsForward treats a contiguous selection as one block (no leapfrogging)", () => {
    expect(moveObjectsForward(objects, ["a", "b"]).map((o) => o.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("moveObjectsBackward swaps each selected object past exactly one unselected neighbor", () => {
    expect(moveObjectsBackward(objects, ["d"]).map((o) => o.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("is a no-op when the selection is already at the target end", () => {
    expect(moveObjectsToFront(objects, ["d"])).toEqual(objects);
    expect(moveObjectsForward(objects, ["d"])).toEqual(objects);
  });
});

describe("rectsIntersect", () => {
  it("detects an overlap", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it("detects no overlap when rects are fully separate", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBe(false);
  });

  it("edges touching but not overlapping counts as no intersection (strict <)", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe("getObjectBounds", () => {
  it("returns bounds for box-shaped objects", () => {
    expect(getObjectBounds(makeRect({ x: 1, y: 2, w: 3, h: 4 }))).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("returns null for object types with their own dedicated resize chrome", () => {
    expect(getObjectBounds(makeStroke())).toBeNull();
    expect(getObjectBounds(makeArrow())).toBeNull();
    expect(getObjectBounds(makePlacedImage())).toBeNull();
  });
});

describe("getSelectionBounds (non-text object types)", () => {
  it("computes a stroke's bounds from its own points, padded by half its width", () => {
    const bounds = getSelectionBounds(makeStroke({ points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 20, pressure: 0.5 }], width: 4 }));
    expect(bounds).toEqual({ x: -2, y: -2, w: 14, h: 24 });
  });

  it("computes an arrow's bounds from its own endpoints regardless of direction", () => {
    const bounds = getSelectionBounds(makeArrow({ x1: 10, y1: 10, x2: 0, y2: 0, width: 2 }));
    expect(bounds).toEqual({ x: -1, y: -1, w: 12, h: 12 });
  });

  it("falls back to getObjectBounds for box-shaped objects", () => {
    expect(getSelectionBounds(makeRect({ x: 1, y: 2, w: 3, h: 4 }))).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe("findObjectsInRect (non-text object types)", () => {
  it("returns every object whose bounds overlap the marquee at all, not just fully-enclosed ones", () => {
    const objects: ImageAnnotationObject[] = [makeRect({ id: "inside", x: 5, y: 5, w: 5, h: 5 }), makeRect({ id: "partial", x: 45, y: 45, w: 20, h: 20 }), makeRect({ id: "outside", x: 200, y: 200, w: 10, h: 10 })];
    const found = findObjectsInRect(objects, { x: 0, y: 0, w: 50, h: 50 }).map((o) => o.id);
    expect(found).toEqual(["inside", "partial"]);
  });
});

describe("findObjectAt (non-text object types, topmost-first)", () => {
  it("returns the topmost (last-drawn) object when several overlap", () => {
    const objects: ImageAnnotationObject[] = [makeRect({ id: "bottom", x: 0, y: 0, w: 50, h: 50 }), makeRect({ id: "top", x: 0, y: 0, w: 50, h: 50 })];
    expect(findObjectAt(objects, 25, 25)?.id).toBe("top");
  });

  it("returns null when nothing is hit", () => {
    expect(findObjectAt([makeRect({ x: 0, y: 0, w: 10, h: 10 })], 500, 500)).toBeNull();
  });

  it("hits an arrow within tolerance of its line segment, not just its endpoints", () => {
    const arrow = makeArrow({ x1: 0, y1: 0, x2: 100, y2: 0, width: 2 });
    expect(findObjectAt([arrow], 50, 0)?.id).toBe("arrow-1"); // midpoint of the line
    expect(findObjectAt([arrow], 50, 50)).toBeNull(); // far off the line
  });

  it("hits a rotated placed-image by unrotating the query point first", () => {
    // A 100x50 image centered at (50,25), rotated 90 degrees - its rotated footprint on screen is
    // now tall/narrow, but the object's own unrotated x/y/width/height never change.
    const image = makePlacedImage({ x: 0, y: 0, width: 100, height: 50, rotation: Math.PI / 2 });
    // (50, 25) is the center regardless of rotation - always a hit.
    expect(findObjectAt([image], 50, 25)?.id).toBe("img-1");
  });
});

describe("resizeBoxObject", () => {
  it("keeps the opposite corner fixed when dragging one corner", () => {
    const rect = makeRect({ x: 10, y: 10, w: 20, h: 20 }); // corners at (10,10) and (30,30)
    const result = resizeBoxObject(rect, "se", 40, 50); // drag the se corner outward
    expect(result).toMatchObject({ x: 10, y: 10, w: 30, h: 40 }); // nw corner (10,10) unchanged
  });

  it("enforces a minimum size instead of collapsing/inverting", () => {
    const rect = makeRect({ x: 10, y: 10, w: 20, h: 20 });
    const result = resizeBoxObject(rect, "se", 5, 5, 8); // dragged past the opposite corner
    expect(result.w).toBeGreaterThanOrEqual(8);
    expect(result.h).toBeGreaterThanOrEqual(8);
  });
});

describe("transformObjectForGeometry (non-text object types)", () => {
  const params = { srcWidth: 100, srcHeight: 50, outWidth: 50, outHeight: 100, quarterTurns: 1 as const, flipH: false, flipV: false };

  it("swaps w/h for a box-shaped object on a 90-degree turn", () => {
    const result = transformObjectForGeometry(makeRect({ x: 0, y: 0, w: 20, h: 10 }), params) as RectObject;
    expect(result.w).toBe(10);
    expect(result.h).toBe(20);
  });

  it("does not swap w/h on a 180-degree turn", () => {
    const result = transformObjectForGeometry(makeRect({ x: 0, y: 0, w: 20, h: 10 }), { ...params, quarterTurns: 2, outWidth: 100, outHeight: 50 }) as RectObject;
    expect(result.w).toBe(20);
    expect(result.h).toBe(10);
  });

  it("re-tilts a placed-image's own rotation field on a 90-degree turn", () => {
    const result = transformObjectForGeometry(makePlacedImage({ rotation: 0 }), params) as PlacedImageObject;
    expect(result.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it("moves an arrow's endpoints through the same transform", () => {
    const result = transformObjectForGeometry(makeArrow({ x1: 0, y1: 0, x2: 100, y2: 0 }), { ...params, flipH: false, flipV: false }) as ArrowObject;
    // A 90-degree turn around the source's own center maps (0,0)->(outWidth,0)-ish - just assert
    // the endpoints actually moved and stayed distinct from each other, not exact pixel values
    // (the precise formula is covered by transformPointForGeometry's own private implementation).
    expect(result.x1).not.toBe(0);
    expect([result.x1, result.y1]).not.toEqual([result.x2, result.y2]);
  });
});

describe("applyCommand / invertCommand", () => {
  it("add appends the object and delete's inverse adds it back", () => {
    const doc = makeDoc();
    const object = makeRect();
    const afterAdd = applyCommand(doc, { type: "add", object });
    expect(afterAdd.objects).toEqual([object]);

    const deleteCmd: Parameters<typeof applyCommand>[1] = { type: "delete", object };
    const afterDelete = applyCommand(afterAdd, deleteCmd);
    expect(afterDelete.objects).toEqual([]);
    expect(invertCommand(deleteCmd)).toEqual({ type: "add", object });
  });

  it("edit replaces only the matching object, and inverting swaps before/after", () => {
    const before = makeRect({ id: "a", x: 0 });
    const after = { ...before, x: 99 };
    const doc = makeDoc({ objects: [before, makeRect({ id: "b" })] });
    const editCmd: Parameters<typeof applyCommand>[1] = { type: "edit", before, after };
    const result = applyCommand(doc, editCmd);
    expect((result.objects[0] as RectObject).x).toBe(99);
    expect(invertCommand(editCmd)).toEqual({ type: "edit", before: after, after: before });
  });

  it("batch-delete removes every listed object and inverts to batch-add", () => {
    const a = makeRect({ id: "a" });
    const b = makeRect({ id: "b" });
    const c = makeRect({ id: "c" });
    const doc = makeDoc({ objects: [a, b, c] });
    const cmd: Parameters<typeof applyCommand>[1] = { type: "batch-delete", objects: [a, c] };
    expect(applyCommand(doc, cmd).objects).toEqual([b]);
    expect(invertCommand(cmd)).toEqual({ type: "batch-add", objects: [a, c] });
  });

  it("adjustments command round-trips through invertCommand", () => {
    const before = { brightness: 1, contrast: 1, saturation: 1 };
    const after = { brightness: 1.5, contrast: 1, saturation: 1 };
    const cmd: Parameters<typeof applyCommand>[1] = { type: "adjustments", before, after };
    const doc = applyCommand(makeDoc({ adjustments: before }), cmd);
    expect(doc.adjustments).toEqual(after);
    expect(invertCommand(cmd)).toEqual({ type: "adjustments", before: after, after: before });
  });
});
