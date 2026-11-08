// utils/stage/stageMeasure.ts
//
// The Stage's text layout in the browser - the one place a text's lines and letters are placed,
// shared by the engine (box sizes, letter positions for morphs) and the rasteriser (which draws
// each letter where this put it), so a morphing text and the same text at rest can never disagree.
//
// Everything is laid out once in stage units (px at 1080 tall) and only scaled when drawn: text
// re-wrapped at 4K could break a line differently from 1080p at the edge, and then the export
// wouldn't match the preview. Wrapping is measureTextBlock's (the overlay titles' own); a letter
// sits at the width of its line up to it, so kerning between letters is kept. With tabular figures
// every digit takes the widest digit's room, centred in it - a ticking clock or counter holds still
// (canvas text can't switch the font's own tabular feature on).
import { measureTextBlock } from "../../handlers/pdfAnnotationHandlers";
import { titleFontCss } from "../titleFonts";
import type { MeasuredGlyph, MeasuredText, StageMeasure } from "./stageLayout";
import { graphemes } from "./stageTextMorph";
import type { StageElement, StageTextLook, StageWeightRun } from "./stageTypes";

export const DEFAULT_STAGE_LINE_HEIGHT = 1.3;
const DIGIT = /^[0-9]$/;

export function stageFont(look: StageTextLook, sizePx = look.fontSize, weight?: number): string {
  return titleFontCss(look.fontFamily, sizePx, { bold: look.bold, italic: look.italic, weight });
}

// The weight a run gives the code unit at `offset`, if any.
export const weightAt = (runs: StageWeightRun[] | undefined, offset: number): number | undefined => runs?.find((r) => offset >= r.start && offset < r.end)?.weight;

let ctx: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D {
  if (!ctx) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    ctx = c.getContext("2d")!;
  }
  return ctx;
}

// The widest digit in the current font, without tracking - every digit's room with tabular figures.
const digitWidths = new Map<string, number>();
export function tabularDigitWidth(c: CanvasRenderingContext2D): number {
  let w = digitWidths.get(c.font);
  if (w === undefined) {
    const spacing = c.letterSpacing;
    c.letterSpacing = "0px";
    w = 0;
    for (let d = 0; d < 10; d++) w = Math.max(w, c.measureText(String(d)).width);
    c.letterSpacing = spacing;
    digitWidths.set(c.font, w);
  }
  return w;
}

// Each grapheme's x within a line (and the line's width). `fontAt` gives the font for the code unit
// at an offset in the line. Plain runs keep their kerning (a letter sits at the width of the run up
// to it, in the run's font); a change of font starts a new run; with `tabular`, digits each take
// the widest digit's room plus the tracking.
function lineGlyphs(c: CanvasRenderingContext2D, line: string, spacing: number, tabular: boolean, fontAt: (offset: number) => string): { xs: number[]; widths: number[]; width: number } {
  const gs = graphemes(line);
  const xs: number[] = [];
  const widths: number[] = [];
  let runStart = 0; // x where the current plain run began
  let run = ""; // the plain run so far
  let x = 0;
  let offset = 0;
  c.font = fontAt(0);
  for (const g of gs) {
    const font = fontAt(offset);
    offset += g.length;
    if (font !== c.font) {
      // A new font: the run so far ends where it reached.
      runStart = runStart + (run ? c.measureText(run).width : 0);
      run = "";
      c.font = font;
    }
    if (tabular && DIGIT.test(g)) {
      const digitWidth = tabularDigitWidth(c);
      x = runStart + (run ? c.measureText(run).width : 0);
      xs.push(x);
      widths.push(digitWidth);
      x += digitWidth + spacing;
      runStart = x;
      run = "";
      continue;
    }
    const before = run ? c.measureText(run).width : 0;
    run += g;
    const after = c.measureText(run).width;
    xs.push(runStart + before);
    widths.push(Math.max(0, after - before - spacing));
    x = runStart + after;
  }
  // Tracking adds space after a line's last letter too - left out of its width, as the titles do.
  return { xs, widths, width: gs.length ? Math.max(0, x - spacing) : 0 };
}

export function layoutStageText(element: StageElement, text: string, maxWidth: number, weights?: StageWeightRun[]): MeasuredText {
  const look: StageTextLook = element.textLook ?? { fontSize: 40 };
  const fs = look.fontSize;
  const font = stageFont(look);
  const padX = look.paddingX ?? 0;
  const padY = look.paddingY ?? 0;
  const spacing = (look.letterSpacing ?? 0) * fs;
  const lineHeight = fs * (look.lineHeight ?? DEFAULT_STAGE_LINE_HEIGHT);
  const wrapWidth = Math.max(1, maxWidth - 2 * padX);
  const { lines } = measureTextBlock(text, fs, wrapWidth, { font, letterSpacing: spacing, lineHeight: look.lineHeight ?? DEFAULT_STAGE_LINE_HEIGHT });

  const c = measureContext();
  c.font = font;
  c.letterSpacing = `${spacing}px`;
  const tabular = !!look.tabularNums;
  const fontAt = (abs: number) => {
    const w = weightAt(weights, abs);
    return w === undefined ? font : stageFont(look, fs, w);
  };
  const measured = lines.map((l) => lineGlyphs(c, l.text, spacing, tabular, (o) => fontAt(l.startOffset + o)));
  const boxWidth = element.fit === "hug" ? Math.max(0, ...measured.map((m) => m.width)) + 2 * padX : maxWidth;
  const align = look.textAlign ?? "left";
  const placed = lines.map((l, i) => {
    const room = boxWidth - 2 * padX;
    const x = padX + (align === "center" ? (room - measured[i].width) / 2 : align === "right" ? room - measured[i].width : 0);
    return { text: l.text, x, y: padY + i * lineHeight, start: l.startOffset };
  });

  // Every grapheme of the whole text, placed; a space a line broke at takes no room.
  const glyphs: MeasuredGlyph[] = [];
  let offset = 0;
  let li = 0;
  let gi = 0; // grapheme index within line li
  for (const g of graphemes(text)) {
    // Lines run in order; a dropped break space sits just past its line's end.
    while (li < placed.length - 1 && offset >= placed[li].start + placed[li].text.length) {
      li++;
      gi = 0;
    }
    const line = placed[li];
    if (line && offset >= line.start && offset < line.start + line.text.length) {
      glyphs.push({ text: g, start: offset, weight: weightAt(weights, offset), x: line.x + measured[li].xs[gi], y: line.y, width: measured[li].widths[gi], height: lineHeight });
      gi++;
    } else {
      const at = line ?? placed[placed.length - 1];
      glyphs.push({ text: g, start: offset, x: at ? at.x : padX, y: at ? at.y : padY, width: 0, height: lineHeight });
    }
    offset += g.length;
  }
  c.letterSpacing = "0px";
  return { width: boxWidth, height: Math.max(lines.length, 1) * lineHeight + 2 * padY, glyphs, lines: placed };
}

