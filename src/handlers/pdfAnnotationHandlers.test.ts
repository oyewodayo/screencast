// handlers/pdfAnnotationHandlers.test.ts
//
// Unit tests for the DOM-free pure functions in pdfAnnotationHandlers.ts. Deliberately does NOT
// cover the canvas-rendering functions (renderObject/renderTextObject/measureTextBlock/etc, which
// need document.createElement("canvas")) or getPageViewportSize/getPageTextLines (which need a
// real pdf.js PDFPageProxy) - see vitest.config.ts's own comment on why this test run has no DOM.
// Covers coordinate conversion, the text-range/color-run interval algebra, and hit-testing/command
// logic instead - the actual bug surface for anything touching undo/redo or click-to-select.
import { describe, expect, it } from "vitest";
import {
  addTextRange,
  applyColorRun,
  applyCommand,
  devicePointToPdfPoint,
  findImageObjectAt,
  findTextLineAt,
  findTextObjectAt,
  hitTestEraser,
  invertCommand,
  isTextRangeCovered,
  pdfPointToDevicePoint,
  removeTextRange,
  shiftColorRunsForEdit,
  shiftTextRangesForEdit,
  toggleTextRange,
} from "./pdfAnnotationHandlers";
import { ImageObject, PdfAnnotationDocument, StrokeObject, TextColorRun, TextObject } from "../utils/pdfAnnotationTypes";

function makeText(overrides: Partial<TextObject> = {}): TextObject {
  return { id: "text-1", pageIndex: 0, createdAt: 0, updatedAt: 0, type: "text", text: "hello", color: "#000", fontSize: 12, x: 10, y: 100, width: 50, height: 20, ...overrides };
}

function makeImage(overrides: Partial<ImageObject> = {}): ImageObject {
  return { id: "img-1", pageIndex: 0, createdAt: 0, updatedAt: 0, type: "image", src: "x.png", x: 0, y: 100, width: 40, height: 20, rotation: 0, ...overrides };
}

function makeStroke(overrides: Partial<StrokeObject> = {}): StrokeObject {
  return { id: "stroke-1", pageIndex: 0, createdAt: 0, updatedAt: 0, type: "stroke", color: "#000", width: 4, opacity: 1, points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }], ...overrides };
}

