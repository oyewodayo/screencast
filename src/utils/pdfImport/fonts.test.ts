import { describe, expect, it } from "vitest";
import { bundledFamily, embeddedFamilyName } from "./fonts";
import { readLayout, writeLayout, bodyStyleVars } from "../docLayout";
import * as Y from "yjs";

describe("PDF font mapping", () => {
  it("uses the bundled full font for the designs Docs ships", () => {
    expect(bundledFamily("ABCDEF+LMRoman10-Regular")).toBe("Latin Modern Roman");
    expect(bundledFamily("LMRoman9-Italic")).toBe("Latin Modern Roman");
    expect(bundledFamily("CMR10")).toBe("Latin Modern Roman");
    expect(bundledFamily("NimbusRomNo9L-Medi")).toBe("TeX Gyre Termes");
    expect(bundledFamily("TimesNewRomanPS-BoldMT")).toBe("TeX Gyre Termes");
    expect(bundledFamily("LMMono10-Regular")).toBe("Latin Modern Mono");
    expect(bundledFamily("MinionPro-Regular")).toBeNull();
  });

  it("groups an embedded font's faces under one family", () => {
    expect(embeddedFamilyName("ABCDEF+MinionPro-Bold")).toBe("pdf-minionpro");
    expect(embeddedFamilyName("MinionPro-It")).toBe("pdf-minionpro");
  });
});

describe("document layout settings", () => {
  it("round-trips columns and the body style through the Y.Doc", () => {
    const ydoc = new Y.Doc();
    expect(readLayout(ydoc).columns).toBe(1);
    const body = { fontFamily: '"Latin Modern Roman", serif', fontSize: 10, lineHeight: 1.15, blockSpacing: 0, paragraphIndent: 10, color: null, justify: true, hyphenate: true };
    writeLayout(ydoc, { columns: 2, columnGap: 0.23, body });
    const layout = readLayout(ydoc);
    expect(layout.columns).toBe(2);
    expect(layout.columnGap).toBe(0.23);
    expect(layout.body).toEqual(body);
    expect(bodyStyleVars(layout.body)).toMatchObject({ "--doc-body-size": "10pt", "--doc-block-space": "0pt", "--doc-par-indent": "10pt" });
  });
});
