// components/docs/DocImageIcons.tsx
//
// Small pictograms for the picture layouts (docImageLayout.ts) and alignments: grey text lines
// round a blue picture, so each choice shows what it does to the text - the same idea as Word's
// and Docs' wrap icons, drawn to match this toolbar's 18px icons.
import React from "react";
import type { ImageAlign, ImageLayout } from "../../utils/docImageLayout";

const LINE = "currentColor";
const PIC = "#3b82f6";

const Lines: React.FC<{ rows: [number, number, number][] }> = ({ rows }) => (
  <>
    {rows.map(([x, y, w], i) => (
      <rect key={i} x={x} y={y} width={w} height={1.6} rx={0.8} fill={LINE} opacity={0.55} />
    ))}
  </>
);

export const LayoutIcon: React.FC<{ layout: ImageLayout; size?: number }> = ({ layout, size = 18 }) => {
  const body = (() => {
    switch (layout) {
      case "inline":
        return (
          <>
            <Lines rows={[[2, 3, 16], [2, 15.5, 16]]} />
            <rect x={2} y={9} width={3} height={1.6} rx={0.8} fill={LINE} opacity={0.55} />
            <rect x={6} y={6.5} width={6} height={6} rx={1} fill={PIC} />
            <rect x={13} y={11} width={5} height={1.6} rx={0.8} fill={LINE} opacity={0.55} />
          </>
        );
      case "block":
        return (
          <>
            <Lines rows={[[2, 2.5, 16], [2, 16, 16]]} />
            <rect x={5.5} y={5.5} width={9} height={8} rx={1} fill={PIC} />
          </>
        );
      case "wrapLeft":
        return (
          <>
            <rect x={2} y={4} width={7} height={7} rx={1} fill={PIC} />
            <Lines rows={[[11, 4, 7], [11, 7.5, 7], [11, 11, 7], [2, 14.5, 16]]} />
          </>
        );
      case "wrapRight":
        return (
          <>
            <rect x={11} y={4} width={7} height={7} rx={1} fill={PIC} />
            <Lines rows={[[2, 4, 7], [2, 7.5, 7], [2, 11, 7], [2, 14.5, 16]]} />
          </>
        );
      case "front":
        return (
          <>
            <Lines rows={[[2, 3, 16], [2, 7, 16], [2, 11, 16], [2, 15, 16]]} />
            <rect x={6} y={5} width={8} height={8} rx={1} fill={PIC} stroke="white" strokeWidth={1} />
          </>
        );
      case "behind":
        return (
          <>
            <rect x={6} y={5} width={8} height={8} rx={1} fill={PIC} opacity={0.45} />
            <Lines rows={[[2, 3, 16], [2, 7, 16], [2, 11, 16], [2, 15, 16]]} />
          </>
        );
    }
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      {body}
    </svg>
  );
};

export const AlignIcon: React.FC<{ align: ImageAlign; size?: number }> = ({ align, size = 18 }) => {
  const x = align === "left" ? 2 : align === "center" ? 6 : 10;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <rect x={x} y={5.5} width={8} height={7} rx={1} fill={PIC} />
      <rect x={2} y={2.5} width={16} height={1.6} rx={0.8} fill={LINE} opacity={0.55} />
      <rect x={2} y={15} width={16} height={1.6} rx={0.8} fill={LINE} opacity={0.55} />
    </svg>
  );
};
