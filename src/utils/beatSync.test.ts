// Covers utils/beatSync.ts.
import { describe, expect, it } from "vitest";
import { beatOutputTimes, fitImageClipsToBeats } from "./beatSync";
import type { AudioOverlay, Clip } from "./videoEditTypes";

const music = (extra: Partial<AudioOverlay> = {}): AudioOverlay => ({
  id: "m", src: "song.mp3", startTime: 1, endTime: 9, trimStart: 2, sourceDuration: 60, volume: 1,
  createdAt: 0, updatedAt: 0, beats: [1, 2.5, 3, 3.5, 6, 10, 11], ...extra,
});
const image = (id: string, seconds: number): Clip => ({ id, sourcePath: `${id}.jpg`, start: 0, end: seconds });

describe("beatOutputTimes", () => {
  it("maps the beats inside the trimmed part of a track onto the timeline", () => {
    // Track plays source 2..10 at output 1..9: beats 2.5 3 3.5 6 10 -> 1.5 2 2.5 5 9.
    expect(beatOutputTimes([music()])).toEqual([1.5, 2, 2.5, 5, 9]);
    expect(beatOutputTimes([music({ muted: true })])).toEqual([]);
  });
});

describe("fitImageClipsToBeats", () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

  it("ends every image on a beat, the chosen number of beats apart", () => {
    const fitted = fitImageClipsToBeats([image("a", 5), image("b", 5), image("c", 5)], beats, 2);
    expect(fitted.map((c) => c.end)).toEqual([1, 1, 1]);
  });

  it("keeps video clips as they are and realigns the next image", () => {
    const video: Clip = { id: "v", sourcePath: "v.mp4", start: 0, end: 0.7 };
    const fitted = fitImageClipsToBeats([video, image("a", 5)], beats, 1);
    expect(fitted[0]).toBe(video);
    // The video ends off the beat at 0.7s - the image runs to the next beat (1.0s), back on the grid.
    expect(fitted[1].end).toBeCloseTo(0.3);
  });

  it("leaves images past the last beat alone", () => {
    const fitted = fitImageClipsToBeats([image("a", 3), image("b", 3), image("c", 3)], beats, 4);
    expect(fitted[0].end).toBe(2);
    expect(fitted[1].end).toBe(2);
    expect(fitted[2].end).toBe(3);
  });
});
