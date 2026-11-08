// components/docs/DocLetterheadOverlay.tsx
//
// The letterhead on every drawn sheet - page 1's sheet on the first page, the continuation sheet
// on the rest (docLetterhead.ts). The same SVGs print uses as @page backgrounds. Drawn over the
// text like the watermark (DocWatermarkOverlay.tsx), because the page-break gaps paint paper over
// the card exactly where a letterhead's header and footer bands sit; multiply makes it read as
// printed underneath - on white paper it only darkens, so black text stays black.
import React from "react";
import { pageHeightPx, type PageFormat } from "../../utils/docPageGeometry";
import useDocSheets from "../../hooks/useDocSheets";

interface Props {
  firstUrl: string;
  restUrl: string;
  pageCount: number;
  page: PageFormat;
  dark: boolean;
}

const DocLetterheadOverlay: React.FC<Props> = ({ firstUrl, restUrl, pageCount, page, dark }) => {
  // At each sheet's real top (useDocSheets) - a long table can make a sheet taller than a page.
  const { sheets, ref: rootRef } = useDocSheets(pageCount, page);
  if (!firstUrl && !restUrl) return null;
  const height = pageHeightPx(page);
  return (
    <div ref={rootRef} aria-hidden className="doc-letterhead-layer absolute inset-0 z-[1] pointer-events-none overflow-hidden print:hidden">
      {Array.from({ length: pageCount }, (_, k) => {
        const url = k === 0 ? firstUrl : restUrl;
        if (!url) return null;
        return (
          <div
            key={k}
            className="absolute inset-x-0"
            style={{ top: sheets[k]?.top ?? 0, height, backgroundImage: `url("${url}")`, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat", mixBlendMode: dark ? "normal" : "multiply" }}
          />
        );
      })}
    </div>
  );
};

export default DocLetterheadOverlay;
