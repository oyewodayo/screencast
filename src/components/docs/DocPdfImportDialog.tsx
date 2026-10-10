// components/docs/DocPdfImportDialog.tsx
//
// "Import PDF" (DocsHome.tsx): shows the chosen PDF's first page, offers the two ways to bring it
// in - rebuilt as an editable document, or every page kept exactly - and follows the import with a
// progress bar and, for an editable import, a summary of what was rebuilt.
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getDocument } from "pdfjs-dist";
import { IoClose, IoCheckmarkCircle } from "react-icons/io5";
import { TbMathFunction, TbTable, TbQuote, TbColumns2, TbPhoto, TbTypography } from "react-icons/tb";
import { ensureWorkerConfigured } from "../../hooks/usePdfDocument";
// The import engine loads on demand - it is only needed once someone actually imports a PDF.
import type { PdfImportMode, PdfImportProgress, PdfImportResult } from "../../utils/pdfImport";

interface DocPdfImportDialogProps {
  path: string;
  fileName: string;
  onClose: () => void;
  onOpenDoc: (id: string) => void;
}

const STAGE_LABEL: Record<PdfImportProgress["stage"], string> = {
  reading: "Reading pages",
  analysing: "Rebuilding layout, equations and tables",
  building: "Assembling the document",
  saving: "Saving",
};

// Overall progress across stages (reading and analysing dominate).
function fraction(p: PdfImportProgress, mode: PdfImportMode): number {
  const within = p.total > 0 ? p.current / p.total : 0;
  if (mode === "exact") return p.stage === "saving" ? 0.96 : 0.92 * within;
  switch (p.stage) {
    case "reading":
      return 0.5 * within;
    case "analysing":
      return 0.5 + 0.38 * within;
    case "building":
      return 0.9;
    case "saving":
      return 0.96;
  }
}

