import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARGINS,
  clampMargin,
  cssPageSize,
  fitMarginsToPage,
  isDarkPageColor,
  normalizePageColor,
  pageContentHeightPx,
  pageContentWidthPx,
  pageFormatForPoints,
  pageHeightPx,
  pageWidthPx,
  type PageFormat,
} from "./docPageGeometry";
import { cssLengthToIn } from "./docIndentExtension";

const letter: PageFormat = { size: "letter", orientation: "portrait" };
const letterLandscape: PageFormat = { size: "letter", orientation: "landscape" };
const a4: PageFormat = { size: "a4", orientation: "portrait" };

describe("page geometry", () => {
  it("subtracts the doc's own margins", () => {
    expect(pageContentHeightPx(letter, null)).toBe(9 * 96);
    expect(pageContentWidthPx(letter, { top: 1, right: 0.5, bottom: 1, left: 1.5 })).toBe(6.5 * 96);
  });

  it("clamps a margin so at least 1in of page remains", () => {
    expect(clampMargin(letter, DEFAULT_MARGINS, "left", 9)).toBe(6.5);
    expect(clampMargin(letter, DEFAULT_MARGINS, "top", -2)).toBe(0);
    expect(clampMargin(a4, { top: 1, right: 3, bottom: 1, left: 1 }, "left", 5)).toBeCloseTo(4.27);
  });

  it("lays a landscape page out wide and short", () => {
    expect(pageWidthPx(letterLandscape)).toBe(11 * 96);
    expect(pageHeightPx(letterLandscape)).toBe(8.5 * 96);
    expect(pageContentHeightPx(letterLandscape, null)).toBe(6.5 * 96);
    expect(pageContentWidthPx(letterLandscape, null)).toBe(9 * 96);
    expect(cssPageSize(letterLandscape)).toBe("letter landscape");
    expect(cssPageSize(a4)).toBe("a4 portrait");
  });

  it("clamps margins against the turned page", () => {
    // 11in wide in landscape, so a left margin can grow to 11 - 1 - 1 = 9in...
    expect(clampMargin(letterLandscape, DEFAULT_MARGINS, "left", 12)).toBe(9);
    // ...but only 8.5in tall: the top margin stops at 6.5in.
    expect(clampMargin(letterLandscape, DEFAULT_MARGINS, "top", 12)).toBe(6.5);
  });

  it("shrinks margins that no longer fit after turning the page", () => {
    const wide = { top: 1, right: 4, bottom: 1, left: 4 }; // fits landscape Letter (11in)
    const fitted = fitMarginsToPage(letter, wide); // portrait leaves 8.5 - 1 = 7.5in for both sides
    expect(fitted.left + fitted.right).toBeCloseTo(7.5);
    expect(fitted.left).toBeCloseTo(fitted.right);
    expect(fitMarginsToPage(letterLandscape, DEFAULT_MARGINS)).toEqual(DEFAULT_MARGINS);
  });

  it("recognises paper size and orientation from PDF points", () => {
    expect(pageFormatForPoints(612, 792)).toEqual({ size: "letter", orientation: "portrait" });
    expect(pageFormatForPoints(792, 612)).toEqual({ size: "letter", orientation: "landscape" });
    expect(pageFormatForPoints(842, 595)).toEqual({ size: "a4", orientation: "landscape" });
    expect(pageFormatForPoints(612, 1008)).toEqual({ size: "legal", orientation: "portrait" });
  });
});

describe("page colour", () => {
  it("stores white and malformed colours as no colour", () => {
    expect(normalizePageColor("#FFF8E1")).toBe("#fff8e1");
    expect(normalizePageColor("#ffffff")).toBeNull();
    expect(normalizePageColor("red")).toBeNull();
    expect(normalizePageColor(null)).toBeNull();
  });

  it("knows which papers need light text", () => {
    expect(isDarkPageColor("#1e293b")).toBe(true);
    expect(isDarkPageColor("#fef9c3")).toBe(false);
    expect(isDarkPageColor(null)).toBe(false);
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
