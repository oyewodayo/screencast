// components/whiteboard/WhiteboardIconGlyph.tsx
//
// Crisp 24x24 vector SVG renderer for Briefcast's shared `stickerIcons` catalog.
// Reused across the live Whiteboard canvas, left Tool Rail icon picker, and right Style Panel.

import React, { memo } from "react";
import { getStickerIconDef, StickerIcon } from "../../utils/stickerIcons";

interface WhiteboardIconGlyphProps {
  icon: StickerIcon | string | undefined;
  color?: string;
  strokeWidth?: number;
  className?: string;
  size?: number | string;
}

const WhiteboardIconGlyph: React.FC<WhiteboardIconGlyphProps> = memo(
  ({ icon, color = "currentColor", strokeWidth = 2.1, className, size = "100%" }) => {
    if (!icon || icon === "none") return null;

    if (icon === "briefcast") {
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          className={className}
          aria-hidden="true"
        >
          <defs>
            <mask id="wb-bc-bite">
              <rect x="0" y="0" width="24" height="24" fill="white" />
              <circle cx="2.2" cy="20.6" r="12.6" fill="black" />
            </mask>
          </defs>
          <rect x="1.7" y="3.4" width="20.6" height="17.2" rx="2.4" fill={color} mask="url(#wb-bc-bite)" />
          <path d="M2.4 10 A9.6 9.6 0 0 1 12 19.6" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
          <path d="M2.4 13.7 A5.9 5.9 0 0 1 8.3 19.6" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
          <path d="M2.4 17.3 A2.3 2.3 0 0 1 4.7 19.6" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
        </svg>
      );
    }

    const def = getStickerIconDef(icon);
    if (!def) return null;

    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        {def.paths.map((d, i) =>
          def.solid ? (
            <path key={i} d={d} fill={color} />
          ) : (
            <path
              key={i}
              d={d}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )
        )}
      </svg>
    );
  }
);

WhiteboardIconGlyph.displayName = "WhiteboardIconGlyph";

export default WhiteboardIconGlyph;
