// utils/stage/stageMath.ts
//
// Equations in Stage scenes. KaTeX typesets the LaTeX in a hidden part of the page - real TeX layout,
// in its own Computer Modern faces - and that layout is read back as a description: every glyph
// (character, face, size, colour, baseline position), every rule (fraction bars, overlines), and
// KaTeX's few SVG pieces (radical signs, stretchy brackets, arrows). The renderer draws from that
// description at the export's own resolution, so an equation is as sharp at 4K as at 1080p, and a
// change of equation can be shown glyph by glyph: what stays glides to its new place, what's new
// writes in (mathMorph below).
//
// Layout needs the DOM and the faces loaded, so it's asynchronous: loadStageMath(scene) settles a
// scene's equations before it's compiled (stageLive.whenCompiled, stageExport), as its fonts and
// pictures are, and mathLayout() then answers at once from the cache.
import katex from "katex";
import "katex/dist/katex.min.css";
import type { StageScene } from "./stageTypes";

export interface MathGlyph {
  ch: string;
  // A CSS font string (style weight size family) - what the canvas draws it with.
  font: string;
  // Family alone, for matching glyphs between equations.
  family: string;
  // Left edge and baseline, stage units from the equation's top-left.
  x: number;
  y: number;
  width: number;
  color: string;
}
export interface MathRule {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}
export interface MathSvg {
  markup: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  image?: HTMLImageElement;
}
export interface MathLayout {
  tex: string;
  size: number;
  width: number;
  height: number;
  glyphs: MathGlyph[];
  rules: MathRule[];
  svgs: MathSvg[];
  error?: string;
}

const cache = new Map<string, MathLayout>();
const pending = new Map<string, Promise<MathLayout>>();
const keyOf = (tex: string, size: number, color: string) => `${size}\u0000${color}\u0000${tex}`;

// The equation laid out, if it has been (null until loadMath for it has settled).
export function mathLayout(tex: string, size: number, color: string): MathLayout | null {
  return cache.get(keyOf(tex, size, color)) ?? null;
}

let host: HTMLDivElement | null = null;
function layoutHost(): HTMLDivElement {
  if (host && host.isConnected) return host;
  host = document.createElement("div");
  // In the page (so KaTeX's stylesheet and faces apply) but never seen or hit.
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style;white-space:nowrap;";
  document.body.appendChild(host);
  return host;
}

const canvasCtx = (() => {
  let ctx: CanvasRenderingContext2D | null = null;
  return () => (ctx ??= document.createElement("canvas").getContext("2d")!);
})();

export function loadMath(tex: string, size: number, color: string): Promise<MathLayout> {
  const key = keyOf(tex, size, color);
  const ready = cache.get(key);
  if (ready) return Promise.resolve(ready);
  let p = pending.get(key);
  if (!p) {
    p = layOut(tex, size, color).then((l) => {
      cache.set(key, l);
      pending.delete(key);
      return l;
    });
    pending.set(key, p);
  }
  return p;
}

