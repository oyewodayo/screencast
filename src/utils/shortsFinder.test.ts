// Covers utils/shortsFinder.ts (finding moments that work as shorts) and utils/shortsBuild.ts
// (turning one into a timeline).
import { describe, expect, it } from "vitest";
import { findShortMoments, splitSentences } from "./shortsFinder";
import { buildShort, DEFAULT_SHORT_STYLE, remapKnots, sliceTimeline, tightenedTime } from "./shortsBuild";
import { buildTranscriptTokens, withDetectedPauses } from "./transcriptEdit";
import { defaultCaptionSettings } from "./captions";
import { clipOutputDuration } from "./clipTiming";
import { CaptionTrack, CaptionWord, Clip, createEmptyState, VideoEditState } from "./videoEditTypes";

// A talk as word timings: sentences spoken at `wps` words a second, `gap` seconds between them.
function talk(paragraphs: { sentences: string[]; gapAfter?: number }[], wps = 2.6, gap = 0.35): { words: CaptionWord[]; end: number } {
  const words: CaptionWord[] = [];
  let t = 1;
  for (const p of paragraphs) {
    for (const s of p.sentences) {
      for (const w of s.split(" ")) {
        words.push({ start: t, end: t + 0.8 / wps, text: w });
        t += 1 / wps;
      }
      t += gap;
    }
    t += p.gapAfter ?? 0.8;
  }
  return { words, end: t + 1 };
}

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `and then it was ${topic} thing number ${i} which was kind of there and it was fine.`);

const STRONG = [
  "Why do most people fail at gradient descent?",
  "The biggest mistake is picking the learning rate by guessing.",
  "If the learning rate is too big, gradient descent jumps right over the minimum.",
  "If the learning rate is too small, gradient descent crawls for hours.",
  "So you try a learning rate range test first.",
  "You raise the learning rate every step and watch the loss.",
  "The loss falls, then it explodes.",
  "Pick the learning rate just before it explodes.",
  "That's why the range test beats guessing every single time.",
];

function fixture(gap = 0.35) {
  const { words, end } = talk(
    [
      { sentences: filler("the meeting", 14), gapAfter: 1.5 },
      { sentences: STRONG, gapAfter: 1.5 },
      { sentences: filler("the lunch", 14), gapAfter: 1.5 },
    ],
    2.6,
    gap
  );
  const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: { ...defaultCaptionSettings(), enabled: false } };
  const clips: Clip[] = [{ id: "c1", sourcePath: "a.mp4", start: 0, end }];
  return { words, end, track, clips };
}

describe("splitSentences", () => {
  it("ends sentences at punctuation and at long pauses", () => {
    const words: CaptionWord[] = [
      { start: 0, end: 0.3, text: "Hello" },
      { start: 0.4, end: 0.7, text: "there." },
      { start: 0.8, end: 1.0, text: "Is" },
      { start: 1.1, end: 1.3, text: "it" },
      { start: 1.4, end: 1.6, text: "on?" },
      { start: 1.7, end: 1.9, text: "Wait" },
      { start: 3.5, end: 3.8, text: "okay" },
    ];
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const s = splitSentences(buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end: 5 }], track));
    expect(s.map((x) => x.text)).toEqual(["Hello there.", "Is it on?", "Wait", "okay"]);
    expect(s[1].question).toBe(true);
    // No full stop, but the long pause after it ends it.
    expect(s[2].terminal).toBe(true);
  });
});

// How recognition often transcribes flat or fast speech: commas only (no full stops, no "?"), and
// word timings stretched across the pauses - the pauses are known only from measured silences.
// `drift` words: recognition's timings run that many words early, so each silence lands that many
// words after the punctuation it belongs to.
function commaOnly(paragraphs: string[][], drift = 0) {
  const words: CaptionWord[] = [];
  const pauses: { at: number; length: number }[] = [];
  let t = 1;
  for (const p of paragraphs) {
    for (const s of p) {
      const ws = s.replace(/[.?!]$/, "").split(" ");
      ws.forEach((w, i) => {
        const last = i === ws.length - 1;
        const pause = last ? 0.93 : /,$/.test(w) ? 0.45 : 0;
        if (pause) pauses.push({ at: words.length + drift, length: pause });
        words.push({ start: t, end: t + 0.38, text: last ? `${w},` : w });
        t += 0.38;
      });
    }
  }
  // Lay the silences in, after the (drifted) word each belongs to; words stretch over them.
  const silences: { start: number; end: number }[] = [];
  let shift = 0;
  const byWord = new Map(pauses.map((p) => [p.at, p.length]));
  words.forEach((w, i) => {
    w.start += shift;
    w.end += shift;
    const pause = byWord.get(i);
    if (pause) {
      silences.push({ start: w.end - 0.03, end: w.end - 0.03 + pause });
      w.end += pause;
      shift += pause;
    }
  });
  return { words, end: t + shift + 1, silences };
}

