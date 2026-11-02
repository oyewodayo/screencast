import { describe, expect, it } from "vitest";
import { estimateSeconds, formatDuration, isCancelled, VOICES, wordCount } from "./aiVoice";

describe("AI voice helpers", () => {
  it("counts words", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
    expect(wordCount("Hello,  world\nagain")).toBe(3);
  });

  it("estimates reading time from words, pace and pauses", () => {
    expect(estimateSeconds("", 1, 1)).toBe(0);
    const text = "One two three four five six seven. Eight nine ten eleven twelve thirteen.";
    const normal = estimateSeconds(text, 1, 1);
    expect(normal).toBeGreaterThan(5);
    expect(normal).toBeLessThan(10);
    expect(estimateSeconds(text, 1.25, 1)).toBeLessThan(normal);
    expect(estimateSeconds(text, 1, 1.6)).toBeGreaterThan(normal);
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42.4)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 05s");
  });

  it("recognises a cancelled run", () => {
    expect(isCancelled("TTS_CANCELLED")).toBe(true);
    expect(isCancelled(new Error("BACKGROUND cancelled"))).toBe(true);
    expect(isCancelled("disk full")).toBe(false);
  });

  it("offers each voice once, with exactly one recommendation", () => {
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
    expect(VOICES.filter((v) => v.recommended)).toHaveLength(1);
  });
});
