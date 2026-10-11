import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildDocxBytes } from "./docDocx";
import { DEFAULT_PAGE_CHROME, type DocPageChrome } from "./docPageChrome";

const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

async function parts(pageChrome: DocPageChrome | null) {
  const zip = await JSZip.loadAsync(await buildDocxBytes(doc, "Quarterly report", { pageChrome }));
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
