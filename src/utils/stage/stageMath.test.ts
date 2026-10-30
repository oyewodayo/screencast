import { describe, expect, it } from "vitest";
import { MathLayout, planMathMorph } from "./stageMath";

const layout = (chars: string): MathLayout => ({
  tex: chars,
  size: 64,
  width: chars.length * 30,
  height: 80,
  rules: [],
  svgs: [],
  glyphs: [...chars].map((ch, i) => ({ ch, font: "italic 400 64px KaTeX_Math", family: "KaTeX_Math", x: i * 30, y: 60, width: 30, color: "rgb(255, 255, 255)" })),
});

describe("equation rewrites", () => {
  it("keeps what stays in order and writes on what's new", () => {
    const plan = planMathMorph(layout("a+b"), layout("a+b=c"));
    expect(plan.pairs).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(plan.arriving.sort()).toEqual([3, 4]);
    expect(plan.gone).toEqual([]);
  });

  it("carries a term that moved past others rather than dropping and re-adding it", () => {
    // "x=ab" -> "ab=x": x travels to the end.
    const plan = planMathMorph(layout("x=ab"), layout("ab=x"));
    const travelled = plan.pairs.find(([i]) => i === 0);
    expect(travelled).toEqual([0, 3]);
    expect(plan.gone).toEqual([]);
    expect(plan.arriving).toEqual([]);
  });

  it("lets go of what's removed", () => {
    const plan = planMathMorph(layout("a+b+c"), layout("a+c"));
    expect(plan.gone.length).toBe(2);
    expect(plan.arriving).toEqual([]);
  });
});
