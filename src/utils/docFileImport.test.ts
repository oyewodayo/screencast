import { describe, expect, it } from "vitest";
import { fingerprintBytes, isOpenableDocument, markdownToHtml, textToHtml } from "./docFileImport";

describe("isOpenableDocument", () => {
  it("takes Word, Markdown and text files", () => {
    expect(isOpenableDocument("main.docx")).toBe(true);
    expect(isOpenableDocument("README.MD")).toBe(true);
    expect(isOpenableDocument("notes.txt")).toBe(true);
    expect(isOpenableDocument("old.doc")).toBe(false);
    expect(isOpenableDocument("talk.mp4")).toBe(false);
  });
});

describe("textToHtml", () => {
  it("makes paragraphs at blank lines and keeps single line breaks, escaped", () => {
    expect(textToHtml("Hello <world>\r\nline two\n\n\nNext")).toBe("<p>Hello &lt;world&gt;<br>line two</p><p>Next</p>");
  });
});

describe("markdownToHtml", () => {
  it("converts GitHub-flavoured Markdown and drops front matter", () => {
    const html = markdownToHtml("---\ntitle: x\n---\n# Title\n\n**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task");
    expect(html).not.toContain("title: x");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
  });
});

describe("fingerprintBytes", () => {
  it("tells changed files apart", () => {
    const a = fingerprintBytes(new TextEncoder().encode("same"));
    expect(fingerprintBytes(new TextEncoder().encode("same"))).toBe(a);
    expect(fingerprintBytes(new TextEncoder().encode("sane"))).not.toBe(a);
  });
});
