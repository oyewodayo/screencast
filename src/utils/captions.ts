// utils/captions.ts
//
// The video editor's burned-in captions: style presets, turning per-source word transcripts into
// output-timed caption lines (through the current clips), and writing those lines out as an ASS
// script for export_trimmed_video to burn in with libass (conversion.rs). The live preview
// (CaptionOverlayLayer.tsx) renders the very same lines with CSS built from the same preset
// numbers, so what's shown over the video is what lands in the exported file.
import type { CSSProperties } from "react";
import { CaptionSettings, CaptionStylePreset, CaptionTrack, CaptionWord, Clip } from "./videoEditTypes";

export interface CaptionPresetDef {
  label: string;
  // A font every Windows install ships - libass (DirectWrite) and the WebView both resolve it to
  // the same face, which is what keeps preview and export matching.
  fontFamily: string;
  bold: boolean;
  textColor: string;
  // Word colour when emphasis is OFF - only differs from textColor where the preset's base colour
  // is a deliberately muted "not yet spoken" tone (card).
  plainColor?: string;
  emphasisColor: string;
  emphasisScale: number;
  box: { color: string; opacity: number } | null;
  outline: { color: string; width: number } | null; // width as a fraction of the font size
  shadow: number; // offset as a fraction of the font size, 0 = none
  // Soft glow around the letters - radius as a fraction of the font size. Exported as a blurred
  // outline in the glow colour (ASS \blur), previewed as stacked text-shadows.
  glow?: { color: string; radius: number };
  // "Button" emphasis - the word being spoken sits on a rounded pill in emphasisColor, with its
  // text in pill.textColor; radius is a fraction of the pill's height (0.5 = fully round ends).
  // Exported with every word explicitly positioned and the pill drawn as an ASS vector shape (see
  // buildCaptionsAss), since libass has no per-word rounded background of its own.
  pill?: { textColor: string; radius: number };
  uppercase: boolean;
  // libass sizes text by the font's ascender+descender height, CSS by its em box - this is that
  // ratio for fontFamily, so an ASS Fontsize of cssPx * factor renders the same visual size.
  assSizeFactor: number;
}