export const canvasStageMeasure: StageMeasure = { text: layoutStageText };

// Widths of single graphemes and the kerning between pairs, per font - so a text whose wording
// changes every frame (a clock) is laid out from a few lookups, not a run of canvas measurements.
const advanceCache = new Map<string, Map<string, number>>();
function advance(c: CanvasRenderingContext2D, s: string): number {
  let m = advanceCache.get(c.font);
  if (!m) advanceCache.set(c.font, (m = new Map()));
  let w = m.get(s);
  if (w === undefined) {
    w = c.measureText(s).width;
    m.set(s, w);
  }
  return w;
}

// One line of text in `frameWidth` (aligned in it as the look says) from cached advances: each
// letter's own width plus the kerning the font applies between it and the one before (measured
// once per pair), tabular digits each in the widest digit's room. For live values - short, on one
// line - where the same letters recur frame after frame.
export function layoutLiveLine(element: StageElement, text: string, frameWidth: number, weights?: StageWeightRun[]): MeasuredText {
  const look: StageTextLook = element.textLook ?? { fontSize: 40 };
  const fs = look.fontSize;
  const padX = look.paddingX ?? 0;
  const padY = look.paddingY ?? 0;
  const spacing = (look.letterSpacing ?? 0) * fs;
  const lineHeight = fs * (look.lineHeight ?? DEFAULT_STAGE_LINE_HEIGHT);
  const c = measureContext();
  c.letterSpacing = "0px";
  const tabular = !!look.tabularNums;
  const gs = graphemes(text);
  const xs: number[] = [];
  const ws: number[] = [];
  let x = 0;
  let prev: string | null = null;
  let prevFont = "";
  let at = 0;
  for (const g of gs) {
    c.font = stageFont(look, fs, weightAt(weights, at));
    at += g.length;
    const fixed = tabular && DIGIT.test(g);
    const w = fixed ? tabularDigitWidth(c) : advance(c, g);
    // Kerning between two ordinary letters of one font: the pair's width less the two alone.
    if (prev !== null && !fixed && !(tabular && DIGIT.test(prev)) && c.font === prevFont) x += advance(c, prev + g) - advance(c, prev) - w;
    xs.push(x);
    ws.push(w);
    x += w + spacing;
    prev = g;
    prevFont = c.font;
  }
  const width = gs.length ? x - spacing : 0;
  const room = frameWidth - 2 * padX;
  const align = look.textAlign ?? "left";
  const left = padX + (align === "center" ? (room - width) / 2 : align === "right" ? room - width : 0);
  let offset = 0;
  const glyphs: MeasuredGlyph[] = gs.map((g, i) => {
    const out = { text: g, start: offset, weight: weightAt(weights, offset), x: left + xs[i], y: padY, width: ws[i], height: lineHeight };
    offset += g.length;
    return out;
  });
  return { width: frameWidth, height: lineHeight + 2 * padY, glyphs, lines: [{ text, x: left, y: padY, start: 0 }] };
}

// Every character a live value in this text can show: its own words, digits, and what the formats
// add (clock separators, AM/PM, %, a sign, a decimal point).
export function liveCharset(template: string): Set<string> {
  const set = new Set(graphemes(template.replace(/\{[^}]*\}/g, "")));
  for (const ch of "0123456789:%.-, APM") set.add(ch);
  return set;
}

// Every face and weight a scene's text uses, loaded - text measured before its face arrives is laid
// out in a fallback face, and every letter lands somewhere else.
export async function loadStageFonts(scene: { elements: StageElement[]; beats: { changes: Record<string, { weightRuns?: StageWeightRun[] }> }[] }): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const fonts = new Set<string>();
  for (const e of scene.elements) {
    if (!e.textLook) continue;
    const runs = [e.props.weightRuns, ...scene.beats.map((b) => b.changes[e.id]?.weightRuns)].flatMap((r) => r ?? []);
    fonts.add(stageFont(e.textLook, 32));
    for (const r of runs) fonts.add(stageFont(e.textLook, 32, r.weight));
  }
  await Promise.all([...fonts].map((f) => document.fonts.load(f).catch(() => undefined)));
}
