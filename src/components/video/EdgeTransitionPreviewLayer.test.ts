// The video's intro / outro windows (videoEditTypes.ts edgeTransitionWindows - the preview's copy of
// conversion.rs's edge_windows) and which one plays at a moment of the timeline.
import { describe, expect, it } from "vitest";
import { edgeTransitionWindows } from "../../utils/videoEditTypes";
import { edgeAt } from "./EdgeTransitionPreviewLayer";

const fade = (duration: number) => ({ type: "fade" as const, duration });

describe("edgeTransitionWindows", () => {
  it("matches export's clamp: 90% alone, 45% each together, never overlapping", () => {
    expect(edgeTransitionWindows({ intro: fade(3), outro: fade(3) }, 4)).toEqual({ intro: 1.8, outro: 1.8 });
    expect(edgeTransitionWindows({ intro: fade(3), outro: fade(3) }, 20)).toEqual({ intro: 3, outro: 3 });
    expect(edgeTransitionWindows({ intro: fade(3) }, 2)).toEqual({ intro: 1.8, outro: null });
    expect(edgeTransitionWindows({ intro: fade(0), outro: fade(Number.NaN) }, 10)).toEqual({ intro: null, outro: null });
    expect(edgeTransitionWindows(undefined, 10)).toEqual({ intro: null, outro: null });
  });
});

describe("edgeAt", () => {
  const edges = { intro: fade(1), outro: fade(2) };
  it("is the intro over the video's first seconds, from black (p 0) to the video (p 1)", () => {
    expect(edgeAt(edges, 10, 0)).toEqual({ edge: "intro", p: 0 });
    expect(edgeAt(edges, 10, 0.5)).toEqual({ edge: "intro", p: 0.5 });
  });
  it("is nothing in between", () => {
    expect(edgeAt(edges, 10, 1)).toBeNull();
    expect(edgeAt(edges, 10, 7.9)).toBeNull();
  });
  it("is the outro over its last seconds, reaching black at the very end", () => {
    expect(edgeAt(edges, 10, 8)).toEqual({ edge: "outro", p: 0 });
    expect(edgeAt(edges, 10, 9)).toEqual({ edge: "outro", p: 0.5 });
    expect(edgeAt(edges, 10, 10)).toEqual({ edge: "outro", p: 1 });
  });
  it("works on a single short clip with both", () => {
    expect(edgeAt(edges, 2, 0.45)).toEqual({ edge: "intro", p: 0.5 });
    expect(edgeAt(edges, 2, 1.55)?.edge).toBe("outro");
  });
});