export const CAPTION_PRESETS: Record<CaptionStylePreset, CaptionPresetDef> = {
  highlight: {
    label: "Highlight",
    fontFamily: "Arial",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#d07cff",
    emphasisScale: 1,
    box: { color: "#000000", opacity: 0.8 },
    outline: null,
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.117,
  },
  outline: {
    label: "Outline",
    fontFamily: "Impact",
    bold: false,
    textColor: "#ffffff",
    emphasisColor: "#facc15",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.1 },
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.22,
  },
  clean: {
    label: "Clean",
    fontFamily: "Segoe UI",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#4ade80",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.04 },
    shadow: 0.06,
    uppercase: false,
    assSizeFactor: 1.33,
  },
  card: {
    label: "Card",
    fontFamily: "Georgia",
    bold: true,
    textColor: "#9ca3af",
    plainColor: "#111827",
    emphasisColor: "#111827",
    emphasisScale: 1,
    box: { color: "#ffffff", opacity: 1 },
    outline: null,
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.136,
  },
  classic: {
    label: "Classic",
    fontFamily: "Georgia",
    bold: false,
    textColor: "#ffffff",
    emphasisColor: "#86efac",
    emphasisScale: 1,
    box: { color: "#000000", opacity: 0.85 },
    outline: null,
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.136,
  },
  pop: {
    label: "Pop",
    fontFamily: "Arial Black",
    bold: false,
    textColor: "#facc15",
    emphasisColor: "#ffffff",
    emphasisScale: 1.15,
    box: null,
    outline: { color: "#000000", width: 0.12 },
    shadow: 0,
    uppercase: true,
    assSizeFactor: 1.41,
  },
  neon: {
    label: "Neon",
    fontFamily: "Segoe UI",
    bold: true,
    textColor: "#e0f2fe",
    emphasisColor: "#f0abfc",
    emphasisScale: 1,
    box: null,
    outline: null,
    shadow: 0,
    glow: { color: "#22d3ee", radius: 0.12 },
    uppercase: false,
    assSizeFactor: 1.33,
  },
  bubble: {
    label: "Bubble",
    fontFamily: "Segoe UI",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#fde047",
    emphasisScale: 1,
    box: { color: "#2563eb", opacity: 0.95 },
    outline: null,
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.33,
  },
  typewriter: {
    label: "Typewriter",
    fontFamily: "Courier New",
    bold: true,
    textColor: "#f5f5f4",
    emphasisColor: "#fbbf24",
    emphasisScale: 1,
    box: { color: "#1c1917", opacity: 0.85 },
    outline: null,
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.133,
  },
  comic: {
    label: "Comic",
    fontFamily: "Comic Sans MS",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#fb7185",
    emphasisScale: 1.12,
    box: null,
    outline: { color: "#1e1b4b", width: 0.11 },
    shadow: 0,
    uppercase: false,
    assSizeFactor: 1.393,
  },
  tv: {
    label: "TV",
    fontFamily: "Arial",
    bold: false,
    textColor: "#fde047",
    emphasisColor: "#ffffff",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.06 },
    shadow: 0.05,
    uppercase: false,
    assSizeFactor: 1.117,
  },
  headline: {
    label: "Headline",
    fontFamily: "Arial Black",
    bold: false,
    textColor: "#ffffff",
    emphasisColor: "#fde047",
    emphasisScale: 1,
    box: { color: "#dc2626", opacity: 1 },
    outline: null,
    shadow: 0,
    uppercase: true,
    assSizeFactor: 1.41,
  },
  button: {
    label: "Button",
    fontFamily: "Arial",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#8b5cf6",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.05 },
    shadow: 0,
    pill: { textColor: "#ffffff", radius: 0.5 },
    uppercase: false,
    assSizeFactor: 1.117,
  },
  spotlight: {
    label: "Spotlight",
    fontFamily: "Arial Black",
    bold: false,
    textColor: "#ffffff",
    emphasisColor: "#facc15",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.08 },
    shadow: 0,
    pill: { textColor: "#111827", radius: 0.28 },
    uppercase: true,
    assSizeFactor: 1.41,
  },
  chip: {
    label: "Chip",
    fontFamily: "Segoe UI",
    bold: true,
    textColor: "#ffffff",
    emphasisColor: "#16a34a",
    emphasisScale: 1,
    box: null,
    outline: { color: "#000000", width: 0.03 },
    shadow: 0.05,
    pill: { textColor: "#ffffff", radius: 0.22 },
    uppercase: false,
    assSizeFactor: 1.33,
  },
};

export const CAPTION_PRESET_ORDER: CaptionStylePreset[] = [
  "highlight",
  "outline",
  "clean",
  "card",
  "classic",
  "pop",
  "neon",
  "bubble",
  "typewriter",
  "comic",
  "tv",
  "headline",
  "button",
  "spotlight",
  "chip",
];

export function defaultCaptionSettings(preset: CaptionStylePreset = "highlight"): CaptionSettings {
  const def = CAPTION_PRESETS[preset];
  return {
    enabled: true,
    preset,
    emphasis: true,
    emphasisColor: def.emphasisColor,
    position: "bottom",
    offset: 0.08,
    size: 1,
    maxWordsPerLine: 6,
    uppercase: def.uppercase,
  };
}

// Base caption text size as a fraction of the frame height, before CaptionSettings.size.
const BASE_FONT_FRACTION = 0.05;
// Box padding (CSS) / ASS opaque-box border, as a fraction of the font size.
export const BOX_PAD_FRACTION = 0.28;
// A new line starts after a pause this long, even mid-sentence.
const LINE_BREAK_PAUSE_SEC = 0.8;
// How long a line stays up after its last word, if the next line isn't already due.
const LINE_HOLD_SEC = 0.6;

export function captionFontPx(settings: CaptionSettings, frameHeight: number): number {
  return Math.max(8, frameHeight * BASE_FONT_FRACTION * settings.size);
}

