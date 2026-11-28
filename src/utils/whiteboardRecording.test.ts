import { describe, expect, it } from "vitest";
import {
  buildChaptersFromSlideMarks,
  computeScreenCaptureRegion,
  formatRecordingTimer,
  sanitizeRecordingFileName,
} from "./whiteboardRecording";

describe("whiteboardRecording", () => {
  it("computes even-dimensioned physical capture regions", () => {
    const r = computeScreenCaptureRegion(
      { left: 10, top: 20, width: 1201, height: 675 },
      { x: 100, y: 50 },
      1.25
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBe(113);
    expect(r!.y).toBe(75);
    expect(r!.width % 2).toBe(0);
    expect(r!.height % 2).toBe(0);
    expect(r!.spec).toBe(`region:${r!.x},${r!.y},${r!.width},${r!.height}`);
  });

  it("rejects regions smaller than hardware encoder minimums", () => {
    expect(computeScreenCaptureRegion({ left: 0, top: 0, width: 40, height: 40 }, { x: 0, y: 0 }, 1)).toBeNull();
  });

  it("sanitizes unsafe path characters from whiteboard titles", () => {
    expect(sanitizeRecordingFileName('  System: Design / "v2" *  ')).toBe("System Design v2");
    expect(sanitizeRecordingFileName("")).toBe("Whiteboard Presentation");
  });

  it("builds clean slide chapters by collapsing rapid click-throughs and anchoring slide 1 at 0:00", () => {
    const chapters = buildChaptersFromSlideMarks([
      { time: 0.4, label: "Overview" },
      { time: 18.2, label: "Skipped Slide" },
      { time: 18.9, label: "Architecture" },
      { time: 52.0, label: "Architecture" },
      { time: 74.5, label: "Q&A" },
    ]);
    expect(chapters.map((c) => ({ time: c.time, label: c.label }))).toEqual([
      { time: 0, label: "Overview" },
      { time: 18.9, label: "Architecture" },
      { time: 74.5, label: "Q&A" },
    ]);
  });

  it("formats recording timers cleanly", () => {
    expect(formatRecordingTimer(0)).toBe("00:00");
    expect(formatRecordingTimer(65_000)).toBe("01:05");
    expect(formatRecordingTimer(3_661_000)).toBe("1:01:01");
  });
});
