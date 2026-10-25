import { describe, expect, it } from "vitest";
import { chapterAtOutputTime, chapterOutputTime, chaptersForExport, formatChapterTimestamp, outputChapters, suggestChapters, youtubeChapterLines } from "./videoChapters";
import type { CaptionTrack, Clip } from "./videoEditTypes";
import { defaultCaptionSettings } from "./captions";

const clip = (id: string, start: number, end: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: "a.mp4", start, end, ...extra });

describe("video chapters", () => {
  it("follow their shot through cuts, reorders and speed changes", () => {
    const chapter = { id: "c", sourcePath: "a.mp4", sourceTime: 50, label: "Results" };
    expect(chapterOutputTime([clip("1", 0, 100)], chapter)).toBe(50);
    // The first 30 s cut: it moves 30 s earlier.
    expect(chapterOutputTime([clip("1", 30, 100)], chapter)).toBe(20);
    // Reordered after a 10 s clip, played at 2x: 10 + (50 - 40) / 2.
    expect(chapterOutputTime([clip("2", 0, 10), clip("1", 40, 100, { speed: 2 })], chapter)).toBe(15);
    // Its moment cut out: gone.
    expect(chapterOutputTime([clip("1", 0, 40), clip("3", 60, 100)], chapter)).toBeNull();
  });

  it("anchors a new chapter where the playhead is", () => {
    const clips = [clip("1", 0, 10), clip("2", 40, 100)];
    const c = chapterAtOutputTime(clips, 15, "Middle")!;
    expect(c.sourceTime).toBe(45);
    expect(chapterOutputTime(clips, c)).toBe(15);
  });

  it("exports surviving chapters in order, the first at 0:00", () => {
    const clips = [clip("1", 0, 100)];
    const chapters = [
      { id: "b", sourcePath: "a.mp4", sourceTime: 40, label: "Two" },
      { id: "a", sourcePath: "a.mp4", sourceTime: 5, label: "One" },
      { id: "x", sourcePath: "other.mp4", sourceTime: 5, label: "Elsewhere" },
    ];
    expect(outputChapters(clips, chapters).map((c) => c.label)).toEqual(["One", "Two"]);
    expect(chaptersForExport(clips, chapters)).toEqual([
      { time: 0, label: "One" },
      { time: 40, label: "Two" },
    ]);
  });

  it("formats YouTube chapter lines and says when they won't count", () => {
    expect(formatChapterTimestamp(3725)).toBe("1:02:05");
    expect(formatChapterTimestamp(65)).toBe("1:05");
    const ok = youtubeChapterLines(
      [
        { time: 0, label: "Intro" },
        { time: 30, label: "Method" },
        { time: 95, label: "Results" },
      ],
      200
    );
    expect(ok).toEqual({ lines: ["0:00 Intro", "0:30 Method", "1:35 Results"], problem: null });
    // Starts late: an Intro is added at 0:00; chapters under 10 s apart merge.
    const fixed = youtubeChapterLines(
      [
        { time: 12, label: "A" },
        { time: 15, label: "B" },
        { time: 60, label: "C" },
      ],
      120
    );
    expect(fixed.lines).toEqual(["0:00 Intro", "0:12 A", "1:00 C"]);
    expect(youtubeChapterLines([{ time: 0, label: "Only" }], 100).problem).toMatch(/at least 3/);
  });

  it("suggests chapters where the talk changes subject", () => {
    // Three stretches of talk about different things, with a pause between each.
    const topics = [
      "neural network training gradient descent learning rate optimizer loss",
      "protein folding structure amino acids molecular biology enzyme",
      "climate ocean temperature carbon emissions atmosphere warming",
    ];
    const words: { start: number; end: number; text: string }[] = [];
    let t = 0;
    for (const topic of topics) {
      const vocab = topic.split(" ");
      for (let i = 0; i < 160; i++) {
        words.push({ start: t, end: t + 0.3, text: vocab[i % vocab.length] });
        t += 0.4;
      }
      t += 2.5; // a pause between subjects
    }
    const captions: CaptionTrack = { language: "en", transcripts: { "a.mp4": words }, settings: defaultCaptionSettings() };
    const clips = [clip("1", 0, t)];
    const found = suggestChapters(clips, captions, t);
    expect(found.length).toBe(3);
    expect(found[0].time).toBe(0);
    // Each boundary lands on the pause before its subject (each subject is 64 s + a 2.5 s pause).
    expect(Math.abs(found[1].time - 66.5)).toBeLessThan(3);
    expect(Math.abs(found[2].time - 133)).toBeLessThan(3);
    expect(found.map((c) => c.label).join(" | ")).toMatch(/Protein|Fold|Amino|Enzyme|Molecular/i);
  });
});
