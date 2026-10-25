// utils/keystrokes.ts
//
// Keyboard shortcuts pressed while recording (input_tracker.rs records them - modifier combos and
// keys like Enter/Esc only, never typing) shown as keycap chips over the video: "Ctrl + Shift + P".
//
// Each press is anchored to its recording's SOURCE time and mapped through the timeline's clips,
// like captions, so chips stay on their moment through cuts, reorders and speed changes. The chip
// painter (drawKeyChip) is the one both renderers use - KeystrokeLayer.tsx paints it live, and
// the export paints every distinct chip frame once and shows them as a sprite track (spriteTrack.ts).
import type { Clip } from "./videoEditTypes";
import type { KeyPress, PointerRecording } from "./pointerTrack";
import { clipOutputDuration, sourceToOutputOffset } from "./clipTiming";
import type { SpriteTrackSpec } from "./spriteTrack";
import { encodeSprite, runsFromCells } from "./spriteTrack";

export interface KeystrokeStyle {
  show: boolean;
  position: "bottom" | "top";
  // Multiple of the default chip size.
  size: number;
}

export const DEFAULT_KEYSTROKE_STYLE: KeystrokeStyle = { show: true, position: "bottom", size: 1 };
export const keystrokeStyleOf = (s: Partial<KeystrokeStyle> | undefined): KeystrokeStyle => ({ ...DEFAULT_KEYSTROKE_STYLE, ...(s ?? {}) });

export interface KeyChip {
  // Output seconds.
  start: number;
  end: number;
  keys: string[];
  // How many times in a row it was pressed ("Ctrl + Z  ×3").
  count: number;
  // Whether it fades out at `end` (false: the next chip replaces it there).
  fadesOut: boolean;
}

// How long a chip stays after its last press, and how close repeats must be to count as one.
const HOLD = 1.5;
const REPEAT_WINDOW = 1.0;
export const CHIP_APPEAR = 0.14;
export const CHIP_DISAPPEAR = 0.22;

// What a key is called on its cap.
const KEY_NAMES: Record<string, string> = {
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Delete: "Del",
  Insert: "Ins",
  Escape: "Esc",
  Plus: "+",
};
export const keyCapLabel = (key: string): string => KEY_NAMES[key] ?? key;

// The presses on the output timeline, as chips. `recordings` maps each clip's source file to its
// recording (only recordings with shortcuts contribute).
export function buildKeyChips(clips: Clip[], recordings: Map<string, PointerRecording | null>): KeyChip[] {
  const presses: { at: number; keys: string[] }[] = [];
  let clipStart = 0;
  for (const clip of clips) {
    const keys: KeyPress[] = recordings.get(clip.sourcePath)?.keys ?? [];
    for (const k of keys) {
      if (k.t >= clip.start && k.t < clip.end) presses.push({ at: clipStart + sourceToOutputOffset(clip, k.t), keys: k.keys });
    }
    clipStart += clipOutputDuration(clip);
  }
  presses.sort((a, b) => a.at - b.at);
  const chips: (KeyChip & { lastPress: number })[] = [];
  for (const p of presses) {
    const prev = chips[chips.length - 1];
    if (prev && prev.keys.join("+") === p.keys.join("+") && p.at - prev.lastPress <= REPEAT_WINDOW) {
      prev.count += 1;
      prev.lastPress = p.at;
      prev.end = p.at + HOLD;
      continue;
    }
    chips.push({ start: p.at, end: p.at + HOLD, keys: p.keys, count: 1, fadesOut: true, lastPress: p.at });
  }
  // The next chip takes over the moment it's pressed.
  for (let i = 0; i + 1 < chips.length; i++) {
    if (chips[i + 1].start < chips[i].end) {
      chips[i].end = chips[i + 1].start;
      chips[i].fadesOut = false;
    }
  }
  return chips.map(({ lastPress: _, ...chip }) => chip);
}