describe("findShortMoments", () => {
  it("puts a pause that drifted a word or two late back at the comma", () => {
    const { words, end, silences } = commaOnly([filler("the meeting", 6), STRONG, filler("the lunch", 6)], 2);
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const tokens = withDetectedPauses(buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end }], track), { "a.mp4": silences });
    const sentences = splitSentences(tokens).map((x) => x.text);
    expect(sentences).toContain("Why do most people fail at gradient descent,");
    expect(sentences).toContain("The biggest mistake is picking the learning rate by guessing,");
    const best = findShortMoments(tokens, null, { minSec: 15 })[0];
    expect(best.title).toBe("Why do most people fail at gradient descent?");
  });

  it("doesn't end a short on a sign-off", () => {
    const { words, end } = talk([{ sentences: [...STRONG, "That was it for this week.", "Thanks for watching, see you next time."] }], 2.6, 0.9);
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const best = findShortMoments(buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end }], track), null, { minSec: 15 })[0];
    expect(best.end).toBeLessThan(words.find((w) => w.text === "That")!.start);
  });

  it("still finds the hook when recognition left out full stops and question marks", () => {
    const { words, end, silences } = commaOnly([filler("the meeting", 6), STRONG, filler("the lunch", 6)]);
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const tokens = withDetectedPauses(buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end }], track), { "a.mp4": silences });
    const best = findShortMoments(tokens, null, { minSec: 15 })[0];
    expect(best.opening).toBe("Why do most people fail at gradient descent,");
    expect(best.title).toBe("Why do most people fail at gradient descent?");
    expect(best.reasons).toContain("Opens with a question");
  });

  it("picks the self-contained, hooky explanation over the rambling around it", () => {
    const { track, clips } = fixture();
    const moments = findShortMoments(buildTranscriptTokens(clips, track), null);
    expect(moments.length).toBeGreaterThan(0);
    const best = moments[0];
    expect(best.opening).toBe(STRONG[0]);
    expect(best.title).toBe("Why do most people fail at gradient descent?");
    expect(best.reasons).toContain("Opens with a question");
    expect(best.reasons).toContain("Lands on a takeaway");
  });

  it("returns moments within the length limits that never overlap", () => {
    const { track, clips } = fixture();
    const moments = findShortMoments(buildTranscriptTokens(clips, track), null, { minSec: 15, maxSec: 40, limit: 6 });
    expect(moments.length).toBeGreaterThan(1);
    for (const m of moments) {
      expect(m.estimatedSec).toBeGreaterThanOrEqual(15);
      expect(m.estimatedSec).toBeLessThanOrEqual(40);
    }
    const sorted = [...moments].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
  });

  it("prefers louder delivery when everything else is equal", () => {
    // Neutral sentences (no "and ..." openers, which would mark every ending but the last as unfinished).
    const { words, end } = talk([{ sentences: Array.from({ length: 30 }, (_, i) => `The value in row ${i} was copied over to the sheet.`) }], 2.6, 0.9);
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const tokens = buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end }], track);
    // In the first half - the talk's very end is a clean ending of its own, which would compete.
    const loud = { start: end * 0.25, end: end * 0.25 + 30 };
    const moments = findShortMoments(tokens, (a, b) => Math.max(0, Math.min(b, loud.end) - Math.max(a, loud.start)) / (b - a) * 6, { limit: 1 });
    // It holds (nearly) all of the loud stretch.
    expect(Math.min(moments[0].end, loud.end) - Math.max(moments[0].start, loud.start)).toBeGreaterThan(27);
  });

  it("finds nothing in a recording too short to hold one", () => {
    const { words, end } = talk([{ sentences: ["Just a quick hello."] }]);
    const track: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    expect(findShortMoments(buildTranscriptTokens([{ id: "c", sourcePath: "a.mp4", start: 0, end }], track), null)).toEqual([]);
  });
});

