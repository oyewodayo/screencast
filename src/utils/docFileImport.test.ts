import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { getSchema } from "@tiptap/core";
import { fingerprintBytes, isOpenableDocument, markdownToHtml, textToHtml } from "./docFileImport";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { resolveDocxMetadata } from "./docxStyleResolver";
import { applyParagraphStyles } from "./docxImport";

async function buildMockGoogleDocsCvDocx(): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:oyewodayo@gmail.com" TargetMode="External"/>
  <Relationship Id="rIdLink2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://github.com/oyewodayo" TargetMode="External"/>
</Relationships>`
  );

  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>
        <w:sz w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="0" w:line="276" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="400" w:after="120"/></w:pPr>
    <w:rPr><w:b w:val="1"/><w:sz w:val="40"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="360" w:after="120"/></w:pPr>
    <w:rPr><w:b w:val="0"/><w:sz w:val="32"/></w:rPr>
  </w:style>
</w:styles>`
  );

  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="-"/>
      <w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1">
    <w:abstractNumId w:val="1"/>
  </w:num>
</w:numbering>`
  );

  // Mirrors the exact structure of Copy of Temidayo_Oyewo_CV_Quantum.docx:
  // P0: Heading1 (20pt bold)
  // P1: Normal (11pt)
  // P2: Empty paragraph (dropped by mammoth!)
  // P3: Normal with hyperlinks and 10pt runs (sz=20)
  // P4: Heading2 "PROFILE" (16pt, b=0 non-bold)
  // P5: Normal body paragraph (11pt)
  // P6: Bullet item with '-' marker
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/><w:spacing w:before="200"/></w:pPr>
      <w:r><w:t>TEMIDAYO SOLOMON OYEWO</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:r><w:t>Computational Physicist | Quantum Simulation</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
      <w:hyperlink r:id="rIdLink1">
        <w:r><w:rPr><w:sz w:val="20"/><w:u w:val="single"/><w:color w:val="1155cc"/></w:rPr><w:t>oyewodayo@gmail.com</w:t></w:r>
      </w:hyperlink>
      <w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t> | +234 803 6131 267 | </w:t></w:r>
      <w:hyperlink r:id="rIdLink2">
        <w:r><w:rPr><w:sz w:val="20"/><w:u w:val="single"/><w:color w:val="1155cc"/></w:rPr><w:t>github.com/oyewodayo</w:t></w:r>
      </w:hyperlink>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:before="240" w:after="120"/></w:pPr>
      <w:r><w:t>PROFILE</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="Normal"/>
        <w:pBdr><w:bottom w:val="single" w:sz="6" w:color="1F4E79"/></w:pBdr>
        <w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>
      </w:pPr>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Computational physicist</w:t></w:r>
      <w:r><w:t> working on quantum simulation.</w:t></w:r>
      <w:r><w:tab/><w:t>2026</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
      <w:r><w:t>Built a state-vector simulator in C++17.</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>
      <w:pgMar w:top="180" w:right="1440" w:bottom="0" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: "uint8array" });
}

describe("docFileImport", () => {
  it("recognises document extensions that open in Briefcast Docs", () => {
    expect(isOpenableDocument("paper.docx")).toBe(true);
    expect(isOpenableDocument("NOTES.MD")).toBe(true);
    expect(isOpenableDocument("readme.markdown")).toBe(true);
    expect(isOpenableDocument("draft.txt")).toBe(true);
    expect(isOpenableDocument("slides.pdf")).toBe(false);
    expect(isOpenableDocument("clip.mp4")).toBe(false);
  });

  it("changes the byte fingerprint when the file's contents change", () => {
    const a = fingerprintBytes(new TextEncoder().encode("first draft"));
    const b = fingerprintBytes(new TextEncoder().encode("first draft"));
    const c = fingerprintBytes(new TextEncoder().encode("second draft"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("turns plain text paragraphs and line breaks into HTML", () => {
    expect(textToHtml("First line\nsecond line\n\nSecond paragraph & <more>")).toBe(
      "<p>First line<br>second line</p><p>Second paragraph &amp; &lt;more&gt;</p>"
    );
  });

  it("strips YAML front matter and renders Markdown structure to HTML", () => {
    const html = markdownToHtml("---\ntitle: Draft\n---\n# Heading\n\nA **bold** word and a list:\n\n- one\n- two\n");
    expect(html).not.toContain("title: Draft");
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
  });

  it("resolves .docx styles without shifting on empty paragraphs and preserves Heading2 un-bold, hyperlink runs, dash bullets, right tabs, and page setup", async () => {
    const bytes = await buildMockGoogleDocsCvDocx();
    const meta = await resolveDocxMetadata(bytes);

    // 7 <w:p> in XML, 1 is empty -> 6 ParagraphStyle entries emitted, with the empty paragraph's
    // vertical height folded into P3's spaceBeforePt.
    expect(meta.paragraphs).toHaveLength(6);
    expect(meta.pageSetup).not.toBeNull();
    expect(meta.pageSetup?.margins).toEqual({ top: 0.13, right: 1, bottom: 0, left: 1 });

    // P[2] (the contact line after the skipped empty paragraph) has 10pt runs including inside <w:hyperlink>
    const contactStyle = meta.paragraphs[2];
    expect(contactStyle.textPreview).toContain("oyewodayo@gmail.com | +234 803 6131 267");
    expect(contactStyle.fontSizePt).toBe(10);
    expect(contactStyle.spaceBeforePt).toBeGreaterThan(10); // folded empty paragraph height (~12.65pt)

    // P[3] ("PROFILE" Heading 2) has 16pt font and bold === false (<w:b w:val="0"/>)
    const profileHeading = meta.paragraphs[3];
    expect(profileHeading.textPreview).toBe("PROFILE");
    expect(profileHeading.fontSizePt).toBe(16);
    expect(profileHeading.bold).toBe(false);

    // P[4] (body paragraph after PROFILE) has 11pt font, bottom border, and a right-aligned tab run
    const bodyPara = meta.paragraphs[4];
    expect(bodyPara.fontSizePt).toBe(11);
    expect(bodyPara.borderBottom).toBe("0.75pt solid #1f4e79");
    expect(bodyPara.runs.some((r) => r.tabAlign === "right" && r.text.includes("2026"))).toBe(true);

    // Apply resolved styles onto the ProseMirror document structure (matching mammoth's 6 blocks)
    const schema = getSchema(getDocContentExtensions());
    const rawDoc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "TEMIDAYO SOLOMON OYEWO" }] },
        { type: "paragraph", content: [{ type: "text", text: "Computational Physicist | Quantum Simulation" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", marks: [{ type: "link", attrs: { href: "mailto:oyewodayo@gmail.com" } }], text: "oyewodayo@gmail.com" },
            { type: "text", text: " | +234 803 6131 267 | " },
            { type: "text", marks: [{ type: "link", attrs: { href: "https://github.com/oyewodayo" } }], text: "github.com/oyewodayo" },
          ],
        },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "PROFILE" }] },
        { type: "paragraph", content: [{ type: "text", text: "Computational physicist working on quantum simulation.\u00a02026" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Built a state-vector simulator in C++17." }] }],
            },
          ],
        },
      ],
    });

    const node = applyParagraphStyles(rawDoc, schema.marks.textStyle, meta.paragraphs);
    const blocks: Array<{ type: string; text: string; attrs: Record<string, unknown>; firstMarkAttrs?: Record<string, unknown> }> = [];
    node.forEach((child) => {
      const firstText = child.firstChild;
      const tsMark = firstText?.marks.find((m) => m.type.name === "textStyle");
      blocks.push({
        type: child.type.name,
        text: child.textContent,
        attrs: child.attrs as Record<string, unknown>,
        firstMarkAttrs: tsMark?.attrs as Record<string, unknown> | undefined,
      });
    });

    // Block 0: H1 "TEMIDAYO SOLOMON OYEWO" at 20pt
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].firstMarkAttrs?.fontSize).toBe(20);

    // Block 2: Contact line at 10pt
    expect(blocks[2].text).toContain("oyewodayo@gmail.com");
    expect(blocks[2].firstMarkAttrs?.fontSize).toBe(10);

    // Block 3: H2 "PROFILE" at 16pt with fontWeight: "normal"
    expect(blocks[3].type).toBe("heading");
    expect(blocks[3].text).toBe("PROFILE");
    expect(blocks[3].firstMarkAttrs?.fontSize).toBe(16);
    expect(blocks[3].firstMarkAttrs?.fontWeight).toBe("normal");

    // Block 4: Body paragraph at 11pt (NOT shifted to 16pt!)
    expect(blocks[4].type).toBe("paragraph");
    expect(blocks[4].firstMarkAttrs?.fontSize).toBe(11);
    expect(blocks[4].attrs.borderBottom).toBe("0.75pt solid #1f4e79");

    // Block 5: Bullet list with '-' marker
    expect(blocks[5].type).toBe("bulletList");
    expect(blocks[5].attrs.bulletMarker).toBe("-");
  });
});
