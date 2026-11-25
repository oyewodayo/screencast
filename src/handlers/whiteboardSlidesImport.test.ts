// handlers/whiteboardSlidesImport.test.ts
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  importPptxSlides,
  layoutImportedSlides,
  parseGoogleSlidesInput,
} from "./whiteboardSlidesImport";

async function buildSamplePptx(): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`
  );

  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`
  );

  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:themeElements>
    <a:clrScheme name="Briefcast">
      <a:dk1><a:srgbClr val="0F172A"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:accent1><a:srgbClr val="2563EB"/></a:accent1>
    </a:clrScheme>
  </a:themeElements>
</a:theme>`
  );

  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="F8FAFC"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="914400"/></a:xfrm>
          <a:prstGeom prst="rect"/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr anchor="ctr"/>
          <a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="3600" b="1"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:rPr><a:t>Q4 Product Launch</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Rounded Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>
          <a:xfrm rot="5400000"><a:off x="1219200" y="2286000"/><a:ext cx="3657600" cy="1828800"/></a:xfrm>
          <a:prstGeom prst="roundRect"/>
          <a:solidFill><a:schemeClr val="accent1"/></a:solidFill>
          <a:ln w="25400"><a:solidFill><a:srgbClr val="1E40AF"/></a:solidFill></a:ln>
        </p:spPr>
        <p:txBody>
          <a:bodyPr anchor="ctr"/>
          <a:p><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Architecture</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:cxnSp>
        <p:nvCxnSpPr><p:cNvPr id="4" name="Arrow"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
        <p:spPr>
          <a:xfrm><a:off x="4876800" y="3200400"/><a:ext cx="2438400" cy="0"/></a:xfrm>
          <a:ln w="25400"><a:solidFill><a:srgbClr val="334155"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>
        </p:spPr>
      </p:cxnSp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="5" name="Logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdImg1"/><a:srcRect l="10000" t="5000" r="10000" b="5000"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="7620000" y="2286000"/><a:ext cx="2438400" cy="1828800"/></a:xfrm></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );

  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`
  );

  zip.file("ppt/media/image1.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

  zip.file(
    "ppt/notesSlides/notesSlide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>Remember to demo live pen annotations!</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`
  );

  zip.file(
    "ppt/slides/slide2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:graphicFrame>
        <p:nvGraphicFramePr><p:cNvPr id="6" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
        <p:xfrm><a:off x="914400" y="914400"/><a:ext cx="9144000" cy="3657600"/></p:xfrm>
        <a:graphic><a:graphicData>
          <a:tbl>
            <a:tblGrid><a:gridCol w="4572000"/><a:gridCol w="4572000"/></a:tblGrid>
            <a:tr h="1828800">
              <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Metric</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Target</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
            <a:tr h="1828800">
              <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>FPS</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>60</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
          </a:tbl>
        </a:graphicData></a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );

  return zip.generateAsync({ type: "uint8array" });
}

describe("whiteboardSlidesImport", () => {
  it("parses Google Slides links and rejects published /d/e/ embed URLs with actionable guidance", () => {
    const ok1 = parseGoogleSlidesInput("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#slide=id.p");
    expect(ok1.ok).toBe(true);
    if (ok1.ok) expect(ok1.presentationId).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");

    const ok2 = parseGoogleSlidesInput("1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(ok2.ok).toBe(true);

    const badEmbed = parseGoogleSlidesInput("https://docs.google.com/presentation/d/e/2PACX-1vSomeLongPublishedId/pub");
    expect(badEmbed.ok).toBe(false);
    if (!badEmbed.ok) expect(badEmbed.error).toContain("/presentation/d/<ID>/edit");

    const badUrl = parseGoogleSlidesInput("https://example.com/not-slides");
    expect(badUrl.ok).toBe(false);
  });

  it("imports a multi-slide PowerPoint (.pptx) with theme colors, shapes, connectors, images, tables, and speaker notes", async () => {
    const pptxBytes = await buildSamplePptx();
    const savedImages: string[] = [];

    const deck = await importPptxSlides(pptxBytes, {
      includeSpeakerNotes: true,
      saveImage: async (_bytes, mime) => {
        savedImages.push(mime);
        return { assetFileName: "slide-img-1.png", naturalWidth: 400, naturalHeight: 300 };
      },
    });

    expect(deck.slides.length).toBe(2);

    // Slide 1 checks
    const s1 = deck.slides[0];
    expect(s1.width).toBe(960);
    expect(s1.height).toBe(540);
    expect(s1.name).toBe("1. Q4 Product Launch");

    const frame1 = s1.nodes.find((n) => n.shapeType === "artboard");
    expect(frame1?.x).toBe(0);
    expect(frame1?.y).toBe(0);
    expect(frame1?.fillColor).toBe("#f8fafc");

    const titleNode = s1.nodes.find((n) => n.shapeType === "text" && n.text === "Q4 Product Launch");
    expect(titleNode).toBeDefined();
    expect(titleNode?.x).toBe(48); // 609600 / 12192000 * 960 === 48 (strict top-left, no center offset)
    expect(titleNode?.y).toBe(36); // 457200 / 12192000 * 960 === 36
    expect(titleNode?.fontColor).toBe("#2563eb"); // Resolved from theme accent1
    expect(titleNode?.fontWeight).toBe("bold");

    const boxNode = s1.nodes.find((n) => n.shapeType === "rectangle" && n.text === "Architecture");
    expect(boxNode?.x).toBe(96);
    expect(boxNode?.y).toBe(180);
    expect(boxNode?.fillColor).toBe("#2563eb");
    expect(boxNode?.cornerRadius).toBe(14);
    expect(boxNode?.rotation).toBe(90);

    const imgNode = s1.nodes.find((n) => n.shapeType === "image");
    expect(imgNode?.x).toBe(600);
    expect(imgNode?.y).toBe(180);
    expect(imgNode?.imageCropX).toBeCloseTo(0.1, 4);
    expect(imgNode?.imageCropW).toBeCloseTo(0.8, 4);
    expect(imgNode?.assetFileName).toBe("slide-img-1.png");
    expect(savedImages).toEqual(["image/png"]);

    const stickyNote = s1.nodes.find((n) => n.shapeType === "note");
    expect(stickyNote?.text).toContain("Remember to demo live pen annotations!");

    expect(s1.edges.length).toBe(1);
    expect(s1.edges[0].endArrowType).toBe("triangle");

    // Slide 2 table check
    const s2 = deck.slides[1];
    const tableNode = s2.nodes.find((n) => n.shapeType === "table");
    expect(tableNode?.tableRows).toBe(2);
    expect(tableNode?.tableCols).toBe(2);
    expect(tableNode?.tableCellText).toEqual([
      ["Metric", "Target"],
      ["FPS", "60"],
    ]);

    // Layout as frames vs pages
    const asFrames = layoutImportedSlides(deck, "frames", { x: 100, y: 100 });
    expect(asFrames.pages.length).toBe(0);
    const frameNodes = asFrames.nodes.filter((n) => n.shapeType === "artboard");
    expect(frameNodes.length).toBe(2);
    expect(frameNodes[1].x).toBeGreaterThan(frameNodes[0].x + frameNodes[0].width);

    const asPages = layoutImportedSlides(deck, "pages");
    expect(asPages.pages.length).toBe(2);
    expect(asPages.pages[0].name).toBe("1. Q4 Product Launch");
  });
});
