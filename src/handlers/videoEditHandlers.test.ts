// handlers/videoEditHandlers.test.ts
//
// Unit tests for the pure clip/overlay logic in videoEditHandlers.ts - no React, no Tauri, no
// DOM. These are exactly the functions a future Tauri/React version bump should leave completely
// unchanged; if one of these breaks, the app's actual editing behavior changed, not just plumbing.
import { describe, expect, it } from "vitest";
import {
  applyAutoZoomAtClicks,
  bringOverlayToFront,
  clipIndexAt,
  deleteClipAt,
  deleteOverlay,
  duplicateOverlay,
  duplicateTimedOverlay,
  insertClip,
  moveOverlayTime,
  overlaysActiveAt,
  removeSilentRanges,
  reorderClip,
  resizeAudioOverlayTime,
  resizeClipEdge,
  resizeOverlayTime,
  sendOverlayToBack,
  splitClipAt,
  toKeepSegments,
  updateClip,
  updateOverlay,
} from "./videoEditHandlers";
import { AudioOverlay, Clip, TextOverlay } from "../utils/videoEditTypes";

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return { id: "clip-1", sourcePath: "video.mp4", start: 0, end: 10, ...overrides };
}

function makeTextOverlay(overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: "overlay-1",
    text: "hello",
    color: "#fff",
    x: 0.1,
    y: 0.1,
    width: 0.3,
    height: 0.1,
    fontSize: 24,
    startTime: 1,
    endTime: 5,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeAudioOverlay(overrides: Partial<AudioOverlay> = {}): AudioOverlay {
  return {
    id: "audio-1",
    src: "music.mp3",
    sourceDuration: 20,
    startTime: 2,
    endTime: 8,
    trimStart: 0,
    volume: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("toKeepSegments", () => {
  it("maps clips to export-ready segments in the same order, sanitizing crop", () => {
    const clips = [
      makeClip({ id: "a", start: 0, end: 5 }),
      makeClip({ id: "b", start: 5, end: 10, crop: { x: 0, y: 0, width: NaN, height: 1 } }),
    ];
    const segments = toKeepSegments(clips);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ sourcePath: "video.mp4", start: 0, end: 5 });
    // A crop with a non-finite width is dropped back to "uncropped" rather than sent to export.
    expect(segments[1].crop).toBeUndefined();
  });

  it("carries speed and noiseReduction through unchanged", () => {
    const [segment] = toKeepSegments([makeClip({ speed: 1.5, noiseReduction: 0.5 })]);
    expect(segment.speed).toBe(1.5);
    expect(segment.noiseReduction).toBe(0.5);
  });

  it("keeps a valid crop untouched", () => {
    const crop = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    const [segment] = toKeepSegments([makeClip({ crop })]);
    expect(segment.crop).toEqual(crop);
  });
});

describe("clipIndexAt", () => {
  const clips = [makeClip({ id: "a", sourcePath: "x.mp4", start: 0, end: 5 }), makeClip({ id: "b", sourcePath: "y.mp4", start: 0, end: 5 })];

  it("finds the clip matching both sourcePath and time range", () => {
    expect(clipIndexAt(clips, "y.mp4", 2)).toBe(1);
  });

  it("returns -1 when the time falls in another file's overlapping range", () => {
    // Both clips span [0,5) in source time but belong to different files - sourcePath disambiguates.
    expect(clipIndexAt(clips, "z.mp4", 2)).toBe(-1);
  });

  it("end time is exclusive", () => {
    expect(clipIndexAt(clips, "x.mp4", 5)).toBe(-1);
  });
});

describe("splitClipAt", () => {
  it("splits into two adjacent clips carrying the look/motion effects forward", () => {
    const clip = makeClip({ start: 0, end: 10, colorFilter: { preset: "bw", intensity: 1 }, speed: 2 });
    const result = splitClipAt([clip], 0, 4);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 0, end: 4, speed: 2, colorFilter: { preset: "bw", intensity: 1 } });
    expect(result[1]).toMatchObject({ start: 4, end: 10, speed: 2 });
    expect(result[0].id).not.toBe(result[1].id);
  });

  it("only the first half keeps transitionIn", () => {
    const clip = makeClip({ start: 0, end: 10, transitionIn: { type: "fade", duration: 0.5 } });
    const [first, second] = splitClipAt([clip], 0, 4);
    expect(first.transitionIn).toEqual({ type: "fade", duration: 0.5 });
    expect(second.transitionIn).toBeUndefined();
  });

  it("is a no-op when the split point is too close to either edge", () => {
    const clips = [makeClip({ start: 0, end: 10 })];
    expect(splitClipAt(clips, 0, 0.01)).toBe(clips); // too close to start
    expect(splitClipAt(clips, 0, 9.99)).toBe(clips); // too close to end
  });

  it("is a no-op for an out-of-range index", () => {
    const clips = [makeClip()];
    expect(splitClipAt(clips, 5, 4)).toBe(clips);
  });
});

