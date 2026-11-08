import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_PAGE_CHROME,
  formatPageNumber,
  hasPageChrome,
  normalizePageChrome,
  parseChromeText,
  printChromeCss,
  readPageChrome,
  renderSlot,
  writePageChrome,
  type DocPageChrome,
} from "./docPageChrome";

const ctx = { title: "Report", date: "October 11, 2026", pages: 12 };
const withNumber = (patch: Partial<DocPageChrome["pageNumber"]>): DocPageChrome => ({
  ...DEFAULT_PAGE_CHROME,
  pageNumber: { ...DEFAULT_PAGE_CHROME.pageNumber, enabled: true, ...patch },
});

describe("formatPageNumber", () => {
  it("writes each numeral style", () => {
    expect(formatPageNumber(14, "decimal")).toBe("14");
    expect(formatPageNumber(14, "lower-roman")).toBe("xiv");
    expect(formatPageNumber(1994, "upper-roman")).toBe("MCMXCIV");
    expect(formatPageNumber(1, "lower-alpha")).toBe("a");
    expect(formatPageNumber(26, "lower-alpha")).toBe("z");
    expect(formatPageNumber(27, "upper-alpha")).toBe("AA");
    expect(formatPageNumber(28, "lower-alpha")).toBe("ab");
  });
});

describe("parseChromeText", () => {
  it("splits fields out of text", () => {
    expect(parseChromeText("Page {page} of {pages}")).toEqual([{ kind: "text", text: "Page " }, { kind: "page" }, { kind: "text", text: " of " }, { kind: "pages" }]);
    expect(parseChromeText("{unknown}")).toEqual([{ kind: "text", text: "{unknown}" }]);
  });
});

describe("renderSlot", () => {
  it("renders the page number in its style, numerals and start", () => {
    const chrome = withNumber({ style: "pageOf", format: "lower-roman", start: 3 });
    expect(renderSlot(chrome, "footer", "center", 2, ctx)).toBe("Page iv of 12");
    expect(renderSlot(chrome, "footer", "left", 2, ctx)).toBe("");
  });

  it("appends the number after the slot's own text", () => {
    const chrome = { ...withNumber({ position: "header-right" }), header: { left: "", center: "", right: "{title} · {date}" } };
    expect(renderSlot(chrome, "header", "right", 5, ctx)).toBe("Report · October 11, 2026   5");
  });
});

describe("normalizePageChrome", () => {
  it("fills in and clamps a partial or hostile value", () => {
    const n = normalizePageChrome({ header: { left: 7 }, pageNumber: { enabled: true, position: "middle", start: -4, format: "klingon" }, fontSize: 99 });
    expect(n.header).toEqual({ left: "", center: "", right: "" });
    expect(n.pageNumber).toMatchObject({ enabled: true, position: "footer-center", start: 1, format: "decimal" });
    expect(n.fontSize).toBe(14);
  });
});

describe("readPageChrome / writePageChrome", () => {
  it("shows legacy meta header/footer until the chrome is stored in the document", () => {
    const ydoc = new Y.Doc();
    expect(readPageChrome(ydoc, "Draft", "Certified").footer.left).toBe("Certified");
    writePageChrome(ydoc, withNumber({}));
    const stored = readPageChrome(ydoc, "Draft", "Certified");
    expect(stored.footer.left).toBe("");
    expect(stored.pageNumber.enabled).toBe(true);
  });

  it("removes the key once nothing is shown", () => {
    const ydoc = new Y.Doc();
    writePageChrome(ydoc, withNumber({}));
    writePageChrome(ydoc, DEFAULT_PAGE_CHROME);
    expect(hasPageChrome(readPageChrome(ydoc))).toBe(false);
  });
});

describe("printChromeCss", () => {
  const opts = { title: 'He said "hi"', date: "today", fontFamily: "Georgia, serif", color: "#666", pagesHint: 3 };

  it("always blanks the corner boxes so Chromium adds no stamps of its own", () => {
    const css = printChromeCss(DEFAULT_PAGE_CHROME, opts);
    expect(css).toContain('@top-left-corner { content: "" }');
    expect(css).toContain('@bottom-right-corner { content: "" }');
    expect(css).not.toContain("@bottom-center");
  });

  it("numbers pages through a fixed counter style starting at the chosen number", () => {
    const css = printChromeCss({ ...withNumber({ style: "pageOf", format: "upper-roman", start: 4 }), header: { left: "{title}", center: "", right: "" } }, opts);
    expect(css).toMatch(/@counter-style doc-page-number \{ system: fixed 1; symbols: "IV" "V" "VI"/);
    expect(css).toContain('@bottom-center { content: "Page " counter(page, doc-page-number) " of " counter(pages);');
    expect(css).toContain('@top-left { content: "He said \\"hi\\"";');
  });

  it("hides every box on a title page", () => {
    const css = printChromeCss({ ...withNumber({}), differentFirstPage: true }, opts);
    expect(css).toContain("@page :first { @bottom-center { content: none; } }");
  });
});