const ModeCard: React.FC<{
  active: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  description: string;
  points: { icon: React.ComponentType<{ size?: number; className?: string }>; text: string }[];
}> = ({ active, onSelect, title, badge, description, points }) => (
  <button
    type="button"
    role="radio"
    aria-checked={active}
    onClick={onSelect}
    className={`group relative flex-1 min-w-0 flex flex-col justify-start text-left rounded-xl border p-3.5 transition-colors ${
      active
        ? "border-blue-500 bg-blue-50/70 dark:bg-blue-500/10 ring-1 ring-blue-500"
        : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
    }`}
  >
    <div className="flex w-full items-center gap-2">
      <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${active ? "border-blue-600 bg-blue-600 shadow-[inset_0_0_0_2px_white] dark:shadow-[inset_0_0_0_2px_#262626]" : "border-neutral-300 dark:border-neutral-600"}`} />
      <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</span>
      {badge && <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-500/20 rounded-full px-2 py-0.5">{badge}</span>}
    </div>
    <p className="mt-1.5 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{description}</p>
    <ul className="mt-2.5 space-y-1">
      {points.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300">
          <Icon size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
          {text}
        </li>
      ))}
    </ul>
  </button>
);

const DocPdfImportDialog: React.FC<DocPdfImportDialogProps> = ({ path, fileName, onClose, onOpenDoc }) => {
  const [mode, setMode] = useState<PdfImportMode>("editable");
  const [progress, setProgress] = useState<PdfImportProgress | null>(null);
  const [result, setResult] = useState<PdfImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busy = progress !== null && !result && !error;

  // First-page preview and page count.
  useEffect(() => {
    let cancelled = false;
    ensureWorkerConfigured();
    let destroy: (() => void) | null = null;
    (async () => {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path }));
      const task = getDocument({ data: bytes });
      destroy = () => void task.destroy();
      const pdf = await task.promise;
      if (cancelled) return;
      setPages(pdf.numPages);
      const page = await pdf.getPage(1);
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = (150 / base.width) * Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    })().catch((err) => {
      if (!cancelled) setError(`Couldn't open this PDF: ${err instanceof Error ? err.message : String(err)}`);
    });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const start = async () => {
    setError(null);
    setProgress({ stage: "reading", current: 0, total: pages ?? 1 });
    try {
      const { importPdfFile } = await import("../../utils/pdfImport");
      const r = await importPdfFile(path, fileName, mode, setProgress);
      if (mode === "exact") onOpenDoc(r.id);
      else setResult(r);
    } catch (err) {
      console.error("PDF import failed:", err);
      setError(err instanceof Error ? err.message : String(err));
      setProgress(null);
    }
  };

  const pct = progress ? Math.round(100 * (result ? 1 : fraction(progress, mode))) : 0;
  const s = result?.stats;
  const summary = s
    ? [
        [s.paragraphs, "paragraphs"],
        [s.equations, "display equations"],
        [s.inlineMath, "inline formulas"],
        [s.tables, "tables"],
        [s.figures, "figures"],
        [s.citations, "citations"],
        [s.crossRefs, "cross-references"],
        [s.references, "references"],
      ].filter(([n]) => (n as number) > 0)
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="pdf-import-title" className="w-full max-w-[640px] rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200/70 dark:border-neutral-800 shadow-[0_24px_64px_rgba(0,0,0,0.25)] overflow-hidden">
        <div className="flex items-start gap-4 p-5 pb-4">
          <div className="shrink-0 w-[75px] rounded-sm overflow-hidden ring-1 ring-neutral-200 dark:ring-neutral-700 shadow-sm bg-white">
            <canvas ref={canvasRef} className="block w-full h-auto" aria-label="First page" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="pdf-import-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Import PDF
            </h2>
            <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-400 truncate" title={fileName}>
              {fileName}
            </p>
            {pages !== null && <p className="mt-0.5 text-xs text-neutral-400">{pages === 1 ? "1 page" : `${pages} pages`}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="p-1.5 -m-1 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10 disabled:opacity-40">
            <IoClose size={18} />
          </button>
        </div>

        {result ? (
          <div className="px-5 pb-5">
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
              <IoCheckmarkCircle size={20} className="text-green-600" /> Rebuilt as an editable document
            </div>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 truncate">{result.title}</p>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {summary.map(([n, label]) => (
                <div key={label as string} className="rounded-lg bg-neutral-50 dark:bg-neutral-800/70 px-2.5 py-2">
                  <div className="text-lg font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{(n as number).toLocaleString()}</div>
                  <div className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">{label}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
              Every equation is LaTeX you can edit, and citations, cross-references and numbering stay live as you change the document.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3.5 py-1.5 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                Close
              </button>
              <button type="button" autoFocus onClick={() => onOpenDoc(result.id)} className="px-4 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
                Open document
              </button>
            </div>
          </div>
        ) : (
          <div className="px-5 pb-5">
            <div className="flex gap-3" role="radiogroup" aria-label="How to import">
              <ModeCard
                active={mode === "editable"}
                onSelect={() => !busy && setMode("editable")}
                title="Editable"
                badge="Recommended"
                description="Rebuilt as a real document that looks like the PDF and edits like Docs."
                points={[
                  { icon: TbColumns2, text: "Columns, fonts and spacing" },
                  { icon: TbMathFunction, text: "Equations as editable LaTeX" },
                  { icon: TbTable, text: "Tables, figures and captions" },
                  { icon: TbQuote, text: "Live citations and references" },
                ]}
              />
              <ModeCard
                active={mode === "exact"}
                onSelect={() => !busy && setMode("exact")}
                title="Exact pages"
                description="Every page kept pixel-perfect as printed, with selectable text."
                points={[
                  { icon: TbPhoto, text: "Identical to the PDF" },
                  { icon: TbTypography, text: "Text you can select and copy" },
                ]}
              />
            </div>

            {progress && (
              <div className="mt-4" aria-live="polite">
                <div className="flex justify-between text-xs text-neutral-600 dark:text-neutral-400">
                  <span>
                    {STAGE_LABEL[progress.stage]}
                    {progress.total > 1 && (progress.stage === "reading" || progress.stage === "analysing") ? ` · page ${Math.min(progress.current + 1, progress.total)} of ${progress.total}` : "…"}
                  </span>
                  <span className="tabular-nums">{pct}%</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                  <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="px-3.5 py-1.5 text-sm rounded-md text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40">
                Cancel
              </button>
              <button type="button" onClick={() => void start()} disabled={busy || pages === null} className="px-4 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                {busy ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocPdfImportDialog;
