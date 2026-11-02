import { describe, expect, it } from "vitest";
import { creditsFor, defaultPart, MusicTrack, searchTracks, snapToBeat, suggestTracks } from "./musicLibrary";
import { duckEnvelopeFor, duckGainAt, invertRanges, mergeRanges, speechTimeline, DUCK_ATTACK_SEC, DUCK_RELEASE_SEC } from "./musicDucking";
import { AudioOverlay, Clip } from "./videoEditTypes";

const asset = { url: "x.m4a", size: 1, sha256: "a".repeat(64) };
const track = (id: string, over: Partial<MusicTrack> = {}): MusicTrack => ({
  id,
  title: id,
  artist: "Artist",
  kind: "music",
  moods: [],
  tags: [],
  duration: 120,
  peaks: [],
  file: asset,
  license: { name: "CC0-1.0" },
  ...over,
});

describe("searchTracks", () => {
  const tracks = [
    track("a", { title: "Morning Coffee", genre: "Lo-fi", moods: ["chill"] }),
    track("b", { title: "City Lights", artist: "Neon", moods: ["energetic"] }),
    track("c", { title: "Chill Out", moods: ["calm"] }),
  ];
  it("needs every word to match, title hits first", () => {
    expect(searchTracks(tracks, "chill").map((t) => t.id)).toEqual(["c", "a"]);
    expect(searchTracks(tracks, "lo-fi chill").map((t) => t.id)).toEqual(["a"]);
    expect(searchTracks(tracks, "neon").map((t) => t.id)).toEqual(["b"]);
    expect(searchTracks(tracks, "  ")).toHaveLength(3);
    expect(searchTracks(tracks, "jazz")).toHaveLength(0);
  });
});

describe("suggestTracks", () => {
  const calm = track("calm", { energy: 1, tags: ["background"] });
  const loud = track("loud", { energy: 5 });
  const short = track("short", { energy: 1, duration: 20 });
  const sfx = track("ding", { kind: "sfx", energy: 1 });
  it("prefers calm, long-enough music under speech and drive under a montage", () => {
    const talk = suggestTracks([loud, short, calm, sfx], { videoDuration: 60, hasSpeech: true, isMontage: false });
    expect(talk[0].id).toBe("calm");
    expect(talk.map((t) => t.id)).not.toContain("ding");
    const montage = suggestTracks([calm, loud], { videoDuration: 60, hasSpeech: false, isMontage: true });
    expect(montage[0].id).toBe("loud");
  });
});

describe("defaultPart / snapToBeat", () => {
  it("starts at the best part when there's room, else as late as fits", () => {
    expect(defaultPart({ duration: 120, highlightStart: 30 }, 40)).toEqual({ start: 30, length: 40 });
    expect(defaultPart({ duration: 120, highlightStart: 100 }, 40)).toEqual({ start: 80, length: 40 });
    expect(defaultPart({ duration: 20, highlightStart: 5 }, 40)).toEqual({ start: 0, length: 20 });
  });
  it("snaps only within tolerance", () => {
    expect(snapToBeat(10.1, [9.5, 10, 10.5])).toBe(10);
    expect(snapToBeat(10.25, [9, 11])).toBe(10.25);
    expect(snapToBeat(3, undefined)).toBe(3);
  });
});

describe("creditsFor", () => {
  it("lists CC-BY tracks once and skips CC0", () => {
    const by = { trackId: "b", title: "Song", artist: "Kev", kind: "music" as const, license: "CC-BY-4.0" };
    const zero = { trackId: "z", title: "Free", artist: "X", kind: "music" as const, license: "CC0-1.0" };
    expect(creditsFor([by, zero, by, undefined])).toBe('Music:\n"Song" by Kev, licensed under CC BY 4.0');
    expect(creditsFor([zero])).toBe("");
  });
});

describe("music ducking", () => {
  it("inverts and merges ranges", () => {
    expect(invertRanges([[2, 3], [5, 6]], 0, 8)).toEqual([[0, 2], [3, 5], [6, 8]]);
    expect(invertRanges([[0, 10]], 2, 4)).toEqual([]);
    expect(mergeRanges([[5, 6], [0, 1], [1.5, 2]], 0.6)).toEqual([[0, 2], [5, 6]]);
  });

  it("maps clip speech onto the output timeline", () => {
    const clips = [
      { id: "1", sourcePath: "a.mp4", start: 10, end: 20 },
      { id: "2", sourcePath: "b.mp4", start: 0, end: 10, speed: 2 },
    ] as Clip[];
    const silences = new Map<string, [number, number][]>([
      ["a.mp4", [[0, 12], [15, 30]]], // speech 12..15 -> output 2..5
      ["b.mp4", [[4, 10]]], // speech 0..4 at 2x -> output 10..12
    ]);
    expect(speechTimeline({ clips, videoAudioMuted: false, audioOverlays: [] }, silences)).toEqual([[2, 5], [10, 12]]);
    expect(speechTimeline({ clips, videoAudioMuted: true, audioOverlays: [] }, silences)).toEqual([]);
  });

  it("eases down before speech, holds, and recovers after", () => {
    const ranges: [number, number][] = [[10, 12]];
    expect(duckGainAt(ranges, 5, 0.25)).toBe(1);
    expect(duckGainAt(ranges, 10 - DUCK_ATTACK_SEC / 2, 0.25)).toBeCloseTo(0.625);
    expect(duckGainAt(ranges, 11, 0.25)).toBe(0.25);
    expect(duckGainAt(ranges, 12 + DUCK_RELEASE_SEC / 2, 0.25)).toBeCloseTo(0.625);
    expect(duckGainAt(ranges, 13, 0.25)).toBe(1);
  });

  it("sends export only the ranges near a ducked overlay", () => {
    const o = { id: "m", src: "m.m4a", startTime: 0, endTime: 8, trimStart: 0, sourceDuration: 60, volume: 1, duckUnderSpeech: true, createdAt: 0, updatedAt: 0 } as AudioOverlay;
    const env = duckEnvelopeFor(o, [[2, 3], [20, 21]]);
    expect(env?.ranges).toEqual([[2, 3]]);
    expect(duckEnvelopeFor({ ...o, duckUnderSpeech: false }, [[2, 3]])).toBeUndefined();
  });
});
