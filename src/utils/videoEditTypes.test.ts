// Covers the image-clip / video-project helpers in utils/videoEditTypes.ts - what "Create video
// from images" (NewVideoProjectDialog) seeds a new project's timeline with.
import { describe, expect, it } from "vitest";
import { IMAGE_CLIP_MAX_SECONDS, createProjectState, isImageClipPath, isVideoEditState, isVideoProjectPath } from "./videoEditTypes";

describe("isImageClipPath / isVideoProjectPath", () => {
  it("recognizes still images case-insensitively (HEIC included), but not video", () => {
    expect(isImageClipPath("C:\\photos\\IMG_1.JPG")).toBe(true);
    expect(isImageClipPath("scan.webp")).toBe(true);
    expect(isImageClipPath("IMG_0042.HEIC")).toBe(true);
    expect(isImageClipPath("clip.mp4")).toBe(false);
  });

  it("recognizes project files", () => {
    expect(isVideoProjectPath("C:\\lib\\Trip.BriefVideo")).toBe(true);
    expect(isVideoProjectPath("Trip.mp4")).toBe(false);
  });
});

describe("createProjectState", () => {
  const images = ["a.jpg", "b.png", "c.jpg"];

  it("makes one clip per image, in order, each the chosen length", () => {
    const state = createProjectState(images, { imageDuration: 4, kenBurns: false, transition: null });
    expect(state.clips.map((c) => c.sourcePath)).toEqual(images);
    expect(state.clips.every((c) => c.start === 0 && c.end === 4)).toBe(true);
    expect(state.clips.every((c) => !c.kenBurns && !c.transitionIn)).toBe(true);
    expect(isVideoEditState(state)).toBe(true);
  });

  it("adds varied Ken Burns motion and a transition into every image after the first", () => {
    const state = createProjectState(images, { imageDuration: 5, kenBurns: true, transition: "fade" });
    expect(state.clips[0].transitionIn).toBeUndefined();
    expect(state.clips[1].transitionIn).toEqual({ type: "fade", duration: 1 });
    expect(new Set(state.clips.map((c) => c.kenBurns?.preset)).size).toBe(3);
  });

  it("keeps a transition shorter than its clip, and clamps clip length", () => {
    const short = createProjectState(images, { imageDuration: 1.5, kenBurns: false, transition: "fade" });
    expect(short.clips[1].transitionIn!.duration).toBeCloseTo(0.5);
    const long = createProjectState(images, { imageDuration: 10_000, kenBurns: false, transition: null });
    expect(long.clips[0].end).toBe(IMAGE_CLIP_MAX_SECONDS);
  });

  it("allows an empty (blank) timeline", () => {
    const state = createProjectState([], { imageDuration: 5, kenBurns: true, transition: "fade" });
    expect(state.clips).toEqual([]);
    expect(isVideoEditState(state)).toBe(true);
  });
});
