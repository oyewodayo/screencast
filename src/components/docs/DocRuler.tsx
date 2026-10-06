// components/docs/DocRuler.tsx
//
// Google-Docs-style rulers for the Docs editor.
//
//   DocHorizontalRuler - sticky at the top of the page scroller, exactly as wide as the page card.
//     Grey zones are the left/right page margins (drag their inner edge to change them). The three
//     markers are the current paragraph's indents: first-line (top bar), left (bottom triangle),
//     right (bottom triangle on the right).
//   DocVerticalRuler - pinned to the left edge of the scroller, tracking whichever page is at the
//     top of the view, with draggable top/bottom margins.
//
// "Smart" behaviour while dragging anything:
//   - snaps to the ruler grid (1/8 in, or 0.25 cm), and to the other markers / the margin edge when
//     within a few pixels of them (the guide line turns solid when it has locked onto one);
//   - hold Alt for free positioning at 0.01 precision;
//   - a tooltip shows the exact value, and a guide line runs down (or across) the page;
//   - Escape cancels the drag and restores the old value;
//   - dragging the left indent keeps the first line where it is (Docs' behaviour); hold Shift to
//     move both together.
// Precision without the mouse: every marker is a focusable slider - arrows step by the grid, Alt+
// arrows by 0.01, Shift+arrows by a half inch / 1 cm; double-click a marker to type exact
// indentation values, double-click a margin zone to open Page setup. The unit button on the left
// switches inches/centimetres (remembered).
//
// Positions are measured from the live DOM - the paragraph's real left/right edges and its
// computed text-indent - so markers sit exactly where the text is, including inside lists and
// for older documents whose indents are stored in the legacy em-based form.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { DocMargins, DocPageSize } from "../../utils/docTypes";
import { PAGE_DIMENSIONS_IN, PAGE_GAP_PX, PX_PER_IN, clampMargin, pageHeightPx } from "../../utils/docPageGeometry";
import { effectiveLeftIn } from "../../utils/docIndentExtension";

export type RulerUnit = "in" | "cm";

const UNIT_STORAGE_KEY = "briefcast.docs.rulerUnit";
const CM_PER_IN = 2.54;
const SNAP_PX = 5;
export const RULER_SIZE = 24;

const UNIT_INFO: Record<RulerUnit, { gridIn: number; labelEveryIn: number; minorIn: number; halfIn: number; label: string }> = {
  // grid = snap step; ticks every minor, taller ticks every half unit, numbers every unit
  in: { gridIn: 1 / 8, labelEveryIn: 1, minorIn: 1 / 8, halfIn: 1 / 2, label: "in" },
  cm: { gridIn: 0.25 / CM_PER_IN, labelEveryIn: 1 / CM_PER_IN, minorIn: 0.25 / CM_PER_IN, halfIn: 0.5 / CM_PER_IN, label: "cm" },
};

function defaultUnit(): RulerUnit {
  try {
    const stored = localStorage.getItem(UNIT_STORAGE_KEY);
    if (stored === "in" || stored === "cm") return stored;
  } catch {
    // storage unavailable
  }
  // Inches where the locale uses them (US, Liberia, Myanmar), centimetres elsewhere.
  return /-(US|LR|MM)$/i.test(navigator.language) ? "in" : "cm";
}

export function useRulerUnit(): [RulerUnit, (u: RulerUnit) => void] {
  const [unit, setUnitState] = useState<RulerUnit>(defaultUnit);
  const setUnit = useCallback((u: RulerUnit) => {
    setUnitState(u);
    try {
      localStorage.setItem(UNIT_STORAGE_KEY, u);
    } catch {
      // per-viewer convenience only
    }
  }, []);
  return [unit, setUnit];
}

export function formatLength(inches: number, unit: RulerUnit): string {
  const v = unit === "in" ? inches : inches * CM_PER_IN;
  return `${(Math.round(v * 100) / 100).toFixed(2)} ${unit}`;
}

