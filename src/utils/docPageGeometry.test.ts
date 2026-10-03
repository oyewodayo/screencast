import { describe, expect, it } from "vitest";
import { DEFAULT_MARGINS, clampMargin, pageContentHeightPx, pageContentWidthPx } from "./docPageGeometry";
import { cssLengthToIn } from "./docIndentExtension";

describe("page geometry", () => {
  it("subtracts the doc's own margins", () => {
    expect(pageContentHeightPx("letter", null)).toBe(9 * 96);
    expect(pageContentWidthPx("letter", { top: 1, right: 0.5, bottom: 1, left: 1.5 })).toBe(6.5 * 96);
  });

  it("clamps a margin so at least 1in of page remains", () => {
    expect(clampMargin("letter", DEFAULT_MARGINS, "left", 9)).toBe(6.5);
    expect(clampMargin("letter", DEFAULT_MARGINS, "top", -2)).toBe(0);
    expect(clampMargin("a4", { top: 1, right: 3, bottom: 1, left: 1 }, "left", 5)).toBeCloseTo(4.27);
  });
});

describe("cssLengthToIn", () => {
  it("converts absolute units", () => {
    expect(cssLengthToIn("0.5in")).toBe(0.5);
    expect(cssLengthToIn("48px")).toBe(0.5);
    expect(cssLengthToIn("36pt")).toBe(0.5);
    expect(cssLengthToIn("2.54cm")).toBeCloseTo(1);
    expect(cssLengthToIn("-0.25in")).toBe(-0.25);
  });
  it("ignores relative units and junk", () => {
    expect(cssLengthToIn("2em")).toBeNull();
    expect(cssLengthToIn("")).toBeNull();
    expect(cssLengthToIn("auto")).toBeNull();
  });
});
