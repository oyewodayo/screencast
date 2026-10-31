// utils/stage/stageRenderer.ts
//
// Draws a compiled Stage scene (stageEngine.ts) at any moment, on the GPU (three.js). The same
// renderer paints the editor's preview and every frame of the export, so the two match pixel for
// pixel. An orthographic camera looks at the stage in stage units with y pointing down; one stage
// unit is outputHeight / 1080 device pixels.
//
// What each element becomes:
// - a shape, a text's box (pill, rounded, square) and the scene background: drawn by its signed
//   distance - a rounded rectangle, an ellipse, a ring or arc, a pie slice, or any outline from
//   stageShapes - an exact edge at any size, an outline inside, on or outside it, a pill that grows
//   without redrawing anything, blur that just widens the edge, and one form morphing into another
//   by blending the two distances;
// - text at rest: one raster of its lines (stageRaster.ts) placed on whole pixels - crisp. Text of
//   one colour is drawn white and tinted here, so a colour change (a line dimming) costs nothing;
// - a text mid-morph: its letters from a glyph atlas in ONE instanced draw - each letter's place,
//   atlas cell, colour, opacity and blur ride in per-instance attributes.
// Blur is a Gaussian (sigma as CSS blur()) sampled as a 32-tap disc from a pre-smoothed mip level.
//
// Nothing is created while a scene plays: prepare() lays out and draws every text state the scene
// reaches and builds every atlas first, so a beat starting is only new numbers. Only a text showing
// a live value (a clock) is redrawn as it plays, into one reused canvas.
//
// Colour is left alone end to end: textures and colours go in as the sRGB values they are and come
// out the same (raw shaders, no colour management) - the Stage matches the canvas exactly, and the
// whiteboard's own three.js scenes are untouched. Alpha is premultiplied throughout.
import * as THREE from "three";
import type { CompiledStage, SampledElement } from "./stageEngine";
import { sampleStage, stageGlyphSets, stageTextStates } from "./stageEngine";
import { hasTemplate } from "./stageChannels";
import { parseStageColor } from "./stageColor";
import type { MeasuredText } from "./stageLayout";
import { FORM_INFO, FORM_KIND, MAX_VERTS, ShapeForm, formOutline, insetOutline } from "./stageShapes";
import { canvasStageMeasure, layoutLiveLine, liveCharset, stageFont } from "./stageMeasure";
import { GlyphAtlas, atlasCellKey, glyphAtlas, rasterStageText } from "./stageRaster";
import type { StageColorRun, StageElement, StageTextLook, StageWeightRun } from "./stageTypes";
import { DEFAULT_ENTER, DEFAULT_EXIT, STAGE_HEIGHT } from "./stageTypes";
import { StickerIcon, drawStickerIcon } from "../stickerIcons";
import { stageImage } from "./stageImages";
import { MATH_INK, MathMorphPlan, drawMath, drawMathMorph, mathLayout, planMathMorph } from "./stageMath";
import { GraphState, drawGraph } from "./stageGraph";

// A graph state's identity for redraw decisions (states are replaced, never mutated).
const graphIds = new WeakMap<GraphState, number>();
let nextGraphId = 1;
const graphId = (g: GraphState | undefined) => {
  if (!g) return 0;
  let id = graphIds.get(g);
  if (!id) graphIds.set(g, (id = nextGraphId++));
  return id;
};

const WIPE_KIND: Record<string, number> = { right: 0, left: 1, up: 2, down: 3, centre: 4 };

export interface StageOffset {
  dx: number;
  dy: number;
  dw?: number;
  dh?: number;
  dr?: number;
}

const VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BOX_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 color;
uniform vec4 strokeColor;
uniform float strokePx;
uniform vec2 size;
uniform float margin;
uniform float radius;
uniform float blurPx;
uniform float opacity;
// A linear gradient from color to color2 along gradDir (useGrad = 1), across the box - or, with
// gradType = 1, radial from the centre to the box's edge.
uniform vec4 color2;
uniform vec2 gradDir;
uniform float useGrad;
uniform float gradType;
// The form (stageShapes): A is drawn; mid-morph, B (the form it's leaving) is blended in by
// 1 - shapeMix. Kinds: 0 rounded box, 1 ellipse, 2 polygon (verts, rounded by the radius), 3 ring or
// arc, 4 pie or donut. params: (B's radius px, inner ratio, sweep rad, start rad); A's radius is
// \`radius\`. caps: 1 round ends on an arc.
uniform float formA;
uniform float formB;
uniform float shapeMix;
uniform vec4 paramsA;
uniform vec4 paramsB;
uniform float capsA;
uniform float capsB;
uniform int countA;
uniform int countB;
// The outlines' points: row 0 for A, row 1 for B (a float texture, uploaded only when one changes).
uniform sampler2D vertTex;
// How far the outline reaches outside the edge (px): 0 inside, half its width centred, all of it outside.
uniform float strokeOut;
// A dashed (1) or dotted (2) outline: (style, dash length px, gap px, offset px - its march). Where
// along the edge a point is comes from the outline in row 2 of vertTex (cumulative length in z), or
// for rings and pies from the angle; perim is the edge's length.
uniform vec4 dash;
uniform float perim;
uniform int countD;
// A wipe (on = 1): a soft edge sweeping across the box toward a side - x right, y down, both 0..1
// over the box - showing a share of it (y: 0 nothing, 1 all). Kinds: 0 toward the right, 1 left,
// 2 up, 3 down, 4 out from the centre.
uniform vec4 wipe;
float wipeMask(vec2 q) {
  if (wipe.x < 0.5) return 1.0;
  float v = wipe.z < 0.5 ? q.x : wipe.z < 1.5 ? 1.0 - q.x : wipe.z < 2.5 ? 1.0 - q.y : wipe.z < 3.5 ? q.y : abs(q.x - 0.5) * 2.0;
  float f = 0.08;
  float edge = wipe.y * (1.0 + f);
  return 1.0 - smoothstep(edge - f, edge, v);
}
// A drop shadow (px): offset, Gaussian sigma; straight-alpha colour. Outside the box only, as CSS.
uniform vec4 shadowColor;
uniform vec2 shadowOffset;
uniform float shadowSigma;
// A picture over the fill (useMap = 1): uvScale fits it (cover/contain); blur reads a smaller mip.
uniform sampler2D map;
uniform float useMap;
uniform vec2 uvScale;
uniform float mapLod;
// The dot reveal (dotT < 1): cells dotCell px square fill with palette dots in random order, take the
// picture's colours, then grow and merge into it.
uniform float dotT;
uniform float dotCell;
uniform vec3 palette[4];
in vec2 vUv;
out vec4 outColor;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec4 picture(vec2 p, float lod) {
  vec2 uv = vec2(p.x / size.x * uvScale.x + 0.5, 0.5 - p.y / size.y * uvScale.y);
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  vec4 t = textureLod(map, uv, lod);
  return vec4(t.rgb, t.a * inside.x * inside.y);
}
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdEllipse(vec2 p, vec2 ab) {
  ab = max(ab, vec2(0.5));
  float k0 = length(p / ab);
  float k1 = length(p / (ab * ab));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(ab.x, ab.y);
}
// Exact distance to a polygon (Inigo Quilez), negative inside.
vec2 vert(int i, int side) {
  return texelFetch(vertTex, ivec2(i, side), 0).xy;
}
float sdPoly(vec2 p, int side) {
  int n = side == 0 ? countA : countB;
  vec2 v0 = vert(0, side);
  float d = dot(p - v0, p - v0);
  float s = 1.0;
  for (int i = 0; i < ${MAX_VERTS}; i++) {
    if (i >= n) break;
    int j = i == 0 ? n - 1 : i - 1;
    vec2 vi = vert(i, side);
    vec2 vj = vert(j, side);
    vec2 e = vj - vi;
    vec2 w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
// An infinite wedge about +y with half-aperture (sin, cos) = sc.
float sdWedge(vec2 p, vec2 sc) {
  p.x = abs(p.x);
  float m = length(p - sc * max(dot(p, sc), 0.0));
  return m * sign(sc.y * p.x - sc.x * p.y);
}
float shapeDist(vec2 p, int side) {
  float form = side == 0 ? formA : formB;
  vec4 prm = side == 0 ? paramsA : paramsB;
  float rad = side == 0 ? radius : prm.x;
  vec2 hs = size * 0.5;
  if (form < 0.5) return sdRoundBox(p, hs, min(rad, min(hs.x, hs.y)));
  if (form < 1.5) return sdEllipse(p, hs);
  if (form < 2.5) return sdPoly(p, side) - rad;
  // Rings and pies are worked out where the box is a circle of radius R.
  float R = max(min(hs.x, hs.y), 0.5);
  vec2 q = p * vec2(R / max(hs.x, 0.5), R / max(hs.y, 0.5));
  float sweep = clamp(prm.z, 0.0, 6.2831853);
  float mid = prm.w + sweep * 0.5;
  vec2 dir = vec2(sin(mid), -cos(mid));
  vec2 l = vec2(dot(q, vec2(-dir.y, dir.x)), dot(q, dir));
  vec2 sc = vec2(sin(sweep * 0.5), cos(sweep * 0.5));
  float inner = clamp(prm.y, 0.0, 0.995);
  bool whole = sweep > 6.2825;
  if (form < 3.5) {
    float rb = R * (1.0 - inner) * 0.5;
    float ra = R - rb;
    float dRing = abs(length(q) - ra) - rb;
    if (whole) return dRing;
    if (sweep < 1e-4) return 1e6;
    float caps = side == 0 ? capsA : capsB;
    if (caps > 0.5) {
      vec2 a = vec2(abs(l.x), l.y);
      return ((sc.y * a.x > sc.x * a.y) ? length(a - sc * ra) : abs(length(a) - ra)) - rb;
    }
    return max(dRing, sdWedge(l, sc));
  }
  float d = length(q) - R;
  if (!whole) d = sweep < 1e-4 ? 1e6 : max(d, sdWedge(l, sc));
  if (inner > 0.0) d = max(d, R * inner - length(q));
  return d;
}
float dist(vec2 p) {
  return shapeMix >= 0.999 ? shapeDist(p, 0) : mix(shapeDist(p, 1), shapeDist(p, 0), shapeMix);
}
// How far along the edge (px) the point nearest p is.
float edgeParam(vec2 p) {
  if (countD == 0) {
    // Rings and pies: by angle, clockwise from the top, round the box's circle.
    float R = max(min(size.x, size.y) * 0.5, 0.5);
    vec2 q = p * vec2(R / max(size.x * 0.5, 0.5), R / max(size.y * 0.5, 0.5));
    float a = atan(q.x, -q.y);
    if (a < 0.0) a += 6.2831853;
    return a / 6.2831853 * perim;
  }
  float best = 1e20;
  float at = 0.0;
  for (int i = 0; i < ${MAX_VERTS}; i++) {
    if (i >= countD) break;
    int j = i + 1 >= countD ? 0 : i + 1;
    vec4 vi = texelFetch(vertTex, ivec2(i, 2), 0);
    vec2 vj = texelFetch(vertTex, ivec2(j, 2), 0).xy;
    vec2 e = vj - vi.xy;
    vec2 w = p - vi.xy;
    float h = clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    vec2 b = w - e * h;
    float dd = dot(b, b);
    if (dd < best) {
      best = dd;
      at = vi.z + h * length(e);
    }
  }
  return at;
}
// The share of the outline shown at p: dashes along the edge, or round dots on its centre line
// (cd: distance from the outline's centre line). The spacing is evened out so the pattern closes
// seamlessly round the shape.
float dashMask(vec2 p, float cd) {
  float period = max(1.0, dash.y + dash.z);
  float n = max(1.0, floor(perim / period + 0.5));
  float per = perim / n;
  float s = mod(edgeParam(p) + dash.w, per);
  if (dash.x < 1.5) {
    float len = dash.y * per / period;
    return clamp(min(s + 0.5, len - s + 0.5), 0.0, 1.0);
  }
  float r = strokePx * 0.5;
  return clamp(r - length(vec2(s - per * 0.5, cd)) + 0.5, 0.0, 1.0);
}
// Coverage of the inside of distance d: a one-pixel antialiased edge, widened by blur (a
// Gaussian's edge is about 2.5 sigma across).
float cover(float d, float w) {
  float a = clamp(0.5 - d / (2.0 * w), 0.0, 1.0);
  return a * a * (3.0 - 2.0 * a);
}
void main() {
  vec2 p = vUv * (size + 2.0 * margin) - margin - size * 0.5;
  float d = dist(p);
  float w = max(0.75, blurPx * 1.25);
  float outer = cover(d - strokeOut, w);
  // The fill inside the outline; the outline (inside, on or outside the edge) over it.
  float inner = strokePx > 0.0 ? cover(d - strokeOut + strokePx, w) : outer;
  vec4 c = color;
  if (useGrad > 0.5) {
    float g;
    if (gradType > 0.5) g = length(p / max(size * 0.5, vec2(1.0)));
    else {
      // 0 at the start corner side, 1 at the far side, for any direction.
      float span = abs(gradDir.x) * size.x + abs(gradDir.y) * size.y;
      g = dot(p, gradDir) / max(span, 1.0) + 0.5;
    }
    c = mix(color, color2, clamp(g, 0.0, 1.0));
  }
  vec4 fill = vec4(c.rgb, 1.0) * c.a;
  float merged = 1.0;
  if (useMap > 0.5) {
    vec4 t = picture(p, mapLod);
    fill = vec4(t.rgb, 1.0) * t.a + fill * (1.0 - t.a);
    if (dotT < 0.999) {
      vec2 q = p + size * 0.5;
      vec2 cell = floor(q / dotCell);
      vec2 centre = (cell + 0.5) * dotCell - size * 0.5;
      float r = hash12(cell);
      float pick = hash12(cell + 17.31);
      // Arrive (0-0.5), each cell at its own moment, popping in; take on the picture (0.4-0.75);
      // grow and merge into it (0.72-1).
      float pop = clamp((dotT / 0.5 - r * 0.92) / 0.08, 0.0, 1.0);
      float tint = clamp((dotT - 0.4 - r * 0.2) / 0.15, 0.0, 1.0);
      merged = smoothstep(0.72, 1.0, dotT);
      vec3 hue = pick < 0.25 ? palette[0] : pick < 0.5 ? palette[1] : pick < 0.75 ? palette[2] : palette[3];
      vec4 under = picture(centre, log2(max(1.0, dotCell)));
      vec3 dotRgb = mix(hue, under.rgb, tint);
      float dotA = mix(1.0, under.a, tint);
      float radius = dotCell * (0.34 * pop + 0.5 * merged);
      float cov = clamp(0.5 - (length(p - centre) - radius), 0.0, 1.0) * step(0.001, pop);
      vec4 dotted = vec4(dotRgb, 1.0) * dotA * cov;
      fill = mix(dotted, fill, merged * merged);
    }
  }
  vec4 ring = vec4(strokeColor.rgb, 1.0) * strokeColor.a * (outer - inner);
  vec4 body;
  if (dash.x > 0.5 && strokePx > 0.0) {
    // Broken outline: the fill runs to the edge under it, showing through the gaps.
    float cd = d - strokeOut + strokePx * 0.5;
    float m = dashMask(p, cd);
    ring = vec4(strokeColor.rgb, 1.0) * strokeColor.a * (dash.x < 1.5 ? (outer - inner) * m : m);
    fill *= cover(d, w);
    body = ring * merged + fill * (1.0 - ring.a * merged);
  } else {
    fill *= inner;
    body = fill + ring * merged;
  }
  // A box thinner than a pixel covers only that much of one - an empty bar draws nothing.
  float thin = clamp(min(size.x, size.y), 0.0, 1.0);
  if (shadowColor.a > 0.0) {
    // The Gaussian's edge through the normal CDF (logistic approximation), from the distance to
    // the offset box - exact along the sides, close at the corners.
    float ds = dist(p - shadowOffset) - strokeOut;
    float sh = 1.0 / (1.0 + exp(1.702 * ds / max(shadowSigma, 0.5)));
    body += vec4(shadowColor.rgb, 1.0) * shadowColor.a * sh * (1.0 - outer) * merged;
  }
  outColor = body * opacity * thin * wipeMask((p + size * 0.5) / max(size, vec2(1.0)));
}`;

// The Gaussian disc both texture shaders blur with: 32 taps over 3 sigma, from the mip level whose
// texels are about as far apart as the taps, so a wide blur stays smooth. Reads outside `rect`
// (an atlas cell) count as empty.
const BLUR_GLSL = /* glsl */ `
vec4 cellSample(sampler2D map, vec2 uv, vec4 rect, float lod) {
  vec2 inside = step(rect.xy, uv) * step(uv, rect.zw);
  return textureLod(map, uv, lod) * inside.x * inside.y;
}
vec4 blurred(sampler2D map, vec2 uv, vec4 rect, vec2 texSize, float sigma) {
  if (sigma < 0.35) return cellSample(map, uv, rect, 0.0);
  float lod = max(0.0, log2(sigma) - 0.5);
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int i = 0; i < 32; i++) {
    float r = sqrt((float(i) + 0.5) / 32.0);
    float a = float(i) * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * r * sigma * 3.0 / texSize;
    float w = exp(-r * r * 4.5);
    acc += cellSample(map, uv + o, rect, lod) * w;
    total += w;
  }
  return acc / total;
}`;

// A whole-text raster (premultiplied), tinted when it was drawn white.
const RASTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec2 texSize;
uniform vec4 tint;
uniform float useTint;
uniform float opacity;
uniform float blurPx;
in vec2 vUv;
out vec4 outColor;
${BLUR_GLSL}
// A wipe (on = 1): a soft edge sweeping across the box toward a side - x right, y down, both 0..1
// over the box - showing a share of it (y: 0 nothing, 1 all). Kinds: 0 toward the right, 1 left,
// 2 up, 3 down, 4 out from the centre.
uniform vec4 wipe;
float wipeMask(vec2 q) {
  if (wipe.x < 0.5) return 1.0;
  float v = wipe.z < 0.5 ? q.x : wipe.z < 1.5 ? 1.0 - q.x : wipe.z < 2.5 ? 1.0 - q.y : wipe.z < 3.5 ? q.y : abs(q.x - 0.5) * 2.0;
  float f = 0.08;
  float edge = wipe.y * (1.0 + f);
  return 1.0 - smoothstep(edge - f, edge, v);
}
void main() {
  vec4 c = blurred(map, vUv, vec4(0.0, 0.0, 1.0, 1.0), texSize, blurPx);
  if (useTint > 0.5) c = vec4(tint.rgb * c.a, c.a) * tint.a;
  outColor = c * opacity * wipeMask(vUv);
}`;

// Letters of a morphing text, one instance each: iRect = its quad in the element's box (stage
// units), iUv = its atlas cell, iTint = straight rgba, iParams = (opacity, blur sigma in px).
const GLYPH_VERTEX = /* glsl */ `
in vec4 iRect;
in vec4 iUv;
in vec4 iTint;
in vec2 iParams;
out vec2 vUv;
out vec4 vCell;
out vec4 vTint;
out vec2 vParams;
void main() {
  vec2 q = position.xy + 0.5;
  vUv = mix(iUv.xy, iUv.zw, q);
  vCell = iUv;
  vTint = iTint;
  vParams = iParams;
  vec2 local = iRect.xy + q * iRect.zw;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 0.0, 1.0);
}`;

const GLYPH_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec2 texSize;
uniform float opacity;
in vec2 vUv;
in vec4 vCell;
in vec4 vTint;
in vec2 vParams;
out vec4 outColor;
${BLUR_GLSL}
void main() {
  float a = blurred(map, vUv, vCell, texSize, vParams.y).a;
  outColor = vec4(vTint.rgb, 1.0) * (a * vTint.a * vParams.x * opacity);
}`;

// A connector: a line `lenPx` long along the quad's x (vUv.x over the line grown by `margin` px
// each end), `thick` px across - solid with round caps, round dots, or round-ended dashes, `period`
// px apart and moved along by `flow` px. Only the first `drawn` of it shows (it draws itself on).
const LINE_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 color;
uniform float opacity;
uniform float lenPx;
uniform float thick;
uniform float margin;
uniform float drawn;
uniform float lineStyle;
uniform float period;
uniform float flow;
// Dots: every rhythm-th dot full size, the ones between small (0 = all full).
uniform float rhythm;
in vec2 vUv;
out vec4 outColor;
void main() {
  float u = vUv.x * (lenPx + 2.0 * margin) - margin;
  float v = (vUv.y - 0.5) * (thick + 2.0 * margin);
  float r = thick * 0.5;
  float end = lenPx * drawn;
  // Everything stays inside [0, end], round ends included: a dot nearing either end shrinks
  // away (flowing dots arrive and leave whole, never sliced), a dash is cut back to it with
  // round caps.
  float d;
  if (lineStyle < 0.5) {
    float cu = clamp(u, min(r, end * 0.5), max(end - r, end * 0.5));
    float rr = min(r, end * 0.5);
    d = length(vec2(u - cu, v)) - rr;
  } else if (lineStyle < 1.5) {
    float pu = mod(u - flow, period) - period * 0.5;
    float c = u - pu;
    float big = rhythm > 0.5 ? (mod(floor((u - flow) / period), rhythm) < 0.5 ? 1.0 : 0.4) : 1.0;
    float rr = r * big * clamp(min(c, end - c) / r, 0.0, 1.0);
    d = rr > 0.0 ? length(vec2(pu, v)) - rr : 1e4;
  } else {
    float pu = mod(u - flow, period);
    float a = max(u - pu + r, r);
    float b = min(u - pu + max(r, period * 0.55 - r), end - r);
    d = b >= a ? length(vec2(u - clamp(u, a, b), v)) - r : 1e4;
  }
  float a = clamp(0.5 - d, 0.0, 1.0) * color.a * opacity;
  outColor = vec4(color.rgb * a, a);
}`;

const premultipliedBlend = {
  // The y-down camera mirrors the projection, which turns every quad's winding round - draw both sides.
  side: THREE.DoubleSide,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
} as const;

// Three rows of outline points (RG = x, y in px; B = length along the outline so far), read exactly
// by texelFetch: A's outline, B's, and the edge a dashed outline is measured along.
function vertTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(MAX_VERTS * 3 * 4), MAX_VERTS, 3, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const boxMaterial = () =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: BOX_FRAGMENT,
    uniforms: {
      color: { value: new THREE.Vector4() },
      strokeColor: { value: new THREE.Vector4() },
      strokePx: { value: 0 },
      size: { value: new THREE.Vector2() },
      margin: { value: 0 },
      radius: { value: 0 },
      blurPx: { value: 0 },
      opacity: { value: 1 },
      color2: { value: new THREE.Vector4() },
      gradDir: { value: new THREE.Vector2(0, 1) },
      useGrad: { value: 0 },
      gradType: { value: 0 },
      formA: { value: 0 },
      formB: { value: 0 },
      shapeMix: { value: 1 },
      paramsA: { value: new THREE.Vector4(0, 0, Math.PI * 2, 0) },
      paramsB: { value: new THREE.Vector4(0, 0, Math.PI * 2, 0) },
      capsA: { value: 1 },
      capsB: { value: 1 },
      countA: { value: 0 },
      countB: { value: 0 },
      vertTex: { value: vertTexture() },
      strokeOut: { value: 0 },
      dash: { value: new THREE.Vector4() },
      perim: { value: 1 },
      countD: { value: 0 },
      wipe: { value: new THREE.Vector4() },
      shadowColor: { value: new THREE.Vector4() },
      shadowOffset: { value: new THREE.Vector2() },
      shadowSigma: { value: 1 },
      map: { value: null },
      useMap: { value: 0 },
      uvScale: { value: new THREE.Vector2(1, 1) },
      mapLod: { value: 0 },
      dotT: { value: 1 },
      dotCell: { value: 16 },
      palette: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
    },
    ...premultipliedBlend,
  });

