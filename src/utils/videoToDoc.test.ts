import { describe, expect, it } from "vitest";
import {
  buildVideoDocMarkdown,
  extractVideoHighlights,
  groupTranscriptIntoParagraphs,
  humanizeVideoTitle,
  pickScreenshotMoments,
} from "./videoToDoc";
import { BRIEFS_CREATE_URL, buildBriefsVideoPayload } from "./briefsPublish";

describe("videoToDoc", () => {
  it("humanizes video filenames into clean doc titles", () => {
    expect(humanizeVideoTitle("C:\\Videos\\product_demo-v2.mp4")).toBe("Product demo v2");
    expect(humanizeVideoTitle("weekly-sync.mkv")).toBe("Weekly sync");
  });

  it("merges short subtitle lines into readable paragraphs split on pauses", () => {
    const paras = groupTranscriptIntoParagraphs([
      { start: 0, end: 2, text: "Hello everyone," },
      { start: 2.1, end: 4, text: "welcome to the walkthrough." },
      { start: 7.5, end: 9, text: "Next we'll inspect the export pipeline." },
    ]);
    expect(paras).toHaveLength(2);
    expect(paras[0]).toEqual({ start: 0, text: "Hello everyone, welcome to the walkthrough." });
    expect(paras[1]).toEqual({ start: 7.5, text: "Next we'll inspect the export pipeline." });
  });

  it("extracts a real summary and key takeaways from transcript paragraphs", () => {
    const paras = [
      { start: 0, text: "Today we are setting up PyTorch tensors and GPU acceleration for training neural networks." },
      { start: 65, text: "Next we build a clean DataLoader pipeline that batches training samples efficiently without memory leaks." },
      { start: 130, text: "Finally we evaluate validation accuracy and export the trained checkpoint for production inference." },
    ];
    const highlights = extractVideoHighlights(paras, 3);
    expect(highlights.summary.length).toBeGreaterThan(40);
    expect(highlights.takeaways.length).toBeGreaterThanOrEqual(2);
    expect(highlights.takeaways[0]).toMatch(/^\*\*\d+:\d{2}\*\* — /);
  });

  it("groups transcript paragraphs and screenshots under chapter headings without empty dashes", () => {
    const result = buildVideoDocMarkdown({
      fileName: "onboarding_demo.mp4",
      durationSec: 125,
      watchUrl: "https://youtu.be/abc123",
      chapters: [
        { time: 0, label: "Intro" },
        { time: 62, label: "Live Demo" },
      ],
      lines: [
        { start: 1, end: 4, text: "Welcome to Briefcast where we turn raw recordings into polished stories." },
        { start: 65, end: 70, text: "Click Studio Polish to apply framing, voice cleanup, and automatic click zooms." },
      ],
      screenshots: [
        { chapterIndex: 0, time: 1.5, src: "asset://intro.png", alt: "Intro (0:01)" },
        { chapterIndex: 1, time: 63.5, src: "asset://demo.png", alt: "Live Demo (1:03)" },
      ],
    });
    expect(result.title).toBe("Onboarding demo");
    expect(result.stats.chapterCount).toBe(2);
    expect(result.markdown).toContain("## Summary");
    expect(result.markdown).toContain("## Chapters");
    expect(result.markdown).toContain("## Key Takeaways");
    expect(result.markdown).toContain("### 0:00 — Intro");
    expect(result.markdown).toContain("![Intro (0:01)](asset://intro.png)");
    expect(result.markdown).toContain("### 1:02 — Live Demo");
    expect(result.markdown).toContain("![Live Demo (1:03)](asset://demo.png)");
    expect(result.markdown).not.toContain("\n- \n");
  });

  it("plans evenly spaced screenshots for silent videos and produces a clean visual walkthrough", () => {
    const moments = pickScreenshotMoments([], 600, 6);
    expect(moments).toHaveLength(6);
    const result = buildVideoDocMarkdown({
      fileName: "silent_demo.mp4",
      durationSec: 600,
      screenshots: moments.map((m) => ({
        chapterIndex: m.chapterIndex,
        time: m.time,
        src: `asset://shot-${m.chapterIndex}.png`,
        alt: m.label,
      })),
    });
    expect(result.markdown).toContain("## Visual Walkthrough");
    expect(result.markdown).toContain("![Moment 1](asset://shot-0.png)");
    expect(result.markdown).not.toContain("Add a quick 2–3 sentence summary");
    expect(result.markdown).not.toContain("\n- \n");
  });
});

describe("briefsPublish", () => {
  it("builds formatted HTML and plain text for the Briefs composer", () => {
    expect(BRIEFS_CREATE_URL).toBe("https://withbriefs.com/brief/create");
    const payload = buildBriefsVideoPayload({
      title: "Release v0.1.8 Walkthrough",
      summary: "Here is everything new in Briefcast.",
      watchUrl: "https://youtu.be/demo",
      durationSec: 185,
      chapters: [
        { time: 0, label: "Overview" },
        { time: 75, label: "Studio Polish" },
      ],
      lines: [{ start: 2, end: 5, text: "Let's dive in." }],
      includeChapters: true,
      includeTranscript: true,
    });
    expect(payload.html).toContain("<h1>Release v0.1.8 Walkthrough</h1>");
    expect(payload.html).toContain('href="https://youtu.be/demo"');
    expect(payload.html).toContain("<strong>1:15</strong> — Studio Polish");
    expect(payload.html).toContain("<h2>Transcript</h2>");
    expect(payload.text).toContain("Watch the video (3:05): https://youtu.be/demo");
  });
});
