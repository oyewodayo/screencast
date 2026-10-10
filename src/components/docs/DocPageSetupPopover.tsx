// components/docs/DocPageSetupPopover.tsx
//
// Page setup: paper size, margins, and repeating header/footer text - see DocsEditor.tsx's own
// comment on how the print frame and position:fixed make these show up correctly at print time.
// Local draft state so typing doesn't fire a set_doc_page_setup invoke on every keystroke; applied
// together with the Apply button (or Enter). Margins are shown in the ruler's unit. Columns and
// the gutter are document settings in the Y.Doc (docLayout.ts), applied by the same button.
import React, { useEffect, useState } from "react";
import { DocMargins, DocPageSetupPatch, DocPageSize } from "../../utils/docTypes";
import { DEFAULT_MARGINS, PAGE_DIMENSIONS_IN, MIN_CONTENT_IN } from "../../utils/docPageGeometry";
import type { RulerUnit } from "./DocRuler";

interface DocPageSetupPopoverProps {
  pageSize: DocPageSize | null;
  headerText: string | null;
  footerText: string | null;
  margins: DocMargins | null;
  unit: RulerUnit;
  columns: 1 | 2;
  columnGap: number; // inches
  onApply: (patch: DocPageSetupPatch) => void;
  onColumnsChange: (columns: 1 | 2, columnGap: number) => void;
  onClose: () => void;
}

const PAGE_SIZE_LABELS: Record<DocPageSize, string> = {
  letter: "Letter (8.5 × 11 in)",
  a4: "A4 (210 × 297 mm)",
  legal: "Legal (8.5 × 14 in)",
};

const CM_PER_IN = 2.54;

// Word's margin presets (Normal = Docs' default).
const PRESETS: { label: string; margins: DocMargins }[] = [
  { label: "Normal", margins: DEFAULT_MARGINS },
  { label: "Narrow", margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } },
  { label: "Moderate", margins: { top: 1, right: 0.75, bottom: 1, left: 0.75 } },
  { label: "Wide", margins: { top: 1, right: 2, bottom: 1, left: 2 } },
];

const SIDES: (keyof DocMargins)[] = ["top", "bottom", "left", "right"];

