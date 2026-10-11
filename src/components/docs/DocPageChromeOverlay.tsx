// components/docs/DocPageChromeOverlay.tsx
//
// The header, footer and page number drawn in the margins of every sheet on screen, exactly where
// print puts them (docPageChrome.ts's printChromeCss: centred in the top and bottom margins,
// between the side margins). Sheet k starts at k * (page height + PAGE_GAP_PX) in both the
// single-column view (docAutoPaginate.ts keeps every sheet exactly one page tall) and the
// two-column view (.doc-sheet), so the bands are placed by arithmetic, not by measuring the text.
//
// Every margin band is a double-click target, filled or not - as in Word and Google Docs, that's
// how you get to the header or footer. Print draws its own copy (margin boxes), so this is
// print:hidden.
import React from "react";
import { CHROME_SLOTS, renderSlot, type ChromeBand, type DocPageChrome } from "../../utils/docPageChrome";
import { PAGE_GAP_PX, inToPx, pageHeightPx, type PageFormat } from "../../utils/docPageGeometry";
import type { DocMargins } from "../../utils/docTypes";

interface DocPageChromeOverlayProps {
  chrome: DocPageChrome;
  pageCount: number;
  page: PageFormat;
  margins: DocMargins;
  title: string;
  date: string;
  dark: boolean;
  onEdit: (band: ChromeBand) => void;
}

const DocPageChromeOverlay: React.FC<DocPageChromeOverlayProps> = ({ chrome, pageCount, page, margins, title, date, dark, onEdit }) => {
  const pitch = pageHeightPx(page) + PAGE_GAP_PX;
  const ctx = { title, date, pages: pageCount };
  const bands: React.ReactNode[] = [];
  for (let k = 0; k < pageCount; k++) {
    const blank = chrome.differentFirstPage && k === 0;
    for (const band of ["header", "footer"] as ChromeBand[]) {
      const height = inToPx(band === "header" ? margins.top : margins.bottom);
      const top = band === "header" ? k * pitch : k * pitch + pageHeightPx(page) - height;
      const texts = CHROME_SLOTS.map((slot) => (blank ? "" : renderSlot(chrome, band, slot, k + 1, ctx)));
      bands.push(
        <div
          key={`${band}-${k}`}
          className="doc-chrome-band group pointer-events-auto absolute grid grid-cols-[1fr_auto_1fr] items-center gap-3 print:hidden select-none"
          style={{ top, height, left: `${margins.left}in`, right: `${margins.right}in`, fontSize: `${chrome.fontSize}pt` }}
          onDoubleClick={(e) => {
            e.preventDefault();
            onEdit(band);
          }}
          title={`Double-click to edit the ${band}`}
        >
          {/* The hover outline marks the band as editable without cluttering the page. */}
          <span aria-hidden className="pointer-events-none absolute inset-x-[-6px] inset-y-1 rounded border border-dashed border-transparent group-hover:border-blue-400/60" />
          {texts.map((text, i) => (
            <span
              key={CHROME_SLOTS[i]}
              className={`min-w-0 truncate whitespace-pre ${i === 0 ? "text-left" : i === 1 ? "text-center" : "text-right"} ${dark ? "text-neutral-300" : "text-neutral-500"}`}
            >
              {text}
            </span>
          ))}
        </div>
      );
    }
  }
  return (
    <div aria-hidden className="absolute inset-0 z-[2] pointer-events-none print:hidden" style={{ fontFamily: "var(--doc-body-font, inherit)" }}>
      {bands}
    </div>
  );
};

export default DocPageChromeOverlay;