export interface CaptionLineWord {
  start: number; // output seconds
  end: number;
  text: string;
}

export interface CaptionLine {
  id: string;
  start: number; // output seconds
  end: number;
  words: CaptionLineWord[];
  // Where this line's words live in CaptionTrack.transcripts[sourcePath] - what editing a line's
  // text rewrites (replaceCaptionLineText) and what clicking it seeks to.
  sourcePath: string;
  firstWordIndex: number;
  lastWordIndex: number;
  sourceStart: number;
}

// Maps every transcript word that survives the current edit (inside some clip's [start,end)) onto
// the output timeline - clips in order, each scaled by its own speed, the same output-time model
// text overlays and the timeline ruler use - and groups them into lines: a new line at
// maxWordsPerLine, after a sentence-ending word, after a pause, and always at a clip boundary.
export function buildCaptionLines(clips: Clip[], track: CaptionTrack | null): CaptionLine[] {
  if (!track) return [];
  const maxWords = Math.max(1, Math.round(track.settings.maxWordsPerLine));
  const lines: CaptionLine[] = [];
  let offset = 0;
  for (const clip of clips) {
    const speed = clip.speed ?? 1;
    const words = track.transcripts[clip.sourcePath] ?? [];
    let current: CaptionLine | null = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.end <= clip.start || w.start >= clip.end) continue;
      const start = offset + (Math.max(w.start, clip.start) - clip.start) / speed;
      const end = offset + (Math.min(w.end, clip.end) - clip.start) / speed;
      const prev: CaptionLineWord | undefined = current?.words[current.words.length - 1];
      const breakBefore =
        !current ||
        !prev ||
        current.words.length >= maxWords ||
        start - prev.end > LINE_BREAK_PAUSE_SEC ||
        !!w.lineStart ||
        /[.?!]["')\]]*$/.test(prev.text);
      if (breakBefore) {
        if (current) lines.push(current);
        current = {
          id: `${clip.id}:${i}`,
          start,
          end,
          words: [],
          sourcePath: clip.sourcePath,
          firstWordIndex: i,
          lastWordIndex: i,
          sourceStart: w.start,
        };
      }
      current!.words.push({ start, end: Math.max(end, start), text: w.text });
      current!.lastWordIndex = i;
    }
    if (current) lines.push(current);
    offset += Math.max(0, (clip.end - clip.start) / speed);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const last = line.words[line.words.length - 1];
    const nextStart = i + 1 < lines.length ? lines[i + 1].start : Infinity;
    line.start = line.words[0].start;
    line.end = Math.max(line.start + 0.05, Math.min(last.end + LINE_HOLD_SEC, nextStart));
  }
  return lines;
}

export function captionLineAt(lines: CaptionLine[], outputTime: number): CaptionLine | null {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid];
    if (outputTime < line.start) hi = mid - 1;
    else if (outputTime >= line.end) lo = mid + 1;
    else return line;
  }
  return null;
}

// Index of the word being spoken at outputTime - the last word that has started, so the highlight
// stays on a word through the gap before the next one instead of flickering off.
export function activeWordIndex(line: CaptionLine, outputTime: number): number {
  let idx = -1;
  for (let i = 0; i < line.words.length; i++) {
    if (line.words[i].start <= outputTime) idx = i;
    else break;
  }
  return idx;
}

