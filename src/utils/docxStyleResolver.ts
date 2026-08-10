// utils/docxStyleResolver.ts
//
// mammoth.js (docxImport.ts's own docx->HTML conversion) is deliberately semantic-only - it never
// parses `w:color` at all, discards font/size before generating HTML, and never reads a named
// style's own formatting (color/font/size) or its `w:basedOn` inheritance chain from styles.xml
// (confirmed by reading mammoth 1.12.1's actual source: lib/docx/body-reader.js's
// readRunProperties has zero references to w:color; lib/docx/styles-reader.js only extracts
// {type, styleId, name} from each <w:style>, never its <w:rPr> or <w:basedOn>). This is why a
// heading styled via Word's built-in "Heading 1"/"Heading 2" - which get their color from the
// STYLE definition, not direct run formatting - loses that color on import: mammoth structurally
// cannot see it, no styleMap/transformDocument configuration can recover it.
//
// This module reads the .docx's raw OOXML directly (it's just a zip of XML files) to recover what
// mammoth can't, and only that - mammoth still owns all structural conversion (headings/bold/
// lists/tables/images), this only supplies a parallel per-paragraph color/font/size lookup that
// docxImport.ts overlays onto mammoth's own output afterward.
//
// Scope is deliberately paragraph-level, not per-run: each paragraph/heading's own resolved
// color/font/size (its own direct formatting on the first run, else its named style, else that
// style's basedOn chain up to docDefaults). This covers the realistic common case (a document's
// headings keep their style color, body text keeps a consistent font/size) without the much larger
// complexity of correlating individual mid-paragraph manual formatting overrides, theme-color
// (w:themeColor) lookups via theme1.xml, or table/list-specific style inheritance - all explicitly
// out of scope here, not silently attempted and gotten wrong.
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

export interface ParagraphStyle {
  color?: string;
  fontFamily?: string;
  fontSizePt?: number;
}

interface RunProps {
  color?: string;
  fontFamily?: string;
  fontSizeHalfPt?: number;
}

interface StyleDef extends RunProps {
  basedOn?: string;
}

// xmldom's DOM implementation supports plain (non-namespace-aware) tagName lookups against the
// literal qualified name (e.g. "w:p") - the same approach mammoth's own xmldom-based reader uses,
// since every OOXML document from Word consistently uses the "w:" prefix for the wordprocessingml
// namespace.
function directChildren(el: Element, tagName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === 1 && (child as Element).tagName === tagName) out.push(child as Element);
  }
  return out;
}

function directChild(el: Element, tagName: string): Element | null {
  return directChildren(el, tagName)[0] ?? null;
}

function readRunProps(rPr: Element | null): RunProps {
  if (!rPr) return {};
  const result: RunProps = {};

  const colorVal = directChild(rPr, "w:color")?.getAttribute("w:val");
  if (colorVal && colorVal !== "auto") result.color = colorVal;

  const fontVal = directChild(rPr, "w:rFonts")?.getAttribute("w:ascii");
  if (fontVal) result.fontFamily = fontVal;

  const szVal = directChild(rPr, "w:sz")?.getAttribute("w:val");
  if (szVal) {
    const parsed = parseInt(szVal, 10);
    if (!Number.isNaN(parsed)) result.fontSizeHalfPt = parsed;
  }

  return result;
}

const DOC_DEFAULTS_KEY = "__docDefaults__";

function buildStyleMap(stylesXmlText: string): Map<string, StyleDef> {
  const doc = new DOMParser().parseFromString(stylesXmlText, "text/xml");
  const map = new Map<string, StyleDef>();

  const docDefaultsEl = doc.getElementsByTagName("w:docDefaults")[0];
  if (docDefaultsEl) {
    const rPrDefault = directChild(docDefaultsEl, "w:rPrDefault");
    const rPr = rPrDefault ? directChild(rPrDefault, "w:rPr") : null;
    map.set(DOC_DEFAULTS_KEY, readRunProps(rPr));
  }

  const styleEls = doc.getElementsByTagName("w:style");
  for (let i = 0; i < styleEls.length; i++) {
    const styleEl = styleEls[i];
    if (styleEl.getAttribute("w:type") !== "paragraph") continue;
    const styleId = styleEl.getAttribute("w:styleId");
    if (!styleId) continue;
    const basedOn = directChild(styleEl, "w:basedOn")?.getAttribute("w:val") ?? undefined;
    map.set(styleId, { basedOn, ...readRunProps(directChild(styleEl, "w:rPr")) });
  }

  return map;
}