function makeDoc(overrides: Partial<PdfAnnotationDocument> = {}): PdfAnnotationDocument {
  return { version: 1, sourceFileName: "doc.pdf", pages: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("devicePointToPdfPoint / pdfPointToDevicePoint", () => {
  it("round-trips through a viewport's own conversion functions and carries pressure through", () => {
    const viewport = {
      convertToPdfPoint: (x: number, y: number) => [x / 2, y / 2],
      convertToViewportPoint: (x: number, y: number) => [x * 2, y * 2],
    };
    const pdfPoint = devicePointToPdfPoint(viewport, 100, 200, 0.7);
    expect(pdfPoint).toEqual({ x: 50, y: 100, pressure: 0.7 });
    expect(pdfPointToDevicePoint(viewport, pdfPoint)).toEqual({ x: 100, y: 200 });
  });
});

describe("applyColorRun", () => {
  it("inserts a run with no overlap unchanged", () => {
    expect(applyColorRun([], 0, 5, "red")).toEqual([{ start: 0, end: 5, color: "red" }]);
  });

  it("splits an existing run that fully contains the new one", () => {
    const existing: TextColorRun[] = [{ start: 0, end: 10, color: "blue" }];
    const result = applyColorRun(existing, 3, 6, "red");
    expect(result).toEqual([
      { start: 0, end: 3, color: "blue" },
      { start: 3, end: 6, color: "red" },
      { start: 6, end: 10, color: "blue" },
    ]);
  });

  it("fully replaces a run entirely covered by the new one", () => {
    const existing: TextColorRun[] = [{ start: 2, end: 4, color: "blue" }];
    expect(applyColorRun(existing, 0, 10, "red")).toEqual([{ start: 0, end: 10, color: "red" }]);
  });

  it("is a no-op for a zero-or-negative-length range", () => {
    const existing: TextColorRun[] = [{ start: 0, end: 5, color: "blue" }];
    expect(applyColorRun(existing, 5, 5, "red")).toBe(existing);
    expect(applyColorRun(existing, 5, 2, "red")).toBe(existing);
  });
});

describe("addTextRange / removeTextRange / isTextRangeCovered / toggleTextRange", () => {
  it("addTextRange merges overlapping/adjacent ranges into one", () => {
    expect(addTextRange([{ start: 0, end: 5 }], 5, 10)).toEqual([{ start: 0, end: 10 }]);
    expect(addTextRange([{ start: 0, end: 5 }], 3, 8)).toEqual([{ start: 0, end: 8 }]);
  });

  it("addTextRange keeps disjoint ranges separate", () => {
    expect(addTextRange([{ start: 0, end: 5 }], 10, 15)).toEqual([{ start: 0, end: 5 }, { start: 10, end: 15 }]);
  });

  it("removeTextRange trims/splits overlapping ranges", () => {
    expect(removeTextRange([{ start: 0, end: 10 }], 3, 6)).toEqual([{ start: 0, end: 3 }, { start: 6, end: 10 }]);
  });

  it("isTextRangeCovered detects a gap", () => {
    const ranges = [{ start: 0, end: 3 }, { start: 5, end: 10 }];
    expect(isTextRangeCovered(ranges, 0, 10)).toBe(false); // gap at [3,5)
    expect(isTextRangeCovered(ranges, 5, 10)).toBe(true);
  });

  it("toggleTextRange turns fully-covered selections off and everything else fully on", () => {
    const covered = [{ start: 0, end: 10 }];
    expect(toggleTextRange(covered, 2, 5)).toEqual([{ start: 0, end: 2 }, { start: 5, end: 10 }]);
    expect(toggleTextRange([], 2, 5)).toEqual([{ start: 2, end: 5 }]);
  });
});

describe("shiftColorRunsForEdit / shiftTextRangesForEdit", () => {
  it("leaves ranges entirely before an insertion untouched", () => {
    const runs: TextColorRun[] = [{ start: 0, end: 3, color: "red" }];
    // "abcdef" -> "abcXXdef": inserted "XX" at index 3, well after the run [0,3).
    expect(shiftColorRunsForEdit(runs, "abcdef", "abcXXdef")).toEqual(runs);
  });

  it("shifts ranges entirely after an insertion by the length delta", () => {
    const ranges = [{ start: 4, end: 6 }]; // covers "ef" in "abcdef"
    const result = shiftTextRangesForEdit(ranges, "abcdef", "abXXcdef"); // +2 chars inserted at index 2
    expect(result).toEqual([{ start: 6, end: 8 }]);
  });

  it("shrinks a range whose interior was deleted - as two adjacent surviving pieces, not remerged", () => {
    const ranges = [{ start: 0, end: 6 }]; // covers all of "abcdef"
    const result = shiftTextRangesForEdit(ranges, "abcdef", "abef"); // deleted "cd" from the middle
    // The surviving prefix ("ab", [0,2)) and suffix ("ef", now at [2,4)) come back as two separate
    // range objects even though they're contiguous - shiftRanges never re-merges, it only shifts/
    // trims each original range independently.
    expect(result).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });

  it("is a no-op (same reference) when the text didn't actually change", () => {
    const runs: TextColorRun[] = [{ start: 0, end: 3, color: "red" }];
    expect(shiftColorRunsForEdit(runs, "same", "same")).toBe(runs);
  });
});

describe("findTextObjectAt", () => {
  it("hits a text object whose box contains the point (PDF y-up: top edge is the higher y)", () => {
    const text = makeText({ x: 10, y: 100, width: 50, height: 20 }); // spans y in [80,100]
    expect(findTextObjectAt([text], { x: 20, y: 90, pressure: 1 })).toBe(text);
  });

  it("returns null outside the box", () => {
    const text = makeText({ x: 10, y: 100, width: 50, height: 20 });
    expect(findTextObjectAt([text], { x: 1000, y: 1000, pressure: 1 })).toBeNull();
  });

  it("skips non-text objects", () => {
    const stroke = makeStroke();
    expect(findTextObjectAt([stroke], { x: 0, y: 0, pressure: 1 })).toBeNull();
  });
});

describe("findImageObjectAt", () => {
  it("hits an unrotated image's bounding box, topmost first", () => {
    const bottom = makeImage({ id: "bottom", x: 0, y: 100, width: 40, height: 20 });
    const top = makeImage({ id: "top", x: 0, y: 100, width: 40, height: 20 });
    expect(findImageObjectAt([bottom, top], { x: 10, y: 90, pressure: 1 })?.id).toBe("top");
  });

  it("returns null when the point misses every image", () => {
    const image = makeImage({ x: 0, y: 100, width: 40, height: 20 });
    expect(findImageObjectAt([image], { x: 1000, y: 1000, pressure: 1 })).toBeNull();
  });
});

describe("hitTestEraser", () => {
  it("hits a stroke within its own width plus the eraser radius", () => {
    const stroke = makeStroke({ points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }], width: 2 });
    const hits = hitTestEraser([stroke], { x: 5, y: 1, pressure: 1 }, 2);
    expect(hits).toEqual([stroke]);
  });

  it("misses a stroke far from the eraser point", () => {
    const stroke = makeStroke({ points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }] });
    expect(hitTestEraser([stroke], { x: 1000, y: 1000, pressure: 1 }, 5)).toEqual([]);
  });

  it("hits a text object via its bounding box", () => {
    const text = makeText({ x: 10, y: 100, width: 50, height: 20 });
    expect(hitTestEraser([text], { x: 20, y: 90, pressure: 1 }, 0)).toEqual([text]);
  });
});