const DocPageSetupPopover: React.FC<DocPageSetupPopoverProps> = ({ pageSize, headerText, footerText, margins, unit, columns, columnGap, onApply, onColumnsChange, onClose }) => {
  const toUnit = (inches: number) => String(Math.round((unit === "in" ? inches : inches * CM_PER_IN) * 100) / 100);
  const marginDrafts = (m: DocMargins) => Object.fromEntries(SIDES.map((s) => [s, toUnit(m[s])])) as Record<keyof DocMargins, string>;

  const [draftSize, setDraftSize] = useState<DocPageSize>(pageSize ?? "letter");
  const [draftHeader, setDraftHeader] = useState(headerText ?? "");
  const [draftFooter, setDraftFooter] = useState(footerText ?? "");
  const [draftMargins, setDraftMargins] = useState(() => marginDrafts(margins ?? DEFAULT_MARGINS));
  const [draftColumns, setDraftColumns] = useState<1 | 2>(columns);
  const [draftGap, setDraftGap] = useState(() => toUnit(columnGap));

  // Re-syncs the draft if the popover is reopened after the doc's own page setup changed
  // elsewhere (e.g. a ruler drag or a version restore) while it was closed.
  useEffect(() => {
    setDraftSize(pageSize ?? "letter");
    setDraftHeader(headerText ?? "");
    setDraftFooter(footerText ?? "");
    setDraftMargins(marginDrafts(margins ?? DEFAULT_MARGINS));
    setDraftColumns(columns);
    setDraftGap(toUnit(columnGap));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, headerText, footerText, margins, unit, columns, columnGap]);

  const toInches = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? (unit === "in" ? n : n / CM_PER_IN) : NaN;
  };
  const parsed: DocMargins = {
    top: toInches(draftMargins.top),
    right: toInches(draftMargins.right),
    bottom: toInches(draftMargins.bottom),
    left: toInches(draftMargins.left),
  };
  const dims = PAGE_DIMENSIONS_IN[draftSize];
  const gapIn = toInches(draftGap);
  const gapInvalid = draftColumns === 2 && !(gapIn >= 0 && gapIn <= 2);
  const invalid =
    gapInvalid ||
    SIDES.some((s) => !(parsed[s] >= 0)) ||
    parsed.left + parsed.right > dims.width - MIN_CONTENT_IN ||
    parsed.top + parsed.bottom > dims.height - MIN_CONTENT_IN;

  const commit = () => {
    if (invalid) return;
    const isDefault = SIDES.every((s) => Math.abs(parsed[s] - DEFAULT_MARGINS[s]) < 0.005);
    onApply({
      pageSize: draftSize,
      headerText: draftHeader.trim() || null,
      footerText: draftFooter.trim() || null,
      margins: isDefault ? null : parsed,
    });
    if (draftColumns !== columns || (draftColumns === 2 && Math.abs(gapIn - columnGap) > 0.001)) onColumnsChange(draftColumns, draftColumns === 2 ? gapIn : columnGap);
    onClose();
  };

  const field =
    "w-full px-2 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100";
  const label = "block text-xs text-neutral-500 dark:text-neutral-400 mb-1";

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) commit();
      }}
      className="absolute right-0 top-full mt-1 z-30 w-80 rounded-lg border border-neutral-200/70 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-3.5 space-y-3 shadow-[0_2px_6px_2px_rgba(60,64,67,0.15),0_1px_2px_rgba(60,64,67,0.3)]"
    >
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100">Page setup</div>
      <div>
        <label className={label}>Paper size</label>
        <select value={draftSize} onChange={(e) => setDraftSize(e.target.value as DocPageSize)} className={field}>
          {(Object.keys(PAGE_SIZE_LABELS) as DocPageSize[]).map((size) => (
            <option key={size} value={size}>
              {PAGE_SIZE_LABELS[size]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">Margins ({unit === "in" ? "inches" : "centimetres"})</span>
        </div>
        <div className="flex flex-wrap gap-1 mb-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setDraftMargins(marginDrafts(p.margins))}
              className="px-2 py-0.5 text-xs rounded-full border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {SIDES.map((side) => (
            <div key={side}>
              <label className={label} htmlFor={`margin-${side}`}>
                {side[0].toUpperCase() + side.slice(1)}
              </label>
              <input
                id={`margin-${side}`}
                inputMode="decimal"
                value={draftMargins[side]}
                onChange={(e) => setDraftMargins((m) => ({ ...m, [side]: e.target.value }))}
                className={`${field} ${!(parsed[side] >= 0) ? "border-red-500 focus:border-red-500" : ""}`}
              />
            </div>
          ))}
        </div>
        {invalid && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">Margins must leave at least 1 in of page.</p>}
      </div>

      <div>
        <span className={label}>Columns</span>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-neutral-300 dark:border-neutral-600 overflow-hidden" role="radiogroup" aria-label="Columns">
            {([1, 2] as const).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={draftColumns === n}
                onClick={() => setDraftColumns(n)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs ${
                  draftColumns === n ? "bg-blue-50 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200" : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                } ${n === 2 ? "border-l border-neutral-300 dark:border-neutral-600" : ""}`}
              >
                <span className="inline-flex gap-[2px]" aria-hidden>
                  {Array.from({ length: n }, (_, k) => (
                    <span key={k} className={`block h-3.5 ${n === 1 ? "w-3.5" : "w-[6px]"} rounded-[1px] border border-current opacity-70`} />
                  ))}
                </span>
                {n === 1 ? "One" : "Two"}
              </button>
            ))}
          </div>
          {draftColumns === 2 && (
            <label className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
              Gutter
              <input
                inputMode="decimal"
                value={draftGap}
                onChange={(e) => setDraftGap(e.target.value)}
                aria-label={`Space between columns (${unit})`}
                className={`${field} !w-16 !py-1 ${gapInvalid ? "border-red-500 focus:border-red-500" : ""}`}
              />
              {unit}
            </label>
          )}
        </div>
      </div>

      <div>
        <label className={label}>Header (repeats on every printed page)</label>
        <input value={draftHeader} onChange={(e) => setDraftHeader(e.target.value)} placeholder="e.g. document title" className={field} />
      </div>
      <div>
        <label className={label}>Footer (repeats on every printed page)</label>
        <input value={draftFooter} onChange={(e) => setDraftFooter(e.target.value)} placeholder="e.g. confidential" className={field} />
      </div>
      <div className="flex justify-end gap-1.5 pt-1">
        <button type="button" onClick={onClose} className="px-3 py-1 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={invalid}
          className="px-3 py-1 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Apply
        </button>
      </div>
    </div>
  );
};

export default DocPageSetupPopover;
