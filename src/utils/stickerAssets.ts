// utils/stickerAssets.ts
//
// Designed "sticker" elements for the video editor - label chips, name tags, stat counters, info
// and place cards, icon discs, titles, milestones, quotes, profiles, ratings, meters, checklists,
// prices, chat bubbles, versus and date cards, single icons and emoji - in the chunky style of
// explainer videos: a
// bold rounded face, a hard offset edge under every piece, small icons and pictures inside. They
// are ordinary elements (videoAssets.ts draws them through drawSticker, for the preview and for
// export alike), so every one moves, retimes, keyframes and undoes like any other overlay.
//
// Every sticker takes the same style switches - Solid / Outline / No background, a border, the
// 3D edge - and an icon or the user's own picture where the icon goes.

import { invoke } from "@tauri-apps/api/core";
import type { OverlayAsset } from "./videoAssets";
import { StickerIcon, drawStickerIcon } from "./stickerIcons";

export { STICKER_ICONS, drawStickerIcon, searchIcons, type StickerIcon } from "./stickerIcons";

export type StickerFill = "solid" | "outline" | "none";

// The palette the reference style is built from.
export const STICKER_COLORS = {
  navy: "#0b2f8f",
  blue: "#1463f3",
  amber: "#f9b54c",
  teal: "#0f8a6c",
  plum: "#8a1c6b",
  red: "#e5484d",
  ink: "#111827",
  white: "#ffffff",
};

export const STICKER_KINDS = [
  "chip",
  "name-tag",
  "stat",
  "card",
  "place",
  "disc",
  "title",
  "milestone",
  "icon",
  "emoji",
  "quote",
  "profile",
  "rating",
  "meter",
  "checklist",
  "price",
  "message",
  "versus",
  "date",
] as const;
export type StickerKind = (typeof STICKER_KINDS)[number];
export const isStickerKind = (kind: string): kind is StickerKind => (STICKER_KINDS as readonly string[]).includes(kind);

// Stickers that size themselves to their words - the box is only an upper bound, and adding one
// (or changing its text) fits the box to them (stickerAspect).
const HUGGING = new Set<StickerKind>(["chip", "name-tag", "disc", "title", "milestone", "icon", "emoji", "versus"]);
export const stickerHugs = (kind: string): boolean => HUGGING.has(kind as StickerKind);
// Stickers with a background the Style switches act on (a title and a milestone are words on the
// picture; their chips and disc keep their own fill).
export const stickerHasSurface = (kind: string): boolean => kind !== "title" && kind !== "milestone";
// The third text field (a corner tag, a kicker over a headline).
export const stickerTagLabel = (kind: string): string | null =>
  kind === "name-tag" || kind === "disc"
    ? "Corner tag"
    : kind === "card" || kind === "title" || kind === "checklist"
      ? "Kicker"
      : kind === "milestone"
        ? "Pill"
        : kind === "quote"
          ? "Role"
          : kind === "profile"
            ? "Button"
            : kind === "price"
              ? "Was"
              : kind === "message"
                ? "Sender"
                : kind === "date"
                  ? "Date"
                  : null;
// What a sticker can show besides words: an icon and/or a picture in the icon's place, a picture
// only (a speaker's photo), an icon only, or neither.
export const stickerArt = (kind: string): "both" | "picture" | "icon" | null =>
  ["chip", "name-tag", "card", "place", "disc", "title", "profile"].includes(kind) ? "both" : kind === "quote" || kind === "message" ? "picture" : kind === "icon" ? "icon" : null;
// What the icon picker sets on a sticker that uses its icon for something other than art.
export const stickerIconRole = (kind: string): string => (kind === "profile" ? "Badge" : "Icon");
// A checklist's items, typed in one field and split at semicolons.
export const checklistItems = (text: string | undefined): string[] =>
  (text ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);

// A stat counts up for this long once it has entered.
export const STAT_COUNT_SEC = 1.6;
// A chat bubble shows typing dots for this long before its words.
const TYPING_SEC = 0.9;
// Each checklist item ticks this long after the one before it.
const TICK_STEP_SEC = 0.35;

