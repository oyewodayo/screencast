import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildDocxBytes } from "./docDocx";
import { DEFAULT_PAGE_CHROME, type DocPageChrome } from "./docPageChrome";

const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

type Watermark = Parameters<typeof buildDocxBytes>[2] extends infer O ? (O extends { watermark?: infer W } ? W : never) : never;

async function parts(pageChrome: DocPageChrome | null, watermark: Watermark = null) {
  const zip = await JSZip.loadAsync(await buildDocxBytes(doc, "Quarterly report", { pageChrome, watermark }));
  const read = async (prefix: string) =>
    Promise.all(
      Object.keys(zip.files)
        .filter((n) => n.startsWith(`word/${prefix}`))
        .sort()
        .map((n) => zip.file(n)!.async("string"))
    );
  return { document: await zip.file("word/document.xml")!.async("string"), headers: await read("header"), footers: await read("footer") };
}

const numbered: DocPageChrome = {
  ...DEFAULT_PAGE_CHROME,
  header: { left: "{title}", center: "", right: "Draft" },
  pageNumber: { enabled: true, position: "footer-right", style: "pageOf", format: "lower-roman", start: 3 },
  differentFirstPage: true,
};

describe("Word export headers, footers and page numbers", () => {
  it("writes no header or footer parts when there are none", async () => {
    const { headers, footers } = await parts(null);
    expect(headers).toHaveLength(0);
    expect(footers).toHaveLength(0);
  });

  it("fills header slots and writes live PAGE / NUMPAGES fields", async () => {
    const { headers, footers } = await parts(numbered);
    const header = headers.join("");
    expect(header).toContain("Quarterly report");
    expect(header).toContain("Draft");
    expect(header).toMatch(/w:tab w:val="center"/);
    const footer = footers.join("");
    expect(footer).toContain("PAGE");
    expect(footer).toContain("NUMPAGES");
  });

  it("numbers from the chosen start in the chosen numerals, with a blank first page", async () => {
    const { document } = await parts(numbered);
    expect(document).toMatch(/<w:pgNumType w:start="3" w:fmt="lowerRoman"\/>/);
    expect(document).toContain("<w:titlePg/>");
    expect(document).toMatch(/w:headerReference w:type="first"/);
  });
});

// A 1x1 PNG.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

describe("Word export watermark", () => {
  it("anchors the watermark behind the text, centred on the page, in the header", async () => {
    const { headers } = await parts(null, { png: PNG, widthPx: 816, heightPx: 1056, skipFirstPage: false });
    const header = headers.join("");
    expect(header).toContain('behindDoc="1"');
    expect(header).toMatch(/<wp:positionH relativeFrom="page"><wp:align>center<\/wp:align>/);
  });

  it("leaves it off a first page whose footer still shows", async () => {
    const footerOnly: DocPageChrome = { ...DEFAULT_PAGE_CHROME, footer: { left: "Certified", center: "", right: "" } };
    const { document, headers, footers } = await parts(footerOnly, { png: PNG, widthPx: 816, heightPx: 1056, skipFirstPage: true });
    expect(document).toContain("<w:titlePg/>");
    // Default header has the picture, the first-page one doesn't; both footers carry the text.
    expect(headers.filter((h) => h.includes('behindDoc="1"'))).toHaveLength(1);
    expect(footers.filter((f) => f.includes("Certified"))).toHaveLength(2);
  });
});
