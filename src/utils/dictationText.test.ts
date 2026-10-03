import { describe, expect, it } from "vitest";
import { buildWhisperPrompt, fitToContext, isLikelyHallucination, parseDictation, stripNonSpeech, trailingPeriodToDrop } from "./dictationText";

const en = { commands: true };

describe("stripNonSpeech", () => {
  it("removes whisper's bracketed tags", () => {
    expect(stripNonSpeech("[BLANK_AUDIO]")).toBe("");
    expect(stripNonSpeech("Hello (music) world [Laughter]")).toBe("Hello world");
  });
  it("keeps ordinary parentheses", () => {
    expect(stripNonSpeech("the model (base) works")).toBe("the model (base) works");
  });
});

describe("isLikelyHallucination", () => {
  it("drops short stock phrases", () => {
    expect(isLikelyHallucination("Thank you.", 600)).toBe(true);
    expect(isLikelyHallucination(" you ", 400)).toBe(true);
  });
  it("keeps them after real speech", () => {
    expect(isLikelyHallucination("Thank you.", 2500)).toBe(false);
    expect(isLikelyHallucination("Thank you for the reference letter.", 600)).toBe(false);
  });
});

describe("parseDictation", () => {
  it("recognises whole-chunk commands with whisper punctuation", () => {
    expect(parseDictation("Scratch that.", en)).toEqual([{ kind: "scratch" }]);
    expect(parseDictation(" Bullet list. ", en)).toEqual([{ kind: "bulletList" }]);
    expect(parseDictation("Heading two", en)).toEqual([{ kind: "heading", level: 2 }]);
    expect(parseDictation("Stop dictation.", en)).toEqual([{ kind: "stop" }]);
  });

  it("does not hijack sentences that mention a command", () => {
    expect(parseDictation("We need a bullet list here.", en)).toEqual([{ kind: "text", text: "We need a bullet list here." }]);
  });

  it("splits on new paragraph / new line", () => {
    expect(parseDictation("First point. New paragraph. Second point.", en)).toEqual([
      { kind: "text", text: "First point." },
      { kind: "paragraph" },
      { kind: "text", text: "Second point." },
    ]);
    expect(parseDictation("Line one, new line, line two", en)).toEqual([
      { kind: "text", text: "Line one" },
      { kind: "lineBreak" },
      { kind: "text", text: "line two" },
    ]);
  });

  it("converts spoken punctuation", () => {
    expect(parseDictation("Hello, comma, how are you question mark", en)).toEqual([{ kind: "text", text: "Hello, how are you?" }]);
    expect(parseDictation("It works period", en)).toEqual([{ kind: "text", text: "It works." }]);
    expect(parseDictation("He said open quote yes close quote", en)).toEqual([{ kind: "text", text: "He said “yes”" }]);
  });

  it("keeps whisper's ellipses intact", () => {
    expect(parseDictation("The writing started to... it's just new.", en)).toEqual([{ kind: "text", text: "The writing started to… it's just new." }]);
  });

  it("leaves 'period' alone mid-sentence", () => {
    expect(parseDictation("over a period of time", en)).toEqual([{ kind: "text", text: "over a period of time" }]);
  });

  it("treats everything as text without commands", () => {
    expect(parseDictation("new paragraph comma", { commands: false })).toEqual([{ kind: "text", text: "new paragraph comma" }]);
  });

  it("joins whisper segment newlines with a space", () => {
    expect(parseDictation("First half\nsecond half.", en)).toEqual([{ kind: "text", text: "First half second half." }]);
  });
});

describe("fitToContext", () => {
  it("capitalises at block or sentence start", () => {
    expect(fitToContext("hello there", "")).toBe("Hello there");
    expect(fitToContext("hello there", "Done.")).toBe(" Hello there");
  });
  it("lowercases a function word continuing a sentence", () => {
    expect(fitToContext("And then we left.", "We arrived")).toBe(" and then we left.");
  });
  it("keeps names and I capitalised", () => {
    expect(fitToContext("Marina agreed.", "I asked")).toBe(" Marina agreed.");
    expect(fitToContext("I agree.", "and")).toBe(" I agree.");
  });
  it("does not add a space before punctuation or after whitespace", () => {
    expect(fitToContext(", right?", "Fine")).toBe(", right?");
    expect(fitToContext("next", "word ")).toBe("next");
  });
});

describe("trailingPeriodToDrop", () => {
  it("drops whisper's period before a continuation", () => {
    expect(trailingPeriodToDrop("We measured the gap.", "And it closed.")).toBe(1);
  });
  it("keeps real sentence ends and abbreviations", () => {
    expect(trailingPeriodToDrop("We measured the gap.", "We then left.")).toBe(0);
    expect(trailingPeriodToDrop("ask Dr.", "And")).toBe(0);
    expect(trailingPeriodToDrop("e.g.", "and")).toBe(0);
  });
});

describe("buildWhisperPrompt", () => {
  it("prefixes the title and keeps only the tail", () => {
    expect(buildWhisperPrompt("Lattice Gauge Theory", "Notes on   Wilson loops")).toBe("Lattice Gauge Theory. Notes on Wilson loops");
    expect(buildWhisperPrompt("", "x".repeat(1000)).length).toBe(600);
  });
});