// Rewrites one line's words in its source transcript. The edited words share the original span
// in proportion to their length - close enough for a corrected word or two, and the only timing
// available for text whisper never heard. Empty text removes the line's words.
export function replaceCaptionLineText(track: CaptionTrack, line: CaptionLine, text: string): CaptionTrack {
  const words = track.transcripts[line.sourcePath] ?? [];
  const first = words[line.firstWordIndex];
  const last = words[line.lastWordIndex];
  if (!first || !last) return track;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const spanStart = first.start;
  const spanEnd = Math.max(last.end, spanStart + 0.05);
  const totalChars = tokens.reduce((sum, t) => sum + t.length, 0) || 1;
  let cursor = spanStart;
  const replacement: CaptionWord[] = tokens.map((t) => {
    const dur = ((spanEnd - spanStart) * t.length) / totalChars;
    const word = { start: cursor, end: cursor + dur, text: t };
    cursor += dur;
    return word;
  });
  if (replacement.length > 0 && first.lineStart) replacement[0].lineStart = true;
  const next = [...words.slice(0, line.firstWordIndex), ...replacement, ...words.slice(line.lastWordIndex + 1)];
  return { ...track, transcripts: { ...track.transcripts, [line.sourcePath]: next } };
}

export function displayWord(text: string, settings: CaptionSettings): string {
  return settings.uppercase ? text.toLocaleUpperCase() : text;
}

// ---------- Preview (CSS) ----------

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Styles for the line's text box at a given font size - shared by the preview overlay and the
// panel's preset thumbnails.
export function captionBoxStyle(preset: CaptionPresetDef, fontPx: number): CSSProperties {
  const style: CSSProperties = {
    fontFamily: `"${preset.fontFamily}", sans-serif`,
    fontWeight: preset.bold ? 700 : 400,
    fontSize: fontPx,
    lineHeight: 1.15,
    color: preset.textColor,
    textAlign: "center",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  };
  if (preset.box) {
    style.backgroundColor = hexToRgba(preset.box.color, preset.box.opacity);
    // Same padding on every side as the ASS box (Outline = fontPx * BOX_PAD_FRACTION), square
    // corners like libass draws it.
    style.padding = fontPx * BOX_PAD_FRACTION;
  }
  if (preset.outline) {
    // Stroke is centred on the glyph edge, so twice the width with the fill painted on top gives
    // the same outside-only outline libass draws.
    style.WebkitTextStroke = `${fontPx * preset.outline.width * 2}px ${preset.outline.color}`;
    style.paintOrder = "stroke fill";
  }
  if (preset.shadow > 0) {
    const d = fontPx * preset.shadow;
    style.textShadow = `${d}px ${d}px 0 rgba(0,0,0,0.75)`;
  }
  if (preset.glow) {
    const r = fontPx * preset.glow.radius;
    style.textShadow = `0 0 ${r * 0.5}px ${preset.glow.color}, 0 0 ${r}px ${preset.glow.color}, 0 0 ${r * 2}px ${preset.glow.color}`;
  }
  return style;
}

export function captionWordColor(preset: CaptionPresetDef, settings: CaptionSettings, isActive: boolean): string {
  if (!settings.emphasis) return preset.plainColor ?? preset.textColor;
  if (isActive && preset.pill) return preset.pill.textColor;
  return isActive ? settings.emphasisColor : preset.textColor;
}

// "Button" (pill) geometry, as fractions of the font size - shared by the preview and the export
// so the pill lands in the same place in both.
const PILL_PAD_X = 0.22;
const PILL_PAD_Y = 0.08;
// Extra space between words (on top of a normal space) in pill presets, so a pill never butts up
// against its neighbours.
const PILL_WORD_GAP = 0.14;
// Row pitch for pill presets - taller than plain text so stacked rows' pills don't touch.
const PILL_ROW_HEIGHT = 1.45;

export function captionRowHeightPx(preset: CaptionPresetDef, fontPx: number): number {
  if (preset.pill) return fontPx * PILL_ROW_HEIGHT;
  return fontPx * (1.15 + (preset.box ? 2 * BOX_PAD_FRACTION : 0));
}