describe("applyCommand / invertCommand", () => {
  it("add appends to the right page, leaving other pages untouched by reference", () => {
    const otherPage = { pageIndex: 1, objects: [makeText({ id: "untouched" })] };
    const doc = makeDoc({ pages: [otherPage] });
    const object = makeStroke({ pageIndex: 0 });
    const result = applyCommand(doc, { type: "add", object });
    expect(result.pages.find((p) => p.pageIndex === 0)?.objects).toEqual([object]);
    expect(result.pages.find((p) => p.pageIndex === 1)).toBe(otherPage); // same reference
  });

  it("erase removes only the listed objects from that page", () => {
    const a = makeStroke({ id: "a" });
    const b = makeStroke({ id: "b" });
    const doc = makeDoc({ pages: [{ pageIndex: 0, objects: [a, b] }] });
    const result = applyCommand(doc, { type: "erase", pageIndex: 0, removed: [a] });
    expect(result.pages[0].objects).toEqual([b]);
  });

  it("edit replaces the matching object in place", () => {
    const before = makeText({ id: "a", text: "old" });
    const doc = makeDoc({ pages: [{ pageIndex: 0, objects: [before] }] });
    const after = { ...before, text: "new" };
    const result = applyCommand(doc, { type: "edit", pageIndex: 0, before, after });
    expect((result.pages[0].objects[0] as TextObject).text).toBe("new");
  });

  it("invertCommand: add inverts to an erase of that same object", () => {
    const object = makeStroke();
    expect(invertCommand({ type: "add", object })).toEqual({ type: "erase", pageIndex: object.pageIndex, removed: [object] });
  });

  it("invertCommand: edit swaps before/after", () => {
    const before = makeText({ text: "old" });
    const after = { ...before, text: "new" };
    expect(invertCommand({ type: "edit", pageIndex: 0, before, after })).toEqual({ type: "edit", pageIndex: 0, before: after, after: before });
  });
});

describe("findTextLineAt", () => {
  const lines = [{ xMin: 0, xMax: 100, yMin: 0, yMax: 10 }];

  it("hits a line with the point squarely inside it", () => {
    expect(findTextLineAt(lines, { x: 50, y: 5, pressure: 1 })).toBe(lines[0]);
  });

  it("allows slack outside the exact box for an imprecise click", () => {
    expect(findTextLineAt(lines, { x: 50, y: -2, pressure: 1 })).toBe(lines[0]); // within ySlack
  });

  it("returns null well outside any line, even with slack", () => {
    expect(findTextLineAt(lines, { x: 50, y: 500, pressure: 1 })).toBeNull();
  });
});