describe("removeSilentRanges", () => {
  it("keeps the non-silent pieces and drops the silent ones", () => {
    const clip = makeClip({ start: 0, end: 10 });
    const result = removeSilentRanges([clip], "clip-1", [{ start: 3, end: 6 }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 0, end: 3 });
    expect(result[1]).toMatchObject({ start: 6, end: 10 });
  });

  it("intersects ranges against the clip's own bounds rather than trusting the caller", () => {
    // detect_silence scans the WHOLE source file - a range starting before this clip's own start
    // must be clamped, not applied as-is.
    const clip = makeClip({ start: 5, end: 10 });
    const result = removeSilentRanges([clip], "clip-1", [{ start: 0, end: 7 }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ start: 7, end: 10 });
  });

  it("removes the clip entirely when it's silent throughout", () => {
    const clip = makeClip({ start: 0, end: 10 });
    const result = removeSilentRanges([clip], "clip-1", [{ start: 0, end: 10 }]);
    expect(result).toHaveLength(0);
  });

  it("only the first kept piece retains transitionIn", () => {
    const clip = makeClip({ start: 0, end: 10, transitionIn: { type: "fade", duration: 0.5 } });
    const result = removeSilentRanges([clip], "clip-1", [{ start: 3, end: 6 }]);
    expect(result[0].transitionIn).toEqual({ type: "fade", duration: 0.5 });
    expect(result[1].transitionIn).toBeUndefined();
  });

  it("is a no-op when no range actually overlaps the clip", () => {
    const clips = [makeClip({ start: 0, end: 10 })];
    expect(removeSilentRanges(clips, "clip-1", [{ start: 20, end: 25 }])).toBe(clips);
  });
});

describe("applyAutoZoomAtClicks", () => {
  it("inserts a zoom-in/zoom-out pair around a click roughly in the middle", () => {
    const clip = makeClip({ start: 0, end: 10 });
    const result = applyAutoZoomAtClicks([clip], "clip-1", [{ time: 5, x: 0.5, y: 0.5 }]);
    // lead-in piece, zoom-in, zoom-out, trailing piece
    expect(result.length).toBeGreaterThanOrEqual(3);
    const kenBurnsPresets = result.map((c) => c.kenBurns?.preset).filter(Boolean);
    expect(kenBurnsPresets).toEqual(["zoom-in", "zoom-out"]);
    // Segments stay contiguous and cover the whole original clip.
    expect(result[0].start).toBe(0);
    expect(result[result.length - 1].end).toBe(10);
  });

  it("skips a click too close to the clip's own edge to fit a full zoom window", () => {
    const clips = [makeClip({ start: 0, end: 1 })]; // too short for the ~3.1s zoom envelope
    const result = applyAutoZoomAtClicks(clips, "clip-1", [{ time: 0.5, x: 0.5, y: 0.5 }]);
    // The click doesn't get its own zoom (no room for it), but the clip still comes back as one
    // piece spanning its original range - just rebuilt (new id), not the same object reference.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ start: 0, end: 1 });
    expect(result[0].kenBurns).toBeUndefined();
  });

  it("ignores clicks outside the clip's own [start,end) range", () => {
    const clips = [makeClip({ start: 5, end: 10 })];
    expect(applyAutoZoomAtClicks(clips, "clip-1", [{ time: 2, x: 0.5, y: 0.5 }])).toBe(clips);
  });
});