// Value in inches -> snapped value. `free` (Alt) rounds to 0.01 of the display unit; otherwise a
// nearby candidate (another marker, the margin edge) wins over the grid.
function snapValue(valueIn: number, unit: RulerUnit, free: boolean, candidatesIn: number[]): { value: number; locked: boolean } {
  if (free) {
    const step = unit === "in" ? 0.01 : 0.01 / CM_PER_IN;
    return { value: Math.round(valueIn / step) * step, locked: false };
  }
  for (const c of candidatesIn) {
    if (Math.abs(c - valueIn) * PX_PER_IN <= SNAP_PX) return { value: c, locked: true };
  }
  const grid = UNIT_INFO[unit].gridIn;
  return { value: Math.round(valueIn / grid) * grid, locked: false };
}

function keyStep(e: React.KeyboardEvent, unit: RulerUnit): number | null {
  const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!dir) return null;
  const base = e.altKey ? (unit === "in" ? 0.01 : 0.01 / CM_PER_IN) : e.shiftKey ? (unit === "in" ? 0.5 : 1 / CM_PER_IN) : UNIT_INFO[unit].gridIn;
  return dir * base;
}

// Tick marks for `lengthIn` of ruler, numbered from `zeroIn` (the left/top margin), like Docs.
function Ticks({ lengthIn, zeroIn, unit, vertical }: { lengthIn: number; zeroIn: number; unit: RulerUnit; vertical?: boolean }) {
  const info = UNIT_INFO[unit];
  const items: React.ReactNode[] = [];
  const start = -Math.floor(zeroIn / info.minorIn);
  const end = Math.ceil((lengthIn - zeroIn) / info.minorIn);
  for (let i = start; i <= end; i++) {
    const posIn = zeroIn + i * info.minorIn;
    if (posIn < 0 || posIn > lengthIn) continue;
    const p = posIn * PX_PER_IN;
    const rel = i * info.minorIn;
    const isLabel = Math.abs(rel / info.labelEveryIn - Math.round(rel / info.labelEveryIn)) < 1e-6;
    const isHalf = !isLabel && Math.abs(rel / info.halfIn - Math.round(rel / info.halfIn)) < 1e-6;
    if (isLabel && i !== 0) {
      const n = Math.abs(Math.round(rel / info.labelEveryIn));
      items.push(
        vertical ? (
          <text key={i} x={RULER_SIZE / 2} y={p} dy="0.35em" textAnchor="middle" className="fill-neutral-500 dark:fill-neutral-400 text-[9px]" transform={`rotate(-90 ${RULER_SIZE / 2} ${p})`}>
            {n}
          </text>
        ) : (
          <text key={i} x={p} y={RULER_SIZE / 2} dy="0.35em" textAnchor="middle" className="fill-neutral-500 dark:fill-neutral-400 text-[9px]">
            {n}
          </text>
        )
      );
    } else if (i !== 0) {
      const len = isHalf ? 6 : 3;
      items.push(
        vertical ? (
          <line key={i} x1={(RULER_SIZE - len) / 2} x2={(RULER_SIZE + len) / 2} y1={p} y2={p} className="stroke-neutral-400 dark:stroke-neutral-500" strokeWidth={1} />
        ) : (
          <line key={i} x1={p} x2={p} y1={(RULER_SIZE - len) / 2} y2={(RULER_SIZE + len) / 2} className="stroke-neutral-400 dark:stroke-neutral-500" strokeWidth={1} />
        )
      );
    }
  }
  return <>{items}</>;
}

interface DragState {
  kind: string;
  valueIn: number; // the value being edited, in inches
  posPx: number; // where the guide/tooltip sits along the ruler
  locked: boolean;
  label: string;
}

