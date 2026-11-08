// utils/pointerTrack.ts
//
// The pointer of a screen recording made with "Editable pointer" on (services/input_tracker.rs):
// the screen was captured WITHOUT the mouse pointer, and its path, clicks and shapes (the real
// cursor bitmaps - arrow, hand, I-beam...) were written to "<name>.pointer.json" beside it. The
// editor draws the pointer back over the picture - smoothed, enlarged, with click ripples, hidden
// while idle - the Screen Studio look.
//
// One model drives both renderers: pointerStateAt says where the pointer is, what it looks like and
// which ripple is playing at any SOURCE moment, and drawCursor/drawRipple paint it. The preview
// (PointerLayer.tsx) paints that state every frame; the export samples the same state on a 60 Hz
// grid of the clip's source time and hands Rust the painted sprites (pointerExportLayers) - so both
// show the same pointer, frame for frame.
//
// Coordinates here are the recording's CAPTURE pixels (the screen area as it was on the monitor);
// the video may be smaller (a 4K screen recorded at 1920 wide) - callers scale by videoW / width.
import { invoke } from "@tauri-apps/api/core";
import type { SpriteTrackSpec } from "./spriteTrack";
import { encodeSprite, runsFromCells } from "./spriteTrack";

// What "<name>.pointer.json" holds (input_tracker.rs writes it). Times are seconds of the final
// file; positions are capture pixels of the recorded area at the moment the recording started.
interface PointerSidecar {
  version: number;
  width: number;
  height: number;
  // Flat [t, x, y, t, x, y, ...] - every movement, at most 240 a second.
  moves?: number[];
  // [t, x, y, button] - button 0 left, 1 right, 2 middle; presses only.
  clicks?: [number, number, number, number][];
  cursors?: { id: number; hotX: number; hotY: number; png: string }[];
  // [t, cursor id] - the pointer's look from t on; -1 while the system hides it (typing in some apps).
  shapes?: [number, number][];
  // [t, keys] - keyboard shortcuts, e.g. ["Ctrl", "Shift", "P"]. Never plain typing.
  keys?: [number, string[]][];
}