async function layOut(tex: string, size: number, color: string): Promise<MathLayout> {
  const box = document.createElement("div");
  box.style.cssText = `display:inline-block;font-size:${size}px;color:${color};line-height:1;`;
  let error: string | undefined;
  try {
    katex.render(tex || "\\,", box, { throwOnError: true, displayMode: true, output: "html", strict: false, trust: false });
  } catch (e) {
    error = e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, "") : String(e);
    katex.render(tex || "\\,", box, { throwOnError: false, displayMode: true, output: "html", strict: false });
  }
  // KaTeX's display block carries a vertical margin and centring - the equation alone is wanted.
  const display = box.querySelector(".katex-display") as HTMLElement | null;
  if (display) display.style.margin = "0";
  layoutHost().appendChild(box);
  try {
    // Its faces, before anything is measured - each in the style and weight it's used in: KaTeX's
    // maths italic exists only as an italic, and asking for it upright loads nothing, leaving the
    // layout measured in a fallback face.
    const faces = new Set<string>();
    box.querySelectorAll("*").forEach((n) => {
      const cs = getComputedStyle(n);
      faces.add(`${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`);
    });
    await Promise.all([...faces].map((f) => document.fonts.load(f).catch(() => [])));
    await document.fonts.ready;
    const root = (box.querySelector(".katex-html") ?? box) as HTMLElement;
    const origin = root.getBoundingClientRect();
    const glyphs: MathGlyph[] = [];
    const rules: MathRule[] = [];
    const svgs: MathSvg[] = [];
    const ctx = canvasCtx();
    const range = document.createRange();
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const el = node.parentElement!;
        const cs = getComputedStyle(el);
        const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        ctx.font = font;
        const ascent = ctx.measureText("x").fontBoundingBoxAscent;
        // Character by character (by code point: some glyphs are astral).
        let offset = 0;
        for (const ch of text) {
          const len = ch.length;
          if (ch.trim()) {
            range.setStart(node, offset);
            range.setEnd(node, offset + len);
            const r = range.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) glyphs.push({ ch, font, family: cs.fontFamily, x: r.left - origin.left, y: r.top - origin.top + ascent, width: r.width, color: cs.color });
          }
          offset += len;
        }
        return;
      }
      if (!(node instanceof Element)) return;
      if (node instanceof SVGSVGElement) {
        const r = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        const clone = node.cloneNode(true) as SVGSVGElement;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.setAttribute("width", String(r.width));
        clone.setAttribute("height", String(r.height));
        // currentColor has nothing to inherit inside an image - the colour is written in.
        clone.setAttribute("fill", cs.color);
        clone.querySelectorAll("path").forEach((pathEl) => pathEl.setAttribute("fill", cs.color));
        svgs.push({ markup: new XMLSerializer().serializeToString(clone), x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height, color: cs.color });
        return;
      }
      const cs = getComputedStyle(node);
      // Fraction bars, overlines, underlines and \rule: solid borders.
      const bottom = parseFloat(cs.borderBottomWidth);
      if (bottom > 0 && cs.borderBottomStyle !== "none") {
        const r = node.getBoundingClientRect();
        rules.push({ x: r.left - origin.left, y: r.bottom - origin.top - bottom, width: r.width, height: bottom, color: cs.borderBottomColor });
      }
      const top = parseFloat(cs.borderTopWidth);
      if (top > 0 && cs.borderTopStyle !== "none") {
        const r = node.getBoundingClientRect();
        rules.push({ x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: top, color: cs.borderTopColor });
      }
      if (cs.display === "none" || node.classList.contains("katex-mathml")) return;
      node.childNodes.forEach(walk);
    };
    walk(root);
    // The SVG pieces as images, decoded now so drawing them later never waits.
    await Promise.all(
      svgs.map(
        (s) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              s.image = img;
              resolve();
            };
            img.onerror = () => resolve();
            img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.markup)}`;
          })
      )
    );
    // Fitted to the ink - KaTeX's own box keeps room for depths an equation may not have, which sits
    // it high in its box. Everything is moved so the ink starts a hair from the top-left corner.
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const grow = (l: number, t: number, r: number, b: number) => {
      left = Math.min(left, l);
      top = Math.min(top, t);
      right = Math.max(right, r);
      bottom = Math.max(bottom, b);
    };
    for (const g of glyphs) {
      ctx.font = g.font;
      const m = ctx.measureText(g.ch);
      grow(g.x - m.actualBoundingBoxLeft, g.y - m.actualBoundingBoxAscent, g.x + m.actualBoundingBoxRight, g.y + m.actualBoundingBoxDescent);
    }
    for (const r of rules) grow(r.x, r.y, r.x + r.width, r.y + r.height);
    for (const s of svgs) grow(s.x, s.y, s.x + s.width, s.y + s.height);
    if (!Number.isFinite(left)) return { tex, size, width: Math.ceil(origin.width), height: Math.ceil(origin.height), glyphs, rules, svgs, error };
    const pad = Math.max(2, size * 0.04);
    const dx = pad - left;
    const dy = pad - top;
    for (const g of glyphs) {
      g.x += dx;
      g.y += dy;
    }
    for (const r of rules) {
      r.x += dx;
      r.y += dy;
    }
    for (const s of svgs) {
      s.x += dx;
      s.y += dy;
    }
    return { tex, size, width: Math.ceil(right - left + 2 * pad), height: Math.ceil(bottom - top + 2 * pad), glyphs, rules, svgs, error };
  } finally {
    box.remove();
  }
}

// Every equation a scene shows, in every beat, laid out.
export async function loadStageMath(scene: StageScene): Promise<void> {
  const jobs: Promise<MathLayout>[] = [];
  for (const e of scene.elements) {
    if (e.kind !== "math") continue;
    const size = e.textLook?.fontSize ?? 64;
    const texts = new Set<string>([e.props.text ?? ""]);
    for (const b of scene.beats) {
      const t = b.changes[e.id]?.text;
      if (t !== undefined) texts.add(t);
    }
    for (const tex of texts) jobs.push(loadMath(tex, size, MATH_INK));
  }
  await Promise.all(jobs);
}

// Equations are laid out in one ink and tinted as they're drawn, so a colour change is a tint, not a
// new layout. Colours set inside the TeX (\color{...}) keep their own.
export const MATH_INK = "rgb(255, 255, 255)";

// ---- Drawing ---------------------------------------------------------------------------------------

// The equation drawn into `ctx` at `scale` device pixels a stage unit, offset by (ox, oy) stage units.
// Glyphs in the layout's ink take `ink` (the element's colour); glyphs coloured in the TeX keep theirs.
export function drawMath(ctx: CanvasRenderingContext2D, l: MathLayout, scale: number, ox: number, oy: number, ink: string, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  const tint = (c: string) => (c === MATH_INK ? ink : c);
  for (const r of l.rules) {
    ctx.fillStyle = tint(r.color);
    // At least a device pixel, snapped - a fraction bar never blurs into two half-lit rows.
    const h = Math.max(1, Math.round(r.height * scale));
    ctx.fillRect((ox + r.x) * scale, Math.round((oy + r.y) * scale), r.width * scale, h);
  }
  // Glyphs sit at their measured left edges: whatever alignment the canvas was last left in, not here.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const g of l.glyphs) {
    ctx.font = scaledFont(g.font, scale);
    ctx.fillStyle = tint(g.color);
    ctx.fillText(g.ch, (ox + g.x) * scale, (oy + g.y) * scale);
  }
  for (const s of l.svgs) {
    if (!s.image) continue;
    if (s.color === MATH_INK && ink !== MATH_INK) drawTinted(ctx, s.image, (ox + s.x) * scale, (oy + s.y) * scale, s.width * scale, s.height * scale, ink);
    else ctx.drawImage(s.image, (ox + s.x) * scale, (oy + s.y) * scale, s.width * scale, s.height * scale);
  }
  ctx.restore();
}

// A CSS font string with its pixel size multiplied by `scale`.
export function scaledFont(font: string, scale: number): string {
  return font.replace(/([\d.]+)px/, (_m, px: string) => `${(parseFloat(px) * scale).toFixed(3)}px`);
}

let tintCanvas: HTMLCanvasElement | null = null;
function drawTinted(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, ink: string): void {
  const cw = Math.max(1, Math.ceil(w));
  const ch = Math.max(1, Math.ceil(h));
  tintCanvas ??= document.createElement("canvas");
  tintCanvas.width = cw;
  tintCanvas.height = ch;
  const t = tintCanvas.getContext("2d")!;
  t.clearRect(0, 0, cw, ch);
  t.drawImage(img, 0, 0, w, h);
  t.globalCompositeOperation = "source-in";
  t.fillStyle = ink;
  t.fillRect(0, 0, cw, ch);
  t.globalCompositeOperation = "source-over";
  ctx.drawImage(tintCanvas, x, y);
}

// ---- Morphing one equation into another ------------------------------------------------------------

export interface MathMorphPlan {
  // Glyph pairs [from index, to index] that are the same symbol in the same face - they travel.
  pairs: [number, number][];
  gone: number[];
  arriving: number[];
}

// Matches the two equations' glyphs as a longest common subsequence of (symbol, face): order is kept,
// so "a^2 + b^2" into "a^2 + b^2 = c^2" keeps its first five glyphs and writes on the rest, and a
// term that moves across the equals sign travels rather than vanishing and reappearing.
export function planMathMorph(a: MathLayout, b: MathLayout): MathMorphPlan {
  const ka = a.glyphs.map((g) => `${g.ch}\u0000${g.family}`);
  const kb = b.glyphs.map((g) => `${g.ch}\u0000${g.family}`);
  const n = ka.length;
  const m = kb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const usedA = new Set(pairs.map((p) => p[0]));
  const usedB = new Set(pairs.map((p) => p[1]));
  // Unmatched glyphs of the same symbol anywhere still travel (a term moved past others).
  const gone: number[] = [];
  const arriving = new Set(kb.map((_, k) => k).filter((k) => !usedB.has(k)));
  for (let k = 0; k < n; k++) {
    if (usedA.has(k)) continue;
    const twin = [...arriving].find((x) => kb[x] === ka[k]);
    if (twin !== undefined) {
      pairs.push([k, twin]);
      arriving.delete(twin);
    } else gone.push(k);
  }
  return { pairs, gone, arriving: [...arriving] };
}

// One frame of `a` becoming `b` at progress p (0..1), drawn into `ctx`. Travelling glyphs move and
// change size along an eased path; glyphs leaving fade and drop away early, arriving ones fade and
// rise in late, the two overlapping; rules and SVG pieces cross-fade.
export function drawMathMorph(ctx: CanvasRenderingContext2D, a: MathLayout, b: MathLayout, plan: MathMorphPlan, p: number, scale: number, ox: number, oy: number, ink: string, size: { a: [number, number]; b: [number, number]; at: [number, number] }): void {
  const ease = (t: number) => t * t * (3 - 2 * t);
  const tint = (c: string) => (c === MATH_INK ? ink : c);
  // Each equation centred in the box as it is at this moment.
  const axo = ox + (size.at[0] - size.a[0]) / 2;
  const ayo = oy + (size.at[1] - size.a[1]) / 2;
  const bxo = ox + (size.at[0] - size.b[0]) / 2;
  const byo = oy + (size.at[1] - size.b[1]) / 2;
  ctx.save();
  ctx.textAlign = "left";
  // Overlapping, as a rewrite reads: what leaves fades through the first 60%, what arrives from 30%
  // on - never a moment with nothing new on its way.
  const out = 1 - ease(Math.min(1, p / 0.6));
  const inn = ease(Math.min(1, Math.max(0, (p - 0.3) / 0.7)));
  // Rules and SVG pieces of each, cross-fading.
  drawMath(ctx, { ...a, glyphs: [] }, scale, axo, ayo, ink, out);
  drawMath(ctx, { ...b, glyphs: [] }, scale, bxo, byo, ink, inn);
  ctx.textBaseline = "alphabetic";
  const n = plan.pairs.length;
  plan.pairs.forEach(([ia, ib], k) => {
    const ga = a.glyphs[ia];
    const gb = b.glyphs[ib];
    // A slight stagger left to right, so a rewrite reads as a wave rather than a jump.
    const delay = n > 1 ? (k / (n - 1)) * 0.15 : 0;
    const t = ease(Math.min(1, Math.max(0, (p - delay) / (1 - 0.15))));
    const pa = parseFloat(/([\d.]+)px/.exec(ga.font)?.[1] ?? "16");
    const pb = parseFloat(/([\d.]+)px/.exec(gb.font)?.[1] ?? "16");
    ctx.font = scaledFont(gb.font, (scale * (pa + (pb - pa) * t)) / pb);
    ctx.fillStyle = t < 0.5 ? tint(ga.color) : tint(gb.color);
    ctx.globalAlpha = 1;
    const x = (axo + ga.x) + (bxo + gb.x - axo - ga.x) * t;
    const y = (ayo + ga.y) + (byo + gb.y - ayo - ga.y) * t;
    ctx.fillText(gb.ch, x * scale, y * scale);
  });
  for (const k of plan.gone) {
    const g = a.glyphs[k];
    ctx.globalAlpha = out;
    ctx.font = scaledFont(g.font, scale);
    ctx.fillStyle = tint(g.color);
    ctx.fillText(g.ch, (axo + g.x) * scale, (ayo + g.y + (1 - out) * 6) * scale);
  }
  for (const k of plan.arriving) {
    const g = b.glyphs[k];
    ctx.globalAlpha = inn;
    ctx.font = scaledFont(g.font, scale);
    ctx.fillStyle = tint(g.color);
    ctx.fillText(g.ch, (bxo + g.x) * scale, (byo + g.y - (1 - inn) * 6) * scale);
  }
  ctx.restore();
}
