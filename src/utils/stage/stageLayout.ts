// utils/stage/stageLayout.ts
//
// Where each element's box lands in a beat once sizes and stacks are worked out: a text that hugs
// its content takes its measured size, and a stack places its shown children one after another
// inside its box. Runs on every beat's resolved state before the engine springs between them, so
// when a line is added to a centred group the lines already there glide to their new places, and
// a pill whose words change grows or shrinks to fit - nobody positions anything by hand.
//
// Measuring text needs a canvas, so it comes in from outside (StageMeasure) - the browser one draws
// with the same fonts as the renderer, and tests use a fixed-advance stand-in.
import type { StageElement, StageProps, StageWeightRun } from "./stageTypes";

// One grapheme of a laid-out text, in the element's own box (padding included).
export interface MeasuredGlyph {
  text: string;
  // Its weight when a run set one.
  weight?: number;
  // Where it starts in the text (code units).
  start?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MeasuredText {
  // The box: text plus padding.
  width: number;
  height: number;
  glyphs: MeasuredGlyph[];
  // The wrapped lines as drawn: each line's text, where it starts (x, top of its line box) and the
  // index in the full text of its first code unit - what the rasteriser draws from.
  lines?: { text: string; x: number; y: number; start: number }[];
}

export interface StageMeasure {
  // `text` laid out in `element`'s look, wrapping at `maxWidth` (box width, padding included), parts
  // of it in the weights `weights` gives.
  text(element: StageElement, text: string, maxWidth: number, weights?: StageWeightRun[]): MeasuredText;
}

export type MeasureCache = Map<string, MeasuredText>;

export function measureCached(measure: StageMeasure, cache: MeasureCache, element: StageElement, text: string, maxWidth: number, weights?: StageWeightRun[]): MeasuredText {
  const key = `${element.id}\u0000${maxWidth}\u0000${weights?.length ? JSON.stringify(weights) : ""}\u0000${text}`;
  let m = cache.get(key);
  if (!m) {
    m = measure.text(element, text, maxWidth, weights);
    cache.set(key, m);
  }
  return m;
}

// `props[i]` is elements[i]'s resolved state in one beat; returns it with boxes laid out. `live`
// tells a text whose wording changes every frame (a channel's value) - it keeps its own width, the
// frame its text is aligned in, since no one measurement fits it.
export function layoutBeat(elements: StageElement[], props: StageProps[], measure: StageMeasure | undefined, cache: MeasureCache, live: (text: string | undefined) => boolean = () => false): StageProps[] {
  const out = props.map((p) => ({ ...p }));
  const index = new Map(elements.map((e, i) => [e.id, i]));
  // A parent that isn't a stack, is missing, or leads round in a circle is ignored.
  const parentOf = (i: number): number => {
    const seen = new Set<number>([i]);
    let p = elements[i].parent !== undefined ? index.get(elements[i].parent!) : undefined;
    const first = p;
    while (p !== undefined) {
      if (seen.has(p) || elements[p].kind !== "stack") return -1;
      seen.add(p);
      p = elements[p].parent !== undefined ? index.get(elements[p].parent!) : undefined;
    }
    return first ?? -1;
  };
  const parents = elements.map((_, i) => parentOf(i));
  const children = elements.map(() => [] as number[]);
  parents.forEach((p, i) => p >= 0 && children[p].push(i));

  // Sizes, children before their stacks.
  const sized = new Set<number>();
  const size = (i: number): void => {
    if (sized.has(i)) return;
    sized.add(i);
    const e = elements[i];
    const p = out[i];
    if (e.kind === "text" && e.fit === "hug" && measure) {
      const m = measureCached(measure, cache, e, p.text ?? "", p.width, p.weightRuns);
      // On its own, a hugging text shrinks toward its alignment: a right-aligned one keeps its
      // right edge where it is as "100%" becomes "9%". (In a stack, the stack places it.)
      if (parents[i] < 0 && !live(p.text)) {
        const align = e.textLook?.textAlign ?? "left";
        p.x += align === "center" ? (p.width - m.width) / 2 : align === "right" ? p.width - m.width : 0;
      }
      if (!live(p.text)) p.width = m.width;
      p.height = m.height;
    } else if (e.kind === "stack" && e.stack) {
      const shown = children[i].filter((c) => out[c].visible);
      shown.forEach(size);
      if (e.fit === "hug") {
        const column = e.stack.direction === "column";
        const main = shown.reduce((sum, c) => sum + (column ? out[c].height : out[c].width), 0) + Math.max(0, shown.length - 1) * e.stack.gap;
        const cross = shown.reduce((m, c) => Math.max(m, column ? out[c].width : out[c].height), 0);
        p.width = column ? cross : main;
        p.height = column ? main : cross;
      }
    }
  };
  elements.forEach((_, i) => size(i));

  // Positions, stacks before their children.
  const place = (i: number): void => {
    const e = elements[i];
    if (e.kind !== "stack" || !e.stack) return;
    const box = out[i];
    const { direction, gap, justify, align } = e.stack;
    const column = direction === "column";
    const shown = children[i].filter((c) => out[c].visible);
    const run = shown.reduce((sum, c) => sum + (column ? out[c].height : out[c].width), 0) + Math.max(0, shown.length - 1) * gap;
    const room = column ? box.height : box.width;
    let at = justify === "center" ? (room - run) / 2 : justify === "end" ? room - run : 0;
    for (const c of shown) {
      const child = out[c];
      const crossRoom = column ? box.width : box.height;
      const crossSize = column ? child.width : child.height;
      const cross = align === "center" ? (crossRoom - crossSize) / 2 : align === "end" ? crossRoom - crossSize : 0;
      if (column) {
        child.x = box.x + cross;
        child.y = box.y + at;
        at += child.height + gap;
      } else {
        child.x = box.x + at;
        child.y = box.y + cross;
        at += child.width + gap;
      }
      place(c);
    }
    // Hidden children wait where the run would continue - they enter from there when shown.
    for (const c of children[i]) {
      if (out[c].visible) continue;
      if (column) {
        out[c].y = box.y + at;
        out[c].x = box.x + (align === "center" ? (box.width - out[c].width) / 2 : align === "end" ? box.width - out[c].width : 0);
      } else {
        out[c].x = box.x + at;
        out[c].y = box.y + (align === "center" ? (box.height - out[c].height) / 2 : align === "end" ? box.height - out[c].height : 0);
      }
      place(c);
    }
  };
  elements.forEach((_, i) => parents[i] < 0 && place(i));
  return out;
}