function cssFont(preset: CaptionPresetDef, fontPx: number): string {
  return `${preset.bold ? 700 : 400} ${fontPx}px "${preset.fontFamily}"`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
// Width of `text` in CSS px at fontPx - the export's word layout for pill presets. Matches libass:
// both lay text out from the same font file's advances (verified against the bundled ffmpeg for
// Arial, Arial Black, Segoe UI and Comic Sans at the assSizeFactor conversion).
export function measureCaptionText(text: string, preset: CaptionPresetDef, fontPx: number): number {
  if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * fontPx * 0.55; // no canvas (tests) - rough estimate
  measureCtx.font = cssFont(preset, fontPx);
  return measureCtx.measureText(text).width;
}

// Per-word preview style: colour, plus the pill itself for the active word of a pill preset. The
// pill's padding is cancelled out by a negative margin, so lighting a word up never reflows the
// line - exactly as in the export, where the pill is drawn behind already-placed words.
export function captionWordStyle(preset: CaptionPresetDef, settings: CaptionSettings, isActive: boolean, fontPx: number): CSSProperties {
  const style: CSSProperties = { color: captionWordColor(preset, settings, isActive) };
  if (!preset.pill) return style;
  const gap = (fontPx * PILL_WORD_GAP) / 2;
  style.marginInline = gap;
  if (isActive && settings.emphasis) {
    const padX = fontPx * PILL_PAD_X;
    const padY = fontPx * PILL_PAD_Y;
    const pillH = fontPx * 1.15 + 2 * padY;
    style.backgroundColor = settings.emphasisColor;
    style.padding = `${padY}px ${padX}px`;
    style.marginInline = gap - padX;
    style.borderRadius = pillH * preset.pill.radius;
    style.WebkitTextStroke = "0";
    style.textShadow = "none";
  }
  return style;
}

// ---------- Export (ASS) ----------

// #rrggbb + opacity -> ASS's &HAABBGGRR (alpha inverted: 00 is opaque).
function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const rgb = m ? m[1] : "ffffff";
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

// Braces open override blocks and backslashes start escapes in ASS dialogue text.
function assText(text: string): string {
  return text.replace(/\\/g, "∖").replace(/\{/g, "(").replace(/\}/g, ")");
}

export function buildCaptionsAss(lines: CaptionLine[], settings: CaptionSettings, width: number, height: number): string {
  const preset = CAPTION_PRESETS[settings.preset];
  const fontPx = captionFontPx(settings, height);
  const fontSize = Math.round(fontPx * preset.assSizeFactor);
  const alignment = settings.position === "top" ? 8 : settings.position === "middle" ? 5 : 2;
  const marginV = settings.position === "middle" ? 0 : Math.round(settings.offset * height);
  const marginH = Math.round(width * 0.06);
  const baseColor = settings.emphasis ? preset.textColor : preset.plainColor ?? preset.textColor;

  // Boxed presets use libass's BorderStyle 4: ONE box per line in BackColour, padded by Outline px
  // (the outline itself made fully transparent). BorderStyle 3 boxes each word separately, which
  // shows dark seams where a translucent box's pieces overlap - checked against the bundled ffmpeg.
  // Everything else is BorderStyle 1: outline + drop shadow.
  const boxed = preset.box !== null;
  const borderStyle = boxed ? 4 : 1;
  const outlineColour = boxed ? "&HFF000000" : assColor(preset.glow?.color ?? preset.outline?.color ?? "#000000");
  const backColour = boxed ? assColor(preset.box!.color, preset.box!.opacity) : assColor("#000000", 0.75);
  const outline = boxed
    ? Math.round(fontPx * BOX_PAD_FRACTION)
    : preset.glow
      ? Math.max(1, Math.round(fontPx * preset.glow.radius * 0.6))
      : Math.round(fontPx * (preset.outline?.width ?? 0));
  const shadow = boxed ? 0 : Math.round(fontPx * preset.shadow);
  // Every event starts with this - blurring the glow-coloured outline is what turns it into a glow.
  const linePrefix = preset.glow ? `{\\blur${Math.max(1, Math.round(fontPx * preset.glow.radius * 0.8))}}` : "";

  const style = [
    "Cap",
    preset.fontFamily,
    fontSize,
    assColor(baseColor),
    assColor(baseColor),
    outlineColour,
    backColour,
    preset.bold ? -1 : 0,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    borderStyle,
    outline,
    shadow,
    alignment,
    marginH,
    marginH,
    marginV,
    1,
  ].join(",");

  const out: string[] = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: ${style}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const scaled = preset.emphasisScale !== 1;
  const emphasisTag = (() => {
    const scale = scaled ? `\\fscx${Math.round(preset.emphasisScale * 100)}\\fscy${Math.round(preset.emphasisScale * 100)}` : "";
    return `{\\c${assColor(settings.emphasisColor)}${scale}}`;
  })();
  // Restores only what emphasisTag changed - not {\r}, which would also drop linePrefix's blur.
  const emphasisEnd = `{\\c${assColor(baseColor)}${scaled ? "\\fscx100\\fscy100" : ""}}`;

  const pill = settings.emphasis ? preset.pill : undefined;

  for (const line of lines) {
    const texts = line.words.map((w) => assText(displayWord(w.text, settings)));
    if (pill) {
      out.push(...pillLineEvents(line, preset, settings, pill, { fontPx, width, height, marginV, baseColor, linePrefix }));
      continue;
    }
    if (!settings.emphasis) {
      out.push(`Dialogue: 0,${assTime(line.start)},${assTime(line.end)},Cap,,0,0,0,,${linePrefix}${texts.join(" ")}`);
      continue;
    }
    // One event per word: the whole line, with only that word in the emphasis colour - each runs
    // until the next word starts (the last until the line ends), so the line itself never blinks.
    for (let k = 0; k < line.words.length; k++) {
      const start = k === 0 ? line.start : line.words[k].start;
      const end = k + 1 < line.words.length ? line.words[k + 1].start : line.end;
      if (end - start < 0.01) continue;
      const text = texts.map((t, i) => (i === k ? `${emphasisTag}${t}${emphasisEnd}` : t)).join(" ");
      out.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${linePrefix}${text}`);
    }
  }
  return out.join("\n") + "\n";
}

// Rounded rectangle as an ASS vector drawing (\p1), origin at its top-left - straight edges plus a
// cubic Bezier per corner (0.5523 is the usual circle-quadrant handle length).
function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = 0.5523 * rr;
  const n = (v: number) => v.toFixed(1);
  return [
    `m ${n(rr)} 0`,
    `l ${n(w - rr)} 0`,
    `b ${n(w - rr + k)} 0 ${n(w)} ${n(rr - k)} ${n(w)} ${n(rr)}`,
    `l ${n(w)} ${n(h - rr)}`,
    `b ${n(w)} ${n(h - rr + k)} ${n(w - rr + k)} ${n(h)} ${n(w - rr)} ${n(h)}`,
    `l ${n(rr)} ${n(h)}`,
    `b ${n(rr - k)} ${n(h)} 0 ${n(h - rr + k)} 0 ${n(h - rr)}`,
    `l 0 ${n(rr)}`,
    `b 0 ${n(rr - k)} ${n(rr - k)} 0 ${n(rr)} 0`,
  ].join(" ");
}

// A pill-preset line: this lays the words out itself (measured widths, wrapped at the same 88% of
// the frame the preview uses, rows stacked from the anchored edge) and positions every word
// explicitly, so the pill - a vector shape on the layer below - can be drawn exactly behind the
// word being spoken. One set of events per word, like the plain emphasis path.
function pillLineEvents(
  line: CaptionLine,
  preset: CaptionPresetDef,
  settings: CaptionSettings,
  pill: NonNullable<CaptionPresetDef["pill"]>,
  frame: { fontPx: number; width: number; height: number; marginV: number; baseColor: string; linePrefix: string }
): string[] {
  const { fontPx, width, height, marginV, baseColor, linePrefix } = frame;
  const words = line.words.map((w) => displayWord(w.text, settings));
  const widths = words.map((t) => measureCaptionText(t, preset, fontPx));
  const gap = measureCaptionText(" ", preset, fontPx) + fontPx * PILL_WORD_GAP;
  const maxRowWidth = width * 0.88;

  const rows: { from: number; to: number; width: number }[] = [];
  words.forEach((_, i) => {
    const row = rows[rows.length - 1];
    if (row && row.width + gap + widths[i] <= maxRowWidth) {
      row.width += gap + widths[i];
      row.to = i + 1;
    } else {
      rows.push({ from: i, to: i + 1, width: widths[i] });
    }
  });

  const rowHeight = fontPx * PILL_ROW_HEIGHT;
  const blockHeight = rows.length * rowHeight;
  const blockTop =
    settings.position === "top" ? marginV : settings.position === "middle" ? (height - blockHeight) / 2 : height - marginV - blockHeight;
  const pos: { x: number; y: number }[] = [];
  rows.forEach((row, r) => {
    let x = (width - row.width) / 2;
    const y = blockTop + rowHeight * (r + 0.5);
    for (let i = row.from; i < row.to; i++) {
      pos[i] = { x, y };
      x += widths[i] + gap;
    }
  });

  const padX = fontPx * PILL_PAD_X;
  const pillHeight = fontPx * 1.15 + 2 * fontPx * PILL_PAD_Y;
  const n = (v: number) => v.toFixed(1);
  const events: string[] = [];
  for (let k = 0; k < line.words.length; k++) {
    const start = assTime(k === 0 ? line.start : line.words[k].start);
    const end = assTime(k + 1 < line.words.length ? line.words[k + 1].start : line.end);
    if (start === end) continue;
    const pillWidth = widths[k] + 2 * padX;
    events.push(
      `Dialogue: 0,${start},${end},Cap,,0,0,0,,{\\an7\\pos(${n(pos[k].x - padX)},${n(pos[k].y - pillHeight / 2)})\\bord0\\shad0\\blur0\\1c${assColor(settings.emphasisColor)}\\1a&H00&\\p1}${roundedRectPath(pillWidth, pillHeight, pillHeight * pill.radius)}`
    );
    words.forEach((word, i) => {
      const active = i === k;
      const tags = active ? `\\c${assColor(pill.textColor)}\\bord0\\shad0` : `\\c${assColor(baseColor)}`;
      events.push(`Dialogue: 1,${start},${end},Cap,,0,0,0,,${linePrefix}{\\an4\\pos(${n(pos[i].x)},${n(pos[i].y)})${tags}}${assText(word)}`);
    });
  }
  return events;
}

// ---------- Import (.srt / .vtt) ----------

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const CUE_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseCueTime(raw: string): number | null {
  const m = CUE_TIME.exec(raw);
  if (!m) return null;
  const [, h, min, sec, frac] = m;
  return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(min, 10) * 60 + parseInt(sec, 10) + parseInt(frac.padEnd(3, "0"), 10) / 1000;
}

// SRT and WebVTT share the block shape this reads: optional id/number line, a "start --> end"
// line (VTT may add cue settings after it), then text lines until a blank line. Styling markup
// (<i>, <b>, <c.class>, <00:00:01.000> karaoke stamps, SRT {\an8}-style tags) is stripped - the
// Captions tool's own style replaces it. NOTE/STYLE/REGION blocks have no "-->" and are skipped.
export function parseSubtitleFile(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split("\n");
    const timingIndex = rows.findIndex((r) => r.includes("-->"));
    if (timingIndex < 0) continue;
    const [left, right] = rows[timingIndex].split("-->");
    const start = parseCueTime(left);
    const end = parseCueTime(right ?? "");
    if (start === null || end === null || end <= start) continue;
    const body = rows
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// A cue only times the whole line, so its words share the cue's span in proportion to their
// length - the same estimate replaceCaptionLineText uses for edited text.
export function cuesToCaptionWords(cues: SubtitleCue[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    const totalChars = tokens.reduce((sum, t) => sum + t.length, 0) || 1;
    let cursor = cue.start;
    tokens.forEach((t, i) => {
      const dur = ((cue.end - cue.start) * t.length) / totalChars;
      words.push({ start: cursor, end: cursor + dur, text: t, ...(i === 0 ? { lineStart: true } : {}) });
      cursor += dur;
    });
  }
  return words;
}
