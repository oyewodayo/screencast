// utils/docPdfPage.ts
//
// One page of an imported PDF kept exactly as printed ("Exact pages" import, pdfImport/index.ts):
// the page rendered as an image, with the page's text laid over it in transparent, positioned
// spans - the way pdf.js's own viewer does it - so the text can still be selected, copied and read
// by a screen reader. The page is one block exactly a page tall; the document around it has zero
// margins, so each PDF page is one sheet.
//
// attrs.text holds the text runs as [text, x, y, size, width] tuples in PDF points (y = baseline
// from the page top) - compact, since a page has hundreds of runs.
import { Node, mergeAttributes } from "@tiptap/core";

export type PdfTextRun = [string, number, number, number, number];

const PX_PER_PT = 96 / 72;

export const DocPdfPage = Node.create({
  name: "pdfPage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: null },
      page: { default: 1 },
      width: { default: 612 }, // pt
      height: { default: 792 },
      text: {
        default: [],
        parseHTML: (el: HTMLElement) => {
          try {
            return JSON.parse(el.getAttribute("data-text") ?? "[]");
          } catch {
            return [];
          }
        },
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-text": JSON.stringify(attrs.text ?? []) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-pdf-page]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-pdf-page": String(node.attrs.page) }),
      ["img", { src: node.attrs.src, alt: `Page ${node.attrs.page}`, style: `width:${node.attrs.width}pt;height:${node.attrs.height}pt;display:block` }],
    ];
  },

  renderText({ node }) {
    return ((node.attrs.text as PdfTextRun[]) ?? []).map((r) => r[0]).join(" ");
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "doc-pdf-page";
      dom.contentEditable = "false";
      dom.dataset.pdfPage = String(node.attrs.page);
      const w = Number(node.attrs.width) * PX_PER_PT;
      const h = Number(node.attrs.height) * PX_PER_PT;
      dom.style.width = `${w}px`;
      dom.style.height = `${h}px`;
      const img = document.createElement("img");
      img.src = String(node.attrs.src ?? "");
      img.alt = "";
      img.draggable = false;
      img.className = "doc-pdf-page-image";
      dom.appendChild(img);
      const layer = document.createElement("div");
      layer.className = "doc-pdf-page-text";
      layer.setAttribute("aria-label", `Page ${node.attrs.page}`);
      // Spans are created once and stretched to their run's printed width after layout, so a
      // selection covers the same words the image shows.
      const spans: { el: HTMLSpanElement; width: number }[] = [];
      for (const [text, x, y, size, width] of (node.attrs.text as PdfTextRun[]) ?? []) {
        const span = document.createElement("span");
        span.textContent = text;
        span.style.left = `${x * PX_PER_PT}px`;
        span.style.top = `${(y - 0.83 * size) * PX_PER_PT}px`;
        span.style.fontSize = `${size * PX_PER_PT}px`;
        layer.appendChild(span);
        spans.push({ el: span, width: width * PX_PER_PT });
      }
      dom.appendChild(layer);
      requestAnimationFrame(() => {
        for (const s of spans) {
          const natural = s.el.getBoundingClientRect().width / (dom.getBoundingClientRect().width / w || 1);
          if (natural > 0 && s.width > 0) s.el.style.transform = `scaleX(${s.width / natural})`;
        }
      });
      return { dom, ignoreMutation: () => true, stopEvent: (e) => e.type.startsWith("mouse") || e.type === "selectstart" || e.type === "copy" };
    };
  },
});

export default DocPdfPage;
