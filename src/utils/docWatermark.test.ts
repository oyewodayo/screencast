import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_WATERMARK, hasWatermark, normalizeWatermark, printWatermarkCss, readWatermark, svgDataUrl, watermarkSvg, writeWatermark, type DocWatermark } from "./docWatermark";

const text: DocWatermark = { ...DEFAULT_WATERMARK, kind: "text", text: "Draft <1> & co" };
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("normalizeWatermark", () => {
  it("rejects bad values and an image kind with no usable image", () => {
    const n = normalizeWatermark({ kind: "image", image: "javascript:alert(1)", opacity: 9, color: "red", layout: "sideways" });
    expect(n.kind).toBe("none");
    expect(n.image).toBeNull();
    expect(n.opacity).toBe(1);
    expect(n.color).toBe(DEFAULT_WATERMARK.color);
    expect(n.layout).toBe("diagonal");
  });

  it("keeps a valid image", () => {
    expect(normalizeWatermark({ kind: "image", image: PNG, imageAspect: 2 })).toMatchObject({ kind: "image", image: PNG, imageAspect: 2 });
  });
});

describe("watermarkSvg", () => {
  it("draws nothing when off", () => {
    expect(watermarkSvg(DEFAULT_WATERMARK, 816, 1056)).toBe("");
    expect(hasWatermark({ ...text, text: "   " })).toBe(false);
  });

  it("escapes the text and turns a diagonal along the page's own diagonal", () => {
    const svg = watermarkSvg(text, 816, 1056);
    expect(svg).toContain(">Draft &lt;1&gt; &amp; co</text>");
    expect(svg).toContain(`rotate(-${((Math.atan2(1056, 816) * 180) / Math.PI).toFixed(2)} 408 528)`);
    expect(svg).toContain('fill-opacity="0.3"');
  });

  it("keeps a horizontal mark level and smaller sizes smaller", () => {
    const size = (s: string) => Number(/font-size="([\d.]+)"/.exec(s)![1]);
    const fit = watermarkSvg({ ...text, layout: "horizontal" }, 816, 1056);
    expect(fit).toContain("rotate(0.00 408 528)");
    expect(size(watermarkSvg({ ...text, layout: "horizontal", size: "small" }, 816, 1056))).toBeLessThan(size(fit));
  });

  it("centres an image at its scale, greyed when washed out", () => {
    const svg = watermarkSvg({ ...DEFAULT_WATERMARK, kind: "image", image: PNG, imageAspect: 2, imageScale: 0.5 }, 800, 1000);
    expect(svg).toContain('x="200.0" y="400.0" width="400.0" height="200.0"');
    expect(svg).toContain('filter="url(#w)"');
  });
});

describe("printWatermarkCss", () => {
  it("is an @page background, left off the first page when asked", () => {
    const url = svgDataUrl(watermarkSvg(text, 816, 1056));
    expect(printWatermarkCss(text, url)).toMatch(/^@page \{ background-image: url\("data:image\/svg\+xml,/);
    expect(printWatermarkCss({ ...text, skipFirstPage: true }, url)).toContain("@page :first { background-image: none; }");
    expect(printWatermarkCss(text, "")).toBe("");
  });
});

describe("readWatermark / writeWatermark", () => {
  it("round-trips through the Y.Doc", () => {
    const ydoc = new Y.Doc();
    expect(readWatermark(ydoc).kind).toBe("none");
    writeWatermark(ydoc, text);
    expect(readWatermark(ydoc)).toEqual(normalizeWatermark(text));
  });
});
