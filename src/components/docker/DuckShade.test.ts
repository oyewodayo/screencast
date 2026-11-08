import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DuckShade from "./DuckShade";

const props = { startTime: 0, endTime: 20, level: 0.25, pxPerSec: 10, widthPx: 200, heightPx: 48, visible: [0, 200] as [number, number] };

// The curve's points as [x, y].
const points = (svg: string) =>
  [...(/<path d="([^"]+)" fill="none"/.exec(svg)?.[1] ?? "").matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

describe("duck shade", () => {
  it("dips to the duck level under speech and is flat elsewhere", () => {
    const svg = renderToStaticMarkup(React.createElement(DuckShade, { ...props, ranges: [[5, 8]] }));
    const p = points(svg);
    // -12 dB of a 24 dB scale: halfway down a 48 px chip.
    const deepest = Math.max(...p.map(([, y]) => y));
    expect(deepest).toBeCloseTo(24, 0);
    // Fully down between 5 s and 8 s (50..80 px), untouched well before and after.
    for (const [x, y] of p) {
      if (x >= 50 && x <= 80) expect(y).toBeCloseTo(24, 0);
      if (x < 47 || x > 87) expect(y).toBe(0);
    }
  });

  it("draws nothing where no one speaks", () => {
    expect(renderToStaticMarkup(React.createElement(DuckShade, { ...props, ranges: [[40, 50]] }))).toBe("");
  });
});