// The chip showing at output time `t`, and how far into its appearing / disappearing it is.
export function chipAt(chips: KeyChip[], t: number): { chip: KeyChip; alpha: number; scale: number } | null {
  // Few chips (shortcuts, not typing) - a scan is plenty.
  const chip = chips.find((c) => t >= c.start && t < c.end);
  if (!chip) return null;
  const inP = Math.min(1, (t - chip.start) / CHIP_APPEAR);
  const outP = chip.fadesOut ? Math.max(0, 1 - (chip.end - t) / CHIP_DISAPPEAR) : 0;
  const ease = 1 - (1 - inP) ** 3;
  return { chip, alpha: ease * (1 - outP), scale: (0.9 + 0.1 * ease) * (1 - 0.04 * outP) };
}

// ---- Painting ------------------------------------------------------------------------------------

interface ChipMetrics {
  capH: number;
  font: string;
  pad: number;
  gap: number;
  caps: { label: string; w: number }[];
  countLabel: string | null;
  countW: number;
  width: number;
  height: number;
}

// Sizes are fractions of the frame's height, so a chip looks the same on any export size.
function chipMetrics(ctx: CanvasRenderingContext2D, chip: KeyChip, frameH: number, style: KeystrokeStyle): ChipMetrics {
  const capH = 0.046 * frameH * Math.max(0.5, Math.min(2.5, style.size));
  const font = `600 ${(capH * 0.46).toFixed(2)}px "Segoe UI", system-ui, sans-serif`;
  ctx.font = font;
  const capPad = capH * 0.3;
  const caps = chip.keys.map((k) => {
    const label = keyCapLabel(k);
    return { label, w: Math.max(capH, ctx.measureText(label).width + 2 * capPad) };
  });
  const countLabel = chip.count > 1 ? `×${chip.count}` : null;
  const countW = countLabel ? ctx.measureText(countLabel).width + capH * 0.2 : 0;
  const pad = capH * 0.22;
  const gap = capH * 0.38;
  const width = 2 * pad + caps.reduce((s, c) => s + c.w, 0) + gap * (caps.length - 1) + countW;
  return { capH, font, pad, gap, caps, countLabel, countW, width, height: capH + 2 * pad };
}

// The chip's size in pixels of a frame `frameH` tall.
export function keyChipSize(chip: KeyChip, frameH: number, style: KeystrokeStyle): { width: number; height: number } {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { width: 0, height: 0 };
  const m = chipMetrics(ctx, chip, frameH, style);
  return { width: m.width, height: m.height };
}

// Where the chip's centre sits in a frameW x frameH frame.
export function keyChipCentre(frameW: number, frameH: number, chipH: number, style: KeystrokeStyle): { x: number; y: number } {
  const margin = 0.065 * frameH;
  return { x: frameW / 2, y: style.position === "top" ? margin + chipH / 2 : frameH - margin - chipH / 2 };
}

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
};

// Paints the chip centred on (cx, cy), in pixels of a frame `frameH` tall.
export function drawKeyChip(ctx: CanvasRenderingContext2D, chip: KeyChip, cx: number, cy: number, frameH: number, style: KeystrokeStyle, alpha: number, scale: number): void {
  if (alpha <= 0) return;
  const m = chipMetrics(ctx, chip, frameH, style);
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const x0 = -m.width / 2;
  const y0 = -m.height / 2;
  // The pill.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = m.capH * 0.35 * scale;
  ctx.shadowOffsetY = m.capH * 0.08 * scale;
  roundRect(ctx, x0, y0, m.width, m.height, m.capH * 0.28 + m.pad);
  ctx.fillStyle = "rgba(17,18,22,0.86)";
  ctx.fill();
  ctx.restore();
  // The keycaps, with a "+" between them.
  ctx.font = m.font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  let x = x0 + m.pad;
  const capY = y0 + m.pad;
  m.caps.forEach((cap, i) => {
    roundRect(ctx, x, capY, cap.w, m.capH, m.capH * 0.24);
    ctx.fillStyle = "rgba(255,255,255,0.13)";
    ctx.fill();
    // The cap's lower lip.
    roundRect(ctx, x, capY + m.capH * 0.9, cap.w, m.capH * 0.1, m.capH * 0.05);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(cap.label, x + cap.w / 2, capY + m.capH * 0.47);
    x += cap.w;
    if (i < m.caps.length - 1) {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillText("+", x + m.gap / 2, capY + m.capH * 0.47);
      x += m.gap;
    }
  });
  if (m.countLabel) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.textAlign = "left";
    ctx.fillText(m.countLabel, x + m.capH * 0.2, capY + m.capH * 0.47);
  }
  ctx.restore();
}