const EMOJI_FACE = `"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;

// ---------- fonts and pictures ----------

const FACE = `"Poppins", "Inter", "Segoe UI", system-ui, sans-serif`;
const font = (weight: 600 | 800, px: number) => `${weight} ${Math.max(1, px)}px ${FACE}`;

// Bumped whenever a face or a picture finishes loading, so a canvas paused on one frame knows to
// draw it again (AssetCanvas).
let resourceVersion = 0;
export const stickerResourceVersion = (): number => resourceVersion;

let fontsRequested: Promise<void> | null = null;
function ensureFonts(): Promise<void> {
  if (!fontsRequested) {
    fontsRequested =
      typeof document !== "undefined" && document.fonts
        ? Promise.all([document.fonts.load(font(800, 32)), document.fonts.load(font(600, 32))])
            .then(() => {
              resourceVersion++;
            })
            .catch(() => undefined)
        : Promise.resolve();
  }
  return fontsRequested;
}

// Pictures go through a data: URL (read_image_data_url) - an asset:// one would taint the canvas
// export reads back (see loadOverlayImage, videoOverlayRender.ts).
const pictures = new Map<string, HTMLImageElement | Promise<HTMLImageElement | null> | null>();
function loadPicture(path: string): Promise<HTMLImageElement | null> {
  const known = pictures.get(path);
  if (known instanceof Promise) return known;
  if (known !== undefined) return Promise.resolve(known);
  const pending = invoke<string>("read_image_data_url", { path })
    .then(
      (url) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        })
    )
    .catch(() => null)
    .then((img) => {
      pictures.set(path, img);
      resourceVersion++;
      return img;
    });
  pictures.set(path, pending);
  return pending;
}
const pictureNow = (path: string | undefined): HTMLImageElement | null => {
  if (!path) return null;
  const known = pictures.get(path);
  if (known === undefined) void loadPicture(path);
  return known instanceof HTMLImageElement ? known : null;
};

// Everything a sticker draws with, loaded - export waits on this before its first frame.
export async function loadStickerResources(asset: OverlayAsset): Promise<void> {
  await ensureFonts();
  if (asset.image) await loadPicture(asset.image);
}

// ---------- colour ----------

const parseHex = (color: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
};
const isDark = (color: string): boolean => {
  const rgb = parseHex(color);
  return !!rgb && 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 150;
};
// Words on a surface: white on a dark one, the edge colour (navy by default) on a light one.
const inkOn = (surface: string, edge: string): string => (isDark(surface) ? "#ffffff" : edge);

// ---------- shapes ----------

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
  ctx.beginPath();
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, rr);
  else ctx.rect(x, y, w, h);
};

interface Style {
  fill: StickerFill;
  border: boolean;
  lip: boolean;
  edge: string;
}
const styleOf = (asset: OverlayAsset): Style => ({
  fill: asset.fill ?? "solid",
  border: !!asset.border,
  lip: asset.lip !== false,
  edge: asset.color2 ?? STICKER_COLORS.navy,
});
// Inner pieces (a chip on a card, a name tag's title) are always filled, and keep the 3D edge.
const solidLike = (s: Style): Style => ({ ...s, fill: "solid", border: false });

// A surface in `color`: its 3D edge offset under it, then the surface, then its border.
function surface(ctx: CanvasRenderingContext2D, trace: () => void, color: string, s: Style, lipX: number, lipY: number, lineW: number): void {
  if (s.fill === "none") return;
  if (s.lip && (lipX || lipY)) {
    ctx.save();
    ctx.translate(lipX, lipY);
    trace();
    if (s.fill === "outline") {
      ctx.strokeStyle = s.edge;
      ctx.lineWidth = lineW;
      ctx.stroke();
    } else {
      ctx.fillStyle = s.edge;
      ctx.fill();
    }
    ctx.restore();
  }
  trace();
  if (s.fill === "solid") {
    ctx.fillStyle = color;
    ctx.fill();
    if (s.border) {
      ctx.strokeStyle = s.edge;
      ctx.lineWidth = lineW;
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
    ctx.stroke();
  }
}

// The colour words and icons take on a surface drawn in `color` with style `s`. With no surface
// under them they sit on the video itself, where a dark colour would vanish - those go white.
const inkFor = (color: string, s: Style): string => (s.fill === "solid" ? inkOn(color, s.edge) : isDark(color) ? "#ffffff" : color);

// Words, with the 3D edge behind them when there's no solid surface to carry it.
function words(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, ink: string, s: Style, depth: number): void {
  if (!text) return;
  if (s.fill !== "solid" && s.lip && depth > 0) {
    ctx.fillStyle = s.edge;
    ctx.fillText(text, x + depth * 0.6, y + depth);
  }
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y);
}

// Shrinks `px` until `text` fits `maxW` at `weight`; leaves ctx.font set. Returns the width.
function fitText(ctx: CanvasRenderingContext2D, text: string, weight: 600 | 800, px: number, maxW: number): { px: number; width: number } {
  ctx.font = font(weight, px);
  let width = ctx.measureText(text).width;
  if (width > maxW && width > 0) {
    px = Math.max(1, (px * maxW) / width);
    ctx.font = font(weight, px);
    width = ctx.measureText(text).width;
  }
  return { px, width };
}

// Up to `maxLines` lines of `text` within `maxW`, shrinking the face until it fits.
function wrapText(ctx: CanvasRenderingContext2D, text: string, weight: 600 | 800, px: number, maxW: number, maxLines: number): { lines: string[]; px: number } {
  const wordsIn = text.split(/\s+/).filter(Boolean);
  for (let size = px; size >= px * 0.5; size *= 0.92) {
    ctx.font = font(weight, size);
    const lines: string[] = [];
    let line = "";
    for (const w of wordsIn) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width <= maxW || !line) line = next;
      else {
        lines.push(line);
        line = w;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) {
      // Two lines are split where they come out most even - no lone last word.
      if (lines.length === 2) {
        let best = lines;
        let bestW = Infinity;
        for (let k = 1; k < wordsIn.length; k++) {
          const pair = [wordsIn.slice(0, k).join(" "), wordsIn.slice(k).join(" ")];
          const widest = Math.max(ctx.measureText(pair[0]).width, ctx.measureText(pair[1]).width);
          if (widest <= maxW && widest < bestW) {
            best = pair;
            bestW = widest;
          }
        }
        return { lines: best, px: size };
      }
      return { lines, px: size };
    }
  }
  const { px: fitted } = fitText(ctx, text, weight, px * 0.5, maxW);
  return { lines: [text], px: fitted };
}

// A picture covering a box, clipped to whatever path `clip` traces.
function picture(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, clip: () => void): void {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.save();
  clip();
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

// ---------- pieces ----------

interface ChipSpec {
  label: string;
  icon: StickerIcon;
  img: HTMLImageElement | null;
  color: string;
}

// A chip's widths at pill height `ph`: lead padding, icon/picture room, gap, words, tail padding.
function chipLayout(ctx: CanvasRenderingContext2D, spec: ChipSpec, ph: number, maxW = Infinity) {
  const hasArt = !!spec.img || spec.icon !== "none";
  const artW = spec.img ? ph * 0.74 : hasArt ? ph * 0.5 : 0;
  const lead = spec.img ? ph * 0.13 : hasArt ? ph * 0.3 : ph * 0.42;
  const tail = spec.label ? ph * 0.42 : ph * 0.3;
  const gap = artW && spec.label ? ph * (spec.img ? 0.2 : 0.16) : 0;
  const fixed = lead + artW + gap + tail;
  const { px, width: textW } = spec.label ? fitText(ctx, spec.label, 800, ph * 0.44, Math.max(1, maxW - fixed)) : { px: ph * 0.44, width: 0 };
  return { lead, artW, gap, tail, textW, px, width: fixed + textW };
}

// A pill-shaped chip with its left edge at x and top at y. Returns the drawn width (no edge).
function chip(ctx: CanvasRenderingContext2D, spec: ChipSpec, s: Style, x: number, y: number, ph: number, maxW: number): number {
  const L = chipLayout(ctx, spec, ph, maxW);
  const width = Math.min(maxW, L.width);
  const lineW = Math.max(1.5, ph * 0.07);
  surface(ctx, () => roundRect(ctx, x, y, width, ph, ph * 0.42), spec.color, s, ph * 0.06, ph * 0.1, lineW);
  const ink = inkFor(spec.color, s);
  const midY = y + ph / 2;
  const artX = x + L.lead;
  if (spec.img) {
    const d = L.artW;
    picture(ctx, spec.img, artX, midY - d / 2, d, d, () => {
      ctx.beginPath();
      ctx.arc(artX + d / 2, midY, d / 2, 0, Math.PI * 2);
    });
  } else if (spec.icon !== "none") drawStickerIcon(ctx, spec.icon, artX + L.artW / 2, midY, L.artW, ink);
  if (spec.label) {
    ctx.font = font(800, L.px);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    words(ctx, spec.label, artX + L.artW + L.gap, midY + ph * 0.03, ink, s, ph * 0.08);
  }
  return width;
}

// A card surface filling the box (less its edge). Returns the card's own box.
function card(ctx: CanvasRenderingContext2D, color: string, s: Style, w: number, h: number, radius: number) {
  const unit = Math.min(w, h);
  const lipX = s.lip ? unit * 0.035 : 0;
  const lipY = s.lip ? unit * 0.055 : 0;
  const cw = w - lipX;
  const ch = h - lipY;
  surface(ctx, () => roundRect(ctx, 0, 0, cw, ch, radius * ch), color, s, lipX, lipY, Math.max(1.5, unit * 0.025));
  return { cw, ch };
}

const formatCount = (n: number): string => Math.round(n).toLocaleString("en-US");
const ease = (p: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3);
// How far `p` (0..1) has popped in - overshoots a little before settling.
const popIn = (p: number) => {
  const q = Math.max(0, Math.min(1, p));
  return q >= 1 ? 1 : 1 + 2.7 * Math.pow(q - 1, 3) + 1.7 * Math.pow(q - 1, 2);
};

// A five-point star centred on cx,cy.
function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.48;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

// A round avatar: the picture, or a person on the accent colour.
function avatar(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, cx: number, cy: number, d: number, accent: string): void {
  if (img) {
    picture(ctx, img, cx - d / 2, cy - d / 2, d, d, () => {
      ctx.beginPath();
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    });
    return;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  drawStickerIcon(ctx, "user", cx, cy, d * 0.56, inkOn(accent, STICKER_COLORS.navy));
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// "Mar 14", "14 March", "2026-03-14" -> ["MAR", "14"]; anything else shows as it was typed.
function dateParts(text: string): [string, string] {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (iso) return [MONTHS[Math.max(0, Math.min(11, Number(iso[2]) - 1))], String(Number(iso[3]))];
  const words = text.trim().split(/[\s,]+/).filter(Boolean);
  const day = words.find((w) => /^\d{1,2}(st|nd|rd|th)?$/i.test(w));
  const month = words.find((w) => /^[a-z]{3,}/i.test(w));
  if (day && month) return [month.slice(0, 3).toUpperCase(), day.replace(/\D/g, "")];
  return [words[0]?.toUpperCase() ?? "", words.slice(1).join(" ")];
}

// ---------- the stickers ----------

// Draws a sticker filling a w x h box whose top-left is at 0,0. `t` is seconds into its life;
// `enteredAt` when its entrance has finished (a stat starts counting then).
export function drawSticker(ctx: CanvasRenderingContext2D, asset: OverlayAsset, w: number, h: number, t: number, enteredAt: number): void {
  void ensureFonts();
  const kind = asset.kind as StickerKind;
  const s = styleOf(asset);
  const accent = asset.accent ?? STICKER_COLORS.blue;
  const img = pictureNow(asset.image);
  const icon = asset.icon ?? "none";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  switch (kind) {
    case "chip": {
      const ph = h / 1.1;
      chip(ctx, { label: asset.text ?? "", icon, img, color: asset.color }, s, 0, 0, ph, w - ph * 0.06);
      return;
    }

    case "name-tag": {
      // A card with the name, a chip with the title tucked under it, a tag on its corner.
      const tagRoom = h * 0.14;
      const cardH = h * 0.5;
      const pad = cardH * 0.36;
      const lipX = s.lip ? cardH * 0.05 : 0;
      const lipY = s.lip ? cardH * 0.09 : 0;
      const name = asset.text ?? "";
      const tag = asset.tag ?? "";
      ctx.font = font(800, cardH * 0.24);
      const tagW = tag ? ctx.measureText(tag).width + cardH * 0.36 : 0;
      const { px, width: nameW } = fitText(ctx, name, 800, cardH * 0.46, Math.max(1, w - lipX - pad * 2 - tagW * 0.35));
      const cw = Math.min(w - lipX - tagW * 0.35, nameW + pad * 2);
      surface(ctx, () => roundRect(ctx, 0, tagRoom, cw, cardH, cardH * 0.2), asset.color, s, lipX, lipY, Math.max(1.5, cardH * 0.04));
      ctx.font = font(800, px);
      words(ctx, name, pad, tagRoom + cardH / 2 + cardH * 0.03, inkFor(asset.color, s), s, cardH * 0.05);
      if (asset.subtext) {
        const ph = h * 0.27;
        chip(ctx, { label: asset.subtext, icon, img, color: accent }, solidLike(s), cardH * 0.14, tagRoom + cardH + h * 0.06, ph, w - cardH * 0.14 - ph * 0.06);
      }
      if (tag) {
        const th = cardH * 0.4;
        ctx.save();
        ctx.translate(cw - tagW * 0.62, tagRoom + th * 0.05);
        ctx.rotate((-7 * Math.PI) / 180);
        ctx.translate(0, -th / 2);
        chip(ctx, { label: tag, icon: "none", img: null, color: STICKER_COLORS.amber }, solidLike(s), 0, 0, th, tagW * 1.4);
        ctx.restore();
      }
      return;
    }

    case "stat": {
      // A number that counts up once it's in, a line under it.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.07);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.13;
      const from = asset.countFrom ?? 0;
      const to = asset.countTo ?? 0;
      const p = Math.max(0, Math.min(1, (t - enteredAt) / STAT_COUNT_SEC));
      const eased = 1 - Math.pow(1 - p, 3);
      const shown = formatCount(from + (to - from) * eased) + (p >= 1 ? asset.subtext ?? "" : "");
      // Sized for the final figure, so the number doesn't grow as it counts.
      const finalText = formatCount(to) + (asset.subtext ?? "");
      const hasLine = !!asset.text;
      const { px } = fitText(ctx, finalText, 800, ch * (hasLine ? 0.4 : 0.52), cw - pad * 2);
      ctx.font = font(800, px);
      const numberY = hasLine ? ch * 0.4 : ch * 0.5;
      words(ctx, shown, pad, numberY, ink, s, ch * 0.03);
      if (hasLine) {
        fitText(ctx, asset.text!, 600, ch * 0.13, cw - pad * 2);
        words(ctx, asset.text!, pad, ch * 0.76, ink, s, ch * 0.015);
      }
      return;
    }

    case "card": {
      // An icon (or picture) tile, a small kicker, the headline, a line under it.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.1);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.17;
      const hasArt = !!img || icon !== "none";
      const tile = hasArt ? ch * 0.56 : 0;
      const ty = (ch - tile) / 2;
      if (img) {
        picture(ctx, img, pad, ty, tile, tile, () => roundRect(ctx, pad, ty, tile, tile, tile * 0.22));
      } else if (hasArt) {
        // A white tile on a dark card, an edge-coloured disc on a light one.
        const dark = s.fill === "solid" && isDark(asset.color);
        ctx.beginPath();
        if (dark) roundRect(ctx, pad, ty, tile, tile, tile * 0.22);
        else ctx.arc(pad + tile / 2, ch / 2, tile / 2, 0, Math.PI * 2);
        ctx.fillStyle = dark ? "#ffffff" : s.edge;
        ctx.fill();
        drawStickerIcon(ctx, icon, pad + tile / 2, ch / 2, tile * 0.56, dark ? asset.color : "#ffffff");
      }
      const tx = pad + tile + (hasArt ? pad * 0.8 : 0);
      const maxW = Math.max(1, cw - tx - pad);
      const kicker = asset.tag ?? "";
      const head = asset.text ?? "";
      const body = asset.subtext ?? "";
      const kH = kicker ? ch * 0.17 : 0;
      const hH = head ? ch * 0.3 : 0;
      const bH = body ? ch * 0.15 : 0;
      const gap = ch * 0.03;
      let y = (ch - (kH + hH + bH + gap * ((kicker ? 1 : 0) + (body ? 1 : 0)))) / 2;
      if (kicker) {
        fitText(ctx, kicker, 600, ch * 0.15, maxW);
        words(ctx, kicker, tx, y + kH / 2, ink, s, ch * 0.015);
        y += kH + gap;
      }
      if (head) {
        fitText(ctx, head, 800, ch * 0.27, maxW);
        words(ctx, head, tx, y + hH / 2, ink, s, ch * 0.03);
        y += hH + gap;
      }
      if (body) {
        const { lines, px } = wrapText(ctx, body, 600, ch * 0.13, maxW, 2);
        ctx.font = font(600, px);
        lines.forEach((line, i) => words(ctx, line, tx, y + bH / 2 + i * px * 1.15, ink, s, ch * 0.015));
      }
      return;
    }

    case "place": {
      // A name over up to two lines, a location chip under it.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.09);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.15;
      const maxW = cw - pad * 2;
      const { lines, px } = wrapText(ctx, asset.text ?? "", 800, ch * 0.17, maxW, 2);
      ctx.font = font(800, px);
      const lineH = px * 1.22;
      const chipH = asset.subtext ? ch * 0.26 : 0;
      const block = lines.length * lineH + (chipH ? ch * 0.08 + chipH : 0);
      let y = (ch - block) / 2;
      lines.forEach((line) => {
        words(ctx, line, pad, y + lineH / 2, ink, s, ch * 0.02);
        y += lineH;
      });
      if (asset.subtext) {
        y += ch * 0.08;
        const chipIcon = icon === "none" ? "pin" : icon;
        chip(ctx, { label: asset.subtext, icon: chipIcon, img, color: accent }, { ...solidLike(s), lip: false }, pad, y, chipH, maxW);
      }
      return;
    }

    case "disc": {
      // A round badge with an icon or picture, an optional tag on its shoulder.
      const tag = asset.tag ?? "";
      const tagRoom = tag ? h * 0.12 : 0;
      const d = Math.min(w, h - tagRoom) / (s.lip ? 1.08 : 1);
      const r = d / 2;
      const cx = r;
      const cy = tagRoom + r;
      surface(ctx, () => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }, asset.color, s, d * 0.04, d * 0.07, Math.max(1.5, d * 0.05));
      if (img) {
        const inset = s.fill === "solid" ? d * 0.06 : 0;
        picture(ctx, img, cx - r + inset, cy - r + inset, d - inset * 2, d - inset * 2, () => {
          ctx.beginPath();
          ctx.arc(cx, cy, r - inset, 0, Math.PI * 2);
        });
      } else drawStickerIcon(ctx, icon, cx, cy, d * 0.52, inkFor(asset.color, s));
      if (tag) {
        const th = d * 0.3;
        ctx.save();
        ctx.translate(cx + r * 0.42, tagRoom + th * 0.1);
        ctx.rotate((-10 * Math.PI) / 180);
        ctx.translate(0, -th / 2);
        chip(ctx, { label: tag, icon: "none", img: null, color: accent }, { ...s, fill: "solid", border: false }, 0, 0, th, w);
        ctx.restore();
      }
      return;
    }

    case "title": {
      // A kicker chip, a big headline with a disc beside it, a byline.
      const kicker = asset.tag ?? "";
      const kh = kicker ? h * 0.15 : 0;
      const headPx = h * 0.42;
      const discD = (img || icon !== "none") ? h * 0.5 : 0;
      ctx.font = font(800, headPx);
      const { px, width: headW } = fitText(ctx, asset.text ?? "", 800, headPx, Math.max(1, w - (discD ? discD * 1.35 : 0)));
      const lineS: Style = { ...s, fill: "none" };
      if (kicker) chip(ctx, { label: kicker, icon: "none", img: null, color: STICKER_COLORS.amber }, { ...s, fill: "solid", border: false }, 0, 0, kh, w);
      const headY = kh + h * 0.08 + px * 0.55;
      ctx.font = font(800, px);
      words(ctx, asset.text ?? "", -px * 0.03, headY, asset.color, lineS, px * 0.06);
      if (asset.subtext) {
        fitText(ctx, asset.subtext, 600, h * 0.12, w);
        words(ctx, asset.subtext, 0, headY + px * 0.55 + h * 0.1, asset.color, lineS, h * 0.012);
      }
      if (discD) {
        const dx = headW + discD * 0.3;
        const dy = headY - discD / 2;
        ctx.save();
        ctx.translate(dx, dy);
        drawSticker(ctx, { ...asset, kind: "disc", color: accent, tag: undefined, fill: "solid", border: false }, discD * 1.08, discD * 1.08, t, enteredAt);
        ctx.restore();
      }
      return;
    }

    case "milestone": {
      // A big figure, a word beside it, a pill under the word.
      const big = asset.text ?? "";
      const { px: bigPx, width: bigW } = fitText(ctx, big, 800, h * 0.95, w * 0.55);
      const lineS: Style = { ...s, fill: "none" };
      ctx.font = font(800, bigPx);
      words(ctx, big, 0, h * 0.52, accent, lineS, bigPx * 0.05);
      const x = bigW + h * 0.12;
      const restW = Math.max(1, w - x);
      if (asset.subtext) {
        const { px } = fitText(ctx, asset.subtext, 800, h * 0.32, restW);
        ctx.font = font(800, px);
        words(ctx, asset.subtext, x, h * 0.3, asset.color, lineS, px * 0.05);
      }
      if (asset.tag) chip(ctx, { label: asset.tag, icon: "none", img: null, color: asset.color }, { ...s, fill: "solid", border: false }, x, h * 0.52, h * 0.2, restW);
      return;
    }
    case "icon": {
      // One icon - bare, on a tile, or in a ring.
      const d = Math.min(w, h) / (s.lip ? 1.06 : 1);
      const lineW = Math.max(1.5, d * 0.05);
      surface(ctx, () => roundRect(ctx, 0, 0, d, d, d * 0.28), asset.color, s, d * 0.04, d * 0.06, lineW);
      const glyph = s.fill === "none" ? d * 0.94 : d * 0.58;
      const ink = inkFor(asset.color, s);
      if (s.fill === "none" && s.lip) drawStickerIcon(ctx, icon === "none" ? "star" : icon, d / 2 + d * 0.035, d / 2 + d * 0.055, glyph, s.edge);
      drawStickerIcon(ctx, icon === "none" ? "star" : icon, d / 2, d / 2, glyph, s.fill === "none" ? asset.color : ink);
      return;
    }

    case "emoji": {
      // An emoji, alone or on a bubble.
      const d = Math.min(w, h) / (s.lip && s.fill !== "none" ? 1.06 : 1);
      surface(ctx, () => {
        ctx.beginPath();
        ctx.arc(d / 2, d / 2, d / 2, 0, Math.PI * 2);
      }, asset.color, s, d * 0.04, d * 0.06, Math.max(1.5, d * 0.05));
      const px = s.fill === "none" ? d * 0.86 : d * 0.56;
      ctx.font = `${px}px ${EMOJI_FACE}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000000";
      // Emoji faces sit a touch high on the middle baseline.
      ctx.fillText(asset.text || "\u2728", d / 2, d / 2 + px * 0.06);
      ctx.textAlign = "left";
      return;
    }

    case "quote": {
      // Quote marks, the words, and who said them (with their photo).
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.09);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.13;
      drawStickerIcon(ctx, "quote", pad + ch * 0.1, pad + ch * 0.09, ch * 0.2, accent);
      const hasBy = !!(asset.subtext || asset.tag);
      const byH = hasBy ? ch * 0.2 : 0;
      const gap = hasBy ? ch * 0.08 : 0;
      const textTop = pad + ch * 0.22;
      const room = ch - textTop - pad - byH - gap;
      const { lines, px } = wrapText(ctx, asset.text ?? "", 800, ch * 0.11, cw - pad * 2, 3);
      const size = Math.min(px, room / Math.max(1, lines.length) / 1.25);
      ctx.font = font(800, size);
      const lineH = size * 1.25;
      lines.forEach((line, i) => words(ctx, line, pad, textTop + lineH * (i + 0.5), ink, s, ch * 0.012));
      if (hasBy) {
        const cy = ch - pad - byH / 2;
        let x = pad;
        if (img) {
          avatar(ctx, img, x + byH * 0.45, cy, byH * 0.9, accent);
          x += byH * 1.05;
        }
        if (asset.subtext) {
          fitText(ctx, asset.subtext, 800, ch * 0.085, cw - x - pad);
          words(ctx, asset.subtext, x, asset.tag ? cy - ch * 0.045 : cy, ink, s, ch * 0.01);
        }
        if (asset.tag) {
          fitText(ctx, asset.tag, 600, ch * 0.07, cw - x - pad);
          ctx.globalAlpha *= 0.75;
          words(ctx, asset.tag, x, asset.subtext ? cy + ch * 0.05 : cy, ink, s, 0);
          ctx.globalAlpha /= 0.75;
        }
      }
      return;
    }

    case "profile": {
      // Avatar, name with its badge, handle, and a follow button.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.3);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.17;
      const d = ch - pad * 2;
      avatar(ctx, img, pad + d / 2, ch / 2, d, accent);
      const tx = pad + d + pad * 0.8;
      let right = cw - pad;
      if (asset.tag) {
        const bh = ch * 0.42;
        const L = chipLayout(ctx, { label: asset.tag, icon: "none", img: null, color: accent }, bh, cw * 0.35);
        right -= L.width;
        chip(ctx, { label: asset.tag, icon: "none", img: null, color: accent }, { ...solidLike(s), lip: false }, right, (ch - bh) / 2, bh, L.width);
        right -= pad * 0.6;
      }
      const maxW = Math.max(1, right - tx);
      const name = asset.text ?? "";
      const badge = icon === "none" ? 0 : ch * 0.2;
      const { width: nameW } = fitText(ctx, name, 800, ch * 0.22, maxW - (badge ? badge * 1.4 : 0));
      const nameY = asset.subtext ? ch * 0.37 : ch / 2;
      words(ctx, name, tx, nameY, ink, s, ch * 0.02);
      if (badge) {
        const bx = tx + nameW + badge * 0.75;
        ctx.beginPath();
        ctx.arc(bx, nameY, badge / 2, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        drawStickerIcon(ctx, icon, bx, nameY, badge * 0.66, inkOn(accent, s.edge));
      }
      if (asset.subtext) {
        fitText(ctx, asset.subtext, 600, ch * 0.16, maxW);
        ctx.globalAlpha *= 0.72;
        words(ctx, asset.subtext, tx, ch * 0.66, ink, s, 0);
        ctx.globalAlpha /= 0.72;
      }
      return;
    }

    case "rating": {
      // A score, five stars filling up to it, a line under them.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.1);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.15;
      const value = Math.max(0, Math.min(5, asset.countTo ?? 5));
      const shown = value * ease((t - enteredAt) / 1.2);
      const { width: scoreW } = fitText(ctx, value.toFixed(1), 800, ch * 0.46, cw * 0.4);
      words(ctx, shown.toFixed(1), pad, ch / 2, ink, s, ch * 0.03);
      const sx = pad + scoreW + pad * 0.9;
      const starsW = cw - sx - pad;
      const r = Math.min(ch * 0.13, starsW / 10.6);
      const rowY = asset.text ? ch * 0.38 : ch / 2;
      for (let i = 0; i < 5; i++) {
        const cx = sx + r + i * r * 2.15;
        starPath(ctx, cx, rowY, r);
        ctx.fillStyle = s.fill === "solid" && !isDark(asset.color) ? "rgba(15,23,42,0.14)" : "rgba(255,255,255,0.28)";
        ctx.fill();
        const part = Math.max(0, Math.min(1, shown - i));
        if (part > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - r, rowY - r, r * 2 * part, r * 2);
          ctx.clip();
          starPath(ctx, cx, rowY, r * popIn(Math.min(1, (shown - i) * 2)));
          ctx.fillStyle = accent;
          ctx.fill();
          ctx.restore();
        }
      }
      if (asset.text) {
        fitText(ctx, asset.text, 600, ch * 0.14, starsW);
        words(ctx, asset.text, sx, ch * 0.7, ink, s, 0);
      }
      return;
    }

    case "meter": {
      // A label and its percentage, a bar filling to it.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.18);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.17;
      const value = Math.max(0, Math.min(100, asset.countTo ?? 0));
      const shown = value * ease((t - enteredAt) / 1.4);
      const pct = `${Math.round(shown)}%`;
      ctx.font = font(800, ch * 0.22);
      const pctW = ctx.measureText(`${Math.round(value)}%`).width;
      if (asset.text) {
        fitText(ctx, asset.text, 800, ch * 0.22, cw - pad * 3 - pctW);
        words(ctx, asset.text, pad, ch * 0.32, ink, s, ch * 0.02);
      }
      ctx.font = font(800, ch * 0.22);
      ctx.textAlign = "right";
      words(ctx, pct, cw - pad, ch * 0.32, ink, s, ch * 0.02);
      ctx.textAlign = "left";
      const by = ch * 0.56;
      const bh = ch * 0.2;
      const bw = cw - pad * 2;
      roundRect(ctx, pad, by, bw, bh, bh / 2);
      ctx.fillStyle = s.fill === "solid" && !isDark(asset.color) ? "rgba(15,23,42,0.12)" : "rgba(255,255,255,0.25)";
      ctx.fill();
      if (shown > 0) {
        roundRect(ctx, pad, by, Math.max(bh, (bw * shown) / 100), bh, bh / 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }
      return;
    }

    case "checklist": {
      // A kicker, then items ticking in one after another.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.08);
      const ink = inkFor(asset.color, s);
      const items = checklistItems(asset.text);
      const pad = Math.min(cw, ch) * 0.1;
      let y = pad;
      if (asset.tag) {
        const kh = ch * 0.13;
        chip(ctx, { label: asset.tag, icon: "none", img: null, color: accent }, { ...solidLike(s), lip: false }, pad, y, kh, cw - pad * 2);
        y += kh + pad * 0.7;
      }
      const rowH = Math.min(ch * 0.22, (ch - y - pad) / Math.max(1, items.length));
      items.forEach((item, i) => {
        const cy = y + rowH * (i + 0.5);
        const d = rowH * 0.62;
        const p = popIn((t - enteredAt - i * TICK_STEP_SEC) / 0.35);
        ctx.beginPath();
        ctx.arc(pad + d / 2, cy, d / 2, 0, Math.PI * 2);
        ctx.strokeStyle = s.fill === "solid" && !isDark(asset.color) ? "rgba(15,23,42,0.18)" : "rgba(255,255,255,0.35)";
        ctx.lineWidth = Math.max(1, d * 0.08);
        ctx.stroke();
        if (p > 0) {
          ctx.beginPath();
          ctx.arc(pad + d / 2, cy, (d / 2) * p, 0, Math.PI * 2);
          ctx.fillStyle = accent;
          ctx.fill();
          drawStickerIcon(ctx, "check", pad + d / 2, cy, d * 0.62 * Math.min(1, p), inkOn(accent, s.edge));
        }
        fitText(ctx, item, 800, rowH * 0.42, cw - pad * 2.6 - d);
        words(ctx, item, pad + d + pad * 0.6, cy + rowH * 0.02, ink, s, rowH * 0.03);
      });
      return;
    }

    case "price": {
      // The old price struck through, the new one big, what it's per.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.12);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.15;
      let y = pad;
      if (asset.tag) {
        const { width } = fitText(ctx, asset.tag, 600, ch * 0.15, cw - pad * 2);
        const oy = y + ch * 0.08;
        ctx.globalAlpha *= 0.7;
        words(ctx, asset.tag, pad, oy, ink, s, 0);
        ctx.globalAlpha /= 0.7;
        ctx.strokeStyle = accent;
        ctx.lineWidth = Math.max(1.5, ch * 0.025);
        ctx.beginPath();
        ctx.moveTo(pad - ch * 0.02, oy + ch * 0.02);
        ctx.lineTo(pad + width + ch * 0.02, oy - ch * 0.03);
        ctx.stroke();
        y += ch * 0.2;
      }
      const big = asset.text ?? "";
      const per = asset.subtext ?? "";
      ctx.font = font(600, ch * 0.15);
      const perW = per ? ctx.measureText(per).width + ch * 0.04 : 0;
      const { px, width: bigW } = fitText(ctx, big, 800, ch * 0.44, cw - pad * 2 - perW);
      const baseY = (y + ch - pad) / 2 + px * 0.05;
      words(ctx, big, pad, baseY, ink, s, ch * 0.03);
      if (per) {
        ctx.font = font(600, ch * 0.15);
        ctx.globalAlpha *= 0.75;
        words(ctx, per, pad + bigW + ch * 0.04, baseY + px * 0.18, ink, s, 0);
        ctx.globalAlpha /= 0.75;
      }
      return;
    }

    case "message": {
      // A chat bubble with its sender's photo - typing dots first, then the words.
      // The other person's bubbles sit on the left, yours on the right - avatar and tail follow.
      const right = asset.side === "right";
      const d = img ? h * 0.36 : 0;
      const lipX = s.lip ? h * 0.035 : 0;
      const lipY = s.lip ? h * 0.055 : 0;
      const bw = w - (d ? d + h * 0.08 : 0) - lipX;
      const bx = right ? 0 : d ? d + h * 0.08 : 0;
      const fullH = h - lipY;
      // The bubble, and its tail curling out of the bottom corner below it.
      const bh = fullH * 0.9;
      const r = Math.min(bh * 0.3, bw / 2);
      const tail = () => {
        roundRect(ctx, bx, 0, bw, bh, r);
        // Mirrored for a right-hand bubble: x measured in from the tail's side.
        const X = (dx: number) => (right ? bx + bw - dx : bx + dx);
        // Traced the same way round as the bubble on either side - traced the other way, the
        // overlap cancels out under the default fill rule and leaves a hole.
        if (right) {
          ctx.moveTo(X(r * 0.15), bh - r * 0.8);
          ctx.quadraticCurveTo(X(r * 0.2), fullH * 0.97, X(-fullH * 0.05), fullH);
          ctx.quadraticCurveTo(X(r * 0.75), fullH * 0.99, X(r * 1.3), bh - 0.5);
          ctx.lineTo(X(r * 1.3), bh - r * 0.8);
        } else {
          ctx.moveTo(X(r * 1.3), bh - r * 0.8);
          ctx.lineTo(X(r * 1.3), bh - 0.5);
          ctx.quadraticCurveTo(X(r * 0.75), fullH * 0.99, X(-fullH * 0.05), fullH);
          ctx.quadraticCurveTo(X(r * 0.2), fullH * 0.97, X(r * 0.15), bh - r * 0.8);
        }
        ctx.closePath();
      };
      surface(ctx, tail, asset.color, s, lipX, lipY, Math.max(1.5, bh * 0.03));
      if (d) avatar(ctx, img, right ? bx + bw + h * 0.08 + lipX + d / 2 : d / 2, h - d / 2 - lipY * 0.3, d, accent);
      const ink = inkFor(asset.color, s);
      const pad = bh * 0.16;
      const since = t - enteredAt;
      if (since < TYPING_SEC) {
        for (let i = 0; i < 3; i++) {
          const bounce = Math.sin((since * 9 - i * 0.9) * 1) * 0.5 + 0.5;
          ctx.beginPath();
          ctx.arc(bx + pad + bh * 0.08 + i * bh * 0.16, bh / 2 - bounce * bh * 0.06, bh * 0.055, 0, Math.PI * 2);
          ctx.fillStyle = ink;
          ctx.globalAlpha *= 0.45 + 0.5 * bounce;
          ctx.fill();
          ctx.globalAlpha /= 0.45 + 0.5 * bounce;
        }
        return;
      }
      ctx.globalAlpha *= Math.min(1, (since - TYPING_SEC) / 0.2);
      let y = pad;
      if (asset.tag) {
        fitText(ctx, asset.tag, 800, bh * 0.13, bw - pad * 2);
        words(ctx, asset.tag, bx + pad, y + bh * 0.07, accent === asset.color ? ink : accent, { ...s, fill: "solid" }, 0);
        y += bh * 0.19;
      }
      const room = bh - y - pad;
      const { lines, px } = wrapText(ctx, asset.text ?? "", 600, bh * 0.16, bw - pad * 2, 3);
      const size = Math.min(px, room / Math.max(1, lines.length) / 1.22);
      ctx.font = font(600, size);
      const top = y + (room - lines.length * size * 1.22) / 2;
      lines.forEach((line, i) => words(ctx, line, bx + pad, top + size * 1.22 * (i + 0.5), ink, s, 0));
      return;
    }

    case "versus": {
      // Two chips with a VS disc between them.
      const ph = h * 0.62;
      const d = h * 0.94;
      const y = (h - ph) / 2 - h * 0.02;
      const left = { label: asset.text ?? "", icon: "none" as const, img: null, color: asset.color };
      const right = { label: asset.subtext ?? "", icon: "none" as const, img: null, color: accent };
      const lw = chipLayout(ctx, left, ph).width;
      const rw = chipLayout(ctx, right, ph).width;
      const total = lw + rw + d * 0.7;
      const k = total > w ? w / total : 1;
      chip(ctx, left, solidLike(s), 0, y, ph * k, lw * k);
      chip(ctx, right, solidLike(s), lw * k + d * 0.7 * k, y, ph * k, rw * k);
      const cx = lw * k + d * 0.35 * k;
      const cy = h / 2 - h * 0.03;
      surface(ctx, () => {
        ctx.beginPath();
        ctx.arc(cx, cy, (d * k) / 2.2, 0, Math.PI * 2);
      }, s.edge, { ...s, fill: "solid", border: false, edge: "#000000" }, 0, 0, 1);
      fitText(ctx, "VS", 800, d * k * 0.3, d * k * 0.6);
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("VS", cx, cy + d * k * 0.02);
      ctx.textAlign = "left";
      return;
    }

    case "date": {
      // A calendar leaf with the month and day, the event beside it.
      const { cw, ch } = card(ctx, asset.color, s, w, h, 0.12);
      const ink = inkFor(asset.color, s);
      const pad = ch * 0.14;
      const lw = ch * 0.64;
      const lh = ch - pad * 2;
      const [month, day] = dateParts(asset.tag ?? "");
      ctx.save();
      roundRect(ctx, pad, pad, lw, lh, lw * 0.16);
      ctx.clip();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(pad, pad, lw, lh);
      ctx.fillStyle = accent;
      ctx.fillRect(pad, pad, lw, lh * 0.32);
      ctx.restore();
      if (s.fill !== "solid" || !isDark(asset.color)) {
        roundRect(ctx, pad, pad, lw, lh, lw * 0.16);
        ctx.strokeStyle = "rgba(15,23,42,0.15)";
        ctx.lineWidth = Math.max(1, ch * 0.012);
        ctx.stroke();
      }
      ctx.textAlign = "center";
      fitText(ctx, month, 800, lh * 0.2, lw * 0.85);
      ctx.fillStyle = inkOn(accent, s.edge);
      ctx.fillText(month, pad + lw / 2, pad + lh * 0.17);
      fitText(ctx, day, 800, lh * 0.46, lw * 0.85);
      ctx.fillStyle = STICKER_COLORS.ink;
      ctx.fillText(day, pad + lw / 2, pad + lh * 0.67);
      ctx.textAlign = "left";
      const tx = pad + lw + pad;
      const maxW = cw - tx - pad;
      if (asset.text) {
        const { lines, px } = wrapText(ctx, asset.text, 800, ch * 0.2, maxW, 2);
        ctx.font = font(800, px);
        const top = asset.subtext ? ch * 0.42 - (lines.length - 1) * px * 0.6 : ch / 2 - (lines.length - 1) * px * 0.6;
        lines.forEach((line, i) => words(ctx, line, tx, top + i * px * 1.2, ink, s, ch * 0.02));
      }
      if (asset.subtext) {
        fitText(ctx, asset.subtext, 600, ch * 0.13, maxW);
        ctx.globalAlpha *= 0.8;
        words(ctx, asset.subtext, tx, ch * 0.72, ink, s, 0);
        ctx.globalAlpha /= 0.8;
      }
      return;
    }
  }
}

