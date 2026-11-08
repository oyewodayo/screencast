import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { resolveDocxMetadata } from "./docxStyleResolver";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

// One document exercising the Word features the importer used to drop.
async function fidelityDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0"?><w:styles ${W}>
      <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
        <w:top w:val="single" w:sz="4" w:color="000000"/><w:left w:val="single" w:sz="4" w:color="000000"/>
        <w:bottom w:val="single" w:sz="4" w:color="000000"/><w:right w:val="single" w:sz="4" w:color="000000"/>
        <w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/>
      </w:tblBorders></w:tblPr></w:style>
    </w:styles>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
      <Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
    </Relationships>`
  );
  zip.file("word/footer1.xml", `<?xml version="1.0"?><w:ftr ${W}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`);
  zip.file("word/header1.xml", `<?xml version="1.0"?><w:hdr ${W}><w:p><w:r><w:t>Annual Report</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Confidential</w:t></w:r></w:p></w:hdr>`);
  const anchor = `<w:r><w:drawing><wp:anchor behindDoc="0" distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" locked="0" layoutInCell="1" allowOverlap="1">
      <wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>952500</wp:posOffset></wp:positionH>
      <wp:positionV relativeFrom="paragraph"><wp:posOffset>190500</wp:posOffset></wp:positionV>
      <wp:extent cx="1714500" cy="571500"/><wp:wrapNone/><wp:docPr id="1" name="Sig" descr="Signature"/>
      <a:graphic><a:graphicData><pic:pic><pic:spPr><a:xfrm rot="-240000"/></pic:spPr><pic:blipFill><a:blip r:embed="x"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
    </wp:anchor></w:drawing></w:r>`;
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document ${W}><w:body>
      <w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:color="1F3864"/></w:pBdr><w:shd w:val="clear" w:fill="F2F2F2"/></w:pPr>
        <w:r><w:rPr><w:caps/><w:spacing w:val="40"/></w:rPr><w:t>Member details</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Highlighted</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
      <w:p><w:r><w:t>Starts page two</w:t></w:r>${anchor}</w:p>
      <w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
        <w:tr><w:tc><w:tcPr><w:vAlign w:val="center"/><w:tcBorders><w:top w:val="nil"/></w:tcBorders></w:tcPr><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Appendix</w:t></w:r></w:p>
      <w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
    </w:body></w:document>`
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe(".docx import fidelity", () => {
  it("keeps paragraph borders, shading, caps, letter spacing and highlight", async () => {
    const meta = await resolveDocxMetadata(await fidelityDocx());
    const first = meta.paragraphs[0];
    expect(first.borderLeft).toBe("3pt solid #1f3864");
    expect(first.shading).toBe("#f2f2f2");
    expect(first.runs[0]).toMatchObject({ caps: true, letterSpacingPt: 2 });
    expect(meta.paragraphs[1].runs[0].highlight).toBe("#ffff00");
  });

  it("turns page breaks into breaks before the next block", async () => {
    const meta = await resolveDocxMetadata(await fidelityDocx());
    const byText = (t: string) => meta.paragraphs.find((p) => p.textPreview.startsWith(t))!;
    expect(byText("Highlighted").pageBreakBefore).toBe(false);
    expect(byText("Starts page two").pageBreakBefore).toBe(true);
    expect(byText("Appendix").pageBreakBefore).toBe(true);
    expect(byText("Name").pageBreakBefore).toBe(false);
  });

  it("resolves cell borders from the table style, with the cell's own overrides, and vertical alignment", async () => {
    const meta = await resolveDocxMetadata(await fidelityDocx());
    const [name, value] = meta.tables[0].cells[0];
    expect(name.borders).toEqual({ top: "none", right: "0.5pt solid #000000", bottom: "0.5pt solid #000000", left: "0.5pt solid #000000" });
    expect(name.verticalAlign).toBe("middle");
    expect(value.borders?.top).toBe("0.5pt solid #000000");
  });

  it("maps a floating picture to a free layout with its offset and rotation", async () => {
    const meta = await resolveDocxMetadata(await fidelityDocx());
    expect(meta.images[0]).toMatchObject({ layout: "front", x: 100, y: 20, width: 180, height: 60, rotation: -4, alt: "Signature" });
  });

  it("reads the running header and the footer's page number", async () => {
    const meta = await resolveDocxMetadata(await fidelityDocx());
    expect(meta.pageChrome?.header).toEqual({ left: "Annual Report", center: "", right: "Confidential" });
    expect(meta.pageChrome?.pageNumber).toMatchObject({ enabled: true, position: "footer-center", style: "page" });
  });
});