// Resolves a styleId to its effective formatting, walking w:basedOn up to docDefaults for any
// field not directly defined - a style's own value always wins over an inherited one. `visited`
// guards against a malformed/circular basedOn chain.
function resolveStyle(styleId: string | undefined, styleMap: Map<string, StyleDef>, visited: Set<string> = new Set()): RunProps {
  const docDefaults = styleMap.get(DOC_DEFAULTS_KEY) ?? {};
  if (!styleId || visited.has(styleId)) return docDefaults;
  visited.add(styleId);
  const def = styleMap.get(styleId);
  if (!def) return docDefaults;
  const parent = resolveStyle(def.basedOn, styleMap, visited);
  return {
    color: def.color ?? parent.color ?? docDefaults.color,
    fontFamily: def.fontFamily ?? parent.fontFamily ?? docDefaults.fontFamily,
    fontSizeHalfPt: def.fontSizeHalfPt ?? parent.fontSizeHalfPt ?? docDefaults.fontSizeHalfPt,
  };
}

function getFirstRun(p: Element): Element | null {
  return directChildren(p, "w:r")[0] ?? null;
}

// Recursive, not just direct children of <w:body> - a table cell's or list item's own paragraphs
// are <w:p> elements nested under <w:tbl>/<w:tc> (Word has no separate "list"/"listItem" XML
// wrapper - even list paragraphs are flat <w:p> siblings at the body level, tagged with a
// <w:numPr> numbering reference, not nested), so a direct-children-only walk would silently
// misalign against mammoth's own nested list/table output the moment either appears - both are
// common, not edge cases (this app's own docx export produces both). Collecting every <w:p> in
// document order, regardless of nesting depth, keeps this resolver's output correlatable against
// a matching recursive walk of mammoth's ProseMirror tree (see docxImport.ts's applyParagraphStyles).
function collectParagraphs(el: Element, out: Element[]): void {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== 1) continue;
    const childEl = child as Element;
    if (childEl.tagName === "w:p") {
      out.push(childEl); // a <w:p> never contains a nested <w:p> in valid OOXML - no need to recurse into it
    } else {
      collectParagraphs(childEl, out);
    }
  }
}

// Best-effort: returns [] on any failure (missing parts, malformed XML) rather than throwing -
// this is a fidelity improvement layered on top of mammoth's own import, not a required step, so
// a document this can't parse should just fall back to today's "no extra styling" behavior instead
// of failing the whole import.
export async function resolveDocxParagraphStyles(fileBytes: Uint8Array): Promise<ParagraphStyle[]> {
  try {
    const zip = await JSZip.loadAsync(fileBytes);
    const documentXmlText = await zip.file("word/document.xml")?.async("text");
    const stylesXmlText = await zip.file("word/styles.xml")?.async("text");
    if (!documentXmlText || !stylesXmlText) return [];

    const styleMap = buildStyleMap(stylesXmlText);
    const documentDoc = new DOMParser().parseFromString(documentXmlText, "text/xml");
    const bodyEl = documentDoc.getElementsByTagName("w:body")[0];
    if (!bodyEl) return [];

    const paragraphEls: Element[] = [];
    collectParagraphs(bodyEl, paragraphEls);

    return paragraphEls.map((p) => {
      const pPr = directChild(p, "w:pPr");
      const pStyleId = pPr ? directChild(pPr, "w:pStyle")?.getAttribute("w:val") : undefined;
      const styled = resolveStyle(pStyleId ?? undefined, styleMap);
      // The paragraph's own first run may directly override its style's formatting (e.g. a
      // heading with its color manually changed) - direct formatting always wins.
      const firstRun = getFirstRun(p);
      const direct = readRunProps(firstRun ? directChild(firstRun, "w:rPr") : null);

      const color = direct.color ?? styled.color;
      const fontFamily = direct.fontFamily ?? styled.fontFamily;
      const fontSizeHalfPt = direct.fontSizeHalfPt ?? styled.fontSizeHalfPt;

      const result: ParagraphStyle = {};
      if (color) result.color = color;
      if (fontFamily) result.fontFamily = fontFamily;
      if (fontSizeHalfPt) result.fontSizePt = fontSizeHalfPt / 2;
      return result;
    });
  } catch (err) {
    console.error("Failed to resolve docx paragraph styles:", err);
    return [];
  }
}
