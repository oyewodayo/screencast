// components/docs/DocPagePreview.tsx
//
// A miniature, read-only rendering of a document's first page - DocsHome's template cards and
// recent-document thumbnails. The HTML is laid out at real page width (8.5in at 96dpi) inside the
// same `.doc-page-card` classes and body-style variables the editor's page uses (docLayout.css), so
// a typeset paper, a two-column letter or a résumé with its own fonts looks like the real page,
// then scaled down to the card with a CSS transform.
//
// The parts the live editor draws with NodeViews and decorations are filled in here directly:
// math is typeset with KaTeX; citations, the reference list, caption labels, equation numbers and
// cross-references are numbered with the same formatter the editor uses (docCitationStyles.ts);
// a table of contents is built from the page's own headings; and rule-styled tables get the
// `.tableWrapper` the CSS expects.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./docStructure.css";
import "./docFonts.css";
import "./docLayout.css";
import "./docLinks.css";
import { docProseClassName } from "../../utils/docSchemaExtensions";
import { bodyStyleVars } from "../../utils/docLayout";
import { DEFAULT_PAGE, inToPx, isDarkPageColor, pageWidthPx } from "../../utils/docPageGeometry";
import { buildCitationContext, formatBibliography, formatCitation, styleInfo } from "../../utils/docCitationStyles";
import type { DocPreviewData } from "../../utils/docPreview";

const PAGE_MARGIN_PX = 72;

interface DocPagePreviewProps {
  // null while the caller is still loading the document - renders skeleton lines instead.
  preview: DocPreviewData | null;
  // Width / height of the visible window onto the page; the page itself is cropped at the bottom.
  aspectClassName?: string;
}

function el(tag: string, text: string, css?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (css) node.style.cssText = css;
  return node;
}

function finishPage(root: HTMLElement, preview: DocPreviewData): void {
  // Rule-styled tables: the editor's table NodeView wraps every table in .tableWrapper, and the
  // rule styles (booktabs, layout, ...) are written against that wrapper.
  root.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (table.parentElement?.classList.contains("tableWrapper")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "tableWrapper";
    for (const name of ["data-rules", "data-fit", "data-span", "data-space-before", "data-space-after", "style"]) {
      const value = table.getAttribute(name);
      if (value !== null) wrapper.setAttribute(name, value);
    }
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  });

  // Equations: typeset, and number the numbered display equations (1), (2), ...
  const equationNumbers = new Map<string, number>();
  let equation = 0;
  root.querySelectorAll<HTMLElement>("[data-math-block], [data-math-inline]").forEach((node) => {
    const latex = node.getAttribute("data-latex") ?? node.textContent ?? "";
    const display = node.hasAttribute("data-math-block");
    try {
      katex.render(latex, node, { throwOnError: false, displayMode: display });
    } catch {
      node.textContent = latex;
    }
    if (display && node.getAttribute("data-numbered") !== "false") {
      equation++;
      const id = node.getAttribute("data-id");
      if (id) equationNumbers.set(id, equation);
      node.style.position = "relative";
      node.appendChild(el("span", `(${equation})`, "position:absolute;right:0;top:50%;transform:translateY(-50%)"));
    }
  });

  // Captions: "Table 1." / "Figure 1." labels.
  const captionLabels = new Map<string, string>();
  const counts = { table: 0, figure: 0 };
  root.querySelectorAll<HTMLElement>(".doc-caption, p[data-caption]").forEach((caption) => {
    const kind = caption.getAttribute("data-caption") === "table" ? "table" : "figure";
    counts[kind]++;
    const label = `${kind === "table" ? "Table" : "Figure"} ${counts[kind]}`;
    caption.classList.add("doc-caption");
    caption.setAttribute("data-caption-label", `${label}.`);
    const id = caption.getAttribute("data-caption-id");
    if (id) captionLabels.set(id, label);
  });

  root.querySelectorAll<HTMLElement>("[data-xref]").forEach((xref) => {
    const id = xref.getAttribute("data-xref") ?? "";
    xref.textContent = captionLabels.get(id) ?? (equationNumbers.has(id) ? `Eq. (${equationNumbers.get(id)})` : "?");
  });

  // Citations and the reference list, numbered by first citation as the editor does.
  const byId = new Map(preview.references.map((r) => [r.id, r]));
  const lookup = (id: string) => byId.get(id);
  const citeNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-cite]"));
  const cited: string[] = [];
  for (const node of citeNodes) {
    for (const id of (node.getAttribute("data-cite") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) if (!cited.includes(id)) cited.push(id);
  }
  const ctx = buildCitationContext(cited, lookup, preview.citationStyle);
  for (const node of citeNodes) {
    const ids = (node.getAttribute("data-cite") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const citation = formatCitation(ids, node.getAttribute("data-locator"), lookup, ctx);
    node.replaceChildren(citation.superscript ? el("sup", citation.text) : document.createTextNode(`\u00a0${citation.text}`));
  }
  const numeric = styleInfo(preview.citationStyle).numeric;
  root.querySelectorAll<HTMLElement>("[data-bibliography]").forEach((list) => {
    list.replaceChildren(
      ...formatBibliography(ctx).map((ref) => {
        const line = document.createElement("p");
        line.style.cssText = numeric ? "margin:0.25em 0;padding-left:2.2em;text-indent:-2.2em;font-size:0.92em" : "margin:0.25em 0;padding-left:2em;text-indent:-2em;font-size:0.92em";
        if (ref.label) line.append(el("span", ref.label, "display:inline-block;width:2.2em;text-indent:0"));
        for (const s of ref.segments) line.append(el(s.italic ? "em" : s.bold ? "strong" : "span", s.text));
        return line;
      })
    );
  });

  root.querySelectorAll<HTMLElement>("[data-toc]").forEach((toc) => {
    const maxLevel = Number(toc.getAttribute("data-max-level")) || 3;
    const headings = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).filter((h) => Number(h.tagName[1]) <= maxLevel);
    toc.replaceChildren(
      el("p", "Contents", "font-weight:600;font-size:1.25em"),
      ...headings.map((h) => el("p", h.textContent ?? "", `margin:0.35em 0 0 ${(Number(h.tagName[1]) - 1) * 1.5}em;border-bottom:1px dotted currentColor;opacity:.75`))
    );
  });
}

