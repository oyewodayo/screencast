import { describe, expect, it } from "vitest";
import { compileStage, sampleStage } from "./stageEngine";
import { MeasuredGlyph, StageMeasure } from "./stageLayout";
import { assignGlyphIds, graphemes, tokenize } from "./stageTextMorph";
import { parseStageColor } from "./stageColor";
import { StageBeat, StageElement, StageProps, StageScene, defaultStageProps } from "./stageTypes";

// A stand-in for canvas text: every grapheme half the font size wide, lines 1.3x the font size, words
// wrapped at the box width, lines aligned per the look, padding round it all.
const fakeMeasure: StageMeasure = {
  text(element, text, maxWidth) {
    const look = element.textLook ?? { fontSize: 40 };
    const fs = look.fontSize;
    const adv = fs / 2;
    const lineH = fs * 1.3;
    const px = look.paddingX ?? 0;
    const py = look.paddingY ?? 0;
    const gs = graphemes(text);
    const lines: number[][] = [[]];
    let lineW = 0;
    for (const tok of tokenize(gs)) {
      const w = (tok.end - tok.start) * adv;
      if (lineW > 0 && px * 2 + lineW + adv + w > maxWidth) {
        lines.push([]);
        lineW = 0;
      }
      const line = lines[lines.length - 1];
      if (line.length > 0) {
        line.push(tok.start - 1);
        lineW += adv;
      }
      for (let g = tok.start; g < tok.end; g++) line.push(g);
      lineW += w;
    }
    const widest = Math.max(...lines.map((l) => l.length * adv));
    const boxW = element.fit === "hug" ? widest + 2 * px : maxWidth;
    const glyphs: MeasuredGlyph[] = new Array(gs.length);
    lines.forEach((line, li) => {
      const w = line.length * adv;
      const left = look.textAlign === "center" ? (boxW - w) / 2 : look.textAlign === "right" ? boxW - px - w : px;
      line.forEach((g, k) => (glyphs[g] = { text: gs[g], x: left + k * adv, y: py + li * lineH, width: adv, height: lineH }));
    });
    gs.forEach((g, i) => (glyphs[i] ??= { text: g, x: px, y: py, width: 0, height: lineH }));
    return { width: boxW, height: lines.length * lineH + 2 * py, glyphs };
  },
};

const text = (id: string, props: Partial<StageProps>, extra: Partial<StageElement> = {}): StageElement => ({
  id,
  kind: "text",
  fit: "hug",
  textLook: { fontSize: 40, textAlign: "left" },
  props: defaultStageProps({ width: 1600, height: 0, color: "#111111", ...props }),
  ...extra,
});
const stack = (id: string, props: Partial<StageProps>, extra: Partial<StageElement> = {}): StageElement => ({
  id,
  kind: "stack",
  stack: { direction: "column", gap: 10, justify: "center", align: "center" },
  props: defaultStageProps(props),
  ...extra,
});
const beat = (hold: number, changes: StageBeat["changes"] = {}): StageBeat => ({ id: `b${Math.random()}`, hold, changes });
const scene = (elements: StageElement[], beats: StageBeat[], extra: Partial<StageScene> = {}): StageScene => ({
  id: "s",
  startTime: 0,
  width: 1920,
  height: 1080,
  background: { kind: "color", color: "#e8e8e8" },
  elements,
  beats,
  spring: "smooth",
  stagger: 0,
  ...extra,
});
const at = (s: StageScene, t: number, id: string) => sampleStage(compileStage(s, fakeMeasure), t).find((e) => e.id === id);

describe("layout", () => {
  // The Insomnia headline: a centred group; the second line arriving moves the first up to make room.
  const headline = () =>
    scene(
      [
        stack("group", { x: 0, y: 0, width: 1920, height: 1080 }),
        text("easy", { text: "Keeping a Mac awake is easy." }, { parent: "group" }),
        text("battery", { text: "Keeping it alive on battery isn't.", visible: false }, { parent: "group" }),
      ],
      [beat(1.5), beat(2, { battery: { visible: true } })]
    );

  it("centres a lone line, then re-centres both lines as the second arrives", () => {
    const s = headline();
    const alone = at(s, 1.45, "easy")!;
    expect(alone.y).toBeCloseTo((1080 - 52) / 2, 1);
    expect(alone.x).toBeCloseTo((1920 - 28 * 20) / 2, 1);
    const both = at(s, 3.45, "easy")!;
    const second = at(s, 3.45, "battery")!;
    expect(both.y).toBeCloseTo((1080 - (52 + 10 + 52)) / 2, 1);
    expect(second.y).toBeCloseTo(both.y + 52 + 10, 1);
    // The first line glides up - it doesn't jump.
    const mid = at(s, 1.6, "easy")!;
    expect(mid.y).toBeLessThan(alone.y);
    expect(mid.y).toBeGreaterThan(both.y);
  });

  it("closes a stack up when a line is hidden, and the hidden line leaves where it was", () => {
    const s = scene(
      [stack("g", { width: 1920, height: 1080 }), text("a", { text: "one" }, { parent: "g" }), text("b", { text: "two" }, { parent: "g" }), text("c", { text: "three" }, { parent: "g" })],
      [beat(1.5), beat(2, { b: { visible: false } })]
    );
    const before = { a: at(s, 1.45, "a")!.y, b: at(s, 1.45, "b")!.y, c: at(s, 1.45, "c")!.y };
    const after = at(s, 3.45, "c")!;
    expect(after.y).toBeCloseTo(before.b + (52 + 10) / 2, 1);
    expect(at(s, 1.6, "b")!.y).toBeCloseTo(before.b, 3);
  });

  it("grows a hugging pill to fit new words", () => {
    const pill = { ...text("pill", { text: "Lid closed." }), textLook: { fontSize: 40, paddingX: 20, paddingY: 8 } };
    const s = scene([pill], [beat(1.5), beat(2, { pill: { text: "Lid closed. Still running." } })]);
    expect(at(s, 1.45, "pill")!.width).toBeCloseTo(11 * 20 + 40, 1);
    expect(at(s, 3.45, "pill")!.width).toBeCloseTo(26 * 20 + 40, 1);
    const mid = at(s, 1.65, "pill")!;
    expect(mid.width).toBeGreaterThan(260);
    expect(mid.width).toBeLessThan(560);
  });

  it("ignores a parent that isn't a stack or that loops back on itself", () => {
    const s = scene(
      [text("t", { x: 5, y: 7, text: "hi" }, { parent: "t2" }), text("t2", { x: 50, y: 70, text: "x" }), stack("s1", { x: 1, y: 1 }, { parent: "s2" }), stack("s2", { x: 2, y: 2 }, { parent: "s1" })],
      [beat(2)]
    );
    expect(at(s, 1.9, "t")!.x).toBeCloseTo(5, 6);
    expect(() => compileStage(s, fakeMeasure)).not.toThrow();
  });
});

