// utils/docxHeaderFooter.ts
//
// A .docx's running header and footer, read into the document's page chrome (docPageChrome.ts):
// mammoth converts only the body, so without this an imported report loses its running title and
// its page numbers. Reads the last section's default header/footer parts (and its "different first
// page" switch), turns each paragraph into the band's left/centre/right slots - by tab-separated
// parts, else by the paragraph's alignment - and Word's PAGE / NUMPAGES fields into the chrome's
// {page} / {pages}. A slot that is only a page number ("3", "Page 3", "Page 3 of 9", "3 / 9",
// "- 3 -") becomes the chrome's own page-number setting, so it can be restyled in one click.
// Pictures in headers (letterhead logos) aren't carried: the chrome is text.
import type JSZip from "jszip";
import { DOMParser as XmlDOMParser } from "@xmldom/xmldom";
import { DEFAULT_PAGE_CHROME, normalizePageChrome, type ChromeBand, type ChromeSlot, type DocPageChrome, type PageNumberStyle } from "./docPageChrome";

const localName = (el: Element) => el.localName || el.tagName.replace(/^.*:/, "");
const childElements = (el: Element): Element[] => Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
const attrOf = (el: Element | null | undefined, name: string): string | null => {
  if (!el) return null;
  return el.getAttribute(name) ?? el.getAttribute(name.replace(/^.*:/, ""));
};

// One paragraph's text, with fields as {page}/{pages} and tabs kept as \t.
function paragraphText(p: Element): { text: string; align: string | null; sizePt: number | null } {
  let text = "";
  let sizePt: number | null = null;
  let inField: "instr" | "result" | null = null;
  let instr = "";
  const fieldToken = (code: string): string => {
    const c = code.trim().split(/\s+/)[0]?.toUpperCase();
    return c === "PAGE" ? "{page}" : c === "NUMPAGES" || c === "SECTIONPAGES" ? "{pages}" : c === "DATE" || c === "TIME" ? "{date}" : "";
  };
  const walk = (el: Element) => {
    for (const c of childElements(el)) {
      const n = localName(c);
      if (n === "pPr") continue;
      if (n === "fldSimple") {
        text += fieldToken(attrOf(c, "w:instr") ?? "") || "";
        continue;
      }
      if (n === "r") {
        const sz = attrOf(childElements(c).find((x) => localName(x) === "rPr")?.getElementsByTagName("w:sz")[0], "w:val");
        if (sz && sizePt === null) sizePt = parseInt(sz, 10) / 2;
        for (const rc of childElements(c)) {
          const rn = localName(rc);
          if (rn === "fldChar") {
            const t = attrOf(rc, "w:fldCharType");
            if (t === "begin") {
              inField = "instr";
              instr = "";
            } else if (t === "separate") {
              text += fieldToken(instr);
              inField = "result";
            } else if (t === "end") {
              if (inField === "instr") text += fieldToken(instr);
              inField = null;
            }
          } else if (rn === "instrText") {
            if (inField === "instr") instr += rc.textContent ?? "";
          } else if (inField === "result") {
            // The field's cached result ("3") - the token already stands for it.
          } else if (rn === "t") text += rc.textContent ?? "";
          else if (rn === "tab" || rn === "ptab") text += "\t";
        }
        continue;
      }
      if (n === "hyperlink" || n === "smartTag" || n === "ins" || n === "sdt" || n === "sdtContent") walk(c);
    }
  };
  walk(p);
  const pPr = childElements(p).find((x) => localName(x) === "pPr");
  const jc = attrOf(pPr?.getElementsByTagName("w:jc")[0], "w:val");
  return { text, align: jc, sizePt };
}

const PAGE_PATTERNS: { re: RegExp; style: PageNumberStyle }[] = [
  { re: /^\{page\}$/, style: "plain" },
  { re: /^page\s*\{page\}$/i, style: "page" },
  { re: /^page\s*\{page\}\s*of\s*\{pages\}$/i, style: "pageOf" },
  { re: /^\{page\}\s*(\/|of)\s*\{pages\}$/i, style: "slash" },
  { re: /^[-–—]\s*\{page\}\s*[-–—]$/, style: "dash" },
];