const rasterMaterial = () =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: RASTER_FRAGMENT,
    uniforms: { map: { value: null }, texSize: { value: new THREE.Vector2(1, 1) }, tint: { value: new THREE.Vector4(1, 1, 1, 1) }, useTint: { value: 0 }, opacity: { value: 1 }, blurPx: { value: 0 }, wipe: { value: new THREE.Vector4() } },
    ...premultipliedBlend,
  });

const lineMaterial = () =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX,
    fragmentShader: LINE_FRAGMENT,
    uniforms: {
      color: { value: new THREE.Vector4() },
      opacity: { value: 1 },
      lenPx: { value: 1 },
      thick: { value: 1 },
      margin: { value: 2 },
      drawn: { value: 1 },
      lineStyle: { value: 0 },
      period: { value: 8 },
      flow: { value: 0 },
      rhythm: { value: 0 },
    },
    ...premultipliedBlend,
  });

const glyphMaterial = () =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GLYPH_VERTEX,
    fragmentShader: GLYPH_FRAGMENT,
    uniforms: { map: { value: null }, texSize: { value: new THREE.Vector2(1, 1) }, opacity: { value: 1 } },
    ...premultipliedBlend,
  });

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.flipY = false;
  t.premultiplyAlpha = true;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// A colour as straight rgba 0..1 - the engine's numbers when it gave them, else parsed.
function setRgba(out: THREE.Vector4, rgba: [number, number, number, number] | undefined, css: string | undefined): THREE.Vector4 {
  if (rgba) return out.set(rgba[0], rgba[1], rgba[2], rgba[3]);
  const c = parseStageColor(css) ?? [0, 0, 0, 0];
  return out.set(c[0] / 255, c[1] / 255, c[2] / 255, c[3]);
}

// The reveal's dots before they take on the picture - the reference film's warm pinks and violets.
const DOT_PALETTE = ["#e8559d", "#f29a3f", "#a65ee6", "#d64bc4"];

const lookOf = (e: StageElement): StageTextLook => e.textLook ?? { fontSize: 40 };
// The most blur an element itself gets (entering, leaving, its own) - room round its raster.
const elementBlurMost = (e: StageElement) => Math.max(DEFAULT_ENTER.blur, DEFAULT_EXIT.blur, e.enter?.blur ?? 0, e.exit?.blur ?? 0, e.props.blur);
// A raster's empty margin: room for three sigma of blur, plus a pixel.
const rasterMargin = (e: StageElement) => Math.ceil(elementBlurMost(e) * 3 + 2);
// An atlas cell's margin: the element's blur plus a morphing letter's own.
const atlasMargin = (e: StageElement) => Math.ceil((elementBlurMost(e) + lookOf(e).fontSize * 0.35) * 3 + 2);

type Mesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

interface Raster {
  layout: MeasuredText;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  tinted: boolean;
}

// Per-letter data: place (4), atlas cell (4), colour (4), opacity + blur (2).
const GLYPH_ATTRS = [
  ["iRect", 4],
  ["iUv", 4],
  ["iTint", 4],
  ["iParams", 2],
] as const;
// Buffer sets a letter batch rotates through. Writing into a buffer the GPU may still be reading
// from the frame before makes the driver wait for it (on Direct3D, under ANGLE, a stall of tens of
// milliseconds at 4K); three sets means the one written is always idle.
const GLYPH_BUFFERING = 3;

interface GlyphBuffers {
  geometry: THREE.InstancedBufferGeometry;
  attrs: THREE.InstancedBufferAttribute[];
  // The data version each attribute holds.
  versions: number[];
}

interface GlyphBatch {
  mesh: Mesh;
  capacity: number;
  sets: GlyphBuffers[];
  turn: number;
  // This frame's data, and its version per attribute (bumped only when something actually changed -
  // a clock's letters mostly stay put, and unchanged data isn't uploaded at all).
  staging: Float32Array[];
  versions: number[];
}

interface ElementGfx {
  // A connector's line.
  line?: Mesh;
  // An icon, drawn white once for its size (and tinted).
  icon?: { key: string; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture };
  // An equation, drawn at this resolution (and every frame while it rewrites itself).
  math?: { key: string; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; mesh: Mesh; shape: string; plan?: { from: string; to: string; plan: MathMorphPlan } };
  // A graph, drawn at this resolution - every frame while it animates, else only when it changes.
  graph?: { key: string; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture; mesh: Mesh; shape: string };
  box: Mesh | null;
  text: Mesh | null;
  // Every prepared text state, by key; plus one canvas a live text is redrawn into.
  rasters: Map<string, Raster>;
  live: Raster | null;
  glyphs: GlyphBatch | null;
}

interface SharedAtlas {
  atlas: GlyphAtlas;
  texture: THREE.CanvasTexture;
}

