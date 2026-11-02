// utils/docxTextBoxes.ts
//
// Text boxes in a .docx body, made into text the editor can hold. mammoth reads a text box only
// through its VML fallback and nests its paragraphs inside the paragraph that anchors it, so they
// arrive run together, unstyled, and out of step with docxStyleResolver.ts's paragraph list. So,
// before anything reads the document, each text box's paragraphs are lifted out to the body right
// after their anchor paragraph - real paragraphs, with their own styles, in reading order - and
// text boxes standing side by side (a signature block for two signatories, a two-column address)
// become one borderless table row, left to right, so the layout survives as well as the words.
// Pictures and shapes without text are left alone (docxImport.ts / docxLetterhead.ts handle them).
import JSZip from "jszip";
import { DOMParser as XmlDOMParser, XMLSerializer as XmlSerializer } from "@xmldom/xmldom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const local = (el: Element) => el.localName || el.tagName.replace(/^.*:/, "");
const kids = (el: Element): Element[] => Array.from(el.childNodes as unknown as ArrayLike<Node>).filter((n): n is Element => n.nodeType === 1);
const descendants = (el: Element, name: string): Element[] => {
  const out: Element[] = [];
  const walk = (e: Element) => {
    for (const c of kids(e)) {
      if (local(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
};

interface Box {
  holder: Element; // the run child to remove (mc:AlternateContent, w:drawing or w:pict)
  content: Element; // w:txbxContent
  x: number; // EMU, for left-to-right order
  y: number;
  w: number;
  h: number;
}

const emu = (v: string | null) => parseInt(v ?? "0", 10) || 0;

function boxesIn(p: Element): Box[] {
  const out: Box[] = [];
  for (const r of kids(p).filter((c) => local(c) === "r" || local(c) === "hyperlink")) {
    for (const holder of kids(r)) {
      const kind = local(holder);
      if (kind !== "AlternateContent" && kind !== "drawing" && kind !== "pict") continue;
      // The DrawingML text box (mc:Choice) when there is one, else the VML one.
      const choice = kind === "AlternateContent" ? kids(holder).find((c) => local(c) === "Choice") : null;
      const scope = choice ?? (kind === "AlternateContent" ? kids(holder).find((c) => local(c) === "Fallback") : holder);
      if (!scope) continue;
      const content = descendants(scope, "txbxContent")[0];
      if (!content) continue;
      // An empty text box is a frame or a decoration, not text: leave it where it is.
      if (!(content.textContent ?? "").trim() && !descendants(content, "drawing").length) continue;
      const anchor = descendants(scope, "anchor")[0];
      const ext = anchor ? descendants(anchor, "extent")[0] : null;
      const off = (axis: string) => {
        const pos = anchor ? descendants(anchor, axis)[0] : null;
        const o = pos ? descendants(pos, "posOffset")[0] : null;
        return emu(o?.textContent ?? null);
      };
      // VML: style="margin-left:..pt;margin-top:..pt;width:..pt;height:..pt"
      const shape = !anchor ? (descendants(scope, "shape")[0] ?? descendants(scope, "rect")[0]) : null;
      const style = shape?.getAttribute("style") ?? "";
      const pt = (name: string) => {
        const m = style.match(new RegExp(`${name}:\\s*(-?[\\d.]+)pt`));
        return m ? parseFloat(m[1]) * 12700 : 0;
      };
      out.push({
        holder,
        content,
        x: anchor ? off("positionH") : pt("margin-left"),
        y: anchor ? off("positionV") : pt("margin-top"),
        w: ext ? emu(ext.getAttribute("cx")) : pt("width"),
        h: ext ? emu(ext.getAttribute("cy")) : pt("height"),
      });
    }
  }
  return out;
}

function el(doc: Document, name: string, attrs: Record<string, string> = {}): Element {
  const e = doc.createElementNS(W_NS, `w:${name}`);
  for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W_NS, `w:${k}`, v);
  return e;
}

// The blocks a text box holds (its paragraphs and tables), copied for the body.
const blocksOf = (content: Element) => kids(content).filter((c) => local(c) === "p" || local(c) === "tbl").map((c) => c.cloneNode(true) as Element);

// A borderless one-row table holding side-by-side text boxes.
function rowTable(doc: Document, boxes: Box[]): Element {
  const tbl = el(doc, "tbl");
  const tblPr = el(doc, "tblPr");
  const borders = el(doc, "tblBorders");
  for (const side of ["top", "left", "bottom", "right", "insideH", "insideV"]) borders.appendChild(el(doc, side, { val: "nil" }));
  tblPr.appendChild(borders);
  tbl.appendChild(tblPr);
  const grid = el(doc, "tblGrid");
  const twips = (e: number) => String(Math.max(400, Math.round(e / 635)));
  for (const b of boxes) grid.appendChild(el(doc, "gridCol", { w: twips(b.w) }));
  tbl.appendChild(grid);
  const tr = el(doc, "tr");
  for (const b of boxes) {
    const tc = el(doc, "tc");
    const tcPr = el(doc, "tcPr");
    tcPr.appendChild(el(doc, "tcW", { w: twips(b.w), type: "dxa" }));
    tc.appendChild(tcPr);
    const blocks = blocksOf(b.content);
    if (!blocks.some((x) => local(x) === "p")) blocks.push(el(doc, "p"));
    blocks.forEach((x) => tc.appendChild(x));
    tr.appendChild(tc);
  }
  tbl.appendChild(tr);
  return tbl;
}

export async function flattenTextBoxes(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/document.xml");
  const xml = await file?.async("string");
  if (!xml || !xml.includes("txbxContent")) return bytes;
  const doc = new XmlDOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const body = doc.getElementsByTagName("w:body")[0] as Element | undefined;
  if (!body) return bytes;
  let changed = false;
  // Body paragraphs and table-cell paragraphs, but not paragraphs that are themselves inside a
  // text box (those move with their box).
  const paragraphs = descendants(body, "p").filter((p) => {
    for (let a = p.parentNode as Element | null; a && a !== body; a = a.parentNode as Element | null) if (local(a) === "txbxContent") return false;
    return true;
  });
  for (const p of paragraphs) {
    const boxes = boxesIn(p);
    if (!boxes.length) continue;
    changed = true;
    for (const b of boxes) b.holder.parentNode?.removeChild(b.holder);
    // Rows: boxes whose vertical extents overlap stand side by side.
    const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
    const rows: Box[][] = [];
    for (const b of sorted) {
      const row = rows.find((r) => r.some((o) => b.y < o.y + o.h * 0.8 && o.y < b.y + b.h * 0.8));
      if (row) row.push(b);
      else rows.push([b]);
    }
    const insert: Element[] = [];
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      if (row.length === 1) insert.push(...blocksOf(row[0].content));
      else insert.push(rowTable(doc, row));
    }
    const parent = p.parentNode as Element;
    const ref: Node | null = p.nextSibling;
    for (const node of insert) parent.insertBefore(node, ref);
    // A table directly inside a table cell must be followed by a paragraph (Word's rule).
    if (local(parent) === "tc" && insert.length && local(insert[insert.length - 1]) === "tbl" && (!ref || local(ref as Element) !== "p")) parent.insertBefore(el(doc, "p"), ref);
  }
  if (!changed) return bytes;
  zip.file("word/document.xml", new XmlSerializer().serializeToString(doc as unknown as Node));
  return zip.generateAsync({ type: "uint8array" });
}