export interface CursorImage {
  id: number;
  hotX: number;
  hotY: number;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export interface PointerClick {
  t: number;
  x: number;
  y: number;
  button: number;
}

export interface KeyPress {
  t: number;
  keys: string[];
}

export interface PointerRecording {
  width: number;
  height: number;
  // Raw movements, sorted by time.
  t: Float64Array;
  x: Float32Array;
  y: Float32Array;
  clicks: PointerClick[];
  cursors: Map<number, CursorImage>;
  shapes: { t: number; id: number }[];
  // clicks' and shapes' times, for binary search.
  clickT: Float64Array;
  shapeT: Float64Array;
  keys: KeyPress[];
  // The size the pointer is drawn at when the recording has no cursor bitmaps of its own.
  nominalCursorHeight: number;
}

// How the editor draws the pointer (VideoEditState.pointerStyle). Undefined fields take the
// defaults below.
export interface PointerStyle {
  // Off: no pointer at all in the video (it was never in the picture).
  show: boolean;
  // Multiple of the pointer's size on screen while recording.
  size: number;
  // 0 = exactly as moved; 1 = the smoothest glide (a ~100 ms Gaussian over the path).
  smoothing: number;
  // Fades the pointer out after it rests for IDLE_DELAY seconds, back in when it moves.
  hideIdle: boolean;
  // A ring that expands from every click.
  ripples: boolean;
  rippleColor: string;
}

export const DEFAULT_POINTER_STYLE: PointerStyle = {
  show: true,
  size: 1.4,
  smoothing: 0.5,
  hideIdle: false,
  ripples: true,
  rippleColor: "#3b82f6",
};

export const pointerStyleOf = (s: Partial<PointerStyle> | undefined): PointerStyle => ({ ...DEFAULT_POINTER_STYLE, ...(s ?? {}) });

// The smoothed path is kept on a uniform grid this fine - well above any screen recording's frame
// rate, so sampling it between grid points (linear) never shows.
const PATH_RATE = 240;
// smoothing 1 = a Gaussian of this many seconds (sigma) along the path.
const MAX_SMOOTH_SIGMA = 0.1;
// Around each click the path is pulled back onto the real pointer (sigma, seconds) - smoothing
// never moves a click off what was clicked.
const CLICK_PIN_SIGMA = 0.05;
export const IDLE_DELAY = 1.6;
const IDLE_FADE_OUT = 0.35;
const IDLE_FADE_IN = 0.12;
export const RIPPLE_SECONDS = 0.45;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- Loading ---------------------------------------------------------------------------------

async function decodeCursor(c: { id: number; hotX: number; hotY: number; png: string }): Promise<CursorImage | null> {
  try {
    const bytes = Uint8Array.from(atob(c.png), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    return { id: c.id, hotX: c.hotX, hotY: c.hotY, width: bitmap.width, height: bitmap.height, bitmap };
  } catch {
    return null;
  }
}

export async function parsePointerSidecar(json: string): Promise<PointerRecording | null> {
  let raw: PointerSidecar;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || !(raw.width > 0) || !(raw.height > 0)) return null;
  const flat = Array.isArray(raw.moves) ? raw.moves : [];
  const n = Math.floor(flat.length / 3);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => flat[3 * a] - flat[3 * b]);
  const t = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  order.forEach((k, i) => {
    t[i] = flat[3 * k];
    x[i] = flat[3 * k + 1];
    y[i] = flat[3 * k + 2];
  });
  const cursors = new Map<number, CursorImage>();
  for (const c of await Promise.all((raw.cursors ?? []).map(decodeCursor))) if (c) cursors.set(c.id, c);
  const clicks = (raw.clicks ?? [])
    .filter((c) => Array.isArray(c) && c.length >= 3 && c.every(Number.isFinite))
    .map(([ct, cx, cy, b]) => ({ t: ct, x: cx, y: cy, button: b ?? 0 }))
    .sort((a, b) => a.t - b.t);
  const shapes = (raw.shapes ?? []).filter((s) => Array.isArray(s) && Number.isFinite(s[0])).map(([st, id]) => ({ t: st, id })).sort((a, b) => a.t - b.t);
  const keys = (raw.keys ?? [])
    .filter((k) => Array.isArray(k) && Number.isFinite(k[0]) && Array.isArray(k[1]) && k[1].length > 0)
    .map(([kt, ks]) => ({ t: kt, keys: ks.map(String) }))
    .sort((a, b) => a.t - b.t);
  // The arrow's height is the pointer's "size" - what ripples are sized from.
  const arrow = [...cursors.values()].sort((a, b) => a.id - b.id)[0];
  return {
    width: raw.width,
    height: raw.height,
    t,
    x,
    y,
    clicks,
    cursors,
    shapes,
    clickT: Float64Array.from(clicks.map((c) => c.t)),
    shapeT: Float64Array.from(shapes.map((s) => s.t)),
    keys,
    nominalCursorHeight: arrow?.height ?? Math.round(raw.height / 34),
  };
}

// Each recording's pointer, loaded once per session (null: recorded without one).
const loaded = new Map<string, Promise<PointerRecording | null>>();
export function loadPointerRecording(sourcePath: string): Promise<PointerRecording | null> {
  let p = loaded.get(sourcePath);
  if (!p) {
    p = invoke<string | null>("load_pointer_sidecar", { videoPath: sourcePath })
      .then((json) => (json ? parsePointerSidecar(json) : null))
      .catch(() => null);
    loaded.set(sourcePath, p);
  }
  return p;
}

// Whether the recording's pointer is drawn by the editor (it isn't in the picture itself).
export const hasPointerPath = (rec: PointerRecording | null | undefined): rec is PointerRecording => !!rec && rec.t.length > 0;

// ---- The path ----------------------------------------------------------------------------------

export interface PointerPath {
  t0: number;
  x: Float32Array;
  y: Float32Array;
}

