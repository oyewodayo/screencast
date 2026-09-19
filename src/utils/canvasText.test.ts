// utils/canvasText.test.ts
//
// A fake measurer with a fixed 10px-per-character advance stands in for a real 2D context: jsdom has
// none, and a deterministic width makes the wrap boundaries exact rather than font-dependent.
import { describe, expect, it } from "vitest";
import { TextMeasurer, wrapTextToWidth } from "./canvasText";

const CHAR_W = 10;
const fixed: TextMeasurer = { measureText: (text: string) => ({ width: text.length * CHAR_W }) };
const wrap = (text: string, maxWidth: number) => wrapTextToWidth(fixed, text, maxWidth);

describe("wrapTextToWidth", () => {
  it("leaves text that already fits on one line", () => {
    expect(wrap("abc def", 100)).toEqual(["abc def"]);
  });

  it("wraps at spaces when a line would overflow", () => {
    // "abc def" is 70px; at 40px only "abc" fits.
    expect(wrap("abc def", 40)).toEqual(["abc", "def"]);
  });

  it("fits as many words per line as it can rather than one per line", () => {
    expect(wrap("aa bb cc dd", 50)).toEqual(["aa bb", "cc dd"]);
  });

  it("honours explicit newlines", () => {
    expect(wrap("one\ntwo", 500)).toEqual(["one", "two"]);
  });

  it("keeps blank lines from consecutive newlines", () => {
    expect(wrap("a\n\nb", 500)).toEqual(["a", "", "b"]);
  });

  it("wraps within each explicit line independently", () => {
    expect(wrap("aa bb\ncc dd", 20)).toEqual(["aa", "bb", "cc", "dd"]);
  });

  // The regression this file exists for: exports clipped a long unbroken label instead of breaking it,
  // while the on-screen DOM renderers (word-break: break-word) broke it correctly.
  it("breaks a single word too long for its own line", () => {
    expect(wrap("abcdefgh", 30)).toEqual(["abc", "def", "gh"]);
  });

  it("breaks a long word that follows other words, flushing the line first", () => {
    expect(wrap("hi abcdefgh", 30)).toEqual(["hi", "abc", "def", "gh"]);
  });

  it("lets a following word share the broken word's last line, as CSS does", () => {
    // At 40px (4 chars) "abcde" breaks to "abcd" + "e", and "e f" is 3 chars, so "f" joins the tail.
    expect(wrap("abcde f", 40)).toEqual(["abcd", "e f"]);
  });

  it("never loses characters, however narrow the box", () => {
    const text = "alpha beta gamma delta";
    for (const width of [10, 20, 35, 50, 90, 1000]) {
      expect(wrap(text, width).join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
    }
  });

  it("places a single character wider than the box rather than looping forever", () => {
    // A guard against the obvious infinite loop in any break-the-word implementation.
    expect(wrap("abc", 3)).toEqual(["a", "b", "c"]);
  });

  it("treats a non-positive width as 'do not wrap' instead of one character per line", () => {
    // A shape narrower than its own padding asks for this; one character per line is never the answer.
    expect(wrap("abc def", 0)).toEqual(["abc def"]);
    expect(wrap("abc def", -20)).toEqual(["abc def"]);
  });

  it("does not split a surrogate pair down the middle", () => {
    // Each emoji is one code point but two UTF-16 units; naive indexing yields broken glyphs.
    const lines = wrap("😀😀😀", 100);
    expect(lines.join("")).toBe("😀😀😀");
    expect(lines.every((line) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line))).toBe(true);
  });

  it("returns one empty line for empty text, so callers still get a line to place", () => {
    expect(wrap("", 100)).toEqual([""]);
  });
});
