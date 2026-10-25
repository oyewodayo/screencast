import { describe, expect, it } from "vitest";
import { channelCrossings, channelValue, formatValue } from "./stageChannels";
import { compileStage, sampleStage, stageIsMoving } from "./stageEngine";
import { parseStageColor } from "./stageColor";
import { StageElement, StageScene, defaultStageProps } from "./stageTypes";

describe("formatValue", () => {
  it("reads minutes after midnight as a clock, wrapping past midnight", () => {
    expect(formatValue(23 * 60, "time")).toBe("11:00 PM");
    expect(formatValue(24 * 60, "time")).toBe("12:00 AM");
    expect(formatValue(24 * 60 + 6 * 60 + 58, "time")).toBe("6:58 AM");
    expect(formatValue(12 * 60 + 5, "time")).toBe("12:05 PM");
    expect(formatValue(-30, "clock24")).toBe("23:30");
  });

  it("formats percentages, counts and durations", () => {
    expect(formatValue(63.6, "pct")).toBe("64%");
    expect(formatValue(42.4, "int")).toBe("42");
    expect(formatValue(3.14159, "fixed2")).toBe("3.14");
    expect(formatValue(6 * 3600 + 12 * 60 + 40, "duration")).toBe("6:12:40");
    expect(formatValue(125, "duration")).toBe("2:05");
    expect(formatValue(Number.NaN, "pct")).toBe("");
  });
});

describe("channels", () => {
  const ch = { id: "c", keys: [{ t: 2, value: 50 }, { t: 0, value: 100 }, { t: 4, value: 50, easing: "hold" as const }, { t: 6, value: 0 }] };

  it("are keyframed in time, whatever order the keys were given in", () => {
    expect(channelValue(ch, -1)).toBe(100);
    expect(channelValue(ch, 1)).toBeCloseTo(75, 9);
    expect(channelValue(ch, 3)).toBe(50);
    expect(channelValue(ch, 5)).toBe(50);
    expect(channelValue(ch, 9)).toBe(0);
  });

  it("find threshold crossings to well under a frame", () => {
    const linear = { id: "l", keys: [{ t: 0, value: 100 }, { t: 10, value: 0 }] };
    const [t] = channelCrossings(linear, 20, 0, 10);
    expect(t).toBeCloseTo(8, 5);
    expect(channelCrossings(linear, 200, 0, 10)).toEqual([]);
  });
});

// The reference's battery race: a night's clock, a stock bar draining to dead at 3:10 AM, a bar that
// turns red below 20%, and a status line that changes when it dies.
describe("the battery race", () => {
  const night = (t: number) => 23 * 60 + (t / 6) * (7 * 60 + 58);
  const deadAt = ((24 * 60 + 3 * 60 + 10 - 23 * 60) / (7 * 60 + 58)) * 6;
  const element = (id: string, extra: Partial<StageElement>): StageElement => ({ id, kind: "text", props: defaultStageProps({ x: 100, y: 100, width: 360, height: 40, color: "#8a8a8a" }), ...extra });
  const race: StageScene = {
    id: "race",
    startTime: 0,
    width: 1920,
    height: 1080,
    background: { kind: "color", color: "#e8e8e8" },
    spring: "smooth",
    stagger: 0,
    channels: [
      { id: "clock", keys: [{ t: 0, value: night(0) }, { t: 6, value: night(6) }] },
      { id: "stock", keys: [{ t: 0, value: 100 }, { t: deadAt, value: 0 }] },
    ],
    elements: [
      element("time", { props: defaultStageProps({ text: "{clock:time}", color: "#111111" }) }),
      element("bar", { kind: "shape", bind: { width: { channel: "stock", from: [0, 100], to: [0, 360] } }, when: [{ channel: "stock", below: 20, changes: { color: "#ef4444" } }] }),
      element("status", { props: defaultStageProps({ text: "sudo pmset -a disablesleep 1", color: "#111111" }), when: [{ channel: "stock", below: 0.5, changes: { text: "Dead at 3:10 AM. Agents stopped.", color: "#dc2626" } }] }),
    ],
    beats: [{ id: "b", hold: 7, changes: {} }],
  };
  const c = compileStage(race);
  const get = (t: number, id: string) => sampleStage(c, t).find((e) => e.id === id)!;

  it("ticks the clock through midnight", () => {
    expect(get(0.5, "time").text).toBe(formatValue(night(0.5), "time"));
    expect(get(6, "time").text).toBe("6:58 AM");
    // From just after its own entrance begins (at 0 it is still fully transparent).
    const pastMidnight = Array.from({ length: 60 }, (_, i) => get(0.05 + i / 10, "time").text ?? "");
    // Through midnight into the 12 AM hour (each sample is ~8 clock-minutes apart), never "0:xx".
    expect(pastMidnight.some((s) => /^12:\d\d AM$/.test(s))).toBe(true);
    expect(pastMidnight.some((s) => s.startsWith("0:"))).toBe(false);
  });

  it("drives the bar's width straight from the channel - no lag", () => {
    for (const t of [0.5, 1.7, 2.9]) expect(get(t, "bar").width).toBeCloseTo(360 * channelValue(race.channels![1], t) / 100, 9);
    expect(get(5, "bar").width).toBe(0);
  });

  it("turns the bar red from the moment it crosses 20%, springing into the colour", () => {
    const crossing = deadAt * 0.8;
    expect(parseStageColor(get(crossing - 0.05, "bar").color)!.slice(0, 3)).toEqual([138, 138, 138]);
    const after = parseStageColor(get(crossing + 0.1, "bar").color)!;
    expect(after[0]).toBeGreaterThan(138);
    expect(after[0]).toBeLessThan(239);
    expect(parseStageColor(get(crossing + 1.5, "bar").color)!.slice(0, 3)).toEqual([239, 68, 68]);
  });

  it("switches the status line when the battery dies", () => {
    expect(get(deadAt - 0.02, "status").text).toBe("sudo pmset -a disablesleep 1");
    expect(get(deadAt + 0.02, "status").text).toBe("Dead at 3:10 AM. Agents stopped.");
  });

  it("keeps redrawing while the values run and stops once they rest", () => {
    expect(stageIsMoving(c, 1)).toBe(true);
    expect(stageIsMoving(c, 6.9)).toBe(false);
  });
});