// Box widths whose three passes make a Gaussian of `sigma` samples (Kovesi) - the same split the
// export's blurs use (box_widths_for_sigma, conversion.rs).
function boxWidths(sigma: number, passes = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl -= 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - passes * wl * wl - 4 * passes * wl - 3 * passes) / (-4 * wl - 4));
  return Array.from({ length: passes }, (_, i) => (i < m ? wl : wu));
}

// A running-sum box filter of odd `width`, edges held.
function boxPass(src: Float32Array, width: number): Float32Array {
  const n = src.length;
  const out = new Float32Array(n);
  const r = (width - 1) / 2;
  if (r < 1 || n === 0) return src.slice();
  const at = (i: number) => src[i < 0 ? 0 : i >= n ? n - 1 : i];
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += at(i);
  for (let i = 0; i < n; i++) {
    out[i] = sum / width;
    sum += at(i + r + 1) - at(i - r);
  }
  return out;
}

// Index of the last entry of sorted `times` that is <= s, or -1.
function lastAtOrBefore(times: ArrayLike<number>, s: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= s) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

// The pointer's path on a uniform PATH_RATE grid: the recorded positions held between movements
// (what the screen showed), then smoothed along time - a Gaussian, so the glide has no lag - and
// pulled back onto the real position around every click.
export function preparePointerPath(rec: PointerRecording, smoothing: number): PointerPath {
  const n = rec.t.length;
  if (n === 0) return { t0: 0, x: new Float32Array(0), y: new Float32Array(0) };
  const t0 = rec.t[0];
  const count = Math.max(1, Math.ceil((rec.t[n - 1] - t0) * PATH_RATE) + 1);
  const rawX = new Float32Array(count);
  const rawY = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = t0 + i / PATH_RATE;
    while (j + 1 < n && rec.t[j + 1] <= s) j++;
    rawX[i] = rec.x[j];
    rawY[i] = rec.y[j];
  }
  const sigma = clamp(smoothing, 0, 1) * MAX_SMOOTH_SIGMA * PATH_RATE;
  if (sigma < 0.5) return { t0, x: rawX, y: rawY };
  let x = rawX;
  let y = rawY;
  for (const w of boxWidths(sigma)) {
    x = boxPass(x, w);
    y = boxPass(y, w);
  }
  const pin = CLICK_PIN_SIGMA * PATH_RATE;
  for (const c of rec.clicks) {
    const centre = (c.t - t0) * PATH_RATE;
    const from = Math.max(0, Math.floor(centre - 3 * pin));
    const to = Math.min(count - 1, Math.ceil(centre + 3 * pin));
    for (let i = from; i <= to; i++) {
      const w = Math.exp(-0.5 * ((i - centre) / pin) ** 2);
      x[i] += (rawX[i] - x[i]) * w;
      y[i] += (rawY[i] - y[i]) * w;
    }
  }
  return { t0, x, y };
}

function pathAt(path: PointerPath, s: number): { x: number; y: number } {
  const n = path.x.length;
  if (n === 0) return { x: 0, y: 0 };
  const f = clamp((s - path.t0) * PATH_RATE, 0, n - 1);
  const i = Math.floor(f);
  const k = f - i;
  const j = Math.min(n - 1, i + 1);
  return { x: path.x[i] + (path.x[j] - path.x[i]) * k, y: path.y[i] + (path.y[j] - path.y[i]) * k };
}

// Prepared paths, per recording and smoothing - the smoothing pass runs once, not per frame.
const pathCache = new WeakMap<PointerRecording, Map<number, PointerPath>>();
export function pointerPath(rec: PointerRecording, smoothing: number): PointerPath {
  let byAmount = pathCache.get(rec);
  if (!byAmount) {
    byAmount = new Map();
    pathCache.set(rec, byAmount);
  }
  const key = Math.round(clamp(smoothing, 0, 1) * 100);
  let path = byAmount.get(key);
  if (!path) {
    path = preparePointerPath(rec, key / 100);
    byAmount.set(key, path);
  }
  return path;
}

// ---- The state at a moment ------------------------------------------------------------------------

