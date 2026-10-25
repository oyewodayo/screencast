import { describe, expect, it } from "vitest";
import { resolveNodeFill } from "./whiteboardTypes";

describe("resolveNodeFill", () => {
  it("leaves an opaque or unset-opacity fill untouched", () => {
    expect(resolveNodeFill({ fillColor: "#ff0000" })).toBe("#ff0000");
    expect(resolveNodeFill({ fillColor: "#ff0000", fillOpacity: 1 })).toBe("#ff0000");
  });

  it("folds the opacity in as a hex alpha channel", () => {
    expect(resolveNodeFill({ fillColor: "#ff0000", fillOpacity: 0.5 })).toBe("#ff000080");
    expect(resolveNodeFill({ fillColor: "#abc", fillOpacity: 0.25 })).toBe("#aabbcc40");
  });

  it("treats no fill and fully transparent alike", () => {
    expect(resolveNodeFill({ fillColor: null, fillOpacity: 0.5 })).toBeNull();
    expect(resolveNodeFill({ fillColor: "#ffffff", fillOpacity: 0 })).toBeNull();
  });

  it("keeps a colour it can't add alpha to solid rather than breaking it", () => {
    expect(resolveNodeFill({ fillColor: "rgb(1, 2, 3)", fillOpacity: 0.5 })).toBe("rgb(1, 2, 3)");
  });
});