// Width over height a hugging sticker wants for its words at the moment (the box it's added with,
// and refitted to when its text changes).
export function stickerAspect(asset: OverlayAsset): number | null {
  if (!stickerHugs(asset.kind) || typeof document === "undefined") return null;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const s = styleOf(asset);
  const icon = asset.icon ?? "none";
  const img = asset.image ? ({} as HTMLImageElement) : null;
  const H = 100;
  switch (asset.kind as StickerKind) {
    case "chip": {
      const ph = H / 1.1;
      return (chipLayout(ctx, { label: asset.text ?? "", icon, img, color: asset.color }, ph).width + ph * 0.06) / H;
    }
    case "name-tag": {
      const cardH = H * 0.5;
      ctx.font = font(800, cardH * 0.24);
      const tagW = asset.tag ? ctx.measureText(asset.tag).width + cardH * 0.36 : 0;
      ctx.font = font(800, cardH * 0.46);
      const nameW = ctx.measureText(asset.text ?? "").width + cardH * 0.72;
      const ph = H * 0.27;
      const sub = asset.subtext ? cardH * 0.14 + chipLayout(ctx, { label: asset.subtext, icon, img, color: "" }, ph).width + ph * 0.06 : 0;
      return (Math.max(nameW + tagW * 0.35 + (s.lip ? cardH * 0.05 : 0), sub) + H * 0.02) / H;
    }
    case "disc":
      return asset.tag ? 1.05 : 1;
    case "icon":
    case "emoji":
      return 1;
    case "versus": {
      const ph = H * 0.62;
      const lw = chipLayout(ctx, { label: asset.text ?? "", icon: "none", img: null, color: "" }, ph).width;
      const rw = chipLayout(ctx, { label: asset.subtext ?? "", icon: "none", img: null, color: "" }, ph).width;
      return (lw + rw + H * 0.94 * 0.7 + H * 0.04) / H;
    }
    case "title": {
      ctx.font = font(800, H * 0.42);
      const headW = ctx.measureText(asset.text ?? "").width;
      ctx.font = font(600, H * 0.12);
      const subW = asset.subtext ? ctx.measureText(asset.subtext).width : 0;
      const discD = img || icon !== "none" ? H * 0.5 : 0;
      return (Math.max(headW + (discD ? discD * 1.4 : 0), subW) + H * 0.04) / H;
    }
    case "milestone": {
      ctx.font = font(800, H * 0.95);
      const bigW = ctx.measureText(asset.text ?? "").width;
      ctx.font = font(800, H * 0.32);
      const word = asset.subtext ? ctx.measureText(asset.subtext).width : 0;
      const pill = asset.tag ? chipLayout(ctx, { label: asset.tag, icon: "none", img: null, color: "" }, H * 0.2).width : 0;
      return (bigW + H * 0.12 + Math.max(word, pill) + H * 0.06) / H;
    }
    default:
      return null;
  }
}