describe("sliceTimeline", () => {
  it("cuts the output range out of the clips, through speed, without the first clip's transition", () => {
    const clips: Clip[] = [
      { id: "a", sourcePath: "a.mp4", start: 10, end: 20 },
      { id: "b", sourcePath: "b.mp4", start: 0, end: 10, speed: 2, transitionIn: { type: "fade", duration: 0.5 } },
      { id: "c", sourcePath: "a.mp4", start: 30, end: 40, transitionIn: { type: "fade", duration: 0.5 } },
    ];
    // Output: a 0-10, b 10-15, c 15-25.
    const slice = sliceTimeline(clips, 5, 18);
    expect(slice.map((c) => [c.sourcePath, c.start, c.end])).toEqual([
      ["a.mp4", 15, 20],
      ["b.mp4", 0, 10],
      ["a.mp4", 30, 33],
    ]);
    expect(slice[1].transitionIn?.type).toBe("fade");
    expect(sliceTimeline(clips, 12, 18)[0].transitionIn).toBeUndefined();
  });
});

describe("tightenedTime / remapKnots", () => {
  const clips: Clip[] = [
    { id: "a", sourcePath: "a.mp4", start: 0, end: 10 },
    { id: "b", sourcePath: "a.mp4", start: 20, end: 30 },
  ];
  const cuts = [
    { clipId: "a", start: 2, end: 4 },
    { clipId: "a", start: 3, end: 5 }, // overlaps the one before
    { clipId: "b", start: 20, end: 21 },
  ];
  it("moves times back by what was removed before them", () => {
    expect(tightenedTime(clips, cuts, 1)).toBeCloseTo(1);
    expect(tightenedTime(clips, cuts, 3)).toBeCloseTo(2); // inside a cut: where it was cut
    expect(tightenedTime(clips, cuts, 6)).toBeCloseTo(3);
    expect(tightenedTime(clips, cuts, 10.5)).toBeCloseTo(7);
    expect(tightenedTime(clips, cuts, 15)).toBeCloseTo(11);
  });
  it("collapses knots that land on one time", () => {
    const knots = remapKnots(
      [
        { t: 2, x: 0.3, y: 0.5 },
        { t: 4.5, x: 0.6, y: 0.5 },
        { t: 8, x: 0.7, y: 0.5 },
      ],
      clips,
      cuts
    );
    expect(knots.map((k) => [Number(k.t.toFixed(3)), k.x])).toEqual([
      [2, 0.6],
      [5, 0.7],
    ]);
  });
});

describe("buildShort", () => {
  it("tightens the moment, captions it, titles it and carries the music under it", () => {
    const { track, clips, end } = fixture(0.8);
    const base: VideoEditState = { ...createEmptyState("a.mp4", end), clips, captions: track };
    base.audioOverlays = [
      { id: "m", src: "song.mp3", startTime: 0, endTime: end, trimStart: 5, sourceDuration: 600, volume: 0.4, createdAt: 0, updatedAt: 0 } as VideoEditState["audioOverlays"][number],
    ];
    const moment = findShortMoments(buildTranscriptTokens(clips, track), null)[0];
    const built = buildShort(base, moment, moment.title, { ...DEFAULT_SHORT_STYLE, teaser: false }, {});
    const raw = moment.end - moment.start;
    expect(built.durationSec).toBeLessThan(raw);
    expect(built.durationSec).toBeCloseTo(built.state.clips.reduce((s, c) => s + clipOutputDuration(c), 0));
    expect(built.state.captions?.settings.enabled).toBe(true);
    expect(built.state.captions?.settings.maxWordsPerLine).toBe(3);
    expect(built.state.textOverlays[0].text).toBe(moment.title);
    expect(built.state.textOverlays[0].endTime).toBeCloseTo(built.durationSec);
    const music = built.state.audioOverlays[0];
    expect(music.startTime).toBe(0);
    expect(music.trimStart).toBeCloseTo(5 + moment.start);
    expect(music.endTime).toBeCloseTo(built.durationSec);
  });

  it("opens on the teaser line, flashing into the moment", () => {
    const { track, clips, end } = fixture();
    const base: VideoEditState = { ...createEmptyState("a.mp4", end), clips, captions: track };
    const moment = findShortMoments(buildTranscriptTokens(clips, track), null)[0];
    expect(moment.teaser).not.toBeNull();
    const built = buildShort(base, moment, moment.title, { ...DEFAULT_SHORT_STYLE, teaser: true, tighten: false }, {});
    expect(built.state.clips[0].start).toBeCloseTo(moment.teaser!.start);
    expect(built.state.clips[1].transitionIn?.type).toBe("fadewhite");
  });
});
