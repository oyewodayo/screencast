// utils/textFormatting.tsx
//
// Extracted from TextNoteEditor.tsx so it can be reused by both that component's own live
// backdrop (PDF text notes) and the video text-overlay preview layer's read-only rendering
// (VideoOverlayLayer) - it was always fully generic (plain text/ranges -> ReactNode, no PDF
// coupling), just previously local to one component.
import React from "react";
import { TextColorRun, TextRange } from "./pdfAnnotationTypes";

// Splits `text` into colored/bold/italic <span> segments at every formatting boundary - the DOM
// counterpart to renderTextObject's canvas version in pdfAnnotationHandlers.ts, same boundary-cut
// approach, just emitting React nodes instead of fillText calls (the browser does the actual line
// wrapping here, via the caller's own CSS, rather than a manual wrapTextBlock pass).
export function renderFormattedSegments(
  text: string,
  colorRuns: TextColorRun[],
  boldRuns: TextRange[],
  italicRuns: TextRange[],
  baseColor: string
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
    nodes.push(
      <span key={start} style={{ color, fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal" }}>
        {segment}
      </span>
    );
  }
  return nodes;
}
