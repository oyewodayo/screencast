// utils/canvasText.ts
//
// Text wrapping for the Canvas2D exporters (PNG/PDF). One implementation shared by the whiteboard and
// the mindmap, because the bug it fixes was exactly the two of them disagreeing.
//
// WHY THIS EXISTS: on screen both tools render labels as DOM text with `word-break: break-word` (see
// MindmapCanvas's node body and WhiteboardCanvas's `break-words`), so the browser wraps at spaces AND
// breaks a word that is too long to fit on a line by itself. The exporters draw with ctx.fillText,
// which wraps nothing at all - so a long label that looked fine on the canvas came out of an export
// either clipped at the shape's edge or running off it. The mindmap wrapped nothing whatsoever; the
// whiteboard wrapped at spaces but left an over-long single word (a URL, a chemical name, a long
// identifier) to overflow. This function is the CSS behaviour those renderers already promise.
//
// It takes a measurer rather than a full CanvasRenderingContext2D so the wrap logic is testable
// without a real canvas - jsdom has no 2D context, and the whole point of a wrap function is that its
// edge cases can be pinned down.

export interface TextMeasurer {
  measureText(text: string): { width: number };
}

// Splits `text` into lines that each fit `maxWidth` when drawn with the measurer's current font.
// Honours explicit newlines (including blank lines), wraps at spaces, and falls back to breaking
// mid-word when a single word cannot fit on a line of its own - matching `overflow-wrap: break-word`.
//
// `maxWidth` of zero or less means "don't wrap" rather than "wrap to nothing": a caller whose shape is
// narrower than its own padding would otherwise ask for lines of no width, and one character per line
// is never what anyone wanted from that.
export function wrapTextToWidth(measurer: TextMeasurer, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine === "" || !(maxWidth > 0)) {
      lines.push(rawLine);
      continue;
    }
    let current = "";
    for (const word of rawLine.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (measurer.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }
      // Doesn't fit alongside what's already on this line - flush and start fresh with the word.
      if (current) {
        lines.push(current);
        current = "";
      }
      if (measurer.measureText(word).width <= maxWidth) {
        current = word;
        continue;
      }
      // The word won't fit on a line of its own either, so break it. Iterating the string (rather
      // than indexing it) keeps surrogate pairs and combining marks intact, so an emoji or an
      // accented character is never split down the middle into two broken glyphs.
      let chunk = "";
      for (const char of word) {
        const next = chunk + char;
        // The `chunk &&` guard is what guarantees progress: a single character wider than maxWidth
        // still gets placed rather than looping forever trying to find room for it.
        if (chunk && measurer.measureText(next).width > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk = next;
        }
      }
      // The tail stays open so a following word can share the line, as CSS would.
      current = chunk;
    }
    lines.push(current);
  }
  return lines;
}

// A measurer backed by one module-level offscreen canvas, for callers that need real text metrics but
// aren't already drawing (the SVG reader view, which wraps by emitting <tspan>s). One canvas for the
// whole app rather than one per call: creating a canvas per measurement is a surprisingly large cost
// when laying out a whole roadmap at once, and these calls happen during render.
//
// The returned measurer borrows that shared context, so its font is only valid until the next call -
// measure and wrap in one go rather than holding one across other work.
let sharedMeasureCtx: CanvasRenderingContext2D | null | undefined;

export function measurerForFont(font: string): TextMeasurer {
  if (sharedMeasureCtx === undefined) {
    // `typeof` rather than a truthiness check: under vitest's default node environment there is no
    // `document` binding at all, so touching it would throw rather than fall through to the estimate.
    sharedMeasureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  }
  if (!sharedMeasureCtx) {
    // No 2D context (jsdom under test, or a webview that refused one). Estimating from the font's px
    // size keeps wrapping approximately right instead of collapsing to one word per line; 0.55em is
    // close to the average advance width of the sans-serif stack these tools use.
    const px = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "14");
    return { measureText: (text: string) => ({ width: text.length * px * 0.55 }) };
  }
  sharedMeasureCtx.font = font;
  return sharedMeasureCtx;
}