// Shared pointer-drag plumbing: capture, live value via `compute`, Escape to cancel, commit on up.
function useRulerDrag() {
  const [drag, setDrag] = useState<DragState | null>(null);
  const cancelRef = useRef(false);

  const begin = useCallback(
    (
      e: React.PointerEvent,
      axis: "x" | "y",
      compute: (deltaPx: number, ev: PointerEvent) => DragState,
      commit: (state: DragState, ev: PointerEvent) => void
    ) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const start = axis === "x" ? e.clientX : e.clientY;
      cancelRef.current = false;
      let last: DragState = compute(0, e.nativeEvent);
      setDrag(last);
      const move = (ev: PointerEvent) => {
        if (cancelRef.current) return;
        last = compute((axis === "x" ? ev.clientX : ev.clientY) - start, ev);
        setDrag(last);
      };
      const key = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          cancelRef.current = true;
          setDrag(null);
        }
      };
      const up = (ev: PointerEvent) => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key, true);
        setDrag(null);
        if (!cancelRef.current && ev.type === "pointerup") commit(last, ev);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
      window.addEventListener("keydown", key, true);
    },
    []
  );
  return { drag, begin };
}

// ------------------------------------------------------------------------------------------------
// Paragraph indents at the cursor

interface ParagraphMetrics {
  pos: number;
  node: PMNode;
  leftIn: number; // attribute values (what a drag edits)
  rightIn: number;
  firstIn: number;
  leftPx: number; // where the text actually is, relative to the page's left edge
  rightPx: number;
  firstPx: number;
}

function readParagraph(editor: Editor, pageEl: HTMLElement | null): ParagraphMetrics | null {
  // useEditor replaces the first editor instance with the Collaboration-bound one right after a doc
  // loads, so the ruler can briefly hold a destroyed editor - whose view.nodeDOM() throws ("reading
  // 'descAt'" of a null docView) and took the whole document view down.
  if (!pageEl || editor.isDestroyed) return null;
  try {
    return measureParagraph(editor, pageEl);
  } catch {
    return null; // a measurement is never worth crashing the editor over
  }
}

function measureParagraph(editor: Editor, pageEl: HTMLElement): ParagraphMetrics | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name !== "paragraph" && node.type.name !== "heading") continue;
    // Paragraphs inside table cells follow the cell, not the page - no indent markers there.
    for (let up = d - 1; up > 0; up--) if (["tableCell", "tableHeader", "codeBlock"].includes($from.node(up).type.name)) return null;
    const pos = $from.before(d);
    const dom = editor.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;
    const page = pageEl.getBoundingClientRect();
    const rect = dom.getBoundingClientRect();
    const textIndent = parseFloat(getComputedStyle(dom).textIndent) || 0;
    return {
      pos,
      node,
      leftIn: effectiveLeftIn(node),
      rightIn: (node.attrs.indentRight as number | null) ?? 0,
      firstIn: (node.attrs.indentFirst as number | null) ?? 0,
      leftPx: rect.left - page.left,
      rightPx: rect.right - page.left,
      firstPx: rect.left - page.left + textIndent,
    };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Horizontal ruler

export interface DocHorizontalRulerProps {
  editor: Editor;
  pageSize: DocPageSize;
  margins: DocMargins;
  unit: RulerUnit;
  onUnitChange: (u: RulerUnit) => void;
  onMarginsChange: (m: DocMargins) => void;
  onOpenPageSetup: () => void;
  // The page card - indent markers are measured against it.
  pageRef: React.RefObject<HTMLDivElement | null>;
  // How far the guide line should reach down (the scroller's visible height).
  guideLengthPx: number;
}