function bandSlots(xml: string): { slots: Record<ChromeSlot, string>; sizePt: number | null } {
  const doc = new XmlDOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  const slots: Record<ChromeSlot, string[]> = { left: [], center: [], right: [] };
  let sizePt: number | null = null;
  // Body-level paragraphs only (text boxes and tables inside a header are layout, not lines).
  const root = doc.documentElement;
  const paragraphs = childElements(root).filter((e) => localName(e) === "p");
  for (const p of paragraphs) {
    const { text, align, sizePt: sz } = paragraphText(p);
    if (sz && sizePt === null) sizePt = sz;
    const parts = text.split("\t").map((t) => t.replace(/\s+/g, " ").trim());
    const nonEmpty = parts.filter(Boolean);
    if (!nonEmpty.length) continue;
    if (parts.length >= 3) {
      if (parts[0]) slots.left.push(parts[0]);
      if (parts[1]) slots.center.push(parts[1]);
      const rest = parts.slice(2).filter(Boolean).join(" ");
      if (rest) slots.right.push(rest);
    } else if (parts.length === 2) {
      // "Title<tab>Page 3": the second part sits at the right tab stop of a header.
      if (parts[0]) slots.left.push(parts[0]);
      if (parts[1]) slots.right.push(parts[1]);
    } else {
      const slot: ChromeSlot = align === "center" ? "center" : align === "right" || align === "end" ? "right" : "left";
      slots[slot].push(nonEmpty[0]);
    }
  }
  return {
    slots: { left: slots.left.join(" · "), center: slots.center.join(" · "), right: slots.right.join(" · ") },
    sizePt,
  };
}

export async function resolveDocxPageChrome(zip: JSZip, docXml: Document): Promise<DocPageChrome | null> {
  const sectPrs = docXml.getElementsByTagName("w:sectPr");
  const sectPr = sectPrs[sectPrs.length - 1];
  if (!sectPr) return null;
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string");
  if (!relsXml) return null;
  const rels = new Map<string, string>();
  const relDoc = new XmlDOMParser().parseFromString(relsXml, "text/xml") as unknown as Document;
  for (const r of Array.from(relDoc.getElementsByTagName("Relationship"))) rels.set(r.getAttribute("Id") ?? "", r.getAttribute("Target") ?? "");

  // A section without its own header/footer continues the previous section's (Word's "Link to
  // previous"), so look back through the sections from the last.
  const refFor = (band: ChromeBand): string | null => {
    let pick: Element | undefined;
    for (let i = sectPrs.length - 1; i >= 0 && !pick; i--) {
      const refs = Array.from(sectPrs[i].getElementsByTagName(band === "header" ? "w:headerReference" : "w:footerReference"));
      pick = refs.find((r) => attrOf(r, "w:type") === "default") ?? refs.find((r) => attrOf(r, "w:type") !== "first" && attrOf(r, "w:type") !== "even");
    }
    const id = pick ? attrOf(pick, "r:id") : null;
    const target = id ? rels.get(id) : null;
    return target ? `word/${target.replace(/^\/?word\//, "").replace(/^\//, "")}` : null;
  };

  const chrome: DocPageChrome = JSON.parse(JSON.stringify(DEFAULT_PAGE_CHROME));
  let sizePt: number | null = null;
  for (const band of ["header", "footer"] as ChromeBand[]) {
    const path = refFor(band);
    const xml = path ? await zip.file(path)?.async("string") : null;
    if (!xml) continue;
    const { slots, sizePt: sz } = bandSlots(xml);
    if (sz && sizePt === null) sizePt = sz;
    for (const slot of ["left", "center", "right"] as ChromeSlot[]) {
      const text = slots[slot];
      const asNumber = !chrome.pageNumber.enabled ? PAGE_PATTERNS.find((p) => p.re.test(text)) : undefined;
      if (asNumber) {
        chrome.pageNumber = { ...chrome.pageNumber, enabled: true, position: `${band}-${slot}`, style: asNumber.style };
        chrome[band][slot] = "";
      } else chrome[band][slot] = text;
    }
  }
  const pgNumType = sectPr.getElementsByTagName("w:pgNumType")[0];
  const start = parseInt(attrOf(pgNumType, "w:start") ?? "", 10);
  if (Number.isFinite(start) && start > 0) chrome.pageNumber.start = start;
  const fmt = attrOf(pgNumType, "w:fmt");
  if (fmt === "lowerRoman") chrome.pageNumber.format = "lower-roman";
  else if (fmt === "upperRoman") chrome.pageNumber.format = "upper-roman";
  else if (fmt === "lowerLetter") chrome.pageNumber.format = "lower-alpha";
  else if (fmt === "upperLetter") chrome.pageNumber.format = "upper-alpha";
  chrome.differentFirstPage = sectPr.getElementsByTagName("w:titlePg").length > 0 && attrOf(sectPr.getElementsByTagName("w:titlePg")[0], "w:val") !== "0";
  if (sizePt) chrome.fontSize = sizePt;
  return normalizePageChrome(chrome);
}
