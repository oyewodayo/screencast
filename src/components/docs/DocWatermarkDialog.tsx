// components/docs/DocWatermarkDialog.tsx
//
// Watermark (docWatermark.ts): a word or an image faintly across every page. A side panel like
// Header & footer, so the pages stay in view - every change is written to the document at once and
// shows on every sheet (DocWatermarkOverlay.tsx) as it's made.
import React, { useEffect, useRef, useState } from "react";
import { IoClose } from "react-icons/io5";
import { MdImage, MdTextFields } from "react-icons/md";
import {
  DEFAULT_WATERMARK,
  WATERMARK_COLORS,
  WATERMARK_PRESETS,
  prepareWatermarkImage,
  type DocWatermark,
  type WatermarkFont,
  type WatermarkLayout,
  type WatermarkSize,
} from "../../utils/docWatermark";

interface DocWatermarkDialogProps {
  watermark: DocWatermark;
  onChange: (next: DocWatermark) => void;
  onClose: () => void;
}

const field =
  "w-full min-w-0 px-2 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400";
const label = "block text-xs text-neutral-500 dark:text-neutral-400 mb-1";
const sectionTitle = "text-sm font-medium text-neutral-900 dark:text-neutral-50";
const chip = (on: boolean) =>
  `h-7 px-2.5 rounded-full text-xs border transition-colors ${
    on
      ? "border-transparent bg-[#c2e7ff] text-[#001d35] dark:bg-blue-500/30 dark:text-blue-50 font-medium"
      : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
  }`;

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: React.ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900/60 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-md font-medium transition-colors ${
            value === o.id ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm" : "text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Slider: React.FC<{ id: string; label: string; value: number; min: number; max: number; onChange: (v: number) => void }> = ({ id, label: text, value, min, max, onChange }) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <label htmlFor={id} className="text-xs text-neutral-500 dark:text-neutral-400">
        {text}
      </label>
      <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-300">{value}%</span>
    </div>
    <input id={id} type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-blue-600" />
  </div>
);

