// components/video/pageCurl.ts
//
// Page curl: the outgoing picture peels off like a sheet of paper rolling over a cylinder of radius
// R whose axis is the fold line. Seen from above, a point of the sheet a distance s past the fold
// sits at R*sin(s/R) past it on the cylinder's near half (the printed side), comes back over the
// top on its far half (the back of the page), and past s = pi*R lies flat on top of the page again,
// mirrored. Everything is a function of the distance across the fold alone, so it is drawn in
// "fold space" - the frame turned so the peel direction points along +x, the fold a vertical line
// at x = K - where every layer is a 1-D remap of columns:
//
//   flat page    x < K                     source x
//   front half   K <= x < K+R              source K + R*asin((x-K)/R)
//   back half    K <= x < K+R              source K + R*(pi - asin((x-K)/R))   (over the front)
//   back flap    x < K                     source K + pi*R - (x-K)             (over the page)
//
// The back of the page is the paper colour over the mirrored picture (seeThrough of it showing),
// both halves of the cylinder darken as they turn away from the viewer, and the lifted sheet casts
// a soft shadow. The export (transition_graphs.rs, page_curl) builds the same layers from rotate +
// remap with the same constants; the preview draws the column maps as thin strips.
import type { PeelFrom, TransitionEasing, TransitionLook } from "../../utils/videoEditTypes";

// The cylinder's radius, as a fraction of the frame's diagonal (times look.size).
export const CURL_RADIUS = 0.07;
// How far past the far side the fold travels beyond one radius (when the cylinder, the furthest
// thing on screen, has left the frame), in radii - so the shadow has left too.
export const CURL_TAIL = 1;
// Darkening at the cylinder's edge (where its surface is edge-on): front and back halves.
export const CURL_SHADE_FRONT = 0.55;
export const CURL_SHADE_BACK = 0.6;
// The cast shadow: opacity (times look.intensity), blur (gaussian sigma) and shift along the peel
// direction, in radii.
export const CURL_SHADOW_ALPHA = 0.6;
export const CURL_SHADOW_BLUR = 0.34;
export const CURL_SHADOW_SHIFT = 0.25;
export const DEFAULT_PAPER_COLOR = "#f2efe8";
export const DEFAULT_SEE_THROUGH = 0.15;

export const curlSize = (look: TransitionLook) => Math.max(0.4, Math.min(2, look.size ?? 1));
export const curlSeeThrough = (look: TransitionLook) => Math.max(0, Math.min(1, look.seeThrough ?? DEFAULT_SEE_THROUGH));
export const curlShadow = (look: TransitionLook) => Math.max(0, Math.min(1.5, look.intensity ?? 1));

// The motion curve: progress 0..1 -> how far the fold has travelled 0..1.
export function ease(easing: TransitionEasing | undefined, p: number): number {
  const c = Math.max(0, Math.min(1, p));
  switch (easing) {
    case "linear":
      return c;
    case "in":
      return c * c;
    case "out":
      return 1 - (1 - c) * (1 - c);
    default:
      return c * c * (3 - 2 * c);
  }
}

// The unit vector (screen px, y down) the page lifts towards - from the far side to the corner or
// edge it peels from. A corner's fold runs parallel to the frame's other diagonal, so it reaches
// both neighbouring corners together.
export function curlDirection(from: PeelFrom | undefined, W: number, H: number): [number, number] {
  let v: [number, number];
  switch (from) {
    case "right":
      return [1, 0];
    case "left":
      return [-1, 0];
    case "bottom":
      return [0, 1];
    case "top":
      return [0, -1];
    case "bottomLeft":
      v = [-H, W];
      break;
    case "topRight":
      v = [H, -W];
      break;
    case "topLeft":
      v = [-H, -W];
      break;
    default:
      v = [H, W];
  }
  const n = Math.hypot(v[0], v[1]);
  return [v[0] / n, v[1] / n];
}

export interface CurlGeometry {
  dx: number;
  dy: number;
  // The peel direction's angle (radians, clockwise from +x, as y is down).
  theta: number;
  // Fold space: the frame turned by -theta, in its bounding box Wr x Hr, centred.
  Wr: number;
  Hr: number;
  R: number;
  // The fold's travel, Wr down to -(R + tail).
  travel: number;
}