export const DocHorizontalRuler: React.FC<DocHorizontalRulerProps> = ({
  editor,
  pageSize,
  margins,
  unit,
  onUnitChange,
  onMarginsChange,
  onOpenPageSetup,
  pageRef,
  guideLengthPx,
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [widthPx, setWidthPx] = useState(() => PAGE_DIMENSIONS_IN[pageSize].width * PX_PER_IN);
  const [para, setPara] = useState<ParagraphMetrics | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const { drag, begin } = useRulerDrag();

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidthPx(el.getBoundingClientRect().width));
    ro.observe(el);
    setWidthPx(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Re-measure the paragraph after every editor update (selection moves, typing, indent changes).
  useLayoutEffect(() => {
    const measure = () => setPara(readParagraph(editor, pageRef.current));
    measure();
    editor.on("transaction", measure);
    return () => {
      editor.off("transaction", measure);
    };
  }, [editor, pageRef]);
  // ...and when the page reflows (margins, width).
  useEffect(() => {
    setPara(readParagraph(editor, pageRef.current));
  }, [editor, pageRef, margins, widthPx]);

  const leftPx = margins.left * PX_PER_IN;
  const rightPx = widthPx - margins.right * PX_PER_IN;
  const lengthIn = widthPx / PX_PER_IN;

  const startMarginDrag = (side: "left" | "right") => (e: React.PointerEvent) => {
    const startIn = margins[side];
    begin(
      e,
      "x",
      (dx, ev) => {
        const raw = startIn + (side === "left" ? dx : -dx) / PX_PER_IN;
        const { value, locked } = snapValue(raw, unit, ev.altKey, []);
        const v = clampMargin(pageSize, margins, side, value);
        return {
          kind: `margin-${side}`,
          valueIn: v,
          posPx: side === "left" ? v * PX_PER_IN : widthPx - v * PX_PER_IN,
          locked,
          label: `${side === "left" ? "Left" : "Right"} margin: ${formatLength(v, unit)}`,
        };
      },
      (s) => s.valueIn !== startIn && onMarginsChange({ ...margins, [side]: s.valueIn })
    );
  };

  const applyIndent = useCallback(
    (patch: { left?: number; right?: number; first?: number }) => {
      if (!para) return;
      editor.chain().focus().setParagraphIndent(patch).run();
    },
    [editor, para]
  );

  const maxColumnIn = (rightPx - leftPx) / PX_PER_IN - 0.5;

  const startIndentDrag = (kind: "left" | "first" | "right") => (e: React.PointerEvent) => {
    if (!para) return;
    const p = para;
    // Candidate snap positions (absolute, inches from the page's left edge) for smart alignment.
    const abs = { margin: margins.left, left: p.leftPx / PX_PER_IN, first: p.firstPx / PX_PER_IN, right: p.rightPx / PX_PER_IN };
    begin(
      e,
      "x",
      (dx, ev) => {
        const dIn = dx / PX_PER_IN;
        if (kind === "first") {
          const target = snapValue(abs.first + dIn, unit, ev.altKey, [abs.margin, abs.left]);
          const first = Math.max(-p.leftIn, target.value - abs.left);
          return { kind, valueIn: first, posPx: (abs.left + first) * PX_PER_IN, locked: target.locked, label: `First line: ${formatLength(first, unit)}` };
        }
        if (kind === "left") {
          const target = snapValue(abs.left + dIn, unit, ev.altKey, [abs.margin, abs.first]);
          const left = Math.max(0, Math.min(maxColumnIn - p.rightIn, p.leftIn + (target.value - abs.left)));
          return { kind, valueIn: left, posPx: (abs.left + (left - p.leftIn)) * PX_PER_IN, locked: target.locked, label: `Left indent: ${formatLength(left, unit)}` };
        }
        const target = snapValue(abs.right + dIn, unit, ev.altKey, [rightPx / PX_PER_IN]);
        const right = Math.max(0, Math.min(maxColumnIn - p.leftIn, p.rightIn - (target.value - abs.right)));
        return { kind, valueIn: right, posPx: (abs.right - (right - p.rightIn)) * PX_PER_IN, locked: target.locked, label: `Right indent: ${formatLength(right, unit)}` };
      },
      (s, ev) => {
        if (kind === "first") applyIndent({ first: s.valueIn });
        else if (kind === "right") applyIndent({ right: s.valueIn });
        else if (ev.shiftKey) applyIndent({ left: s.valueIn });
        // Docs: the first line stays where it was on the page while the left indent moves.
        else applyIndent({ left: s.valueIn, first: Math.max(-s.valueIn, p.firstIn - (s.valueIn - p.leftIn)) });
      }
    );
  };

  const nudgeIndent = (kind: "left" | "first" | "right") => (e: React.KeyboardEvent) => {
    if (!para) return;
    const step = keyStep(e, unit);
    if (step === null) return;
    e.preventDefault();
    if (kind === "left") applyIndent({ left: Math.max(0, para.leftIn + step), first: Math.max(-(para.leftIn + step), para.firstIn - step) });
    else if (kind === "first") applyIndent({ first: Math.max(-para.leftIn, para.firstIn + step) });
    else applyIndent({ right: Math.max(0, para.rightIn - step) });
  };

  const nudgeMargin = (side: "left" | "right") => (e: React.KeyboardEvent) => {
    const step = keyStep(e, unit);
    if (step === null) return;
    e.preventDefault();
    const raw = margins[side] + (side === "left" ? step : -step);
    onMarginsChange({ ...margins, [side]: clampMargin(pageSize, margins, side, raw) });
  };

  // While dragging a marker, show it at the dragged position.
  const shown = useMemo(() => {
    const base = para ? { left: para.leftPx, first: para.firstPx, right: para.rightPx } : null;
    if (!drag || !base) return base;
    // Text follows a margin being dragged, so its indent markers do too.
    if (drag.kind === "margin-left") return { ...base, left: base.left + drag.posPx - leftPx, first: base.first + drag.posPx - leftPx };
    if (drag.kind === "margin-right") return { ...base, right: base.right + drag.posPx - rightPx };
    if (drag.kind === "left") return { ...base, left: drag.posPx, first: base.first + (drag.posPx - base.left) };
    if (drag.kind === "first") return { ...base, first: drag.posPx };
    if (drag.kind === "right") return { ...base, right: drag.posPx };
    return base;
  }, [para, drag, leftPx, rightPx]);
  const shownLeftMargin = drag?.kind === "margin-left" ? drag.posPx : leftPx;
  const shownRightMargin = drag?.kind === "margin-right" ? drag.posPx : rightPx;

  const markerBase = "absolute -translate-x-1/2 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-[1px] cursor-ew-resize";

  return (
    <div className="relative flex items-stretch select-none" style={{ height: RULER_SIZE }}>
      {/* Unit switch, in the canvas to the left of the page. */}
      <button
        type="button"
        onClick={() => onUnitChange(unit === "in" ? "cm" : "in")}
        data-tip={`Ruler units: ${unit === "in" ? "inches" : "centimetres"} (click to switch)`}
        className="absolute right-full mr-2 top-1/2 -translate-y-1/2 h-5 px-1.5 rounded text-[10px] font-semibold uppercase tracking-wide text-neutral-500 hover:bg-black/[0.06] dark:text-neutral-400 dark:hover:bg-white/10"
      >
        {unit}
      </button>

      <div ref={boxRef} className="relative w-full h-full rounded-sm bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800">
        {/* margin zones */}
        <div
          className="absolute inset-y-0 left-0 bg-neutral-200/80 dark:bg-neutral-800 cursor-default"
          style={{ width: shownLeftMargin }}
          onDoubleClick={onOpenPageSetup}
          data-tip="Left margin - drag the edge, double-click for Page setup"
        />
        <div
          className="absolute inset-y-0 right-0 bg-neutral-200/80 dark:bg-neutral-800 cursor-default"
          style={{ width: widthPx - shownRightMargin }}
          onDoubleClick={onOpenPageSetup}
          data-tip="Right margin - drag the edge, double-click for Page setup"
        />
        <svg className="absolute inset-0 pointer-events-none" width={widthPx} height={RULER_SIZE}>
          <Ticks lengthIn={lengthIn} zeroIn={margins.left} unit={unit} />
        </svg>

        {/* margin edges */}
        {(["left", "right"] as const).map((side) => (
          <div
            key={side}
            role="slider"
            tabIndex={0}
            aria-label={`${side === "left" ? "Left" : "Right"} margin`}
            aria-valuetext={formatLength(margins[side], unit)}
            data-tip={`${side === "left" ? "Left" : "Right"} margin ${formatLength(margins[side], unit)} - drag (Alt: free), arrows to nudge`}
            onPointerDown={startMarginDrag(side)}
            onKeyDown={nudgeMargin(side)}
            onDoubleClick={onOpenPageSetup}
            className="absolute inset-y-0 w-2 -translate-x-1/2 cursor-ew-resize outline-none focus-visible:bg-blue-500/30 hover:bg-blue-500/20"
            style={{ left: side === "left" ? shownLeftMargin : shownRightMargin }}
          />
        ))}

        {/* paragraph indent markers */}
        {shown && (
          <>
            <div
              role="slider"
              tabIndex={0}
              aria-label="First line indent"
              aria-valuetext={formatLength(para!.firstIn, unit)}
              data-tip={`First line indent ${formatLength(para!.firstIn, unit)} - drag, double-click for exact values`}
              onPointerDown={startIndentDrag("first")}
              onKeyDown={nudgeIndent("first")}
              onDoubleClick={() => setOptionsOpen(true)}
              className={`${markerBase} top-0 w-3 h-[7px] bg-blue-600 dark:bg-blue-400`}
              style={{ left: shown.first }}
            />
            <div
              role="slider"
              tabIndex={0}
              aria-label="Left indent"
              aria-valuetext={formatLength(para!.leftIn, unit)}
              data-tip={`Left indent ${formatLength(para!.leftIn, unit)} - drag (Shift: move first line too), double-click for exact values`}
              onPointerDown={startIndentDrag("left")}
              onKeyDown={nudgeIndent("left")}
              onDoubleClick={() => setOptionsOpen(true)}
              className={`${markerBase} bottom-0 w-3.5 h-2.5`}
              style={{ left: shown.left }}
            >
              <svg viewBox="0 0 14 10" className="w-full h-full fill-blue-600 dark:fill-blue-400">
                <path d="M7 0 L14 10 L0 10 Z" />
              </svg>
            </div>
            <div
              role="slider"
              tabIndex={0}
              aria-label="Right indent"
              aria-valuetext={formatLength(para!.rightIn, unit)}
              data-tip={`Right indent ${formatLength(para!.rightIn, unit)} - drag, double-click for exact values`}
              onPointerDown={startIndentDrag("right")}
              onKeyDown={nudgeIndent("right")}
              onDoubleClick={() => setOptionsOpen(true)}
              className={`${markerBase} bottom-0 w-3.5 h-2.5`}
              style={{ left: shown.right }}
            >
              <svg viewBox="0 0 14 10" className="w-full h-full fill-blue-600 dark:fill-blue-400">
                <path d="M7 0 L14 10 L0 10 Z" />
              </svg>
            </div>
          </>
        )}

        {/* drag feedback: tooltip + guide line down the page */}
        {drag && (
          <>
            <div
              className="absolute top-full mt-1 z-40 -translate-x-1/2 whitespace-nowrap rounded bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white shadow dark:bg-neutral-100 dark:text-neutral-900"
              style={{ left: drag.posPx }}
            >
              {drag.label}
            </div>
            <div
              className={`absolute top-full z-30 w-0 pointer-events-none border-l ${drag.locked ? "border-solid border-blue-600" : "border-dashed border-blue-500/80"}`}
              style={{ left: drag.posPx, height: guideLengthPx }}
            />
          </>
        )}

        {optionsOpen && para && (
          <IndentOptions
            unit={unit}
            left={para.leftIn}
            right={para.rightIn}
            first={para.firstIn}
            onApply={(v) => {
              applyIndent(v);
              setOptionsOpen(false);
            }}
            onClose={() => setOptionsOpen(false)}
          />
        )}
      </div>
    </div>
  );
};

// Docs' "Indentation options" dialog, as a popover under the ruler.
const IndentOptions: React.FC<{
  unit: RulerUnit;
  left: number;
  right: number;
  first: number;
  onApply: (v: { left: number; right: number; first: number }) => void;
  onClose: () => void;
}> = ({ unit, left, right, first, onApply, onClose }) => {
  const toUnit = (v: number) => String(Math.round((unit === "in" ? v : v * CM_PER_IN) * 100) / 100);
  const fromUnit = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? (unit === "in" ? n : n / CM_PER_IN) : 0;
  };
  const [l, setL] = useState(toUnit(left));
  const [r, setR] = useState(toUnit(right));
  const [special, setSpecial] = useState<"none" | "first" | "hanging">(first > 0 ? "first" : first < 0 ? "hanging" : "none");
  const [by, setBy] = useState(toUnit(Math.abs(first) || (unit === "in" ? 0.5 : 1.27 / CM_PER_IN)));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const apply = () => {
    const leftIn = Math.max(0, fromUnit(l));
    const byIn = Math.max(0, fromUnit(by));
    onApply({ left: leftIn, right: Math.max(0, fromUnit(r)), first: special === "first" ? byIn : special === "hanging" ? -Math.min(byIn, leftIn || byIn) : 0 });
  };
  const field = "w-20 px-2 py-1 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100";

  return (
    <div
      ref={ref}
      className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-72 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3 shadow-[0_2px_6px_2px_rgba(60,64,67,0.15),0_1px_2px_rgba(60,64,67,0.3)]"
      onKeyDown={(e) => e.key === "Enter" && apply()}
    >
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100 mb-2">Indentation options</div>
      <div className="grid grid-cols-[1fr_auto] items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
        <label htmlFor="ind-left">Left ({unit})</label>
        <input id="ind-left" autoFocus className={field} value={l} onChange={(e) => setL(e.target.value)} inputMode="decimal" />
        <label htmlFor="ind-right">Right ({unit})</label>
        <input id="ind-right" className={field} value={r} onChange={(e) => setR(e.target.value)} inputMode="decimal" />
        <label htmlFor="ind-special">Special</label>
        <select id="ind-special" className={field} value={special} onChange={(e) => setSpecial(e.target.value as typeof special)}>
          <option value="none">None</option>
          <option value="first">First line</option>
          <option value="hanging">Hanging</option>
        </select>
        {special !== "none" && (
          <>
            <label htmlFor="ind-by">By ({unit})</label>
            <input id="ind-by" className={field} value={by} onChange={(e) => setBy(e.target.value)} inputMode="decimal" />
          </>
        )}
      </div>
      <div className="flex justify-end gap-1.5 mt-3">
        <button type="button" onClick={onClose} className="px-3 py-1 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
          Cancel
        </button>
        <button type="button" onClick={apply} className="px-3 py-1 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
          Apply
        </button>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------------------------------------
// Vertical ruler

export interface DocVerticalRulerProps {
  pageSize: DocPageSize;
  margins: DocMargins;
  unit: RulerUnit;
  onMarginsChange: (m: DocMargins) => void;
  onOpenPageSetup: () => void;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  pageRef: React.RefObject<HTMLDivElement | null>;
  // Top offset of this ruler inside the scroller frame (below the sticky horizontal ruler).
  topInset: number;
  // Width of the horizontal guide line.
  guideLengthPx: number;
}

export const DocVerticalRuler: React.FC<DocVerticalRulerProps> = ({
  pageSize,
  margins,
  unit,
  onMarginsChange,
  onOpenPageSetup,
  scrollerRef,
  pageRef,
  topInset,
  guideLengthPx,
}) => {
  const pageH = pageHeightPx(pageSize);
  const [pageTop, setPageTop] = useState(0); // current page's top, relative to this ruler's top
  const { drag, begin } = useRulerDrag();

  // Follows the page at the top of the view. Every sheet is exactly pageH tall with a fixed gap
  // between (docAutoPaginate.ts), so page k starts at k * (pageH + PAGE_GAP_PX).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const page = pageRef.current;
      if (!page) return;
      const frameTop = scroller.getBoundingClientRect().top + topInset;
      const cardTop = page.getBoundingClientRect().top - frameTop;
      const stride = pageH + PAGE_GAP_PX;
      const k = Math.max(0, Math.floor((-cardTop + stride * 0.15) / stride));
      setPageTop(cardTop + k * stride);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    if (pageRef.current) ro.observe(pageRef.current);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollerRef, pageRef, pageH, topInset]);

  const topPx = margins.top * PX_PER_IN;
  const bottomPx = pageH - margins.bottom * PX_PER_IN;

  const startDrag = (side: "top" | "bottom") => (e: React.PointerEvent) => {
    const startIn = margins[side];
    begin(
      e,
      "y",
      (dy, ev) => {
        const raw = startIn + (side === "top" ? dy : -dy) / PX_PER_IN;
        const { value, locked } = snapValue(raw, unit, ev.altKey, []);
        const v = clampMargin(pageSize, margins, side, value);
        return {
          kind: side,
          valueIn: v,
          posPx: side === "top" ? v * PX_PER_IN : pageH - v * PX_PER_IN,
          locked,
          label: `${side === "top" ? "Top" : "Bottom"} margin: ${formatLength(v, unit)}`,
        };
      },
      (s) => s.valueIn !== startIn && onMarginsChange({ ...margins, [side]: s.valueIn })
    );
  };
  const nudge = (side: "top" | "bottom") => (e: React.KeyboardEvent) => {
    const step = keyStep(e, unit);
    if (step === null) return;
    e.preventDefault();
    onMarginsChange({ ...margins, [side]: clampMargin(pageSize, margins, side, margins[side] + (side === "top" ? step : -step)) });
  };

  const shownTop = drag?.kind === "top" ? drag.posPx : topPx;
  const shownBottom = drag?.kind === "bottom" ? drag.posPx : bottomPx;

  return (
    <div className="absolute left-0 bottom-0 overflow-visible pointer-events-none" style={{ top: topInset, width: RULER_SIZE }}>
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute left-0 pointer-events-auto select-none" style={{ top: pageTop, width: RULER_SIZE, height: pageH }}>
          <div className="absolute inset-0 rounded-sm bg-white dark:bg-neutral-900 ring-1 ring-neutral-200 dark:ring-neutral-800" />
          <div className="absolute inset-x-0 top-0 bg-neutral-200/80 dark:bg-neutral-800" style={{ height: shownTop }} onDoubleClick={onOpenPageSetup} />
          <div className="absolute inset-x-0 bottom-0 bg-neutral-200/80 dark:bg-neutral-800" style={{ height: pageH - shownBottom }} onDoubleClick={onOpenPageSetup} />
          <svg className="absolute inset-0 pointer-events-none" width={RULER_SIZE} height={pageH}>
            <Ticks lengthIn={pageH / PX_PER_IN} zeroIn={margins.top} unit={unit} vertical />
          </svg>
          {(["top", "bottom"] as const).map((side) => (
            <div
              key={side}
              role="slider"
              tabIndex={0}
              aria-label={`${side === "top" ? "Top" : "Bottom"} margin`}
              aria-valuetext={formatLength(margins[side], unit)}
              data-tip={`${side === "top" ? "Top" : "Bottom"} margin ${formatLength(margins[side], unit)} - drag (Alt: free), arrows to nudge`}
              onPointerDown={startDrag(side)}
              onKeyDown={nudge(side)}
              onDoubleClick={onOpenPageSetup}
              className="absolute inset-x-0 h-2 -translate-y-1/2 cursor-ns-resize outline-none focus-visible:bg-blue-500/30 hover:bg-blue-500/20"
              style={{ top: side === "top" ? shownTop : shownBottom }}
            />
          ))}
        </div>
      </div>
      {drag && (
        <>
          <div
            className="absolute z-40 left-full ml-1.5 -translate-y-1/2 whitespace-nowrap rounded bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white shadow dark:bg-neutral-100 dark:text-neutral-900"
            style={{ top: pageTop + drag.posPx }}
          >
            {drag.label}
          </div>
          <div
            className={`absolute z-30 left-full h-0 border-t ${drag.locked ? "border-solid border-blue-600" : "border-dashed border-blue-500/80"}`}
            style={{ top: pageTop + drag.posPx, width: guideLengthPx }}
          />
        </>
      )}
    </div>
  );
};
