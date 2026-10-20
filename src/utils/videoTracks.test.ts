import { describe, expect, it } from "vitest";
import { compactTracks, exportFades, freeTrack, layerOpacityAt, pipTrack, stackOrder, tracksInUse, videoTrackLabel } from "./videoTracks";

const layer = (id: string, track: number | undefined, startTime: number, endTime: number) => ({ id, track, startTime, endTime });

describe("video tracks", () => {
  it("names tracks after the main video (V1)", () => {
    expect(videoTrackLabel(1)).toBe("V2");
    expect(pipTrack({ track: undefined })).toBe(1);
    expect(pipTrack({ track: 0 })).toBe(1);
  });

  it("composites bottom track first, keeping order within a track", () => {
    const layers = [layer("a", 2, 0, 1), layer("b", undefined, 0, 1), layer("c", 2, 0, 1), layer("d", 1, 0, 1)];
    expect(stackOrder(layers).map((l) => l.id)).toEqual(["b", "d", "a", "c"]);
    expect(tracksInUse(layers)).toEqual([1, 2]);
  });

  it("finds the lowest track free for a time range", () => {
    const layers = [layer("a", 1, 0, 5), layer("b", 2, 4, 8)];
    expect(freeTrack(layers, 5, 6)).toBe(1); // touching the end isn't an overlap
    expect(freeTrack(layers, 3, 6)).toBe(3);
    expect(freeTrack(layers, 0, 2)).toBe(2);
    expect(freeTrack(layers, 0, 2, 1, "a")).toBe(1); // ignoring the layer being moved
  });

  it("fades linearly, each fade capped at half the layer", () => {
    const o = { opacity: 0.8, fadeIn: 1, fadeOut: 5, startTime: 10, endTime: 14 };
    expect(layerOpacityAt(o, 10)).toBe(0);
    expect(layerOpacityAt(o, 10.5)).toBeCloseTo(0.4);
    expect(layerOpacityAt(o, 11.5)).toBeCloseTo(0.8);
    expect(layerOpacityAt(o, 13)).toBeCloseTo(0.4); // the 5 s fade-out is capped to 2 s, from 12 s
    expect(layerOpacityAt(o, 14)).toBe(0);
    expect(exportFades(o)).toEqual({ fadeIn: 1, fadeOut: 2 });
    expect(layerOpacityAt({ startTime: 0, endTime: 1 }, 0.5)).toBe(1);
  });

  it("renumbers tracks without gaps, carrying hidden flags", () => {
    const layers = [layer("a", 3, 0, 1), layer("b", 1, 0, 1), layer("c", 5, 0, 1)];
    const { layers: out, hidden } = compactTracks(layers, [3, 4]);
    expect(out.map((l) => l.track)).toEqual([2, 1, 3]);
    expect(hidden).toEqual([2]);
    const same = [layer("a", 1, 0, 1), layer("b", 2, 0, 1)];
    expect(compactTracks(same, undefined).layers).toBe(same);
  });
});
