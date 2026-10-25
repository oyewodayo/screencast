import { describe, expect, it } from "vitest";
import { TEXT_REVEAL_EXIT_SEC, textRevealFrameKey, textRevealSeconds, textRevealState } from "./textReveal";

const TEXT = "Question and Answer session";
const visible = (text: string, kind: "typewriter" | "words" | "rise", t: number, duration: number) => {
  const s = textRevealState(text, kind, t, duration);
  return Array.from(text, (_, i) => s.char(i).opacity);
};

describe("textReveal", () => {
  it("types letters on in order and finishes with every letter shown", () => {
    const reveal = textRevealSeconds(TEXT, "typewriter", 5);
    const mid = visible(TEXT, "typewriter", reveal / 2, 5);
    const shown = mid.filter((o) => o === 1).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(TEXT.length);
    // Shown letters are a prefix.
    expect(mid.slice(0, shown).every((o) => o === 1)).toBe(true);
    expect(visible(TEXT, "typewriter", reveal, 5).every((o) => o === 1)).toBe(true);
  });

  it("shows the caret only while typing", () => {
    const reveal = textRevealSeconds(TEXT, "typewriter", 5);
    expect(textRevealState(TEXT, "typewriter", reveal / 2, 5).caretAt).not.toBeNull();
    expect(textRevealState(TEXT, "typewriter", reveal + 0.1, 5).caretAt).toBeNull();
  });

  it("reveals word by word - the first word lands before the last starts", () => {
    const s = textRevealState(TEXT, "words", 0.36, 5);
    expect(s.char(0).opacity).toBe(1);
    expect(s.char(TEXT.length - 1).opacity).toBeLessThan(1);
  });

  it("settles fully and fades out at the end", () => {
    for (const kind of ["typewriter", "words", "rise"] as const) {
      const reveal = textRevealSeconds(TEXT, kind, 5);
      const settled = textRevealState(TEXT, kind, reveal + 0.05, 5);
      expect(settled.settled).toBe(true);
      expect(Array.from(TEXT, (_, i) => settled.char(i)).every((c) => c.opacity === 1 && c.dy === 0)).toBe(true);
      expect(textRevealState(TEXT, kind, 5 - TEXT_REVEAL_EXIT_SEC / 2, 5).fade).toBeCloseTo(0.5);
    }
  });

  it("never spends more than 60% of a short overlay revealing", () => {
    expect(textRevealSeconds(TEXT, "typewriter", 1)).toBeLessThanOrEqual(0.6);
  });
});

describe("textReveal controls", () => {
  const D = 6;
  it("types a whole word at a time", () => {
    const settings = { unit: "word" as const };
    const reveal = textRevealSeconds(TEXT, "typewriter", D, settings);
    for (let t = 0; t < reveal; t += 0.05) {
      const s = textRevealState(TEXT, "typewriter", t, D, settings);
      const shown = Array.from(TEXT, (_, i) => s.char(i).opacity).filter((o) => o === 1).length;
      // Never stops mid-word.
      expect(shown === 0 || shown === TEXT.length || /\s/.test(TEXT[shown]) || shown === TEXT.length).toBe(true);
    }
  });

  it("speed and delay change when the title is fully revealed", () => {
    const base = textRevealSeconds(TEXT, "typewriter", D);
    expect(textRevealSeconds(TEXT, "typewriter", D, { speed: 2 })).toBeCloseTo(base / 2);
    const delayed = textRevealState(TEXT, "typewriter", 0.9, D, { delay: 1 });
    expect(delayed.char(0).opacity).toBe(0);
  });

  it("untypes at the end instead of fading", () => {
    const s = textRevealState(TEXT, "typewriter", D - 0.01, D, { exit: "reverse" });
    expect(s.fade).toBe(1);
    expect(s.char(TEXT.length - 1).opacity).toBe(0);
    expect(textRevealState(TEXT, "typewriter", D - 0.01, D, { exit: "none" }).char(TEXT.length - 1).opacity).toBe(1);
  });

  it("human rhythm still finishes on time, in order", () => {
    const settings = { humanize: true };
    const reveal = textRevealSeconds(TEXT, "typewriter", D, settings);
    let last = 0;
    for (let t = 0; t <= reveal; t += 0.02) {
      const s = textRevealState(TEXT, "typewriter", t, D, settings);
      const shown = Array.from(TEXT, (_, i) => s.char(i).opacity).filter((o) => o === 1).length;
      expect(shown).toBeGreaterThanOrEqual(last);
      last = shown;
    }
    const done = textRevealState(TEXT, "typewriter", reveal, D, settings);
    expect(Array.from(TEXT, (_, i) => done.char(i).opacity).every((o) => o === 1)).toBe(true);
  });

  it("a held caret blinks with only two distinct export frames", () => {
    const settings = { caretHold: true };
    const keys = new Set<string>();
    const reveal = textRevealSeconds(TEXT, "typewriter", D, settings);
    for (let k = Math.ceil(reveal * 30) + 1; k < (D - 0.5) * 30; k++) keys.add(textRevealFrameKey(textRevealState(TEXT, "typewriter", k / 30, D, settings), k));
    expect(keys).toEqual(new Set(["caret-on", "caret-off"]));
  });

  it("draws the underline in with the reveal", () => {
    expect(textRevealState(TEXT, "words", 0, D, { underline: "#ff0" }).underline).toBe(0);
    expect(textRevealState(TEXT, "words", 3, D, { underline: "#ff0" }).underline).toBeCloseTo(1);
    expect(textRevealState(TEXT, "words", 3, D).underline).toBe(0);
  });
});

describe("roll", () => {
  it("spins digits through other digits, then lands on the real ones, left to right", () => {
    const mid = textRevealState("22 OCT", "roll", 0.25, 4, { exit: "none" });
    const c0 = mid.char(0);
    expect(c0.clip).toBe(true);
    if (c0.glyph !== undefined) expect(c0.glyph).toMatch(/\d/);
    // The space never rolls.
    expect(mid.char(2).glyph).toBeUndefined();
    const done = textRevealState("22 OCT", "roll", 3.5, 4, { exit: "none" });
    for (let i = 0; i < 6; i++) expect(done.char(i)).toMatchObject({ opacity: 1, dy: 0 });
    expect(done.settled).toBe(true);
  });
});
