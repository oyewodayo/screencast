// components/docs/DocWatermarkOverlay.tsx
//
// The watermark on every drawn sheet - the same SVG print uses as its @page background
// (docWatermark.ts). Drawn over the text rather than under it, because the page-break gaps
// (docAutoPaginate.ts) paint paper over the card; the blend mode makes it look behind the text
// anyway: multiply on a light page only darkens the paper (black text stays black), screen on a
// dark page only lightens it.
import React from "react";
import { PAGE_GAP_PX, pageHeightPx, type PageFormat } from "../../utils/docPageGeometry";

interface DocWatermarkOverlayProps {
  dataUrl: string;
  pageCount: number;
  page: PageFormat;
  skipFirstPage: boolean;
  dark: boolean;
}

const DocWatermarkOverlay: React.FC<DocWatermarkOverlayProps> = ({ dataUrl, pageCount, page, skipFirstPage, dark }) => {
  if (!dataUrl) return null;
  const height = pageHeightPx(page);
  const pitch = height + PAGE_GAP_PX;
  return (
    <div aria-hidden className="absolute inset-0 z-[1] pointer-events-none overflow-hidden print:hidden">
      {Array.from({ length: pageCount }, (_, k) =>
        skipFirstPage && k === 0 ? null : (
          <div
            key={k}
            className="absolute inset-x-0"
            style={{
              top: k * pitch,
              height,
              backgroundImage: `url("${dataUrl}")`,
              backgroundSize: "100% 100%",
              backgroundRepeat: "no-repeat",
              mixBlendMode: dark ? "screen" : "multiply",
            }}
          />
        )
      )}
    </div>
  );
};

export default DocWatermarkOverlay;
