// utils/textFormatting.tsx
//
// Extracted from TextNoteEditor.tsx so it can be reused by both that component's own live
// backdrop (PDF text notes) and the video text-overlay preview layer's read-only rendering
// (VideoOverlayLayer) - it was always fully generic (plain text/ranges -> ReactNode, no PDF
// coupling), just previously local to one component.
import React from "react";
import { TextColorRun, TextRange } from "./pdfAnnotationTypes";
import type { CaretStyle } from "./textReveal";

// Splits `text` into colored/bold/italic <span> segments at every formatting boundary - the DOM
// counterpart to renderTextObject's canvas version in pdfAnnotationHandlers.ts, same boundary-cut
// approach, just emitting React nodes instead of fillText calls (the browser does the actual line
// wrapping here, via the caller's own CSS, rather than a manual wrapTextBlock pass).
// A typing caret that takes no room in the line (a zero-width anchor with the visible part
// absolutely positioned), so the text never shifts. Same shapes as export's drawCaret.
const CARET_SHAPES: Record<CaretStyle, React.CSSProperties> = {
  bar: { left: "-0.04em", top: 0, width: "0.08em", height: "1em" },
  block: { left: 0, top: 0, width: "0.55em", height: "1em", opacity: 0.8 },
  underscore: { left: 0, top: "0.85em", width: "0.55em", height: "0.1em" },
};
const Caret: React.FC<{ shape: CaretStyle }> = ({ shape }) => (
  <span style={{ display: "inline-block", position: "relative", width: 0, height: "1em", verticalAlign: "-0.12em" }}>
    <span style={{ position: "absolute", background: "currentColor", ...CARET_SHAPES[shape] }} />
  </span>
);

export function renderFormattedSegments(
  text: string,
  colorRuns: TextColorRun[],
  boldRuns: TextRange[],
  italicRuns: TextRange[],
  baseColor: string,
  // A letter-by-letter title reveal (textReveal.ts): each character gets its own span styled by
  // `charStyle`, and a typewriter caret is drawn just before index `caretAt`.
  reveal?: { charStyle: (index: number) => React.CSSProperties; caretAt: number | null; caretStyle?: CaretStyle }
): React.ReactNode {
  if (text.length === 0) return null;

  const cutSet = new Set<number>([0, text.length]);
  const addBoundaries = (ranges: TextRange[]): void => {
    for (const range of ranges) {
      cutSet.add(Math.max(0, Math.min(text.length, range.start)));
      cutSet.add(Math.max(0, Math.min(text.length, range.end)));
    }
  };
  addBoundaries(colorRuns);
  addBoundaries(boldRuns);
  addBoundaries(italicRuns);
  const cuts = Array.from(cutSet).sort((a, b) => a - b);

  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const color = colorRuns.find((run) => run.start <= start && run.end >= end)?.color ?? baseColor;
    const bold = boldRuns.some((run) => run.start <= start && run.end >= end);
    const italic = italicRuns.some((run) => run.start <= start && run.end >= end);
    const style: React.CSSProperties = { color, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" };
    if (!reveal) {
      nodes.push(
        <span key={start} style={style}>
          {segment}
        </span>
      );
      continue;
    }
    const chars: React.ReactNode[] = [];
    for (let j = 0; j < segment.length; j++) {
      if (reveal.caretAt === start + j) chars.push(<Caret key="caret" shape={reveal.caretStyle ?? "bar"} />);
      chars.push(
        <span key={j} style={reveal.charStyle(start + j)}>
          {segment[j]}
        </span>
      );
    }
    nodes.push(
      <span key={start} style={style}>
        {chars}
      </span>
    );
  }
  if (reveal && reveal.caretAt !== null && reveal.caretAt >= text.length) nodes.push(<Caret key="caret-end" shape={reveal.caretStyle ?? "bar"} />);
  return nodes;
}