export interface PointerState {
  // Capture pixels.
  x: number;
  y: number;
  // Which cursor bitmap (-1: hidden by the system; null: the recording has no bitmaps - the
  // built-in arrow).
  cursorId: number | null;
  opacity: number;
  ripple: { x: number; y: number; age: number; button: number } | null;
}

// When the pointer starts moving again after resting - where hide-when-idle fades it back in.
const burstCache = new WeakMap<PointerRecording, { activity: Float64Array; bursts: Float64Array }>();
function activityOf(rec: PointerRecording) {
  let a = burstCache.get(rec);
  if (!a) {
    const all = [...rec.t, ...rec.clicks.map((c) => c.t)].sort((p, q) => p - q);
    const bursts: number[] = [];
    let prev = -Infinity;
    for (const t of all) {
      if (t - prev > IDLE_DELAY) bursts.push(t);
      prev = t;
    }
    a = { activity: Float64Array.from(all), bursts: Float64Array.from(bursts) };
    burstCache.set(rec, a);
  }
  return a;
}

function idleOpacity(rec: PointerRecording, s: number): number {
  const { activity, bursts } = activityOf(rec);
  const last = lastAtOrBefore(activity, s);
  // Before anything happens the pointer rests where the recording began.
  const lastT = last >= 0 ? activity[last] : (activity[0] ?? 0) - IDLE_DELAY - IDLE_FADE_OUT;
  const idle = s - lastT;
  const out = idle <= IDLE_DELAY ? 1 : clamp(1 - (idle - IDLE_DELAY) / IDLE_FADE_OUT, 0, 1);
  const b = lastAtOrBefore(bursts, s);
  const inn = b >= 0 && idle <= IDLE_DELAY ? clamp((s - bursts[b]) / IDLE_FADE_IN, 0, 1) : 1;
  return Math.min(out, inn);
}

export function pointerStateAt(rec: PointerRecording, path: PointerPath, style: PointerStyle, s: number): PointerState {
  const { x, y } = pathAt(path, s);
  let cursorId: number | null = null;
  if (rec.shapes.length > 0) {
    const i = lastAtOrBefore(rec.shapeT, s);
    cursorId = rec.shapes[Math.max(0, i)].id;
    if (cursorId >= 0 && !rec.cursors.has(cursorId)) cursorId = null;
  }
  const opacity = style.hideIdle ? idleOpacity(rec, s) : 1;
  let ripple: PointerState["ripple"] = null;
  if (style.ripples && rec.clicks.length > 0) {
    const i = lastAtOrBefore(rec.clickT, s);
    if (i >= 0 && s - rec.clicks[i].t < RIPPLE_SECONDS) {
      const c = rec.clicks[i];
      ripple = { x: c.x, y: c.y, age: s - c.t, button: c.button };
    }
  }
  return { x, y, cursorId, opacity, ripple };
}

// ---- Painting ------------------------------------------------------------------------------------

// The built-in arrow (24 units tall, tip at 0,0) for a recording without cursor bitmaps.
const ARROW_PATH = "M0 0 L0 17 L4.2 13 L7 19.5 L9.8 18.3 L7.1 12 L12.5 12 Z";
const ARROW_HEIGHT = 20;

// Paints the pointer with its hotspot at (x, y): `scale` canvas pixels per capture pixel along each
// axis (a non-uniform crop stretches it, as export does). `mirrored`: drawn flipped about the
// hotspot - the export draws before a mirrored clip's flip, which turns it back.
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  cursor: CursorImage | null,
  nominalHeight: number,
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  opacity: number,
  mirrored = false
): void {
  if (opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(opacity, 0, 1);
  // A soft shadow under it, as the system draws one - in canvas pixels (shadows ignore transforms).
  const k = Math.max(scaleX, scaleY);
  ctx.shadowColor = "rgba(0,0,0,0.28)";
  ctx.shadowBlur = 2.5 * k;
  ctx.shadowOffsetY = 1 * k;
  ctx.translate(x, y);
  ctx.scale(mirrored ? -scaleX : scaleX, scaleY);
  if (cursor) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cursor.bitmap, -cursor.hotX, -cursor.hotY);
  } else {
    const u = nominalHeight / ARROW_HEIGHT;
    ctx.scale(u, u);
    const p = new Path2D(ARROW_PATH);
    ctx.fillStyle = "#000";
    ctx.fill(p);
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#fff";
    ctx.lineJoin = "round";
    ctx.stroke(p);
  }
  ctx.restore();
}

