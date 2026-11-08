// Covers utils/transcriptEdit.ts (edit by transcript) and the cutClipRanges handler it feeds.
import { describe, expect, it } from "vitest";
import { buildTranscriptTokens, cutsDuration, cutsForLongPauses, cutsForTokens, fillerKeys, isFillerWord, repeatKeys, withDetectedPauses } from "./transcriptEdit";
import { cutClipRanges } from "../handlers/videoEditHandlers";
import { CaptionTrack, Clip } from "./videoEditTypes";
import { defaultCaptionSettings } from "./captions";

const track = (words: [number, number, string][], path = "a.mp4"): CaptionTrack => ({
  language: "en",
  transcripts: { [path]: words.map(([start, end, text]) => ({ start, end, text })) },
  settings: defaultCaptionSettings(),
});
const clip = (id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: "a.mp4", start, end, ...extra });

describe("buildTranscriptTokens", () => {
  const words: [number, number, string][] = [
    [0.5, 0.8, "So"],
    [0.9, 1.2, "um,"],
    [1.3, 1.6, "the"],
    [1.7, 2.0, "the"],
    [4.0, 4.4, "plan."],
  ];

  it("lists words in playback order with output times, fillers, repeats and pauses", () => {
    const tokens = buildTranscriptTokens([clip("c1", 0, 10)], track(words));
    expect(tokens.map((t) => t.text)).toEqual(["So", "um,", "the", "the", "plan."]);
    expect(tokens[1].isFiller).toBe(true);
    expect(tokens[2].isRepeat).toBe(true);
    expect(tokens[3].isRepeat).toBe(false);
    expect(tokens[4].pauseBefore).toBeCloseTo(2.0);
    expect(tokens[4].outputStart).toBeCloseTo(4.0);
  });

  it("follows clip order, trims and speed", () => {
    const tokens = buildTranscriptTokens([clip("c2", 3.5, 5, { speed: 2 }), clip("c1", 0, 1.25)], track(words));
    expect(tokens.map((t) => [t.text, t.clipId])).toEqual([
      ["plan.", "c2"],
      ["So", "c1"],
      ["um,", "c1"],
    ]);
    expect(tokens[0].outputStart).toBeCloseTo(0.25); // (4.0 - 3.5) / 2
    expect(tokens[1].outputStart).toBeCloseTo(0.75 + 0.5); // after c2's 0.75s, then 0.5s in
  });

  it("keeps a final word timed past the end of the clip", () => {
    const tokens = buildTranscriptTokens([clip("c1", 0, 4.2)], track(words));
    expect(tokens[tokens.length - 1].text).toBe("plan.");
  });

  it("is empty without captions", () => {
    expect(buildTranscriptTokens([clip("c1", 0, 10)], null)).toEqual([]);
  });
});

describe("cuts", () => {
  const words: [number, number, string][] = [
    [0.5, 0.8, "We"],
    [0.9, 1.2, "um"],
    [1.6, 2.0, "went"],
    [5.0, 5.4, "home."],
  ];
  const clips = [clip("c1", 0, 10)];
  const tokens = buildTranscriptTokens(clips, track(words));

  it("removes a word and the pause after it, up to just before the next word", () => {
    const cuts = cutsForTokens(tokens, new Set([tokens[1].key]), clips);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBeCloseTo(0.86);
    expect(cuts[0].end).toBeCloseTo(1.56);
  });

  it("joins consecutive selected words into one cut, and runs a final cut to just after the last word", () => {
    const cuts = cutsForTokens(tokens, new Set([tokens[2].key, tokens[3].key]), clips);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBeCloseTo(1.56);
    expect(cuts[0].end).toBeCloseTo(5.52);
  });

  it("shortens only pauses longer than the threshold, keeping some silence", () => {
    const cuts = cutsForLongPauses(tokens, 1.0, 0.4);
    expect(cuts).toEqual([{ clipId: "c1", start: 2.2, end: 4.8 }]);
    expect(cutsDuration(cuts, clips)).toBeCloseTo(2.6);
  });

  it("finds fillers and repeats", () => {
    expect([...fillerKeys(tokens)]).toEqual([tokens[1].key]);
    expect(repeatKeys(tokens).size).toBe(0);
    expect(isFillerWord("Uhm...")).toBe(true);
    expect(isFillerWord("umbrella")).toBe(false);
  });
});

describe("measured pauses and edge snapping", () => {
  const words: [number, number, string][] = [
    [0.1, 0.4, "Hello"],
    // Recognition stretched "there" over the 2s pause after it.
    [0.5, 3.0, "there."],
    [3.1, 3.4, "Next"],
  ];
  const clips = [clip("c1", 0, 3.6)];

  it("uses the silence measured in the audio instead of the word gap", () => {
    const tokens = buildTranscriptTokens(clips, track(words));
    expect(tokens[2].pauseBefore).toBeCloseTo(0.1);
    const measured = withDetectedPauses(tokens, { "a.mp4": [{ start: 0.9, end: 2.95 }] });
    expect(measured[2].pauseBefore).toBeCloseTo(2.05);
    const cuts = cutsForLongPauses(measured, 1, 0.3);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].start).toBeCloseTo(1.05);
    expect(cuts[0].end).toBeCloseTo(2.8);
  });

  it("runs a cut to the clip's edge rather than leaving a sliver", () => {
    const tokens = buildTranscriptTokens(clips, track(words));
    const first = cutsForTokens(tokens, new Set([tokens[0].key]), clips);
    expect(first[0].start).toBe(0);
    const last = cutsForTokens(tokens, new Set([tokens[2].key]), clips);
    expect(last[0].end).toBe(3.6);
  });
});

describe("cutClipRanges", () => {
  it("splits a clip around its cuts, keeping its settings and id on the first piece", () => {
    const original = clip("c1", 0, 10, { speed: 1.5, noiseReduction: 0.4, transitionIn: { type: "fade", duration: 1 } });
    const result = cutClipRanges([original], [{ clipId: "c1", start: 2, end: 3 }, { clipId: "c1", start: 6, end: 7 }]);
    expect(result.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [3, 6],
      [7, 10],
    ]);
    expect(result[0].id).toBe("c1");
    expect(result.every((c) => c.speed === 1.5 && c.noiseReduction === 0.4)).toBe(true);
    expect(result[0].transitionIn).toBeDefined();
    expect(result[1].transitionIn).toBeUndefined();
  });

  it("only touches the clip a cut names, even when another clip uses the same source", () => {
    const clips = [clip("c1", 0, 10), clip("c2", 0, 10)];
    const result = cutClipRanges(clips, [{ clipId: "c2", start: 4, end: 5 }]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(clips[0]);
  });

  it("returns the same array when nothing changes", () => {
    const clips = [clip("c1", 0, 10)];
    expect(cutClipRanges(clips, [{ clipId: "other", start: 1, end: 2 }])).toBe(clips);
  });
});