describe("word morph", () => {
  it("keeps shared words still and writes the new ones on after them, in order", () => {
    const s = scene([text("pill", { text: "Lid closed." })], [beat(1.5), beat(2, { pill: { text: "Lid closed. Still running." } })], { wordStagger: 0.1 });
    const c = compileStage(s, fakeMeasure);
    const glyphsAt = (t: number) => sampleStage(c, t).find((e) => e.id === "pill")!.glyphs;
    // Settled: drawn whole.
    expect(glyphsAt(1.45)).toBeUndefined();
    const early = glyphsAt(1.55)!;
    const lid = early.find((g) => g.text === "L")!;
    expect(lid.x).toBeCloseTo(0, 6);
    expect(lid.opacity).toBe(1);
    // "Still" has started, "running." is still waiting its turn.
    expect(early.some((g) => g.text === "S")).toBe(true);
    expect(early.some((g) => g.text === "r")).toBe(false);
    const later = glyphsAt(1.75)!;
    expect(later.find((g) => g.text === "S")!.opacity).toBeGreaterThan(later.find((g) => g.text === "r")!.opacity);
    const done = sampleStage(c, 3.45).find((e) => e.id === "pill")!;
    expect(done.glyphs).toBeUndefined();
    expect(done.text).toBe("Lid closed. Still running.");
  });

  it("slides kept words to their new places and fades dropped words out where they were", () => {
    const s = scene([text("t", { text: "the quick fox" })], [beat(1.5), beat(2, { t: { text: "the fox" } })]);
    const c = compileStage(s, fakeMeasure);
    const g = sampleStage(c, 1.6).find((e) => e.id === "t")!.glyphs!;
    const f = g.find((x) => x.text === "f")!;
    expect(f.x).toBeLessThan(10 * 20);
    expect(f.x).toBeGreaterThan(4 * 20);
    const q = g.find((x) => x.text === "q")!;
    expect(q.x).toBeCloseTo(4 * 20, 6);
    expect(q.opacity).toBeLessThan(1);
  });

  it("colours letters by their runs and animates a run's colour change", () => {
    const line = "Keeping it alive on battery isn't.";
    const start = line.indexOf("on battery");
    const s = scene(
      [text("t", { text: line, color: "#9a9a9a" })],
      // Same words - only the colours change, so the letters fade from grey to their new colours in place.
      [beat(1), beat(1.5, { t: { color: "#111111", colorRuns: [{ start, end: start + 10, color: "#7a1f3d" }] } })]
    );
    const c = compileStage(s, fakeMeasure);
    const mid = sampleStage(c, 1.08).find((e) => e.id === "t")!.glyphs!;
    const o = mid.find((x) => x.text === "o")!;
    const [r, gg, b] = parseStageColor(o.color)!;
    expect(r).toBeGreaterThan(gg);
    expect(r).toBeLessThan(154);
    expect(b).toBeLessThan(154);
    const k = mid.find((x) => x.text === "K")!;
    expect(parseStageColor(k.color)![0]).toBeLessThan(154);
    expect(parseStageColor(k.color)![0]).toBeGreaterThan(17);
    // Settled, it's drawn whole again with its runs.
    expect(sampleStage(c, 2.45).find((e) => e.id === "t")!.glyphs).toBeUndefined();
  });
});

describe("glyph identity", () => {
  it("pairs repeated words with the right occurrence", () => {
    const { ids } = assignGlyphIds(["the cat and the dog", "the dog"]);
    const firstThe = ids[0][0];
    const secondThe = ids[0][12];
    const dog = ids[0][16];
    expect(ids[1][0]).toBe(firstThe);
    expect(ids[1][0]).not.toBe(secondThe);
    expect(ids[1][4]).toBe(dog);
  });

  it("treats an emoji or an accented letter as one glyph", () => {
    expect(graphemes("👍🏽 é")).toEqual(["👍🏽", " ", "é"]);
    const { ids } = assignGlyphIds(["ok 👍🏽", "ok 👍🏽 done"]);
    expect(ids[1][3]).toBe(ids[0][3]);
  });
});
