// components/docs/DocLetterheadDialog.tsx
//
// Putting the document on company letterhead. Three ways in:
//   Your letterheads - saved once, used on any document; one can be the default for new documents
//   Import           - a Word letterhead (.docx/.dotx: header and footer drawn faithfully, shapes,
//                      logos and text boxes included), a PDF (page 2 can be the continuation
//                      sheet), or a picture (a whole page, or a banner along the top or bottom)
//   Design           - company name, logo, address and contact lines in a house layout
// Every way lands on the same preview: the sheet with a sample letter flowing in the text-safe
// area, and guides to drag where the text starts (page 1 and later pages separately) and stops -
// read from the letterhead itself, so most letterheads need no adjusting at all.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { MdCheck, MdClose, MdDeleteOutline, MdOutlineDesignServices, MdOutlineFileUpload, MdOutlineStar, MdOutlineStarBorder, MdPhotoLibrary } from "react-icons/md";
import { letterheadCanvas, letterheadUrl, type DocLetterhead } from "../../utils/docLetterhead";
import { deleteLetterhead, listLetterheads, setDefaultLetterhead, type SavedLetterhead } from "../../utils/letterheadLibrary";
import {
  DEFAULT_DESIGN,
  designLetterhead,
  letterheadFromDocx,
  letterheadFromImage,
  letterheadFromPdf,
  type DesignStyle,
  type ImagePlacement,
  type LetterheadDesign,
} from "../../utils/letterheadSources";
import "./docLetterhead.css";
import ColorInput from "../common/ColorInput";
import BrandLoader from "../common/BrandLoader";

export interface LetterheadApplyOptions {
  saveToLibrary: boolean;
  makeDefault: boolean;
  thumb: string;
}

interface Props {
  current: DocLetterhead | null;
  sheet: { widthPx: number; heightPx: number }; // the document's page
  onApply: (lh: DocLetterhead, opts: LetterheadApplyOptions) => void;
  onRemove: () => void;
  onClose: () => void;
}

type Tab = "library" | "import" | "design";
type RestMode = "same" | "plain" | "own";

const DESIGN_STYLES: { id: DesignStyle; label: string }[] = [
  { id: "modern", label: "Modern" },
  { id: "classic", label: "Classic" },
  { id: "band", label: "Colour band" },
  { id: "minimal", label: "Minimal" },
];
const BRAND_SWATCHES = ["#1f3a5f", "#0b5394", "#0f766e", "#166534", "#7c2d12", "#9f1239", "#6d28d9", "#111827"];

const PREVIEW_W = 380;

