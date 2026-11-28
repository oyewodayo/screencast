import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { JSONContent } from "@tiptap/core";
import { buildDocxBytes } from "./docDocx";

const doc: JSONContent = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

async function documentXml(options: Parameters<typeof buildDocxBytes>[2], inputDoc: JSONContent = doc): Promise<{ document: string; settings: string }> {
  const zip = await JSZip.loadAsync(await buildDocxBytes(inputDoc, "Test", options));
  return { document: await zip.file("word/document.xml")!.async("string"), settings: await zip.file("word/settings.xml")!.async("string") };
}

describe("Word export page setup", () => {
  it("writes a landscape page as the turned paper size with w:orient", async () => {
    const { document } = await documentXml({ pageSize: "letter", orientation: "landscape" });
    // Word reads the turned paper: 11in wide, 8.5in tall, flagged landscape.
    expect(document).toMatch(/<w:pgSz w:w="11in" w:h="8.5in" w:orient="landscape"\/>/);
  });

  it("keeps portrait as before", async () => {
    const { document } = await documentXml({ pageSize: "a4" });
    expect(document).toMatch(/<w:pgSz w:w="8.27in" w:h="11.69in" w:orient="portrait"\/>/);
  });

  it("writes the page colour as the document background, shown by Word", async () => {
    const { document, settings } = await documentXml({ pageColor: "#fff8e1" });
    expect(document).toContain('<w:background w:color="FFF8E1"');
    expect(settings).toContain("w:displayBackgroundShape");
  });

  it("writes no background for white paper", async () => {
    const { document } = await documentXml({ pageColor: null });
    expect(document).not.toContain("<w:background");
  });

  it("exports tables with explicit column grid, DXA cell widths, cell padding, and crisp inner/outer borders for Word and Google Docs", async () => {
    const tableDoc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { borders: "0.5pt solid #000000|none|0.5pt solid #e5e5e5|0.5pt solid #000000" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }],
                },
                {
                  type: "tableHeader",
                  attrs: { borders: "0.5pt solid #000000|0.5pt solid #000000|0.5pt solid #e5e5e5|none" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Email" }] }],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { borders: "0.5pt solid #e5e5e5|none|0.5pt solid #000000|0.5pt solid #000000" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Dr. Omololu Akin-Ojo" }] }],
                },
                {
                  type: "tableCell",
                  attrs: { borders: "0.5pt solid #e5e5e5|0.5pt solid #000000|0.5pt solid #000000|none" },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "oakinojo@gmail.com" }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    const { document } = await documentXml({ pageSize: "letter" }, tableDoc);
    // 1. Explicit column grid (2 columns splitting the 9360-twip text area into 4680 each)
    expect(document).toContain('<w:gridCol w:w="4680"/>');
    expect(document).toContain('<w:tcW w:type="dxa" w:w="4680"/>');
    // 2. Crisp table-level outer & inner borders
    expect(document).toContain('<w:insideH w:val="single" w:color="64748B" w:sz="4"/>');
    expect(document).toContain('<w:insideV w:val="single" w:color="64748B" w:sz="4"/>');
    // 3. Missing ("none") inner vertical borders on grid cells are repaired to single borders, never nil
    expect(document).not.toContain('w:val="nil"');
    // 4. Cell padding (margins) and header row marker are emitted
    expect(document).toContain("<w:tcMar>");
    expect(document).toContain("<w:tblHeader/>");
  });
});
