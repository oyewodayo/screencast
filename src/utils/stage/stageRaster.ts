// utils/stage/stageRaster.ts
//
// Text drawn for the Stage renderer, from the layout stageMeasure.ts made - two forms:
// - a whole-text raster for text at rest: the laid-out lines drawn straight into a canvas at the
//   exact output scale (the browser's own subpixel text, as crisp as text gets), with a margin of
//   empty pixels round it so blur has room to spread;
// - a glyph atlas for a morph: each grapheme drawn once in white, so the GPU can place, tint, fade
//   and blur every letter on its own while words move.
// Letters sit where the layout put them in both, so a morph hands over to the text at rest without
// moving a pixel.
import type { MeasuredText } from "./stageLayout";
import { DEFAULT_STAGE_LINE_HEIGHT, stageFont } from "./stageMeasure";
import type { StageColorRun, StageElement, StageTextLook } from "./stageTypes";

const lookOf = (e: StageElement): StageTextLook => e.textLook ?? { fontSize: 40 };

// Where letters sit in a line box, exactly as the overlay titles place them (drawLevelText): the
// face's ascent-to-descent band centred in the line height, measured against the "top" baseline.
function glyphTop(ctx: CanvasRenderingContext2D, lineHeightPx: number, fontPx: number): number {
  const m = ctx.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent ?? 0;
  const descent = m.fontBoundingBoxDescent ?? fontPx;
  return (lineHeightPx - (ascent + descent)) / 2 + ascent;
}

export interface TextRaster {
  canvas: HTMLCanvasElement;
  // Device px per stage unit, and the empty margin round the text (stage units).
  scale: number;
  margin: number;
}

// `layout`'s text drawn at `scale` px per stage unit, `margin` stage units of room all round.
export function rasterStageText(element: StageElement, layout: MeasuredText, color: string, runs: StageColorRun[] | undefined, scale: number, margin: number, into?: HTMLCanvasElement): TextRaster {
  const look = lookOf(element);
  const canvas = into ?? document.createElement("canvas");
  const w = Math.max(1, Math.ceil((layout.width + 2 * margin) * scale));
  const h = Math.max(1, Math.ceil((layout.height + 2 * margin) * scale));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const fontPx = look.fontSize * scale;
  const spacingPx = (look.letterSpacing ?? 0) * fontPx;
  ctx.font = stageFont(look, fontPx);
  ctx.letterSpacing = `${spacingPx}px`;
  ctx.textBaseline = "top";
  const lineHeightPx = fontPx * (look.lineHeight ?? DEFAULT_STAGE_LINE_HEIGHT);
  const top = glyphTop(ctx, lineHeightPx, fontPx);
  const m = margin * scale;
  // Letters where the layout put them: a run of one colour drawn as one string from its first
  // letter (keeping the font's kerning), a tabular digit on its own, centred in its fixed room.
  const colorAt = (offset: number) => runs?.find((r) => offset >= r.start && offset < r.end)?.color ?? color;
  const tabular = !!look.tabularNums;
  const glyphs = layout.glyphs;
  for (let i = 0; i < glyphs.length; ) {
    const first = glyphs[i];
    const fill = colorAt(first.start ?? 0);
    const x = m + first.x * scale;
    const y = m + first.y * scale + top;
    ctx.font = stageFont(look, fontPx, first.weight);
    if (tabular && DIGIT.test(first.text)) {
      ctx.fillStyle = fill;
      // measureText counts the tracking after the digit; its ink is the rest.
      ctx.fillText(first.text, x + (first.width * scale - (ctx.measureText(first.text).width - spacingPx)) / 2, y);
      i++;
      continue;
    }
    let text = first.text;
    let j = i + 1;
    for (; j < glyphs.length; j++) {
      const g = glyphs[j];
      const prev = glyphs[j - 1];
      if (g.y !== first.y || g.width === 0 || g.weight !== first.weight || (tabular && DIGIT.test(g.text)) || colorAt(g.start ?? 0) !== fill || g.start !== (prev.start ?? 0) + prev.text.length) break;
      text += g.text;
    }
    if (first.width > 0 || text.trim()) {
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
    }
    i = j;
  }
  ctx.letterSpacing = "0px";
  return { canvas, scale, margin };
}

const DIGIT = /^[0-9]$/;

export interface AtlasCell {
  // Texture coordinates (0..1, top-left origin) and the cell's size in stage units.
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  width: number;
  height: number;
}

export interface GlyphAtlas {
  canvas: HTMLCanvasElement;
  scale: number;
  margin: number;
  cells: Map<string, AtlasCell>;
  // Bumped each time the atlas is redrawn - the renderer re-uploads it then.
  version: number;
}

const ATLAS_WIDTH = 2048;

// An atlas cell's key: a grapheme in a weight (none = the look's own).
export const atlasCellKey = (text: string, weight?: number) => `${weight ?? ""}\u0000${text}`;

// White graphemes in `look` at `scale`, with `margin` stage units round each - reusing `prev` when it
// already holds every cell asked for. Texts that look alike share one atlas. `cellKeys` are
// atlasCellKey()s: a grapheme and the weight it's drawn in.
export function glyphAtlas(look: StageTextLook, cellKeys: Iterable<string>, scale: number, margin: number, prev?: GlyphAtlas): GlyphAtlas {
  const wanted = new Set(cellKeys);
  if (prev && prev.scale === scale && prev.margin === margin && [...wanted].every((g) => prev.cells.has(g))) return prev;
  if (prev) for (const g of prev.cells.keys()) wanted.add(g);
  const fontPx = look.fontSize * scale;
  const lineHeightPx = fontPx * (look.lineHeight ?? DEFAULT_STAGE_LINE_HEIGHT);
  const m = Math.ceil(margin * scale);
  const canvas = prev?.canvas ?? document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = stageFont(look, fontPx);
  // Shelf-pack the cells in rows.
  const cellH = Math.ceil(lineHeightPx) + 2 * m;
  const placed: { key: string; g: string; weight?: number; x: number; y: number; w: number }[] = [];
  let x = 0;
  let y = 0;
  for (const key of wanted) {
    const cut = key.indexOf("\u0000");
    const weight = cut > 0 ? Number(key.slice(0, cut)) : undefined;
    const g = key.slice(cut + 1);
    ctx.font = stageFont(look, fontPx, weight);
    const w = Math.ceil(ctx.measureText(g).width) + 2 * m;
    if (x + w > ATLAS_WIDTH) {
      x = 0;
      y += cellH;
    }
    placed.push({ key, g, weight, x, y, w });
    x += w;
  }
  const height = y + cellH;
  canvas.width = ATLAS_WIDTH;
  canvas.height = Math.max(1, height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = stageFont(look, fontPx);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  const top = glyphTop(ctx, lineHeightPx, fontPx);
  const cells = new Map<string, AtlasCell>();
  for (const p of placed) {
    ctx.font = stageFont(look, fontPx, p.weight);
    ctx.fillText(p.g, p.x + m, p.y + m + top);
    cells.set(p.key, { u0: p.x / ATLAS_WIDTH, v0: p.y / canvas.height, u1: (p.x + p.w) / ATLAS_WIDTH, v1: (p.y + cellH) / canvas.height, width: p.w / scale, height: cellH / scale });
  }
  return { canvas, scale, margin: m / scale, cells, version: (prev?.version ?? 0) + 1 };
}
