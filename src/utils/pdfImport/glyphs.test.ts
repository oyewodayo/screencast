import { describe, expect, it } from "vitest";
import { classifyFont, collectFontChars, isMathAlphanumeric, symbolForGlyphName } from "./glyphs";

describe("math font families", () => {
  it.each([
    ["CMMI10", "mathItalic"],
    ["NewTXMI", "mathItalic"],
    ["NewTXMI7", "mathItalic"],
    ["txmiaX", "mathItalic"],
    ["NewTXBMI", "boldMathItalic"],
    ["txsys", "symbol"],
    ["txbsys", "symbol"],
    ["txsyb", "blackboard"],
    ["MSBM10", "blackboard"],
    ["txexs", "extension"],
    ["CMEX10", "extension"],
    ["STIXTwoMath-Regular", "unicodeMath"],
    ["LatinModernMath-Regular", "unicodeMath"],
    ["CambriaMath", "unicodeMath"],
    ["TeXGyreTermesX-Regular", "text"],
  ])("%s is %s", (ps, role) => {
    expect(classifyFont("f", ps, null).role).toBe(role);
  });

  it("recognises Unicode math letters in any font", () => {
    expect(isMathAlphanumeric("𝑅")).toBe(true);
    expect(isMathAlphanumeric("𝝈")).toBe(true);
    expect(isMathAlphanumeric("R")).toBe(false);
  });
});

describe("glyph names", () => {
  it("names the symbol of every size variant", () => {
    expect(symbolForGlyphName("summationdisplay.1")).toBe("∑");
    expect(symbolForGlyphName("summationtext")).toBe("∑");
    expect(symbolForGlyphName("parenleftBigg")).toBe("(");
    expect(symbolForGlyphName("bracerightbig")).toBe("}");
    expect(symbolForGlyphName("integraldisplay")).toBe("∫");
    expect(symbolForGlyphName("radicalBig")).toBe("√");
  });
  it("leaves extension pieces and unknown names alone", () => {
    expect(symbolForGlyphName("braceex")).toBeNull();
    expect(symbolForGlyphName("bracelefttp")).toBeNull();
    expect(symbolForGlyphName("A")).toBeNull();
    expect(symbolForGlyphName(null)).toBeNull();
  });
});

describe("drawn characters", () => {
  const OPS = { setFont: 1, showText: 2, showSpacedText: 3, nextLineShowText: 4, nextLineSetSpacingShowText: 5 };
  it("pairs each reported character with every font character drawn for it", () => {
    const opList = {
      fnArray: [1, 2, 3, 1, 5],
      argsArray: [
        ["g_d0_f1"],
        [[{ unicode: "(", fontChar: "" }, { unicode: "’", fontChar: "" }]],
        [[{ unicode: "(", fontChar: "" }, -120, { unicode: "(", fontChar: "" }]],
        ["g_d0_f2"],
        [0, 0, [{ unicode: "x", fontChar: "x" }]],
      ],
    };
    const map = collectFontChars(opList, OPS);
    expect(map.get("g_d0_f1")?.get("(")).toEqual([0xe007, 0xe00f]);
    expect(map.get("g_d0_f1")?.get("’")).toEqual([0xe016]);
    expect(map.get("g_d0_f2")?.get("x")).toEqual([0x78]);
  });
});