// The pointer's drawn extent around its hotspot, in capture pixels.
export function cursorBounds(rec: PointerRecording, id: number | null): { left: number; top: number; right: number; bottom: number } {
  const c = id !== null ? rec.cursors.get(id) : undefined;
  if (c) return { left: -c.hotX, top: -c.hotY, right: c.width - c.hotX, bottom: c.height - c.hotY };
  const u = rec.nominalCursorHeight / ARROW_HEIGHT;
  return { left: -1, top: -1, right: 13.5 * u, bottom: 20.5 * u };
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0x3b82f6;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// A click's ring at `age` seconds: grows from a third of `radius` to all of it, easing out, while
// it fades - with a faint disc inside.
export function drawRipple(ctx: CanvasRenderingContext2D, x: number, y: number, radiusX: number, radiusY: number, age: number, color: string): void {
  const p = clamp(age / RIPPLE_SECONDS, 0, 1);
  if (p >= 1) return;
  const grow = 0.3 + 0.7 * (1 - (1 - p) ** 3);
  const fade = 1 - p;
  const [r, g, b] = hexToRgb(color);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(radiusX, radiusY);
  ctx.beginPath();
  ctx.arc(0, 0, grow, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${r},${g},${b},${(0.2 * fade).toFixed(4)})`;
  ctx.fill();
  ctx.lineWidth = 0.13 * (1 - 0.5 * p);
  ctx.strokeStyle = `rgba(${r},${g},${b},${(0.85 * fade).toFixed(4)})`;
  ctx.stroke();
  ctx.restore();
}

// A ripple's full radius in capture pixels - it scales with the pointer.
export const rippleRadius = (rec: PointerRecording, style: PointerStyle): number => 1.05 * rec.nominalCursorHeight * clamp(style.size, 0.5, 4);

// ---- Export ---------------------------------------------------------------------------------------

// The export samples the pointer at this rate in SOURCE seconds, on cells centred on k/60 - so a
// 30 or 60 fps recording's frames land exactly on cell centres (the moment both renderers paint).
export const POINTER_GRID = 60;
// overlay places sprites on even pixels (4:2:0 video), so the pointer's position within each 2-pixel
// step is baked into the sprite instead, in this many quarter-pixel phases - at most 1/8 px from
// the preview's exact placement (in headless Edge a 0.09 px offset moved hard edge pixels ~20/255).
const PHASES = 8;
const OPACITY_LEVELS = 8;

export interface PointerExportSegment {
  start: number;
  // Where the segment's picture stops being read - its end plus any transition tail.
  end: number;
  mirrored: boolean;
}

// The pointer layers of one clip's export: its cursor and its ripples, each a sprite track timed
// in the source's own seconds (export_trimmed_video re-times them onto the clip). `videoW` is the
// source video's pixel width - capture pixels are scaled into it.
export function pointerExportLayers(rec: PointerRecording, style: PointerStyle, seg: PointerExportSegment, videoW: number): SpriteTrackSpec[] {
  if (!style.show || !hasPointerPath(rec)) return [];
  const toVideo = videoW / rec.width;
  const size = clamp(style.size, 0.5, 4);
  const scale = toVideo * size;
  const path = pointerPath(rec, style.smoothing);
  // From a cell before the clip's first frame (anything before it is cut off by export).
  const first = Math.floor(seg.start * POINTER_GRID) - 1;
  const last = Math.floor(seg.end * POINTER_GRID) + 1;
  const states: PointerState[] = [];
  for (let k = first; k <= last; k++) states.push(pointerStateAt(rec, path, style, k / POINTER_GRID));
  const cellStart = (i: number) => (first + i - 0.5) / POINTER_GRID;
  const layers: SpriteTrackSpec[] = [];

  // Ripples first (under the pointer). One sprite per frame of the ring's animation.
  if (style.ripples && states.some((s) => s.ripple)) {
    const radius = rippleRadius(rec, style) * toVideo;
    const box = 2 * Math.ceil(radius * 1.12 + 3);
    const frames = Math.ceil(RIPPLE_SECONDS * POINTER_GRID);
    const sprites: string[] = [];
    for (let j = 0; j < frames; j++) {
      sprites.push(
        encodeSprite(box, box, (ctx) => {
          drawRipple(ctx, box / 2, box / 2, radius, radius, j / POINTER_GRID, style.rippleColor);
        })
      );
    }
    const cells = states.map((s) => {
      if (!s.ripple) return null;
      const j = Math.min(frames - 1, Math.round(s.ripple.age * POINTER_GRID));
      const cx = s.ripple.x * toVideo;
      const cy = s.ripple.y * toVideo;
      return { sprite: j, x: 2 * Math.round((cx - box / 2) / 2), y: 2 * Math.round((cy - box / 2) / 2) };
    });
    layers.push({ sprites, width: box, height: box, runs: runsFromCells(cells, cellStart), end: cellStart(cells.length) });
  }

  // The pointer. Every look it takes in this stretch, at every sub-pixel phase it lands on.
  const used = new Set(states.filter((s) => s.cursorId !== -1).map((s) => s.cursorId));
  if (used.size > 0) {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    for (const id of used) {
      const b = cursorBounds(rec, id);
      // Mirrored, the image extends the other way from the hotspot.
      const l = seg.mirrored ? -b.right : b.left;
      const r = seg.mirrored ? -b.left : b.right;
      left = Math.min(left, l);
      right = Math.max(right, r);
      top = Math.min(top, b.top);
      bottom = Math.max(bottom, b.bottom);
    }
    // Room for the shadow and the sub-pixel shift, kept even so placement stays on even pixels.
    const margin = 2 * Math.ceil((4 * scale + 3) / 2);
    const w = 2 * Math.ceil(((right - left) * scale + 2 * margin + 2) / 2);
    const h = 2 * Math.ceil(((bottom - top) * scale + 2 * margin + 2) / 2);
    const spriteIndex = new Map<string, number>();
    const sprites: string[] = [];
    const cells = states.map((s) => {
      if (s.cursorId === -1) return null;
      const level = Math.round(clamp(s.opacity, 0, 1) * OPACITY_LEVELS);
      if (level === 0) return null;
      // The drawn box's top-left in video pixels, split into an even whole part and a phase.
      const bx = s.x * toVideo + left * scale;
      const by = s.y * toVideo + top * scale;
      let ex = 2 * Math.floor(bx / 2);
      let ey = 2 * Math.floor(by / 2);
      let px = Math.round(((bx - ex) * PHASES) / 2);
      let py = Math.round(((by - ey) * PHASES) / 2);
      if (px === PHASES) (ex += 2), (px = 0);
      if (py === PHASES) (ey += 2), (py = 0);
      const key = `${s.cursorId}|${px}|${py}|${level}`;
      let index = spriteIndex.get(key);
      if (index === undefined) {
        index = sprites.length;
        spriteIndex.set(key, index);
        const cursor = s.cursorId !== null ? rec.cursors.get(s.cursorId) ?? null : null;
        const hx = margin + (px * 2) / PHASES - left * scale;
        const hy = margin + (py * 2) / PHASES - top * scale;
        sprites.push(encodeSprite(w, h, (ctx) => drawCursor(ctx, cursor, rec.nominalCursorHeight, hx, hy, scale, scale, level / OPACITY_LEVELS, seg.mirrored)));
      }
      return { sprite: index, x: ex - margin, y: ey - margin };
    });
    layers.push({ sprites, width: w, height: h, runs: runsFromCells(cells, cellStart), end: cellStart(cells.length) });
  }
  return layers;
}
