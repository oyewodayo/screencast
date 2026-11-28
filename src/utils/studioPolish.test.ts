import { describe, expect, it } from "vitest";
import {
  buildStudioColorScreenStyle,
  buildStudioImageScreenStyle,
  buildStudioScreenStyle,
  defaultStudioPolishOptions,
  filterClicksForClip,
  filterSilentRangesForClip,
  STUDIO_POLISH_THEMES,
  totalRangeDuration,
} from "./studioPolish";
import { SCREEN_GRADIENTS } from "./screenStyle";

describe("studioPolish", () => {
  it("pre-selects sensible defaults based on recording capabilities", () => {
    const opts = defaultStudioPolishOptions({
      hasExistingFrame: false,
      existingThemeId: null,
      hasSound: true,
      hasClickSidecar: true,
      hasEditablePointer: false,
      shortcutCount: 0,
    });
    expect(opts).toEqual({
      frame: true,
      themeId: "dusk",
      soundPro: true,
      trimSilence: true,
      autoZoom: true,
      pointerAndKeys: false,
    });

    const silentOpts = defaultStudioPolishOptions({
      hasExistingFrame: true,
      existingThemeId: "ocean",
      hasSound: false,
      hasClickSidecar: false,
      hasEditablePointer: true,
      shortcutCount: 4,
    });
    expect(silentOpts.themeId).toBe("ocean");
    expect(silentOpts.soundPro).toBe(false);
    expect(silentOpts.trimSilence).toBe(false);
    expect(silentOpts.autoZoom).toBe(false);
    expect(silentOpts.pointerAndKeys).toBe(true);
  });

  it("preserves existing screen style padding/radius when updating the theme preset", () => {
    const style = buildStudioScreenStyle("graphite", {
      background: { kind: "gradient", preset: "dusk" },
      padding: 0.12,
      radius: 0.04,
      shadow: 0.8,
    });
    expect(style.background).toEqual({ kind: "gradient", preset: "graphite" });
    expect(style.padding).toBe(0.12);
    expect(style.radius).toBe(0.04);
    expect(style.shadow).toBe(0.8);

    const imgStyle = buildStudioImageScreenStyle("C:\\Wallpapers\\studio.png", style);
    expect(imgStyle.background).toEqual({ kind: "image", path: "C:\\Wallpapers\\studio.png" });
    expect(imgStyle.padding).toBe(0.12);

    const colorStyle = buildStudioColorScreenStyle("#1e293b", style);
    expect(colorStyle.background).toEqual({ kind: "color", color: "#1e293b" });
    expect(colorStyle.padding).toBe(0.12);

    expect(STUDIO_POLISH_THEMES.length).toBe(SCREEN_GRADIENTS.length);
    expect(STUDIO_POLISH_THEMES.length).toBeGreaterThanOrEqual(18);
  });

  it("intersects silence ranges and click events against the clip's active trim window", () => {
    const clip = { start: 10, end: 30 };
    const ranges = filterSilentRangesForClip(clip, [
      { start: 2, end: 8 },
      { start: 9, end: 12.5 },
      { start: 20, end: 21.5 },
      { start: 29.98, end: 35 },
    ]);
    expect(ranges).toEqual([
      { start: 10, end: 12.5 },
      { start: 20, end: 21.5 },
    ]);
    expect(totalRangeDuration(ranges)).toBeCloseTo(4.0);

    const clicks = filterClicksForClip(clip, [
      { elapsedSecs: 5, xFraction: 0.5, yFraction: 0.5 },
      { elapsedSecs: 14.2, xFraction: 0.25, yFraction: 0.75 },
      { elapsedSecs: 31, xFraction: 0.1, yFraction: 0.1 },
    ]);
    expect(clicks).toEqual([{ time: 14.2, x: 0.25, y: 0.75 }]);
  });
});
