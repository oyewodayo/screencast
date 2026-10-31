import { describe, expect, it } from "vitest";
import { ExprError, compileExpr, parseExpr, slopeAt } from "./stageExpr";

const at = (src: string, x: number, vars: Record<string, number> = {}, names: string[] = Object.keys(vars)) => parseExpr(src, names).fn({ ...vars, x });

describe("expressions as people write them", () => {
  it("reads implicit multiplication", () => {
    expect(at("2x", 3)).toBe(6);
    expect(at("3sin(x)", Math.PI / 2)).toBeCloseTo(3);
    expect(at("x(x+1)", 2)).toBe(6);
    expect(at("(x+1)(x-1)", 3)).toBe(8);
    expect(at("2pix", 1)).toBeCloseTo(2 * Math.PI);
    expect(at("sin(x)e^(-x/5)", 1)).toBeCloseTo(Math.sin(1) * Math.exp(-0.2));
  });

  it("keeps the usual precedence: -x^2, right-associative powers, division", () => {
    expect(at("-x^2", 3)).toBe(-9);
    expect(at("2^3^2", 0)).toBe(512);
    expect(at("1/2x", 4)).toBe(2);
    expect(at("2^-1", 0)).toBe(0.5);
  });

  it("lets functions go without brackets the way they're written", () => {
    expect(at("sin 2x", 0.3)).toBeCloseTo(Math.sin(0.6));
    expect(at("sin x cos x", 0.3)).toBeCloseTo(Math.sin(0.3) * Math.cos(0.3));
  });

  it("reads time and the scene's values, and says which it uses", () => {
    expect(at("a x^2", 2, { a: 0.5 })).toBe(2);
    const p = parseExpr("sin(x - t) + speed", ["speed"]);
    expect([...p.names].sort()).toEqual(["speed", "t"]);
    expect(p.fn({ x: 1, t: 1, speed: 2 })).toBe(2);
  });

  it("knows sigmoid, relu, min and max", () => {
    expect(at("sigmoid(0)", 0)).toBe(0.5);
    expect(at("relu(x)", -2)).toBe(0);
    expect(at("max(x, 1, 3)", 2)).toBe(3);
  });

  it("explains what's wrong instead of failing silently", () => {
    expect(compileExpr("sin(x")).toBeInstanceOf(ExprError);
    expect((compileExpr("sin(x") as ExprError).message).toMatch(/closing/);
    expect((compileExpr("foo(x)") as ExprError).message).toMatch(/isn't a value or function/);
    expect((compileExpr("") as ExprError).message).toMatch(/Type a function/);
    expect(compileExpr("2x +")).toBeInstanceOf(ExprError);
  });

  it("finds slopes accurately", () => {
    const { fn } = parseExpr("x^3");
    expect(slopeAt(fn, {}, 2)).toBeCloseTo(12, 6);
  });

  it("evaluates fast enough to sample curves every frame", () => {
    const { fn } = parseExpr("sin(3x)e^(-x/4) + 0.2cos(7x - t)");
    const t0 = performance.now();
    let s = 0;
    for (let i = 0; i < 200_000; i++) s += fn({ x: i * 1e-4, t: 1 });
    const ms = performance.now() - t0;
    expect(Number.isFinite(s)).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});