describe("deleteClipAt / reorderClip / insertClip", () => {
  it("deleteClipAt removes exactly the targeted clip", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" }), makeClip({ id: "c" })];
    const result = deleteClipAt(clips, 1);
    expect(result.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("reorderClip moves a clip to a new position without touching its own start/end", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" }), makeClip({ id: "c" })];
    const result = reorderClip(clips, 0, 2);
    expect(result.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("reorderClip clamps an out-of-range target index", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" })];
    const result = reorderClip(clips, 0, 99);
    expect(result.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("insertClip clamps the insertion index into range", () => {
    const clips = [makeClip({ id: "a" })];
    const inserted = makeClip({ id: "new" });
    expect(insertClip(clips, 99, inserted).map((c) => c.id)).toEqual(["a", "new"]);
    expect(insertClip(clips, -5, inserted).map((c) => c.id)).toEqual(["new", "a"]);
  });
});

describe("resizeClipEdge", () => {
  it("clamps the start edge against the opposite edge minus the minimum clip length", () => {
    const clips = [makeClip({ id: "a", start: 2, end: 10 })];
    const result = resizeClipEdge(clips, "a", "start", 100, 20); // way past `end`
    expect(result[0].start).toBeLessThan(10);
    expect(result[0].end).toBe(10);
  });

  it("clamps the end edge against maxEnd (the source file's own duration)", () => {
    const clips = [makeClip({ id: "a", start: 0, end: 5 })];
    const result = resizeClipEdge(clips, "a", "end", 8, 100);
    expect(result[0].end).toBe(8);
  });

  it("leaves other clips untouched", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b", start: 20, end: 30 })];
    const result = resizeClipEdge(clips, "a", "end", 100, 5);
    expect(result[1]).toEqual(clips[1]);
  });
});

describe("updateClip", () => {
  it("merges the patch into the matching clip only", () => {
    const clips = [makeClip({ id: "a" }), makeClip({ id: "b" })];
    const result = updateClip(clips, "a", { speed: 2, noiseReduction: 0.5 });
    expect(result[0]).toMatchObject({ speed: 2, noiseReduction: 0.5 });
    expect(result[1]).toEqual(clips[1]);
  });

  it("is a no-op (by value) for an unknown id", () => {
    const clips = [makeClip({ id: "a" })];
    expect(updateClip(clips, "missing", { speed: 2 })).toEqual(clips);
  });
});

describe("generic overlay CRUD (updateOverlay / deleteOverlay / overlaysActiveAt)", () => {
  it("updateOverlay merges the patch and bumps updatedAt", () => {
    const overlays = [makeTextOverlay({ id: "a", updatedAt: 0 })];
    const result = updateOverlay(overlays, "a", { text: "changed" });
    expect(result[0].text).toBe("changed");
    expect(result[0].updatedAt).toBeGreaterThan(0);
  });

  it("deleteOverlay removes only the matching overlay", () => {
    const overlays = [makeTextOverlay({ id: "a" }), makeTextOverlay({ id: "b" })];
    expect(deleteOverlay(overlays, "a").map((o) => o.id)).toEqual(["b"]);
  });

  it("overlaysActiveAt is [start,end) - inclusive start, exclusive end", () => {
    const overlays = [makeTextOverlay({ startTime: 1, endTime: 5 })];
    expect(overlaysActiveAt(overlays, 1)).toHaveLength(1);
    expect(overlaysActiveAt(overlays, 4.999)).toHaveLength(1);
    expect(overlaysActiveAt(overlays, 5)).toHaveLength(0);
    expect(overlaysActiveAt(overlays, 0.999)).toHaveLength(0);
  });
});

describe("resizeOverlayTime / moveOverlayTime", () => {
  it("resizeOverlayTime clamps the start edge to leave the minimum overlay duration", () => {
    const overlays = [makeTextOverlay({ id: "a", startTime: 1, endTime: 5 })];
    const result = resizeOverlayTime(overlays, "a", "start", 100, 4.99);
    expect(result[0].startTime).toBeLessThanOrEqual(4.9); // MIN_OVERLAY_DURATION away from endTime
  });

  it("moveOverlayTime preserves duration while shifting both edges", () => {
    const overlays = [makeTextOverlay({ id: "a", startTime: 1, endTime: 5 })]; // duration 4
    const result = moveOverlayTime(overlays, "a", 10, 100);
    expect(result[0].startTime).toBe(10);
    expect(result[0].endTime).toBe(14);
  });

  it("moveOverlayTime clamps so the range never slides past the timeline's own end", () => {
    const overlays = [makeTextOverlay({ id: "a", startTime: 1, endTime: 5 })]; // duration 4
    const result = moveOverlayTime(overlays, "a", 99, 10); // maxEnd = 10
    expect(result[0].endTime).toBe(10);
    expect(result[0].startTime).toBe(6);
  });
});

describe("duplicateOverlay / bringOverlayToFront / sendOverlayToBack", () => {
  it("duplicateOverlay offsets position and assigns a new id", () => {
    const original = makeTextOverlay({ id: "a", x: 0.5, y: 0.5 });
    const copy = duplicateOverlay(original);
    expect(copy.id).not.toBe(original.id);
    expect(copy.x).toBeGreaterThan(original.x);
    expect(copy.y).toBeGreaterThan(original.y);
  });

  it("duplicateOverlay clamps position at the frame's own edge", () => {
    const original = makeTextOverlay({ x: 0.99, y: 0.99 });
    const copy = duplicateOverlay(original);
    expect(copy.x).toBeLessThanOrEqual(1);
    expect(copy.y).toBeLessThanOrEqual(1);
  });

  it("bringOverlayToFront moves the overlay to the end of the array", () => {
    const overlays = [makeTextOverlay({ id: "a" }), makeTextOverlay({ id: "b" }), makeTextOverlay({ id: "c" })];
    expect(bringOverlayToFront(overlays, "a").map((o) => o.id)).toEqual(["b", "c", "a"]);
  });

  it("sendOverlayToBack moves the overlay to the start of the array", () => {
    const overlays = [makeTextOverlay({ id: "a" }), makeTextOverlay({ id: "b" }), makeTextOverlay({ id: "c" })];
    expect(sendOverlayToBack(overlays, "c").map((o) => o.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when already at the target end", () => {
    const overlays = [makeTextOverlay({ id: "a" }), makeTextOverlay({ id: "b" })];
    expect(bringOverlayToFront(overlays, "b")).toBe(overlays);
    expect(sendOverlayToBack(overlays, "a")).toBe(overlays);
  });
});

describe("resizeAudioOverlayTime", () => {
  it("trims into the source when dragging the start edge - trimStart tracks the shift", () => {
    const overlays = [makeAudioOverlay({ id: "a", startTime: 2, endTime: 8, trimStart: 1, sourceDuration: 20 })];
    const result = resizeAudioOverlayTime(overlays, "a", "start", 100, 4);
    expect(result[0].startTime).toBe(4);
    expect(result[0].trimStart).toBe(3); // shifted by the same +2 the startTime moved
  });

  it("can't reveal more of the source than exists before the current trim window", () => {
    // trimStart=1 means only 1s of source exists before the current window - dragging start
    // earlier than that (to startTime - trimStart = 1) must clamp, not go to 0.
    const overlays = [makeAudioOverlay({ id: "a", startTime: 2, endTime: 8, trimStart: 1, sourceDuration: 20 })];
    const result = resizeAudioOverlayTime(overlays, "a", "start", 100, -5);
    expect(result[0].startTime).toBe(1);
    expect(result[0].trimStart).toBe(0);
  });

  it("can't extend the end edge past what's left of the source", () => {
    // trimStart=15, duration=5 -> trimEnd=20 = sourceDuration exactly, so there's zero room left.
    const overlays = [makeAudioOverlay({ id: "a", startTime: 2, endTime: 7, trimStart: 15, sourceDuration: 20 })];
    const result = resizeAudioOverlayTime(overlays, "a", "end", 100, 50);
    expect(result[0].endTime).toBe(7); // unchanged - no room to extend into
  });
});

describe("duplicateTimedOverlay", () => {
  it("offsets the time range by the fixed duplicate offset", () => {
    const original = makeTextOverlay({ startTime: 1, endTime: 3 }); // duration 2
    const copy = duplicateTimedOverlay(original, 100);
    expect(copy.endTime - copy.startTime).toBe(2); // duration preserved
    expect(copy.startTime).toBeGreaterThan(original.startTime);
  });

  it("clamps duration itself when the overlay is already longer than the available timeline", () => {
    const original = makeTextOverlay({ startTime: 0, endTime: 50 }); // duration 50
    const copy = duplicateTimedOverlay(original, 10); // timeline only 10s long
    expect(copy.endTime - copy.startTime).toBeLessThanOrEqual(10);
    expect(copy.endTime).toBeLessThanOrEqual(10);
  });
});