const DocPagePreview: React.FC<DocPagePreviewProps> = ({ preview, aspectClassName = "aspect-[8.5/11]" }) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // The page is laid out at its real width - a landscape page is wider - then scaled to the card.
  const pageWidth = pageWidthPx(preview?.page ?? DEFAULT_PAGE);
  const [scale, setScale] = useState(0);
  const isMeasured = scale > 0;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => setScale(frame.clientWidth / pageWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pageWidth]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || !preview?.html) return;
    try {
      finishPage(root, preview);
    } catch (err) {
      console.error("Failed to finish document preview:", err);
    }
    // isMeasured too: the content div only mounts once the frame has been measured.
  }, [preview, isMeasured]);

  const layout = preview?.layout;
  const pageColor = preview?.pageColor ?? null;
  const pageDark = isDarkPageColor(pageColor);
  // Paper attributes shared by the frame (which paints the paper) and the page inside it (whose
  // leader dots and the like read the same --doc-paper).
  const paperAttrs = {
    "data-page-color": pageColor ?? undefined,
    "data-page-dark": pageDark ? "" : undefined,
  };
  const paperVars = pageColor ? ({ "--doc-page-color": pageColor } as React.CSSProperties) : undefined;
  const cardClass = [
    "doc-page-card",
    layout?.body ? "doc-typeset" : "",
    layout?.body?.justify ? "doc-justify" : "",
    layout?.body?.hyphenate ? "doc-hyphenate" : "",
    layout?.columns === 2 ? "doc-cols-2" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={frameRef}
      aria-hidden
      {...paperAttrs}
      style={paperVars}
      className={`doc-preview-paper relative w-full overflow-hidden pointer-events-none select-none ${aspectClassName}`}
    >
      {preview === null ? (
        <div className="absolute inset-0 p-[9%] flex flex-col gap-2 animate-pulse">
          <div className="h-2.5 w-2/3 rounded bg-gray-200 dark:bg-neutral-800" />
          <div className="h-1.5 w-full rounded bg-gray-100 dark:bg-neutral-800/70" />
          <div className="h-1.5 w-full rounded bg-gray-100 dark:bg-neutral-800/70" />
          <div className="h-1.5 w-4/5 rounded bg-gray-100 dark:bg-neutral-800/70" />
        </div>
      ) : (
        isMeasured && (
          <div
            {...paperAttrs}
            className={`${cardClass} ${docProseClassName}${pageDark ? " prose-invert" : ""}`}
            style={{
              ...(bodyStyleVars(layout?.body ?? null) as React.CSSProperties),
              ...paperVars,
              position: "absolute",
              top: 0,
              left: 0,
              width: pageWidth,
              padding: preview?.margins
                ? `${inToPx(preview.margins.top)}px ${inToPx(preview.margins.right)}px ${inToPx(preview.margins.bottom)}px ${inToPx(preview.margins.left)}px`
                : PAGE_MARGIN_PX * 0.75,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            {/* key: a new document replaces the whole subtree, since finishPage edits the DOM. */}
            {/* Balanced columns: the editor fills columns page by page from a fixed column height,
                which a cropped preview doesn't have. */}
            <div
              key={preview.html}
              ref={contentRef}
              className="ProseMirror"
              style={layout?.columns === 2 ? { columnFill: "balance" } : undefined}
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          </div>
        )
      )}
    </div>
  );
};

export default DocPagePreview;
