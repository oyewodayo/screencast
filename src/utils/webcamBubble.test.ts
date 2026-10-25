import { describe, expect, it } from "vitest";
import { bubbleRegion, defaultBubbleRegion } from "./webcamBubble";

describe("webcam bubble", () => {
  it("finds the bubble where the recorder put it", () => {
    // 1920x1080, medium circle bottom right: side even(345.6) = 346, margin 48.
    const r = bubbleRegion({ shape: "circle", position: "bottom_right", size: "medium", border: "none", cameraCount: 1 }, 1920, 1080);
    expect(r.shape).toBe("circle");
    expect(r.x * 1920).toBeCloseTo(1920 - 346 - 48, 6);
    expect(r.y * 1080).toBeCloseTo(1080 - 346 - 48, 6);
    expect(r.width * 1920).toBeCloseTo(346, 6);
    expect(r.height * 1080).toBeCloseTo(346, 6);
  });

  it("skips the border and places the second camera beside the first", () => {
    // thin border: even(max(5.76, 2)) = 6; bubble 346 + 12 = 358; gap even(23.04) = 22.
    const s = { shape: "rounded", position: "top_left", size: "medium", border: "thin", cameraCount: 2 };
    const first = bubbleRegion(s, 1920, 1080, 0);
    const second = bubbleRegion(s, 1920, 1080, 1);
    expect(first.x * 1920).toBeCloseTo(48 + 6, 6);
    expect(first.y * 1080).toBeCloseTo(48 + 6, 6);
    expect(second.x * 1920).toBeCloseTo(48 + 358 + 22 + 6, 6);
    expect(first.cornerRadius).toBeCloseTo(43 / 346, 6);
  });

  it("rectangles are 4:3", () => {
    const r = bubbleRegion({ shape: "rectangle", position: "center", size: "small", border: "none", cameraCount: 1 }, 1280, 720);
    // side even(179.2) = 178, height even(133.5) = 134.
    expect(r.width * 1280).toBeCloseTo(178, 6);
    expect(r.height * 720).toBeCloseTo(134, 6);
    expect(defaultBubbleRegion(1280, 720).shape).toBe("circle");
  });
});