export async function letterheadThumb(lh: DocLetterhead): Promise<string> {
  const c = await letterheadCanvas(lh.first, lh.widthPx, lh.heightPx, 220 / lh.widthPx).catch(() => null);
  if (!c) return "";
  const ctx = c.getContext("2d")!;
  // Thumbnails are judged against paper.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

// ------------------------------------------------------------------------------------------------
// Preview with draggable safe-area guides

const SAMPLE = [
  "2 November 2026",
  "",
  "Dear Ms Adeyemi,",
  "",
  "Thank you for meeting with our team last week. We were delighted to hear about your plans for the coming year, and we are pleased to confirm the arrangements we discussed.",
  "Please find the agreed schedule attached. Should anything change, our office will be happy to help.",
  "",
  "Yours sincerely,",
];

const Preview: React.FC<{
  lh: DocLetterhead;
  page: "first" | "rest";
  restMode: RestMode;
  onChange: (patch: Partial<DocLetterhead>) => void;
}> = ({ lh, page, restMode, onChange }) => {
  const scale = PREVIEW_W / lh.widthPx;
  const H = lh.heightPx * scale;
  const svg = page === "first" ? lh.first : restMode === "plain" ? null : restMode === "same" ? lh.first : lh.rest;
  const url = useMemo(() => letterheadUrl(svg), [svg]);
  const topIn = page === "first" ? lh.firstTopIn : lh.restTopIn;
  const leftPx = (lh.leftIn ?? 1) * 96 * scale;
  const rightPx = (lh.rightIn ?? 1) * 96 * scale;
  const topPx = topIn * 96 * scale;
  const bottomPx = lh.bottomIn * 96 * scale;
  const drag = useRef<{ which: "top" | "bottom"; y0: number; v0: number } | null>(null);

  const startDrag = (which: "top" | "bottom") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { which, y0: e.clientY, v0: which === "top" ? topIn : lh.bottomIn };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dIn = (e.clientY - d.y0) / scale / 96;
    const v = Math.round(Math.min(lh.heightPx / 96 / 2, Math.max(0.3, d.v0 + (d.which === "top" ? dIn : -dIn))) * 20) / 20;
    if (d.which === "bottom") onChange({ bottomIn: v });
    else onChange(page === "first" ? { firstTopIn: v } : { restTopIn: v });
  };

  return (
    <div className="doc-lh-sheet relative bg-white mx-auto select-none" style={{ width: PREVIEW_W, height: H }} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
      {url && <img src={url} alt="" draggable={false} className="absolute inset-0 w-full h-full pointer-events-none" />}
      {/* A sample letter, set in the safe area at the page's real proportions. */}
      <div className="absolute overflow-hidden text-neutral-700" style={{ left: leftPx, right: rightPx, top: topPx, bottom: bottomPx, fontSize: 11 * scale * 1.333, lineHeight: 1.45 }}>
        {(page === "first" ? SAMPLE : [...SAMPLE.slice(4), ...SAMPLE.slice(4)]).map((p, i) => (
          <p key={i} style={{ margin: 0, minHeight: "1em" }}>
            {p}
          </p>
        ))}
      </div>
      {(["top", "bottom"] as const).map((which) => {
        const y = which === "top" ? topPx : H - bottomPx;
        const value = which === "top" ? topIn : lh.bottomIn;
        return (
          <div key={which} className="doc-lh-guide" style={{ top: y }} onPointerDown={startDrag(which)} data-tip={which === "top" ? "Drag where the text starts" : "Drag where the text stops"}>
            <span className="doc-lh-guide-label" style={which === "top" ? { top: 4 } : { bottom: 4 }}>
              {which === "top" ? `Text starts ${value.toFixed(2)} in` : `Text stops ${value.toFixed(2)} in from the bottom`}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ------------------------------------------------------------------------------------------------

const DocLetterheadDialog: React.FC<Props> = ({ current, sheet, onApply, onRemove, onClose }) => {
  const [library, setLibrary] = useState<SavedLetterhead[] | null>(null);
  const [tab, setTab] = useState<Tab>(current ? "library" : "import");
  const [draft, setDraft] = useState<DocLetterhead | null>(current);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restMode, setRestMode] = useState<RestMode>(current ? (current.rest === null ? "plain" : current.rest === current.first ? "same" : "own") : "same");
  const [hasOwnRest, setHasOwnRest] = useState(!!current && !!current.rest && current.rest !== current.first);
  const [previewPage, setPreviewPage] = useState<"first" | "rest">("first");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState(!current);
  const [makeDefault, setMakeDefault] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pdfInfo, setPdfInfo] = useState<{ bytes: ArrayBuffer; name: string; pages: number; usePage2: boolean } | null>(null);
  const [imageInfo, setImageInfo] = useState<{ blob: Blob; name: string; placement: ImagePlacement } | null>(null);
  const [design, setDesign] = useState<LetterheadDesign>(DEFAULT_DESIGN);

  useEffect(() => {
    void listLetterheads().then((l) => {
      setLibrary(l);
      if (!current && l.length) setTab("library");
    });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const adopt = useCallback((lh: DocLetterhead, opts: { ownRest?: boolean } = {}) => {
    setDraft(lh);
    const own = !!opts.ownRest;
    setHasOwnRest(own);
    setRestMode(lh.rest === null ? "plain" : own ? "own" : "same");
    setPreviewPage("first");
    setError(null);
  }, []);

  // ---- import ----------------------------------------------------------------------------------
  const importFile = useCallback(
    async (bytes: ArrayBuffer, fileName: string, mime = "") => {
      const name = fileName.replace(/\.[^.]+$/, "");
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      setBusy(`Reading ${fileName}…`);
      setError(null);
      setPdfInfo(null);
      setImageInfo(null);
      try {
        if (ext === "docx" || ext === "dotx" || ext === "docm") {
          const lh = await letterheadFromDocx(bytes, name);
          if (!lh) throw new Error("That Word document has no header or footer to use as a letterhead.");
          adopt(lh, { ownRest: !!lh.rest && lh.rest !== lh.first });
        } else if (ext === "pdf" || mime === "application/pdf") {
          const r = await letterheadFromPdf(bytes, name, false);
          if (!r) throw new Error("That PDF couldn't be read.");
          setPdfInfo({ bytes, name, pages: r.pages, usePage2: false });
          adopt(r.letterhead);
        } else {
          const blob = new Blob([bytes], { type: mime || `image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext}` });
          const r = await letterheadFromImage(blob, name, "auto", sheet);
          setImageInfo({ blob, name, placement: r.placement });
          adopt(r.letterhead);
        }
      } catch (err) {
        console.error("Letterhead import failed:", err);
        setError(err instanceof Error ? err.message : "That file couldn't be used as a letterhead.");
      } finally {
        setBusy(null);
      }
    },
    [adopt, sheet]
  );

  const pick = async () => {
    const picked = await openFileDialog({ multiple: false, filters: [{ name: "Letterhead", extensions: ["docx", "dotx", "pdf", "png", "jpg", "jpeg", "webp", "svg"] }] });
    if (!picked || Array.isArray(picked)) return;
    const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: picked });
    await importFile(bytes, picked.split(/[\\/]/).pop() ?? "letterhead");
  };

  const setPage2 = async (usePage2: boolean) => {
    if (!pdfInfo) return;
    setBusy("Rendering…");
    try {
      const r = await letterheadFromPdf(pdfInfo.bytes, pdfInfo.name, usePage2);
      if (r) adopt(r.letterhead, { ownRest: usePage2 });
      setPdfInfo({ ...pdfInfo, usePage2 });
    } finally {
      setBusy(null);
    }
  };
  const setPlacement = async (placement: ImagePlacement) => {
    if (!imageInfo) return;
    const r = await letterheadFromImage(imageInfo.blob, imageInfo.name, placement, sheet);
    setImageInfo({ ...imageInfo, placement });
    adopt(r.letterhead);
  };

  // ---- design (live) ---------------------------------------------------------------------------
  useEffect(() => {
    if (tab !== "design") return;
    const t = window.setTimeout(() => adopt(designLetterhead(design, sheet), { ownRest: true }), 120);
    return () => window.clearTimeout(t);
  }, [tab, design, sheet, adopt]);

  const pickLogo = async () => {
    const picked = await openFileDialog({ multiple: false, filters: [{ name: "Logo", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }] });
    if (!picked || Array.isArray(picked)) return;
    const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: picked });
    const ext = picked.split(".").pop()?.toLowerCase() ?? "png";
    const blob = new Blob([bytes], { type: ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}` });
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const logo = c.toDataURL("image/png");
    const aspect = bmp.width / bmp.height;
    bmp.close();
    // The logo's own colour becomes the brand colour (a draft letterhead from it reports one).
    const probe = designLetterhead({ ...design, logo, logoAspect: aspect, style: "classic", company: "" }, sheet);
    const { brandColorOf } = await import("../../utils/docLetterhead");
    const brand = await brandColorOf(probe.first, probe.widthPx, probe.heightPx);
    setDesign((d) => ({ ...d, logo, logoAspect: aspect, color: brand ?? d.color }));
  };

  // ---- apply -----------------------------------------------------------------------------------
  const finalDraft = useMemo((): DocLetterhead | null => {
    if (!draft) return null;
    const rest = restMode === "plain" ? null : restMode === "same" ? draft.first : (draft.rest ?? draft.first);
    return { ...draft, rest, restTopIn: restMode === "plain" ? Math.min(draft.restTopIn, 1) : restMode === "same" ? draft.firstTopIn : draft.restTopIn };
  }, [draft, restMode]);

  const apply = async () => {
    if (!finalDraft) return;
    setBusy("Applying…");
    try {
      onApply(finalDraft, { saveToLibrary: save, makeDefault: save && makeDefault, thumb: save ? await letterheadThumb(finalDraft) : "" });
    } finally {
      setBusy(null);
    }
  };

  const patchDraft = (p: Partial<DocLetterhead>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "library", label: "Your letterheads", icon: <MdPhotoLibrary size={16} /> },
    { id: "import", label: "Import", icon: <MdOutlineFileUpload size={16} /> },
    { id: "design", label: "Design", icon: <MdOutlineDesignServices size={16} /> },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[6vh] bg-neutral-950/40 backdrop-blur-[2px] doc-lh-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="doc-lh-dialog w-[980px] max-w-[calc(100vw-32px)] max-h-[88vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-800 shadow-[0_24px_64px_rgba(15,23,42,0.35)] text-neutral-800 dark:text-neutral-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div>
            <h2 className="text-lg font-semibold">Letterhead</h2>
            <p className="text-[13px] text-neutral-500 dark:text-neutral-400">Write on your company’s stationery - on screen, in print and PDF, and in Word.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700" aria-label="Close">
            <MdClose size={20} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex border-t border-neutral-100 dark:border-neutral-700">
          {/* Preview */}
          <div className="w-[440px] shrink-0 bg-[#eef1f5] dark:bg-neutral-900 overflow-y-auto px-6 py-5">
            {finalDraft ? (
              <>
                <div className="flex items-center justify-center gap-1 mb-3">
                  {(["first", "rest"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPreviewPage(p)}
                      className={`h-7 px-3 rounded-full text-xs font-medium ${previewPage === p ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-900 dark:text-white" : "text-neutral-500"}`}
                    >
                      {p === "first" ? "Page 1" : "Later pages"}
                    </button>
                  ))}
                </div>
                <Preview lh={finalDraft} page={previewPage} restMode={restMode} onChange={patchDraft} />
                <p className="mt-3 text-center text-[11px] text-neutral-500">Drag the dashed lines to set where your writing starts and stops.</p>
              </>
            ) : (
              <div className="h-full min-h-[420px] flex flex-col items-center justify-center text-center text-neutral-400 gap-2">
                <div className="doc-lh-sheet bg-white w-[220px] h-[285px] flex items-center justify-center text-xs">No letterhead yet</div>
                <span className="text-xs">Pick, import or design one on the right.</span>
              </div>
            )}
          </div>

          {/* Sources and options */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-6 pt-4">
              <div className="inline-flex p-1 rounded-xl bg-neutral-100 dark:bg-neutral-900">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={`h-8 px-3.5 inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition ${tab === t.id ? "bg-white dark:bg-neutral-700 shadow-sm" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}`}
                  >
                    {t.icon}
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
              {tab === "library" &&
                (library === null ? (
                  <div className="py-8 flex justify-center">
                    <BrandLoader variant="contained" size="sm" message="Loading letterheads…" />
                  </div>
                ) : library.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-600 p-6 text-center text-sm text-neutral-500">
                    Letterheads you save appear here, ready for any document.
                    <div className="mt-3 flex justify-center gap-2">
                      <button type="button" onClick={() => setTab("import")} className="h-8 px-3 rounded-lg bg-blue-600 text-white text-[13px] font-medium">
                        Import one
                      </button>
                      <button type="button" onClick={() => setTab("design")} className="h-8 px-3 rounded-lg border border-neutral-200 dark:border-neutral-600 text-[13px] font-medium">
                        Design one
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    {library.map((r) => (
                      <div key={r.id} className="group relative">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(r.id);
                            adopt(r.letterhead, { ownRest: !!r.letterhead.rest && r.letterhead.rest !== r.letterhead.first });
                            setSave(false);
                          }}
                          className={`block w-full rounded-xl overflow-hidden border-2 transition ${selectedId === r.id ? "border-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.18)]" : "border-transparent hover:border-neutral-300"}`}
                        >
                          {r.thumb ? <img src={r.thumb} alt="" className="w-full aspect-[8.5/11] object-cover bg-white" /> : <div className="w-full aspect-[8.5/11] bg-white" />}
                        </button>
                        <div className="mt-1.5 flex items-center gap-1">
                          <span className="flex-1 truncate text-[12px] font-medium">{r.name}</span>
                          <button
                            type="button"
                            onClick={async () => {
                              await setDefaultLetterhead(r.isDefault ? null : r.id);
                              setLibrary(await listLetterheads());
                            }}
                            className={r.isDefault ? "text-amber-500" : "text-neutral-400 hover:text-amber-500"}
                            data-tip={r.isDefault ? "Default for new documents" : "Use for new documents"}
                            aria-label="Default for new documents"
                          >
                            {r.isDefault ? <MdOutlineStar size={16} /> : <MdOutlineStarBorder size={16} />}
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await deleteLetterhead(r.id);
                              setLibrary(await listLetterheads());
                            }}
                            className="text-neutral-400 hover:text-red-600 opacity-0 group-hover:opacity-100"
                            data-tip="Delete from your letterheads"
                            aria-label="Delete"
                          >
                            <MdDeleteOutline size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

              {tab === "import" && (
                <>
                  <div
                    className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center px-6 py-8 transition ${dragOver ? "border-blue-500 bg-blue-50/70 dark:bg-blue-500/10" : "border-neutral-300 dark:border-neutral-600"}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      const f = e.dataTransfer.files[0];
                      if (f) void f.arrayBuffer().then((b) => importFile(b, f.name, f.type));
                    }}
                  >
                    <MdOutlineFileUpload size={30} className="text-neutral-400" />
                    <div className="text-sm font-medium">Drop your letterhead here</div>
                    <div className="text-xs text-neutral-500 max-w-[340px]">A Word document or template (.docx, .dotx), a PDF, or a picture (PNG, JPG, SVG). Logos, shapes and text boxes in a Word header come across as they are.</div>
                    <button type="button" onClick={() => void pick()} className="mt-1 h-8 px-3.5 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700">
                      Choose file…
                    </button>
                  </div>
                  {busy && <div className="mt-3 text-[13px] text-neutral-500 doc-lh-busy">{busy}</div>}
                  {error && <div className="mt-3 text-[13px] text-red-600">{error}</div>}
                  {pdfInfo && pdfInfo.pages > 1 && (
                    <label className="mt-4 flex items-center gap-2 text-[13px] cursor-pointer">
                      <input type="checkbox" checked={pdfInfo.usePage2} onChange={(e) => void setPage2(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                      Page 2 of the PDF is the continuation sheet for later pages
                    </label>
                  )}
                  {imageInfo && (
                    <div className="mt-4">
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">The picture is</div>
                      <div className="inline-flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900">
                        {(
                          [
                            ["sheet", "A whole page"],
                            ["top", "A banner at the top"],
                            ["bottom", "A banner at the bottom"],
                          ] as const
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => void setPlacement(id)}
                            className={`h-7 px-3 rounded-md text-xs ${imageInfo.placement === id ? "bg-white dark:bg-neutral-700 shadow-sm font-medium" : "text-neutral-500"}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {tab === "design" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-2">
                    {DESIGN_STYLES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setDesign((d) => ({ ...d, style: s.id }))}
                        className={`rounded-xl border-2 p-1.5 text-[11px] font-medium transition ${design.style === s.id ? "border-blue-500" : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300"}`}
                      >
                        <DesignThumb style={s.id} color={design.color} />
                        <div className="mt-1">{s.label}</div>
                      </button>
                    ))}
                  </div>
                  <Field label="Company name">
                    <input value={design.company} onChange={(e) => setDesign((d) => ({ ...d, company: e.target.value }))} placeholder="Greater Grace Cooperative" className="doc-lh-input" autoFocus />
                  </Field>
                  <Field label="Tagline">
                    <input value={design.tagline} onChange={(e) => setDesign((d) => ({ ...d, tagline: e.target.value }))} placeholder="Multipurpose Society Limited" className="doc-lh-input" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Address (one line each)">
                      <textarea rows={3} value={design.address} onChange={(e) => setDesign((d) => ({ ...d, address: e.target.value }))} placeholder={"2 Femi Orioye Avenue\nIkorodu, Lagos"} className="doc-lh-input resize-none" />
                    </Field>
                    <Field label="Phone, email, website">
                      <textarea rows={3} value={design.contact} onChange={(e) => setDesign((d) => ({ ...d, contact: e.target.value }))} placeholder={"+234 803 000 0000\nhello@company.com\ncompany.com"} className="doc-lh-input resize-none" />
                    </Field>
                  </div>
                  <div className="flex items-end gap-4">
                    <Field label="Logo">
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => void pickLogo()} className="h-9 px-3 whitespace-nowrap rounded-lg border border-neutral-200 dark:border-neutral-600 text-[13px] font-medium hover:bg-neutral-50 dark:hover:bg-neutral-700">
                          {design.logo ? "Change logo…" : "Add logo…"}
                        </button>
                        {design.logo && <img src={design.logo} alt="" className="h-9 max-w-[80px] object-contain" />}
                        {design.logo && (
                          <button type="button" onClick={() => setDesign((d) => ({ ...d, logo: null }))} className="text-neutral-400 hover:text-red-600" aria-label="Remove logo">
                            <MdClose size={16} />
                          </button>
                        )}
                      </div>
                    </Field>
                    <Field label="Brand colour">
                      <div className="flex items-center gap-1.5 h-9">
                        {BRAND_SWATCHES.map((c) => (
                          <button key={c} type="button" onClick={() => setDesign((d) => ({ ...d, color: c }))} className={`w-6 h-6 rounded-full ${design.color === c ? "ring-2 ring-offset-2 ring-blue-500" : ""}`} style={{ background: c }} aria-label={c} />
                        ))}
                        <label className="relative w-6 h-6 rounded-full overflow-hidden cursor-pointer" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} data-tip="Custom colour">
                          <ColorInput value={design.color} onChange={(e) => setDesign((d) => ({ ...d, color: e.target.value }))} className="absolute inset-0 opacity-0 cursor-pointer" />
                        </label>
                      </div>
                    </Field>
                    <Field label="Type">
                      <div className="inline-flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900 h-9 items-center">
                        {(["sans", "serif"] as const).map((f) => (
                          <button key={f} type="button" onClick={() => setDesign((d) => ({ ...d, font: f }))} className={`h-8 px-3 rounded-md text-xs ${design.font === f ? "bg-white dark:bg-neutral-700 shadow-sm font-medium" : "text-neutral-500"}`} style={{ fontFamily: f === "serif" ? "Georgia, serif" : undefined }}>
                            {f === "sans" ? "Sans" : "Serif"}
                          </button>
                        ))}
                      </div>
                    </Field>
                  </div>
                </div>
              )}

              {finalDraft && (
                <div className="mt-5 pt-4 border-t border-neutral-100 dark:border-neutral-700">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Pages after the first</div>
                  <div className="inline-flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-900">
                    {(
                      [
                        ["same", "Same letterhead"],
                        ...(hasOwnRest ? ([["own", "Continuation sheet"]] as const) : []),
                        ["plain", "Plain paper"],
                      ] as [RestMode, string][]
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setRestMode(id);
                          setPreviewPage("rest");
                        }}
                        className={`h-7 px-3 rounded-md text-xs ${restMode === id ? "bg-white dark:bg-neutral-700 shadow-sm font-medium" : "text-neutral-500"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {!selectedId && (
                    <>
                      <div className="mt-5 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Save</div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <input value={finalDraft.name} onChange={(e) => patchDraft({ name: e.target.value })} placeholder="Letterhead name" className="doc-lh-input !w-56" aria-label="Letterhead name" />
                        <label className="flex items-center gap-1.5 text-[13px] text-neutral-600 dark:text-neutral-300 cursor-pointer whitespace-nowrap">
                          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                          Save to my letterheads
                        </label>
                        <label className={`flex items-center gap-1.5 text-[13px] text-neutral-600 dark:text-neutral-300 cursor-pointer whitespace-nowrap ${save ? "" : "opacity-40 pointer-events-none"}`}>
                          <input type="checkbox" checked={save && makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                          Use for new documents
                        </label>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-neutral-100 dark:border-neutral-700 flex items-center gap-3">
              <div className="flex-1" />
              {current && (
                <button type="button" onClick={onRemove} className="h-9 px-3 rounded-lg text-[13px] font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">
                  Remove letterhead
                </button>
              )}
              <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg text-[13px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                Cancel
              </button>
              <button
                type="button"
                disabled={!finalDraft || !!busy}
                onClick={() => void apply()}
                className="h-9 px-4 rounded-lg text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <MdCheck size={16} />
                {current ? "Update letterhead" : "Use letterhead"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="block mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{label}</span>
    {children}
  </label>
);

// Miniature of each designer layout for the style picker.
const DesignThumb: React.FC<{ style: DesignStyle; color: string }> = ({ style, color }) => (
  <svg viewBox="0 0 85 110" className="w-full rounded-md bg-white ring-1 ring-black/5">
    {style === "band" && <rect x="0" y="0" width="85" height="16" fill={color} />}
    {style === "band" && <rect x="0" y="106" width="85" height="4" fill={color} />}
    {style === "modern" && (
      <>
        <rect x="8" y="8" width="10" height="10" rx="2" fill={color} />
        <rect x="21" y="10" width="26" height="3" rx="1.5" fill={color} />
        <rect x="57" y="9" width="20" height="2" rx="1" fill="#cbd5e1" />
        <rect x="61" y="13" width="16" height="2" rx="1" fill="#cbd5e1" />
        <rect x="8" y="23" width="69" height="1" fill={color} />
        <rect x="0" y="108" width="85" height="2" fill={color} />
      </>
    )}
    {style === "classic" && (
      <>
        <circle cx="42.5" cy="11" r="5" fill={color} />
        <rect x="27" y="19" width="31" height="3" rx="1.5" fill={color} />
        <rect x="8" y="26" width="69" height="0.8" fill={color} />
        <rect x="20" y="102" width="45" height="1.5" rx="0.75" fill="#cbd5e1" />
      </>
    )}
    {style === "minimal" && (
      <>
        <rect x="8" y="10" width="24" height="3" rx="1.5" fill={color} />
        <rect x="57" y="9" width="20" height="1.5" rx="0.75" fill="#cbd5e1" />
        <rect x="61" y="12.5" width="16" height="1.5" rx="0.75" fill="#cbd5e1" />
        <rect x="8" y="19" width="69" height="0.6" fill="#94a3b8" />
      </>
    )}
    {style === "band" && <rect x="8" y="6" width="24" height="3" rx="1.5" fill="#fff" />}
    {[34, 39, 44, 49, 54, 59, 64].map((y) => (
      <rect key={y} x="8" y={y} width={y === 64 ? 40 : 69} height="1.6" rx="0.8" fill="#e5e7eb" />
    ))}
  </svg>
);

export default DocLetterheadDialog;