export function curlGeometry(look: TransitionLook, W: number, H: number): CurlGeometry {
  const [dx, dy] = curlDirection(look.peelFrom, W, H);
  const Wr = W * Math.abs(dx) + H * Math.abs(dy);
  const Hr = W * Math.abs(dy) + H * Math.abs(dx);
  const R = CURL_RADIUS * curlSize(look) * Math.hypot(W, H);
  return { dx, dy, theta: Math.atan2(dy, dx), Wr, Hr, R, travel: Wr + R + CURL_TAIL * R };
}

// The fold's x in fold space at progress p.
export const curlFold = (g: CurlGeometry, look: TransitionLook, p: number) => g.Wr - ease(look.easing, p) * g.travel;

// Lambert darkening across a cylinder half, t = (x - K) / R in 0..1.
const edgeOn = (t: number) => 1 - Math.sqrt(Math.max(0, 1 - t * t));

// ---------- drawing ----------

const scratch: HTMLCanvasElement[] = [];
function layer(i: number, w: number, h: number): CanvasRenderingContext2D {
  scratch[i] ??= document.createElement("canvas");
  const c = scratch[i];
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// A darkening band over [x0, x0 + R] (fold px) where the layer already is.
function shadeBand(ctx: CanvasRenderingContext2D, x0: number, R: number, strength: number, Hr: number) {
  const grad = ctx.createLinearGradient(x0, 0, x0 + R, 0);
  for (let i = 0; i <= 16; i++) grad.addColorStop(i / 16, `rgba(0,0,0,${strength * edgeOn(i / 16)})`);
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = grad;
  ctx.fillRect(x0, 0, R, Hr);
}

// The whole transition at progress p: the new picture, what's left of the old page, and the curl.
// `ctx` is in frame px (W x H); `dpr` device px per frame px.
export function drawPageCurl(ctx: CanvasRenderingContext2D, look: TransitionLook, p: number, old: CanvasImageSource, next: CanvasImageSource, W: number, H: number, dpr: number): void {
  const g = curlGeometry(look, W, H);
  const { dx, dy, Wr, Hr, R } = g;
  const K = curlFold(g, look, p);
  ctx.drawImage(next, 0, 0, W, H);

  // The flat page: the frame where (P - centre) . d < K - Wr/2.
  const cut = K - Wr / 2;
  const corners: [number, number][] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  const side = (q: [number, number]) => (q[0] - W / 2) * dx + (q[1] - H / 2) * dy - cut;
  const page: [number, number][] = [];
  corners.forEach((q, i) => {
    const r = corners[(i + 1) % 4];
    const fq = side(q);
    const fr = side(r);
    if (fq <= 0) page.push(q);
    if ((fq < 0 && fr > 0) || (fq > 0 && fr < 0)) {
      const t = fq / (fq - fr);
      page.push([q[0] + t * (r[0] - q[0]), q[1] + t * (r[1] - q[1])]);
    }
  });
  if (page.length >= 3) {
    ctx.save();
    ctx.beginPath();
    page.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(old, 0, 0, W, H);
    ctx.restore();
  }
  // Nothing of the sheet past the fold is left on screen.
  if (K + R + CURL_TAIL * R < 0) return;

  // Fold-space layers, at most one px per frame px (they're up to ~2x the frame's area, and the curl
  // is soft and moving fast - the export draws it at half size).
  const s = Math.min(dpr, 1, 1600 / Math.max(Wr, Hr));
  const cw = Math.max(1, Math.round(Wr * s));
  const ch = Math.max(1, Math.round(Hr * s));
  const toFold = (c: CanvasRenderingContext2D) => {
    c.setTransform(s, 0, 0, s, 0, 0);
    c.translate(Wr / 2, Hr / 2);
    c.rotate(-g.theta);
    c.drawImage(old, -W / 2, -H / 2, W, H);
    c.setTransform(s, 0, 0, s, 0, 0);
  };
  const fold = layer(0, cw, ch);
  toFold(fold);
  // The same, mirrored (x -> Wr - x), for the back of the page.
  const mirror = layer(1, cw, ch);
  mirror.setTransform(-1, 0, 0, 1, cw, 0);
  mirror.drawImage(fold.canvas, 0, 0);
  mirror.setTransform(s, 0, 0, s, 0, 0);

  // Columns [x0, x1) of fold space from source columns [s0, s1) of `src` (fold px).
  const strip = (c: CanvasRenderingContext2D, src: HTMLCanvasElement, s0: number, s1: number, x0: number, x1: number) => {
    if (s1 <= s0 || x1 <= x0) return;
    c.drawImage(src, s0 * s, 0, (s1 - s0) * s, ch, x0, 0, x1 - x0 + 0.5 / s, Hr);
  };
  const n = Math.max(6, Math.min(160, Math.ceil((R * s) / 1.5)));

  // The printed side round the near half of the cylinder (with a sliver behind the fold, so the
  // page and the curl meet without a seam).
  const front = layer(2, cw, ch);
  front.setTransform(s, 0, 0, s, 0, 0);
  strip(front, fold.canvas, K - 2, K, K - 2, K);
  for (let j = 0; j < n; j++) strip(front, fold.canvas, K + R * Math.asin(j / n), K + R * Math.asin((j + 1) / n), K + (R * j) / n, K + (R * (j + 1)) / n);
  shadeBand(front, K, R, CURL_SHADE_FRONT, Hr);

  // The back of the page: over the top of the cylinder, then lying flat back over the page.
  const back = layer(3, cw, ch);
  back.setTransform(s, 0, 0, s, 0, 0);
  for (let j = 0; j < n; j++) {
    const a = Wr - (K + R * (Math.PI - Math.asin(j / n)));
    const b = Wr - (K + R * (Math.PI - Math.asin((j + 1) / n)));
    strip(back, mirror.canvas, a, b, K + (R * j) / n, K + (R * (j + 1)) / n);
  }
  // Flap: x <= K shows source 2K + pi R - x, i.e. mirror column x + (Wr - 2K - pi R).
  const shift = Wr - 2 * K - Math.PI * R;
  const flapEnd = K + shift;
  if (flapEnd > 0) strip(back, mirror.canvas, 0, flapEnd, -shift, K);
  const see = curlSeeThrough(look);
  if (see < 1) {
    back.globalCompositeOperation = "source-atop";
    back.globalAlpha = 1 - see;
    back.fillStyle = /^#[0-9a-f]{6}$/i.test(look.color ?? "") ? look.color! : DEFAULT_PAPER_COLOR;
    back.fillRect(0, 0, Wr, Hr);
    back.globalAlpha = 1;
  }
  shadeBand(back, K, R, CURL_SHADE_BACK, Hr);

  // The curl over its shadow.
  const curl = layer(4, cw, ch);
  const shadow = curlShadow(look);
  if (shadow > 0) {
    // The silhouette, blurred at quarter size (it's soft anyway) and stretched back.
    const qw = Math.max(1, Math.round(cw / 4));
    const qh = Math.max(1, Math.round(ch / 4));
    const sil = layer(5, qw, qh);
    sil.drawImage(front.canvas, 0, 0, qw, qh);
    sil.drawImage(back.canvas, 0, 0, qw, qh);
    sil.globalCompositeOperation = "source-in";
    sil.fillStyle = "#000";
    sil.fillRect(0, 0, qw, qh);
    const blurred = layer(6, qw, qh);
    blurred.filter = `blur(${(CURL_SHADOW_BLUR * R * s) / 4}px)`;
    blurred.drawImage(sil.canvas, 0, 0);
    curl.globalAlpha = Math.min(1, CURL_SHADOW_ALPHA * shadow);
    curl.drawImage(blurred.canvas, CURL_SHADOW_SHIFT * R * s, 0, cw, ch);
    curl.globalAlpha = 1;
  }
  curl.drawImage(front.canvas, 0, 0);
  curl.drawImage(back.canvas, 0, 0);

  // Back to the frame.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(g.theta);
  ctx.drawImage(curl.canvas, -Wr / 2, -Hr / 2, Wr, Hr);
  ctx.restore();
}