export class StageRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -10, 10);
  private readonly quad = new THREE.PlaneGeometry(1, 1);
  private readonly background: Mesh;
  private readonly gfx = new Map<string, ElementGfx>();
  private readonly atlases = new Map<string, SharedAtlas>();
  private readonly layoutCache = new Map<string, MeasuredText>();
  // The scenes whose resources are kept (prepareAll) - the one playing and those about to.
  private prepared: CompiledStage[] = [];
  // Elements shifted while being dragged in the editor (setOffset) - moved at draw time, with
  // everything inside them, so a drag never waits on the scene recompiling. A resize or turn by a
  // handle (dw, dh, dr) changes the element itself only.
  private readonly offsets = new Map<string, StageOffset>();
  // Work done since the counters were last read - for tests and profiling.
  readonly stats = { rasters: 0, atlases: 0 };
  private pxWidth = 1;
  private pxHeight = 1;
  private readonly m4 = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();

  constructor(canvas: HTMLCanvasElement, pxWidth: number, pxHeight: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.background = this.mesh(boxMaterial());
    this.setSize(pxWidth, pxHeight);
    // Compile every shader program now rather than on the first frame that needs it (a visible
    // hitch of up to half a second otherwise). compile() only visits visible objects, and a program
    // is freed with the last material using it - so these stay, hidden, for the renderer's life.
    this.warm = [this.background, this.mesh(rasterMaterial()), this.glyphBatch(1).mesh, this.mesh(lineMaterial())];
    for (const m of this.warm) m.visible = true;
    this.renderer.compile(this.scene, this.camera);
    for (const m of this.warm) m.visible = false;
  }

  private readonly warm: Mesh[];

  // Device pixels per stage unit.
  get scale(): number {
    return this.pxHeight / STAGE_HEIGHT;
  }

  setSize(pxWidth: number, pxHeight: number): void {
    const w = Math.max(1, Math.round(pxWidth));
    const h = Math.max(1, Math.round(pxHeight));
    if (w === this.pxWidth && h === this.pxHeight) return;
    this.pxWidth = w;
    this.pxHeight = h;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    // Text is drawn for a scale - a new size needs it drawn again.
    this.dropText();
    this.prepared = [];
  }

  private mesh(material: THREE.ShaderMaterial, geometry: THREE.BufferGeometry = this.quad): Mesh {
    const m = new THREE.Mesh(geometry, material);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    m.visible = false;
    this.scene.add(m);
    return m;
  }

  private glyphBatch(capacity: number, prev?: GlyphBatch): GlyphBatch {
    const sets: GlyphBuffers[] = Array.from({ length: GLYPH_BUFFERING }, () => {
      const geometry = new THREE.InstancedBufferGeometry();
      // Copies of the quad's corners, never the quad's own attributes: disposing a geometry frees the
      // GPU buffers of every attribute on it, and a shared one would take the quad every other mesh
      // draws with down too (text vanished in the scene after a morph until this was found).
      geometry.index = this.quad.index!.clone();
      geometry.setAttribute("position", this.quad.getAttribute("position").clone());
      geometry.setAttribute("uv", this.quad.getAttribute("uv").clone());
      const attrs = GLYPH_ATTRS.map(([name, n]) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, a);
        return a;
      });
      geometry.instanceCount = 0;
      return { geometry, attrs, versions: GLYPH_ATTRS.map(() => -1) };
    });
    const mesh = prev?.mesh ?? this.mesh(glyphMaterial(), sets[0].geometry);
    if (prev) for (const set of prev.sets) set.geometry.dispose();
    mesh.geometry = sets[0].geometry;
    return { mesh, capacity, sets, turn: 0, staging: GLYPH_ATTRS.map(([, n]) => new Float32Array(capacity * n)), versions: GLYPH_ATTRS.map(() => 0) };
  }

  // Sends this frame's letters (already in `staging`) to the next idle buffer set, uploading only
  // what changed since that set was last used.
  private commitGlyphs(b: GlyphBatch, count: number): void {
    b.turn = (b.turn + 1) % b.sets.length;
    const set = b.sets[b.turn];
    set.attrs.forEach((a, i) => {
      if (set.versions[i] === b.versions[i]) return;
      const n = a.itemSize;
      (a.array as Float32Array).set(b.staging[i].subarray(0, count * n));
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * n);
      a.needsUpdate = true;
      set.versions[i] = b.versions[i];
    });
    set.geometry.instanceCount = count;
    b.mesh.geometry = set.geometry;
  }

  private gfxFor(id: string): ElementGfx {
    let g = this.gfx.get(id);
    if (!g) {
      g = { box: null, text: null, rasters: new Map(), live: null, glyphs: null };
      this.gfx.set(id, g);
    }
    return g;
  }

  private layoutFor(element: StageElement, text: string, wrapWidth: number, weights?: StageWeightRun[]): MeasuredText {
    // The look is part of it: a new size, font or spacing lays the same words out afresh.
    const key = `${element.id}\u0000${JSON.stringify(element.textLook ?? null)}\u0000${wrapWidth}\u0000${weights?.length ? JSON.stringify(weights) : ""}\u0000${text}`;
    let m = this.layoutCache.get(key);
    if (!m) {
      if (this.layoutCache.size > 4000) this.layoutCache.clear();
      m = canvasStageMeasure.text(element, text, wrapWidth, weights);
      this.layoutCache.set(key, m);
    }
    return m;
  }

  private atlasKey(element: StageElement): string {
    const look = lookOf(element);
    return `${stageFont(look, look.fontSize * this.scale)}\u0000${look.lineHeight ?? ""}\u0000${atlasMargin(element)}`;
  }

  // One colour is tinted at draw time, so it isn't part of the key; with runs the base colour is drawn in.
  // The look is part of the key, so resizing or restyling a text redraws it.
  private rasterKey = (element: StageElement, text: string, runs: StageColorRun[] | undefined, weights: StageWeightRun[] | undefined, wrapWidth: number, color: string | undefined) =>
    `${JSON.stringify(element.textLook ?? null)}\u0000${text}\u0000${wrapWidth}\u0000${JSON.stringify(runs ?? null)}\u0000${JSON.stringify(weights ?? null)}\u0000${runs?.length ? color : ""}`;

  private drawRaster(element: StageElement, text: string, runs: StageColorRun[] | undefined, weights: StageWeightRun[] | undefined, wrapWidth: number, color: string, into?: Raster): Raster {
    this.stats.rasters++;
    const layout = this.layoutFor(element, text, wrapWidth, weights);
    const tinted = !runs || runs.length === 0;
    const before = into ? [into.canvas.width, into.canvas.height] : null;
    const r = rasterStageText(element, layout, tinted ? "#ffffff" : color, runs, this.scale, rasterMargin(element), into?.canvas);
    if (into && before && before[0] === r.canvas.width && before[1] === r.canvas.height) {
      into.texture.needsUpdate = true;
      into.layout = layout;
      into.tinted = tinted;
      return into;
    }
    // A new size needs a new texture (GPU storage is fixed once made).
    into?.texture.dispose();
    const texture = canvasTexture(r.canvas);
    this.renderer.initTexture(texture);
    return { layout, canvas: r.canvas, texture, tinted };
  }

  // Lays out and draws every text state the scene reaches, and builds its atlases - before it plays.
  prepare(compiled: CompiledStage): void {
    this.prepareAll([compiled]);
  }

  // The same for several scenes at once (the one playing and the ones about to): resources are kept
  // for all of them and let go for everything else - GPU memory is shared with the whole machine on
  // most laptops, and a 4K text texture is tens of megabytes. Unchanged text keeps its texture
  // through an edit; only what changed is drawn again.
  prepareAll(list: CompiledStage[]): void {
    if (list.length === this.prepared.length && list.every((c, i) => c === this.prepared[i])) return;
    this.prepared = list;
    const byId = new Map(list.flatMap((c) => c.scene.elements.map((e) => [e.id, e] as const)));
    for (const [id, g] of this.gfx) {
      if (byId.has(id)) continue;
      this.disposeGfx(g);
      this.gfx.delete(id);
    }
    const wanted = new Map<string, { element: StageElement; graphemes: Set<string> }>();
    const glyphSetsOf = new Map<CompiledStage, Map<string, { graphemes: Set<string>; count: number }>>();
    for (const compiled of list) glyphSetsOf.set(compiled, this.prepareOne(compiled, byId, wanted));
    for (const [key, { element, graphemes }] of wanted) this.atlasFor(key, element, graphemes);
    for (const [key, a] of this.atlases) {
      if (wanted.has(key)) continue;
      a.texture.dispose();
      this.atlases.delete(key);
    }
    for (const compiled of list) {
      this.warmUp(compiled, glyphSetsOf.get(compiled)!);
      // And one real frame, so the drawing code itself is warm before the first one anyone sees.
      this.draw(compiled, 0);
    }
    this.renderer.clear();
  }

  // One scene's text states drawn and its atlas cells gathered into `wanted`; returns its glyph sets.
  private prepareOne(compiled: CompiledStage, byId: Map<string, StageElement>, wanted: Map<string, { element: StageElement; graphemes: Set<string> }>) {
    for (const [id, states] of stageTextStates(compiled)) {
      const element = byId.get(id);
      if (!element) continue;
      const g = this.gfxFor(id);
      const keep = new Set<string>();
      for (const st of states) {
        const wrap = st.wrapWidth ?? element.props.width;
        const key = this.rasterKey(element, st.text, st.colorRuns, st.weightRuns, wrap, st.color);
        keep.add(key);
        if (!g.rasters.has(key)) g.rasters.set(key, this.drawRaster(element, st.text, st.colorRuns, st.weightRuns, wrap, st.color ?? "#000000"));
      }
      for (const [key, r] of g.rasters) {
        if (keep.has(key)) continue;
        r.texture.dispose();
        g.rasters.delete(key);
      }
    }
    const glyphSets = stageGlyphSets(compiled);
    // A text showing live values is drawn from the atlas too - every character its values can show.
    for (const e of compiled.scene.elements) {
      if (e.kind !== "text") continue;
      const templates = [e.props.text, ...compiled.scene.beats.map((b) => b.changes[e.id]?.text)].filter((t): t is string => !!t && hasTemplate(t, compiled.channels));
      if (!templates.length) continue;
      const entry = glyphSets.get(e.id) ?? { graphemes: new Set<string>(), count: 0 };
      const weights = [e.props.weightRuns, ...compiled.scene.beats.map((b) => b.changes[e.id]?.weightRuns)].flatMap((runs) => runs ?? []).map((r) => r.weight);
      for (const t of templates) for (const ch of liveCharset(t)) for (const w of [undefined, ...weights]) entry.graphemes.add(atlasCellKey(ch, w));
      // A live value's letters: its typed words plus room for any value a format can produce.
      entry.count = Math.max(entry.count, ...templates.map((t) => t.length + 24));
      glyphSets.set(e.id, entry);
    }
    for (const [id, { graphemes: set }] of glyphSets) {
      const element = byId.get(id);
      if (!element) continue;
      const key = this.atlasKey(element);
      const entry = wanted.get(key) ?? { element, graphemes: new Set<string>() };
      for (const gph of set) entry.graphemes.add(gph);
      wanted.set(key, entry);
    }
    return glyphSets;
  }

  // Shifts element `id` (and everything inside it) by (dx, dy) stage units when drawn, and resizes or
  // turns it by (dw, dh, dr); null clears it.
  setOffset(id: string, offset: StageOffset | null): void {
    if (offset) this.offsets.set(id, offset);
    else this.offsets.delete(id);
  }

  // Nothing on the canvas.
  clear(): void {
    this.renderer.clear();
  }

  // Every mesh the scene will draw made now, its textures and buffers bound, and drawn once at zero
  // opacity - so the GPU driver's lazy setup (texture residency, buffer allocation, binding a
  // program to a new material) happens while the scene loads, never on a frame mid-playback.
  private warmUp(compiled: CompiledStage, glyphSets: Map<string, { graphemes: Set<string>; count: number }>): void {
    const shown: Mesh[] = [];
    const show = (m: Mesh) => {
      m.visible = true;
      shown.push(m);
    };
    for (const e of compiled.scene.elements) {
      if (e.kind === "stack") continue;
      const g = this.gfxFor(e.id);
      if (e.kind === "shape" || e.kind === "image" || e.textLook?.backgroundColor || e.icon?.frame) {
        g.box ??= this.mesh(boxMaterial());
        g.box.material.uniforms.opacity.value = 0;
        const picture = e.kind === "image" ? this.pictureTexture(e.image?.src) : null;
        g.box.material.uniforms.map.value = picture?.texture ?? null;
        g.box.material.uniforms.useMap.value = picture ? 1 : 0;
        show(g.box);
      }
      if (e.kind === "icon") {
        this.iconRaster(e, g);
        g.text ??= this.mesh(rasterMaterial());
        g.text.material.uniforms.map.value = g.icon!.texture;
        g.text.material.uniforms.opacity.value = 0;
        show(g.text);
      }
      if (e.kind === "connector") {
        g.line ??= this.mesh(lineMaterial());
        g.line.material.uniforms.opacity.value = 0;
        show(g.line);
      }
      if (e.kind !== "text") continue;
      const first = g.rasters.values().next().value as Raster | undefined;
      if (first) {
        g.text ??= this.mesh(rasterMaterial());
        g.text.material.uniforms.map.value = first.texture;
        g.text.material.uniforms.opacity.value = 0;
        show(g.text);
      }
      const set = glyphSets.get(e.id);
      if (set) {
        if (!g.glyphs || g.glyphs.capacity < set.count) g.glyphs = this.glyphBatch(Math.max(16, set.count), g.glyphs ?? undefined);
        const shared = this.atlases.get(this.atlasKey(e));
        g.glyphs.mesh.material.uniforms.map.value = shared?.texture ?? null;
        g.glyphs.mesh.material.uniforms.opacity.value = 0;
        // Every buffer set allocated on the GPU and drawn once, now.
        for (let i = 0; i < g.glyphs.sets.length; i++) {
          g.glyphs.versions = g.glyphs.versions.map((v) => v + 1);
          this.commitGlyphs(g.glyphs, 1);
          g.glyphs.mesh.visible = true;
          this.renderer.render(this.scene, this.camera);
        }
        show(g.glyphs.mesh);
      }
    }
    if (!shown.length) return;
    this.renderer.render(this.scene, this.camera);
    for (const m of shown) m.visible = false;
  }

  private atlasFor(key: string, element: StageElement, graphemes: Iterable<string>): SharedAtlas {
    const prev = this.atlases.get(key);
    const atlas = glyphAtlas(lookOf(element), graphemes, this.scale, atlasMargin(element), prev?.atlas);
    if (prev && prev.atlas === atlas) return prev;
    this.stats.atlases++;
    prev?.texture.dispose();
    const texture = canvasTexture(atlas.canvas);
    this.renderer.initTexture(texture);
    const shared = { atlas, texture };
    this.atlases.set(key, shared);
    return shared;
  }

  // A dashed or dotted outline: its pattern, and the edge it's measured along (row 2) - the outline
  // as drawn (corners rounded), or for rings and pies their circle. Worked out only when it changes.
  private setDash(u: Record<string, THREE.IUniform>, form: ShapeForm, s: SampledElement, element: StageElement, stroke: NonNullable<StageElement["shape"]>["stroke"] | undefined, radiusPx: number, t: number): void {
    const d = stroke?.dash;
    const dash = u.dash.value as THREE.Vector4;
    if (!d || !stroke) {
      dash.set(0, 0, 0, 0);
      return;
    }
    const scale = this.scale;
    const w = s.width * scale;
    const h = s.height * scale;
    // Dots sit a dot apart by default; dashes as given.
    const len = d.style === "dot" ? stroke.width * scale : Math.max(0.5, d.length * scale);
    dash.set(d.style === "dot" ? 2 : 1, len, Math.max(0.5, d.gap * scale), -(d.flow ?? 0) * t * scale);
    const kind = FORM_KIND[form] ?? 0;
    const tex = u.vertTex.value as THREE.DataTexture & { userData: { dashKey?: string; dashCount?: number; dashPerim?: number } };
    const inner = s.inner ?? FORM_INFO[form]?.inner?.default ?? 0;
    const key = `${form}|${w.toFixed(1)}|${h.toFixed(1)}|${s.sides ?? 0}|${inner.toFixed(3)}|${radiusPx.toFixed(1)}`;
    if (tex.userData.dashKey !== key) {
      let pts: [number, number][] = [];
      if (kind === 0) {
        const r = Math.max(0, Math.min(radiusPx, w / 2, h / 2));
        const corner = (cx: number, cy: number, a0: number) => {
          const steps = r > 0.5 ? 8 : 0;
          if (!steps) return void pts.push([cx, cy]);
          for (let i = 0; i <= steps; i++) {
            const a = a0 + (i / steps) * (Math.PI / 2);
            pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
          }
        };
        corner(-w / 2 + r, -h / 2 + r, Math.PI);
        corner(w / 2 - r, -h / 2 + r, -Math.PI / 2);
        corner(w / 2 - r, h / 2 - r, 0);
        corner(-w / 2 + r, h / 2 - r, Math.PI / 2);
      } else if (kind === 1) {
        for (let i = 0; i < MAX_VERTS; i++) {
          const a = -Math.PI / 2 + (i / MAX_VERTS) * Math.PI * 2;
          pts.push([(Math.cos(a) * w) / 2, (Math.sin(a) * h) / 2]);
        }
      } else if (kind === 2) {
        pts = formOutline(form, w, h, s.sides ?? 0, inner, { flipX: element.shape?.flipX, flipY: element.shape?.flipY, tail: element.shape?.tail, round: radiusPx }) ?? [];
      }
      const data = tex.image.data as Float32Array;
      const n = Math.min(MAX_VERTS, pts.length);
      let along = 0;
      for (let i = 0; i < n; i++) {
        const o = (2 * MAX_VERTS + i) * 4;
        data[o] = pts[i][0];
        data[o + 1] = pts[i][1];
        data[o + 2] = along;
        const [nx, ny] = pts[(i + 1) % n];
        along += Math.hypot(nx - pts[i][0], ny - pts[i][1]);
      }
      tex.needsUpdate = true;
      tex.userData.dashKey = key;
      tex.userData.dashCount = n;
      // Rings and pies are measured round their circle.
      tex.userData.dashPerim = n ? along : Math.PI * Math.min(w, h);
    }
    u.countD.value = tex.userData.dashCount ?? 0;
    u.perim.value = Math.max(1, tex.userData.dashPerim ?? 1);
  }

  // A box's form into side A or B of its shader: the GPU kind, and for an outline its points at the
  // box's size in pixels (rounded by insetting), or a ring's/pie's inner ratio, sweep and start.
  private setForm(u: Record<string, THREE.IUniform>, side: "A" | "B", form: ShapeForm, s: SampledElement, element: StageElement, radiusPx: number): void {
    const kind = FORM_KIND[form] ?? 0;
    const scale = this.scale;
    const w = s.width * scale;
    const h = s.height * scale;
    const params = u[`params${side}`].value as THREE.Vector4;
    const inner = s.inner ?? FORM_INFO[form]?.inner?.default ?? 0;
    params.set(radiusPx, inner, (Math.max(0, Math.min(360, s.sweep ?? 360)) * Math.PI) / 180, ((element.shape?.start ?? 0) * Math.PI) / 180);
    u[`caps${side}`].value = (element.shape?.caps ?? "round") === "round" ? 1 : 0;
    u[`form${side}`].value = kind;
    if (side === "A") u.radius.value = kind === 0 ? radiusPx : 0;
    if (kind !== 2) {
      u[`count${side}`].value = 0;
      return;
    }
    // The outline is worked out and uploaded only when something about it changed - a still shape
    // costs nothing per frame.
    const sh = element.shape;
    const key = `${form}|${w.toFixed(2)}|${h.toFixed(2)}|${s.sides ?? 0}|${inner.toFixed(4)}|${radiusPx.toFixed(2)}|${sh?.flipX ? 1 : 0}${sh?.flipY ? 1 : 0}|${sh?.tail ?? ""}`;
    const tex = u.vertTex.value as THREE.DataTexture & { userData: { keys?: string[]; counts?: number[]; radii?: number[] } };
    const row = side === "A" ? 0 : 1;
    const cache = (tex.userData.keys ??= ["", ""]);
    const counts = (tex.userData.counts ??= [0, 0]);
    const radii = (tex.userData.radii ??= [0, 0]);
    if (cache[row] !== key) {
      // A bubble carries its rounding in its points; a heart's many points are softened a touch.
      const baked = form === "bubble";
      if (form === "heart") radiusPx = Math.max(radiusPx, Math.min(w, h) * 0.03);
      const outline = formOutline(form, w, h, s.sides ?? 0, inner, { flipX: sh?.flipX, flipY: sh?.flipY, tail: sh?.tail, round: radiusPx }) ?? [];
      const { pts, r } = baked ? { pts: outline, r: 0 } : insetOutline(outline, Math.min(radiusPx, Math.min(w, h) * 0.5));
      const data = tex.image.data as Float32Array;
      const n = Math.min(MAX_VERTS, pts.length);
      for (let i = 0; i < n; i++) {
        data[(row * MAX_VERTS + i) * 4] = pts[i][0];
        data[(row * MAX_VERTS + i) * 4 + 1] = pts[i][1];
      }
      tex.needsUpdate = true;
      cache[row] = key;
      counts[row] = n;
      radii[row] = r;
    }
    u[`count${side}`].value = counts[row];
    if (side === "A") u.radius.value = radii[row];
    else params.x = radii[row];
  }

  // The element's transform: box-relative stage units -> stage.
  private elementMatrix(s: SampledElement): THREE.Matrix4 {
    const ax = s.anchorX * s.width;
    const ay = s.anchorY * s.height;
    this.m4.makeTranslation(s.x + ax, s.y + ay, s.z || 0);
    if (s.rotateY) this.m4.multiply(this.tmp.makeRotationY((s.rotateY * Math.PI) / 180));
    if (s.rotateX) this.m4.multiply(this.tmp.makeRotationX((s.rotateX * Math.PI) / 180));
    if (s.rotation) this.m4.multiply(this.tmp.makeRotationZ((s.rotation * Math.PI) / 180));
    if (s.scale !== 1) this.m4.multiply(this.tmp.makeScale(s.scale, s.scale, 1));
    return this.m4.multiply(this.tmp.makeTranslation(-ax, -ay, 0));
  }

  // A unit quad at (x, y, w, h) in the element's box.
  private place(mesh: Mesh, s: SampledElement, x: number, y: number, w: number, h: number, order: number): void {
    this.elementMatrix(s).multiply(this.tmp.makeTranslation(x + w / 2, y + h / 2, 0)).multiply(this.tmp.makeScale(w, h, 1));
    mesh.matrix.copy(this.m4);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.renderOrder = order;
    mesh.visible = true;
  }

  // The scene at `t` seconds into it - over what's already on the canvas when `clear` is false (the
  // scenes after the first where two overlap). A scene not prepared yet joins the prepared set,
  // replacing an earlier version of itself.
  render(compiled: CompiledStage, t: number, clear = true): void {
    if (!this.prepared.includes(compiled)) this.prepareAll([...this.prepared.filter((c) => c.scene.id !== compiled.scene.id), compiled]);
    this.renderer.autoClear = clear;
    this.draw(compiled, t);
    this.renderer.autoClear = true;
  }

  private draw(compiled: CompiledStage, t: number): void {
    const scene = compiled.scene;
    const scale = this.scale;
    this.camera.left = 0;
    this.camera.right = scene.width;
    this.camera.top = 0;
    this.camera.bottom = STAGE_HEIGHT;
    this.camera.updateProjectionMatrix();
    // Perspective about the stage's centre: w = 1 - z/D, with z kept out of clipping. Everything at
    // z = 0 and untilted - nearly always - projects exactly as the orthographic camera alone would.
    const pm = this.camera.projectionMatrix.elements;
    pm[2] = pm[6] = pm[10] = pm[14] = 0;
    pm[11] = -1 / Math.max(100, scene.perspective ?? 2000);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    let order = 0;
    if (scene.background.kind === "color") {
      const u = this.background.material.uniforms;
      setRgba(u.color.value, undefined, scene.background.color);
      u.size.value.set(scene.width * scale, STAGE_HEIGHT * scale);
      u.margin.value = 0;
      u.radius.value = 0;
      u.blurPx.value = 0;
      u.strokePx.value = 0;
      u.opacity.value = 1;
      this.background.matrix.makeTranslation(scene.width / 2, STAGE_HEIGHT / 2, 0).multiply(this.tmp.makeScale(scene.width, STAGE_HEIGHT, 1));
      this.background.matrixWorldNeedsUpdate = true;
      this.background.renderOrder = order++;
      this.background.visible = true;
    } else this.background.visible = false;

    const byId = new Map(scene.elements.map((e) => [e.id, e]));
    // Dragged elements' shifts, passed down to everything inside them.
    const shiftOf = (id: string): StageOffset | null => {
      for (let e = byId.get(id); e; e = e.parent ? byId.get(e.parent) : undefined) {
        const o = this.offsets.get(e.id);
        if (o) return o;
      }
      return null;
    };
    const drawn = new Set<string>();
    const samples = sampleStage(compiled, t).map((sampled) => {
      const shift = this.offsets.size ? shiftOf(sampled.id) : null;
      if (!shift) return sampled;
      const own = this.offsets.get(sampled.id) === shift;
      return {
        ...sampled,
        x: sampled.x + shift.dx,
        y: sampled.y + shift.dy,
        ...(own && (shift.dw || shift.dh || shift.dr) ? { width: Math.max(1, sampled.width + (shift.dw ?? 0)), height: Math.max(1, sampled.height + (shift.dh ?? 0)), rotation: sampled.rotation + (shift.dr ?? 0) } : {}),
      };
    });
    // Where every element is now - connectors run between them.
    const boxes = new Map(samples.map((x) => [x.id, x]));
    for (const s of samples) {
      const element = byId.get(s.id);
      if (!element) continue;
      drawn.add(s.id);
      const g = this.gfxFor(s.id);
      const blurPx = s.blur * scale;
      const look = element.textLook;
      const frame = element.kind === "icon" ? element.icon?.frame : undefined;
      // Shapes and pictures share the box's corners, outline, gradient and shadow.
      const boxed = element.kind === "shape" || element.kind === "image";
      const boxColor = element.kind === "shape" ? s.color : element.kind === "image" ? s.color ?? "#0000" : element.kind === "text" ? look?.backgroundColor : frame ? frame.fill ?? "#0000" : undefined;
      if (boxColor) {
        g.box ??= this.mesh(boxMaterial());
        const radius = boxed ? element.shape?.radius ?? 0 : frame ? frame.radius : look?.cornerStyle === "pill" ? s.height / 2 : look?.cornerStyle === "rounded" ? (look.fontSize ?? 40) * 0.3 : 0;
        const shadow = boxed ? element.shape?.shadow : undefined;
        const gradient = boxed ? element.shape?.gradient : undefined;
        const stroke = boxed ? element.shape?.stroke : undefined;
        // An outline on or outside the edge reaches past the box.
        const strokeOut = stroke ? (stroke.align === "outside" ? stroke.width : stroke.align === "center" ? stroke.width / 2 : 0) : 0;
        // Room for the blur, the outline, and for the shadow's offset and three sigma of it.
        const shadowReach = shadow ? Math.max(Math.abs(shadow.x ?? 0), Math.abs(shadow.y ?? 0)) + shadow.blur * 1.5 : 0;
        const marginStage = Math.ceil(blurPx * 3 + 2 + (shadowReach + strokeOut) * scale) / scale;
        const u = g.box.material.uniforms;
        u.strokeOut.value = strokeOut * scale;
        u.useGrad.value = gradient ? 1 : 0;
        u.gradType.value = gradient?.type === "radial" ? 1 : 0;
        // Its form, and mid-morph the form it's leaving.
        const shapeRadius = boxed && s.radius !== undefined ? s.radius : radius;
        this.setForm(u, "A", boxed ? s.form ?? "rect" : "rect", s, element, shapeRadius * scale);
        if (boxed && s.morphShape && s.morph !== undefined && s.morph < 1) {
          this.setForm(u, "B", s.morphShape.form, { ...s, sides: s.morphShape.sides }, element, shapeRadius * scale);
          const m = Math.max(0, Math.min(1, s.morph));
          u.shapeMix.value = m * m * (3 - 2 * m);
        } else u.shapeMix.value = 1;
        if (gradient) {
          setRgba(u.color2.value, undefined, gradient.to);
          const a = ((gradient.angle ?? 180) * Math.PI) / 180;
          // CSS angles: 0deg points up, 90deg right (y down here).
          u.gradDir.value.set(Math.sin(a), -Math.cos(a));
        }
        setRgba(u.shadowColor.value, undefined, shadow?.color);
        if (shadow) {
          u.shadowOffset.value.set((shadow.x ?? 0) * scale, (shadow.y ?? 0) * scale);
          // CSS blur radius is two sigma.
          u.shadowSigma.value = (shadow.blur / 2) * scale;
        }
        setRgba(u.color.value, boxed && s.color ? s.rgba : undefined, boxColor);
        const picture = element.kind === "image" ? this.pictureTexture(element.image?.src) : null;
        u.useMap.value = picture ? 1 : 0;
        if (picture) {
          u.map.value = picture.texture;
          // cover crops the picture's long side to the box; contain shows all of it.
          const boxAspect = s.width / Math.max(1e-6, s.height);
          const picAspect = picture.width / Math.max(1, picture.height);
          const wider = picAspect > boxAspect;
          const cover = (element.image?.fit ?? "cover") === "cover";
          const k = cover === wider ? boxAspect / picAspect : picAspect / boxAspect;
          if (cover === wider) u.uvScale.value.set(k, 1);
          else u.uvScale.value.set(1, k);
          // Texels per screen pixel, and the blur, choose the mip.
          const texelsPerPx = (picture.width * (cover ? u.uvScale.value.x : 1)) / Math.max(1, s.width * scale);
          u.mapLod.value = Math.max(0, Math.log2(Math.max(1, texelsPerPx * Math.max(1, blurPx * 0.75))));
        }
        const dots = element.kind === "image" && element.image?.reveal === "dots" && !s.wipe;
        // The spring that drives `draw` front-loads its travel; eased back so the dots take their time
        // arriving and the picture resolves at the end, as in the reference (~1.2 s on "gentle").
        u.dotT.value = dots ? Math.pow(s.draw, 2.2) : 1;
        if (dots) {
          u.dotCell.value = (element.image?.dots?.cell ?? 14) * scale;
          const pal = element.image?.dots?.palette ?? DOT_PALETTE;
          for (let i = 0; i < 4; i++) {
            const c = parseStageColor(pal[i % pal.length]) ?? [255, 255, 255, 1];
            u.palette.value[i].set(c[0] / 255, c[1] / 255, c[2] / 255);
          }
        }
        // A framed icon's outline is the icon's own colour, animating with it.
        if (frame) setRgba(u.strokeColor.value, s.rgba, s.color ?? "#111111");
        else setRgba(u.strokeColor.value, undefined, stroke?.color);
        u.strokePx.value = stroke ? stroke.width * scale : frame ? frame.width * scale : 0;
        this.setDash(u, boxed ? s.form ?? "rect" : "rect", s, element, stroke, (boxed && s.radius !== undefined ? s.radius : radius) * scale, t);
        u.size.value.set(s.width * scale, s.height * scale);
        u.margin.value = marginStage * scale;
        u.blurPx.value = blurPx;
        u.opacity.value = s.opacity;
        this.place(g.box, s, -marginStage, -marginStage, s.width + 2 * marginStage, s.height + 2 * marginStage, order++);
      } else if (g.box) g.box.visible = false;

      if (element.kind === "text" && s.text) order = this.drawText(element, s, g, blurPx, order);
      else this.hideText(g);
      if (element.kind === "icon") order = this.drawIcon(element, s, g, blurPx, order);
      else if (g.text && element.kind !== "text") g.text.visible = false;
      if (element.kind === "math") order = this.drawEquation(element, s, g, blurPx, order);
      else if (g.math) g.math.mesh.visible = false;
      if (element.kind === "graph") order = this.drawGraphElement(compiled, element, s, g, blurPx, order, t);
      else if (g.graph) g.graph.mesh.visible = false;
      if (element.kind === "connector") order = this.drawConnector(element, s, g, boxes, t, order);
      else if (g.line) g.line.visible = false;
      // A wipe on or off: everything it's drawn with is masked by the same sweeping edge.
      const wiping = s.wipe && element.kind !== "graph" && element.kind !== "connector" ? s.wipe : undefined;
      for (const m of [g.box, g.text, g.math?.mesh]) {
        const wu = m?.material.uniforms.wipe;
        if (!wu) continue;
        (wu.value as THREE.Vector4).set(wiping ? 1 : 0, s.draw, WIPE_KIND[wiping ?? "right"], 0);
      }
    }
    for (const [id, g] of this.gfx) {
      if (drawn.has(id)) continue;
      if (g.box) g.box.visible = false;
      if (g.line) g.line.visible = false;
      if (g.math) g.math.mesh.visible = false;
      if (g.graph) g.graph.mesh.visible = false;
      this.hideText(g);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // An icon filling its box, drawn white for the element's own size and tinted - its colour animates
  // for free.
  private drawIcon(element: StageElement, s: SampledElement, g: ElementGfx, blurPx: number, order: number): number {
    const scale = this.scale;
    const box = this.iconRaster(element, g);
    const icon = g.icon!;
    g.text ??= this.mesh(rasterMaterial());
    const u = g.text.material.uniforms;
    u.map.value = icon.texture;
    u.texSize.value.set(icon.canvas.width, icon.canvas.height);
    u.useTint.value = 1;
    setRgba(u.tint.value, s.rgba, s.color ?? "#111111");
    u.opacity.value = s.opacity;
    u.blurPx.value = blurPx;
    // Centred in the box, scaled with it as the box springs.
    const k = Math.min(s.width, s.height) / box;
    const w = (icon.canvas.width / scale) * k;
    this.place(g.text, s, s.width / 2 - w / 2, s.height / 2 - w / 2, w, w, order++);
    return order;
  }

  // A graph filling its box, drawn into a canvas at the output's resolution (stageGraph.drawGraph).
  private drawGraphElement(compiled: CompiledStage, element: StageElement, s: SampledElement, g: ElementGfx, blurPx: number, order: number, t: number): number {
    const state = s.graph;
    if (!state) {
      if (g.graph) g.graph.mesh.visible = false;
      return order;
    }
    const scale = this.scale;
    const margin = rasterMargin(element);
    const w = Math.max(1, s.width);
    const h = Math.max(1, s.height);
    const ink = s.color ?? "#111111";
    const morphing = !!s.morphGraph && s.morph !== undefined && s.morph < 1;
    // Still: the same picture until the state, box, colour or draw-on changes. Animating: every frame.
    const key = s.moving
      ? `live\u0000${t}\u0000${w}x${h}\u0000${s.draw}\u0000${ink}`
      : `${graphId(state)}\u0000${scale}\u0000${w.toFixed(1)}x${h.toFixed(1)}\u0000${ink}\u0000${s.draw.toFixed(4)}`;
    if (!g.graph || g.graph.key !== key) {
      const canvas = g.graph?.canvas ?? document.createElement("canvas");
      const pw = Math.ceil((w + 2 * margin) * scale);
      const ph = Math.ceil((h + 2 * margin) * scale);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, pw, ph);
      drawGraph(ctx, state, { scale, width: w, height: h, ink, draw: s.draw, t, since: s.graphSince ?? 0, channels: compiled.channels, from: morphing ? s.morphGraph : undefined, progress: s.morph }, margin * scale, margin * scale);
      const animated = s.moving || morphing;
      const shape = `${pw}x${ph}x${animated ? 0 : 1}`;
      if (g.graph && g.graph.shape === shape) {
        g.graph.texture.needsUpdate = true;
        g.graph.key = key;
      } else {
        g.graph?.texture.dispose();
        const texture = canvasTexture(canvas);
        texture.generateMipmaps = !animated;
        texture.minFilter = animated ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        this.renderer.initTexture(texture);
        g.graph = { key, canvas, texture, mesh: g.graph?.mesh ?? this.mesh(rasterMaterial()), shape };
      }
    }
    const m = g.graph!;
    const u = m.mesh.material.uniforms;
    u.map.value = m.texture;
    u.texSize.value.set(m.canvas.width, m.canvas.height);
    u.useTint.value = 0;
    u.opacity.value = s.opacity;
    u.blurPx.value = blurPx;
    const cw = m.canvas.width / scale;
    const ch = m.canvas.height / scale;
    this.place(m.mesh, s, s.width / 2 - cw / 2, s.height / 2 - ch / 2, cw, ch, order++);
    return order;
  }

  // An equation centred in its box, drawn from its TeX layout at this resolution - or, mid-rewrite,
  // the frame of the old one becoming the new (stageMath.drawMathMorph).
  private drawEquation(element: StageElement, s: SampledElement, g: ElementGfx, blurPx: number, order: number): number {
    const scale = this.scale;
    const size = element.textLook?.fontSize ?? 64;
    const tex = s.text ?? "";
    const to = mathLayout(tex, size, MATH_INK);
    const from = s.morphFrom !== undefined ? mathLayout(s.morphFrom, size, MATH_INK) : null;
    if (!to) {
      if (g.math) g.math.mesh.visible = false;
      return order;
    }
    const ink = s.color ?? "#111111";
    const margin = rasterMargin(element);
    const w = Math.max(s.width, to.width, from?.width ?? 0);
    const h = Math.max(s.height, to.height, from?.height ?? 0);
    const morphing = !!from && s.morph !== undefined && s.morph < 1;
    const key = `${tex}\u0000${size}\u0000${scale}\u0000${ink}\u0000${Math.ceil(w)}x${Math.ceil(h)}\u0000${morphing ? `${s.morphFrom}\u0000${s.morph!.toFixed(4)}` : ""}`;
    if (!g.math || g.math.key !== key) {
      const canvas = g.math?.canvas ?? document.createElement("canvas");
      const pw = Math.ceil((w + 2 * margin) * scale);
      const ph = Math.ceil((h + 2 * margin) * scale);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, pw, ph);
      if (morphing && from) {
        if (!g.math?.plan || g.math.plan.from !== s.morphFrom || g.math.plan.to !== tex) {
          if (g.math) g.math.plan = { from: s.morphFrom!, to: tex, plan: planMathMorph(from, to) };
        }
        const plan = g.math?.plan?.plan ?? planMathMorph(from, to);
        drawMathMorph(ctx, from, to, plan, s.morph!, scale, margin, margin, ink, { a: [from.width, from.height], b: [to.width, to.height], at: [w, h] });
      } else {
        drawMath(ctx, to, scale, margin + (w - to.width) / 2, margin + (h - to.height) / 2, ink);
      }
      // The same size and mip mode: the texture is refreshed in place; otherwise made anew (a WebGL
      // texture can't change size once allocated).
      const shape = `${pw}x${ph}x${morphing ? 0 : 1}`;
      if (g.math && g.math.shape === shape) {
        g.math.texture.needsUpdate = true;
        g.math.key = key;
      } else {
        g.math?.texture.dispose();
        const texture = canvasTexture(canvas);
        // Rewritten every frame of a morph: no mip chain to rebuild each time.
        texture.generateMipmaps = !morphing;
        texture.minFilter = morphing ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
        this.renderer.initTexture(texture);
        const mesh = g.math?.mesh ?? this.mesh(rasterMaterial());
        g.math = { key, canvas, texture, mesh, shape, plan: g.math?.plan };
      }
    }
    const m = g.math!;
    const u = m.mesh.material.uniforms;
    u.map.value = m.texture;
    u.texSize.value.set(m.canvas.width, m.canvas.height);
    u.useTint.value = 0;
    u.opacity.value = s.opacity;
    u.blurPx.value = blurPx;
    // The box springs; the equation stays its typeset size, centred in it.
    const cw = m.canvas.width / scale;
    const ch = m.canvas.height / scale;
    this.place(m.mesh, s, s.width / 2 - cw / 2, s.height / 2 - ch / 2, cw, ch, order++);
    return order;
  }

  // The icon's white raster for its size at this scale (redrawn only when either changes); returns
  // the box it was drawn for.
  private iconRaster(element: StageElement, g: ElementGfx): number {
    const scale = this.scale;
    const margin = rasterMargin(element);
    // Inside a frame the glyph sits at 60%, the reference's proportion.
    const inset = element.icon?.frame ? 0.6 : 1;
    const box = Math.max(4, Math.min(element.props.width, element.props.height));
    const size = box * inset;
    const name = element.icon?.name ?? "star";
    const key = `${name}\u0000${size}\u0000${scale}`;
    if (!g.icon || g.icon.key !== key) {
      const canvas = g.icon?.canvas ?? document.createElement("canvas");
      const px = Math.ceil((size + 2 * margin) * scale);
      canvas.width = canvas.height = px;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, px, px);
      drawStickerIcon(ctx, name as StickerIcon, px / 2, px / 2, size * scale, "#ffffff");
      g.icon?.texture.dispose();
      const texture = canvasTexture(canvas);
      this.renderer.initTexture(texture);
      g.icon = { key, canvas, texture };
    }
    return box;
  }

  // A connector between two elements' boxes as they are now: from the edge of one toward the
  // other's centre, `gap` short of each edge. Nothing when either end isn't showing or they overlap.
  private drawConnector(element: StageElement, s: SampledElement, g: ElementGfx, boxes: Map<string, SampledElement>, t: number, order: number): number {
    const c = element.connector;
    const a = c && boxes.get(c.from);
    const b = c && boxes.get(c.to);
    const hide = () => {
      if (g.line) g.line.visible = false;
      return order;
    };
    if (!c || !a || !b) return hide();
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2;
    const by = b.y + b.height / 2;
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return hide();
    const ux = dx / dist;
    const uy = dy / dist;
    // How far along the line each box's edge is, from its centre.
    const edge = (box: SampledElement) => Math.min(Math.abs(ux) > 1e-9 ? box.width / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? box.height / 2 / Math.abs(uy) : Infinity);
    const start = edge(a) + c.gap;
    const end = dist - edge(b) - c.gap;
    const len = end - start;
    if (len <= 0) return hide();
    const scale = this.scale;
    const thick = Math.max(0.5, c.thickness);
    const margin = 2 / scale + thick;
    g.line ??= this.mesh(lineMaterial());
    const u = g.line.material.uniforms;
    setRgba(u.color.value, s.rgba, s.color ?? "#111111");
    u.opacity.value = s.opacity * Math.min(a.opacity, b.opacity);
    u.lenPx.value = len * scale;
    u.thick.value = thick * scale;
    u.margin.value = margin * scale;
    u.drawn.value = s.draw;
    u.lineStyle.value = c.style === "dots" ? 1 : c.style === "dashes" ? 2 : 0;
    u.period.value = thick * scale * (c.style === "dashes" ? 4 : c.rhythm ? 1.6 : 2.6);
    u.rhythm.value = c.style === "dots" ? c.rhythm ?? 0 : 0;
    u.flow.value = (c.flow ?? 0) * t * scale;
    const mx = ax + ux * (start + len / 2);
    const my = ay + uy * (start + len / 2);
    this.m4.makeTranslation(mx, my, 0).multiply(this.tmp.makeRotationZ(Math.atan2(uy, ux))).multiply(this.tmp.makeScale(len + 2 * margin, thick + 2 * margin, 1));
    g.line.matrix.copy(this.m4);
    g.line.matrixWorldNeedsUpdate = true;
    g.line.renderOrder = order++;
    g.line.visible = true;
    return order;
  }

  // A scene picture as a mipmapped texture, uploaded once per renderer (stageImages decodes it once
  // for all of them). Null while it isn't loaded - the box draws its fill.
  private readonly pictures = new Map<string, { texture: THREE.Texture; width: number; height: number }>();
  private pictureTexture(src: string | undefined): { texture: THREE.Texture; width: number; height: number } | null {
    if (!src) return null;
    const have = this.pictures.get(src);
    if (have) return have;
    const img = stageImage(src);
    if (!img) return null;
    const texture = new THREE.Texture(img.source);
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    const out = { texture, width: img.width, height: img.height };
    this.pictures.set(src, out);
    return out;
  }

  private hideText(g: ElementGfx): void {
    if (g.text) g.text.visible = false;
    if (g.glyphs) g.glyphs.mesh.visible = false;
  }

  private drawText(element: StageElement, s: SampledElement, g: ElementGfx, blurPx: number, order: number): number {
    const look = lookOf(element);
    const scale = this.scale;
    // A live value: laid out from cached advances and drawn from the atlas - no canvas, no upload.
    // Its letters stay on whole pixels while the element holds still, so digits read crisp.
    const live = s.live && !s.glyphs
      ? layoutLiveLine(element, s.text!, s.width, s.weightRuns).glyphs.map((gl) => {
          const snapped = !s.moving && !s.rotation && s.scale === 1 ? (Math.round((s.x + gl.x) * scale) - s.x * scale) / scale : gl.x;
          return { text: gl.text, weight: gl.weight, x: snapped, y: gl.y, width: gl.width, height: gl.height, opacity: 1, blur: 0, rgba: s.rgba, color: s.color };
        })
      : null;
    const glyphList = s.glyphs ?? live;
    if (glyphList) {
      if (g.text) g.text.visible = false;
      const shared = this.atlasFor(this.atlasKey(element), element, glyphList.map((x) => atlasCellKey(x.text, x.weight)));
      const { atlas } = shared;
      const n = glyphList.length;
      if (!g.glyphs || g.glyphs.capacity < n) g.glyphs = this.glyphBatch(Math.max(n, 2 * (g.glyphs?.capacity ?? 16)), g.glyphs ?? undefined);
      const b = g.glyphs;
      const [rect, uv, tint, params] = b.staging;
      const changed = [false, false, false, false];
      // Writes v at i, noting whether attribute `a` changed.
      const put = (arr: Float32Array, a: number, i: number, v: number) => {
        if (arr[i] !== Math.fround(v)) {
          arr[i] = v;
          changed[a] = true;
        }
      };
      const tabular = !!look.tabularNums;
      const fallback = new THREE.Vector4();
      setRgba(fallback, s.rgba, s.color);
      let k = 0;
      for (const glyph of glyphList) {
        const cell = atlas.cells.get(atlasCellKey(glyph.text, glyph.weight));
        if (!cell) continue;
        // A tabular digit sits centred in its fixed room, as the raster draws it.
        const centre = tabular && /^[0-9]$/.test(glyph.text) ? (glyph.width - (cell.width - 2 * atlas.margin)) / 2 : 0;
        const r = k * 4;
        put(rect, 0, r, glyph.x + centre - atlas.margin);
        put(rect, 0, r + 1, glyph.y - atlas.margin);
        put(rect, 0, r + 2, cell.width);
        put(rect, 0, r + 3, cell.height);
        put(uv, 1, r, cell.u0);
        put(uv, 1, r + 1, cell.v0);
        put(uv, 1, r + 2, cell.u1);
        put(uv, 1, r + 3, cell.v1);
        const c = glyph.rgba ?? [fallback.x, fallback.y, fallback.z, fallback.w];
        for (let j = 0; j < 4; j++) put(tint, 2, r + j, c[j]);
        put(params, 3, k * 2, glyph.opacity);
        put(params, 3, k * 2 + 1, blurPx + glyph.blur * scale);
        k++;
      }
      changed.forEach((c, i) => c && b.versions[i]++);
      this.commitGlyphs(b, k);
      const u = b.mesh.material.uniforms;
      u.map.value = shared.texture;
      u.texSize.value.set(atlas.canvas.width, atlas.canvas.height);
      u.opacity.value = s.opacity;
      b.mesh.matrix.copy(this.elementMatrix(s));
      b.mesh.matrixWorldNeedsUpdate = true;
      b.mesh.renderOrder = order++;
      b.mesh.visible = k > 0;
      return order;
    }
    if (g.glyphs) g.glyphs.mesh.visible = false;

    const wrapWidth = s.wrapWidth ?? s.width;
    const key = this.rasterKey(element, s.text!, s.colorRuns, s.weightRuns, wrapWidth, s.color);
    let raster = g.rasters.get(key);
    if (!raster) {
      // Not prepared: a text showing a live value, or one with part-colours whose base colour is
      // mid-change - redrawn into its one reused canvas.
      g.live = this.drawRaster(element, s.text!, s.colorRuns, s.weightRuns, wrapWidth, s.color ?? "#000000", g.live ?? undefined);
      raster = g.live;
    }
    g.text ??= this.mesh(rasterMaterial());
    const u = g.text.material.uniforms;
    u.map.value = raster.texture;
    u.texSize.value.set(raster.canvas.width, raster.canvas.height);
    u.useTint.value = raster.tinted ? 1 : 0;
    if (raster.tinted) setRgba(u.tint.value, s.rgba, s.color);
    u.opacity.value = s.opacity;
    u.blurPx.value = blurPx;
    const margin = rasterMargin(element);
    const w = raster.canvas.width / scale;
    const h = raster.canvas.height / scale;
    const align = look.textAlign ?? "left";
    const layout = raster.layout;
    // The raster's own size (not the box's, which may be springing), aligned in the box.
    let x = (align === "center" ? (s.width - layout.width) / 2 : align === "right" ? s.width - layout.width : 0) - margin;
    let y = -margin;
    // At rest, straight and unscaled: land the raster on whole pixels so text stays crisp.
    if (!s.moving && !s.rotation && s.scale === 1) {
      x += (Math.round((s.x + x) * scale) - (s.x + x) * scale) / scale;
      y += (Math.round((s.y + y) * scale) - (s.y + y) * scale) / scale;
    }
    this.place(g.text, s, x, y, w, h, order++);
    return order;
  }

  private dropText(): void {
    for (const g of this.gfx.values()) {
      for (const r of g.rasters.values()) r.texture.dispose();
      g.rasters.clear();
      g.live?.texture.dispose();
      g.live = null;
    }
    for (const a of this.atlases.values()) a.texture.dispose();
    this.atlases.clear();
  }

  // The last frame rendered as GL holds it - rows bottom first, premultiplied - into `into` when it's
  // the right size (export reuses a few buffers rather than allocating 33 MB a 4K frame).
  readPixelsRaw(into?: Uint8Array): Uint8Array {
    const gl = this.renderer.getContext();
    const size = this.pxWidth * this.pxHeight * 4;
    const buf = into && into.length === size ? into : new Uint8Array(size);
    gl.readPixels(0, 0, this.pxWidth, this.pxHeight, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  // Starts reading the frame just drawn back without waiting for the GPU: the pixels land in a pixel
  // buffer behind a fence, and `ready()` says when they can be copied out without a stall. The
  // export keeps a few in flight and draws on meanwhile - a synchronous readPixels makes every frame
  // wait for the whole GPU, which on a busy machine was most of the frame's time.
  beginReadback(): { ready: () => boolean; read: (into?: Uint8Array) => Uint8Array; cancel: () => void } {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const size = this.pxWidth * this.pxHeight * 4;
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
    gl.readPixels(0, 0, this.pxWidth, this.pxHeight, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.flush();
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      gl.deleteSync(sync);
      gl.deleteBuffer(pbo);
    };
    return {
      ready: () => done || gl.clientWaitSync(sync, 0, 0) !== gl.TIMEOUT_EXPIRED,
      read: (into?: Uint8Array) => {
        const buf = into && into.length === size ? into : new Uint8Array(size);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        release();
        return buf;
      },
      cancel: release,
    };
  }

  get pixelSize(): { width: number; height: number } {
    return { width: this.pxWidth, height: this.pxHeight };
  }

  // The last frame rendered, as RGBA rows top to bottom (premultiplied alpha).
  readPixels(): Uint8Array {
    const gl = this.renderer.getContext();
    const w = this.pxWidth;
    const h = this.pxHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // GL reads bottom row first.
    const row = w * 4;
    const tmp = new Uint8Array(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      tmp.set(buf.subarray(a, a + row));
      buf.copyWithin(a, b, b + row);
      buf.set(tmp, b);
    }
    return buf;
  }

  private disposeGfx(g: ElementGfx): void {
    for (const r of g.rasters.values()) r.texture.dispose();
    g.live?.texture.dispose();
    g.icon?.texture.dispose();
    g.math?.texture.dispose();
    g.graph?.texture.dispose();
    (g.box?.material.uniforms.vertTex?.value as THREE.Texture | undefined)?.dispose();
    for (const m of [g.box, g.text, g.glyphs?.mesh, g.line, g.math?.mesh, g.graph?.mesh]) {
      if (!m) continue;
      this.scene.remove(m);
      m.material.dispose();
    }
    for (const set of g.glyphs?.sets ?? []) set.geometry.dispose();
  }

  dispose(): void {
    this.dropText();
    for (const g of this.gfx.values()) this.disposeGfx(g);
    this.gfx.clear();
    for (const p of this.pictures.values()) p.texture.dispose();
    this.pictures.clear();
    (this.background.material.uniforms.vertTex?.value as THREE.Texture | undefined)?.dispose();
    this.background.material.dispose();
    this.quad.dispose();
    this.renderer.dispose();
  }
}