const DocWatermarkDialog: React.FC<DocWatermarkDialogProps> = ({ watermark: wm, onChange, onClose }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<DocWatermark>) => onChange({ ...wm, ...patch });

  const pickImage = async (file: File | undefined) => {
    if (!file) return;
    setImageError(null);
    setLoadingImage(true);
    try {
      const { image, aspect } = await prepareWatermarkImage(file);
      set({ kind: "image", image, imageAspect: aspect });
    } catch {
      setImageError("That file couldn't be read as an image.");
    } finally {
      setLoadingImage(false);
    }
  };

  // "Image" with nothing picked yet goes straight to the file picker.
  const chooseKind = (kind: DocWatermark["kind"]) => {
    if (kind === "image" && !wm.image) {
      fileRef.current?.click();
      return;
    }
    set({ kind });
  };

  const opacityPct = Math.round(wm.opacity * 100);

  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-labelledby="doc-watermark-title"
        className="w-[380px] max-w-full h-full overflow-y-auto bg-white dark:bg-neutral-800 border-l border-neutral-200 dark:border-neutral-700 shadow-[-8px_0_24px_rgba(60,64,67,0.15)]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-4 bg-white dark:bg-neutral-800 border-b border-neutral-100 dark:border-neutral-700/60">
          <h2 id="doc-watermark-title" className="flex-1 text-base font-medium text-neutral-900 dark:text-neutral-50">
            Watermark
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -m-1 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          <Segmented
            value={wm.kind}
            onChange={chooseKind}
            options={[
              { id: "none", label: "None" },
              { id: "text", label: (<><MdTextFields size={15} /> Text</>) },
              { id: "image", label: (<><MdImage size={15} /> Image</>) },
            ]}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              void pickImage(e.target.files?.[0]);
              e.target.value = "";
            }}
          />

          {wm.kind === "text" && (
            <>
              <section className="space-y-2">
                <label htmlFor="doc-wm-text" className={sectionTitle}>
                  Text
                </label>
                <input id="doc-wm-text" value={wm.text} maxLength={60} onChange={(e) => set({ text: e.target.value })} placeholder="e.g. DRAFT" className={field} />
                <div className="flex flex-wrap gap-1.5">
                  {WATERMARK_PRESETS.map((p) => (
                    <button key={p} type="button" aria-pressed={wm.text === p} onClick={() => set({ text: p })} className={chip(wm.text === p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <h3 className={sectionTitle}>Look</h3>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented<WatermarkLayout>
                    value={wm.layout}
                    onChange={(layout) => set({ layout })}
                    options={[
                      { id: "diagonal", label: (<><span aria-hidden className="inline-block w-3.5 h-px bg-current -rotate-45" /> Diagonal</>) },
                      { id: "horizontal", label: (<><span aria-hidden className="inline-block w-3.5 h-px bg-current" /> Horizontal</>) },
                    ]}
                  />
                  <Segmented<WatermarkFont>
                    value={wm.font}
                    onChange={(font) => set({ font })}
                    options={[
                      { id: "sans", label: <span style={{ fontFamily: "Arial, sans-serif" }}>Sans</span> },
                      { id: "serif", label: <span style={{ fontFamily: "'Times New Roman', serif" }}>Serif</span> },
                    ]}
                  />
                  <button type="button" aria-pressed={wm.bold} onClick={() => set({ bold: !wm.bold })} className={`${chip(wm.bold)} font-bold`}>
                    B
                  </button>
                </div>
                <div>
                  <span className={label}>Size</span>
                  <Segmented<WatermarkSize>
                    value={wm.size}
                    onChange={(size) => set({ size })}
                    options={[
                      { id: "fit", label: "Fit page" },
                      { id: "large", label: "Large" },
                      { id: "medium", label: "Medium" },
                      { id: "small", label: "Small" },
                    ]}
                  />
                </div>
                <div>
                  <span className={label}>Colour</span>
                  <div className="flex items-center gap-1.5">
                    {WATERMARK_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        aria-label={c.label}
                        aria-pressed={wm.color === c.value}
                        title={c.label}
                        onClick={() => set({ color: c.value })}
                        className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-white dark:ring-offset-neutral-800 ${wm.color === c.value ? "ring-2 ring-blue-500" : "ring-1 ring-black/10"}`}
                        style={{ background: c.value }}
                      />
                    ))}
                    <label
                      title="Custom colour"
                      className={`relative h-6 w-6 rounded-full cursor-pointer ring-offset-2 ring-offset-white dark:ring-offset-neutral-800 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)] ${
                        WATERMARK_COLORS.some((c) => c.value === wm.color) ? "ring-1 ring-black/10" : "ring-2 ring-blue-500"
                      }`}
                    >
                      <input type="color" value={wm.color} onChange={(e) => set({ color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" aria-label="Custom colour" />
                    </label>
                  </div>
                </div>
              </section>
            </>
          )}

          {wm.kind === "image" && wm.image && (
            <section className="space-y-3">
              <h3 className={sectionTitle}>Image</h3>
              <div className="flex items-center gap-3">
                <div className="h-16 w-16 shrink-0 rounded-md border border-neutral-200 dark:border-neutral-700 bg-[repeating-conic-gradient(#f2f2f2_0_25%,#fff_0_50%)] bg-[length:12px_12px] flex items-center justify-center overflow-hidden">
                  <img src={wm.image} alt="" className={`max-h-full max-w-full ${wm.washout ? "grayscale" : ""}`} />
                </div>
                <button type="button" disabled={loadingImage} onClick={() => fileRef.current?.click()} className={chip(false)}>
                  {loadingImage ? "Loading…" : "Replace image…"}
                </button>
              </div>
              <Slider id="doc-wm-scale" label="Size (share of page width)" value={Math.round(wm.imageScale * 100)} min={10} max={100} onChange={(v) => set({ imageScale: v / 100 })} />
              <label className="flex items-center gap-2.5 text-sm text-neutral-700 dark:text-neutral-200 cursor-pointer">
                <input type="checkbox" checked={wm.washout} onChange={(e) => set({ washout: e.target.checked })} className="accent-blue-600" />
                Washout (greyscale)
              </label>
            </section>
          )}
          {loadingImage && !wm.image && <p className="text-sm text-neutral-500">Loading image…</p>}
          {imageError && <p className="text-sm text-red-600 dark:text-red-400">{imageError}</p>}

          {wm.kind !== "none" && (
            <section className="space-y-3">
              <h3 className={sectionTitle}>Placement</h3>
              <Slider id="doc-wm-opacity" label="Strength" value={opacityPct} min={3} max={100} onChange={(v) => set({ opacity: v / 100 })} />
              <label className="flex items-start gap-2.5 text-sm text-neutral-700 dark:text-neutral-200 cursor-pointer">
                <input type="checkbox" checked={wm.skipFirstPage} onChange={(e) => set({ skipFirstPage: e.target.checked })} className="mt-0.5 accent-blue-600" />
                <span>
                  Not on the first page
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">Keeps a title or cover page clean.</span>
                </span>
              </label>
              <p className="text-xs text-neutral-400">Prints behind the text on every page, and goes into PDF and Word exports.</p>
            </section>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-700/60">
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_WATERMARK })}
              className="px-3 py-1.5 text-sm rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              Remove watermark
            </button>
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DocWatermarkDialog;
