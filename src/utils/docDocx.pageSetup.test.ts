import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildDocxBytes } from "./docDocx";

const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] };

async function documentXml(options: Parameters<typeof buildDocxBytes>[2]): Promise<{ document: string; settings: string }> {
  const zip = await JSZip.loadAsync(await buildDocxBytes(doc, "Test", options));
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
});