// ---- Export ---------------------------------------------------------------------------------------

// Chips are sampled on this output grid (cells centred on k/30 - a 30 or 60 fps export's frames).
const KEY_GRID = 30;
// Sampled steps of the appearing / disappearing animation.
const APPEAR_STEPS = 5;
const DISAPPEAR_STEPS = 7;

// The chips as one sprite track on the output timeline (export_trimmed_video's `keystrokes`).
export function keystrokeExportLayer(chips: KeyChip[], frameW: number, frameH: number, style: KeystrokeStyle, totalDuration: number): SpriteTrackSpec | null {
  if (!style.show || chips.length === 0) return null;
  let boxW = 0;
  let boxH = 0;
  for (const c of chips) {
    const s = keyChipSize(c, frameH, style);
    boxW = Math.max(boxW, s.width);
    boxH = Math.max(boxH, s.height);
  }
  // Room for the shadow, kept even.
  const margin = 2 * Math.ceil((0.046 * frameH * style.size * 0.6 + 2) / 2);
  const w = 2 * Math.ceil((boxW + 2 * margin) / 2);
  const h = 2 * Math.ceil((boxH + 2 * margin) / 2);
  const centre = keyChipCentre(frameW, frameH, boxH, style);
  const x = 2 * Math.round((centre.x - w / 2) / 2);
  const y = 2 * Math.round((centre.y - h / 2) / 2);
  const sprites: string[] = [];
  const index = new Map<string, number>();
  const cells: ({ sprite: number; x: number; y: number } | null)[] = [];
  const count = Math.ceil(totalDuration * KEY_GRID) + 1;
  for (let k = 0; k <= count; k++) {
    const t = k / KEY_GRID;
    const on = chipAt(chips, t);
    if (!on) {
      cells.push(null);
      continue;
    }
    // Quantised animation step: appearing, steady, or disappearing.
    const ci = chips.indexOf(on.chip);
    const inStep = Math.min(APPEAR_STEPS, Math.round(((t - on.chip.start) / CHIP_APPEAR) * APPEAR_STEPS));
    const outStep = on.chip.fadesOut ? Math.max(0, Math.round((1 - (on.chip.end - t) / CHIP_DISAPPEAR) * DISAPPEAR_STEPS)) : 0;
    const key = `${ci}|${inStep}|${outStep}`;
    let sprite = index.get(key);
    if (sprite === undefined) {
      sprite = sprites.length;
      index.set(key, sprite);
      const inP = inStep / APPEAR_STEPS;
      const outP = Math.min(1, outStep / DISAPPEAR_STEPS);
      const ease = 1 - (1 - inP) ** 3;
      sprites.push(encodeSprite(w, h, (ctx) => drawKeyChip(ctx, on.chip, w / 2, h / 2, frameH, style, ease * (1 - outP), (0.9 + 0.1 * ease) * (1 - 0.04 * outP))));
    }
    cells.push({ sprite, x, y });
  }
  const cellStart = (i: number) => Math.max(0, (i - 0.5) / KEY_GRID);
  return { sprites, width: w, height: h, runs: runsFromCells(cells, cellStart), end: cellStart(cells.length) };
}
