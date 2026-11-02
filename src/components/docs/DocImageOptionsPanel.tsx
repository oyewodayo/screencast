// components/docs/DocImageOptionsPanel.tsx
//
// "Image options" for the selected picture (opened from DocImageView's toolbar): exact size in the
// ruler's unit (inches or cm, like Word's Size box) with the proportions locked or free, quick
// widths as a share of the text column, rotation, position for free pictures, transparency,
// border, rounded corners, shadow, alt text, and Replace. Every field also scrubs: drag its label
// sideways to change the value live, as in a design tool. Changes apply as they're made - the
// picture on the page is the preview.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { MdClose, MdLink, MdLinkOff, MdRefresh, MdRotateLeft, MdRotateRight, MdSwapHoriz } from "react-icons/md";
import { isFreeLayout, type DocImageAttrs } from "../../utils/docImageLayout";
import { uploadImageFromPath } from "../../utils/docImagePaste";
import { useRulerUnit } from "./DocRuler";

interface Props {
  attrs: DocImageAttrs;
  docId: string | null;
  anchor: { left: number; top: number };
  naturalSize: () => { width: number; height: number } | null;
  maxWidth: () => number;
  onChange: (attrs: Partial<DocImageAttrs>) => void;
  onClose: () => void;
}

const BORDER_COLORS = ["#111827", "#6b7280", "#ffffff", "#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed"];
const PX_PER_IN = 96;

// A number field whose label scrubs the value when dragged sideways (Shift: 10x).
const ScrubField: React.FC<{
  label: string;
  value: number;
  display: (v: number) => string;
  parse: (s: string) => number | null;
  step: number;
  min?: number;
  max?: number;
  suffix?: string;
  onCommit: (v: number) => void;
  className?: string;
}> = ({ label, value, display, parse, step, min = -Infinity, max = Infinity, suffix, onCommit, className = "" }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const scrub = useRef<{ x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <label className={`flex items-center h-8 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 ${className}`}>
      <span
        className="pl-2 pr-1 text-[11px] font-semibold text-neutral-400 cursor-ew-resize select-none"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, v: value };
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return;
          const dx = e.clientX - scrub.current.x;
          onCommit(clamp(scrub.current.v + Math.round(dx / 2) * step * (e.shiftKey ? 10 : 1)));
        }}
        onPointerUp={() => (scrub.current = null)}
      >
        {label}
      </span>
      <input
        className="w-full min-w-0 bg-transparent text-[13px] tabular-nums text-neutral-800 dark:text-neutral-100 outline-none py-1"
        value={draft ?? display(value)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          if (draft !== null) {
            const v = parse(draft);
            if (v !== null && Number.isFinite(v)) onCommit(clamp(v));
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            onCommit(clamp(value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
            setDraft(null);
          }
        }}
      />
      {suffix && <span className="pr-2 text-[11px] text-neutral-400">{suffix}</span>}
    </label>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-700/70 first:border-t-0">
    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</div>
    {children}
  </div>
);

const Slider: React.FC<{ value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }> = ({ value, min, max, step = 1, onChange, label }) => (
  <input
    type="range"
    aria-label={label}
    min={min}
    max={max}
    step={step}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className="w-full accent-blue-600 h-1.5"
  />
);

const DocImageOptionsPanel: React.FC<Props> = ({ attrs: a, docId, anchor, naturalSize, maxWidth, onChange, onClose }) => {
  const [unit] = useRulerUnit();
  const [locked, setLocked] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const free = isFreeLayout(a.layout);
  const nat = naturalSize();
  const width = a.width ?? nat?.width ?? 0;
  const height = a.height ?? nat?.height ?? 0;
  const aspect = width && height ? width / height : 1;

  // Shown in the ruler's unit; stored in px.
  const toUnit = (px: number) => (unit === "in" ? px / PX_PER_IN : (px / PX_PER_IN) * 2.54);
  const fromUnit = (v: number) => (unit === "in" ? v * PX_PER_IN : (v / 2.54) * PX_PER_IN);
  const lenDisplay = (px: number) => toUnit(px).toFixed(2);
  const lenParse = (s: string) => {
    const v = parseFloat(s.replace(",", "."));
    return Number.isFinite(v) ? Math.round(fromUnit(v)) : null;
  };
  const lenStep = unit === "in" ? PX_PER_IN / 100 : PX_PER_IN / 254;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (panelRef.current?.contains(t) || t.closest(".doc-image-toolbar") || t.closest(".doc-image")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const setWidth = (w: number) => {
    w = Math.max(16, Math.round(w));
    onChange(locked ? { width: w, height: Math.max(16, Math.round(w / aspect)) } : { width: w, height: Math.round(height) || null });
  };
  const setHeight = (h: number) => {
    h = Math.max(16, Math.round(h));
    onChange(locked ? { height: h, width: Math.max(16, Math.round(h * aspect)) } : { height: h, width: Math.round(width) || null });
  };
  const fitShare = (share: number) => {
    const w = Math.round(maxWidth() * share);
    onChange({ width: w, height: Math.round(w / aspect) });
  };
  const resetSize = () => {
    const n = naturalSize();
    if (!n) return onChange({ width: null, height: null });
    const max = maxWidth();
    const w = Math.min(n.width, max);
    onChange({ width: w, height: Math.round(w / (n.width / n.height)) });
  };
  const rotateBy = (d: number) => {
    let r = (((a.rotation + d + 180) % 360) + 360) % 360 - 180;
    if (r === -180) r = 180;
    onChange({ rotation: r });
  };

  const replace = async () => {
    if (!docId) return;
    const picked = await openFileDialog({ multiple: false, filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      const src = await uploadImageFromPath(docId, picked);
      // Keep the width on the page, take the new picture's own proportions.
      const img = new Image();
      img.src = src;
      await img.decode().catch(() => undefined);
      const w = a.width ?? Math.min(img.naturalWidth || 400, maxWidth());
      onChange({ src, width: w, height: img.naturalWidth ? Math.round(w * (img.naturalHeight / img.naturalWidth)) : a.height });
    } catch (err) {
      console.error("Failed to replace image:", err);
    }
  };

  const left = Math.min(anchor.left, window.innerWidth - 316);
  const top = Math.min(anchor.top, window.innerHeight - 40);

  return createPortal(
    <div
      ref={panelRef}
      className="print:hidden fixed z-[71] w-[300px] max-h-[calc(100vh-24px)] overflow-y-auto rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-[0_12px_32px_rgba(15,23,42,0.18),0_2px_6px_rgba(15,23,42,0.12)] text-neutral-800 dark:text-neutral-100"
      style={{ left, top }}
      onMouseDown={(e) => {
        // Keep the picture selected while using the panel, but let fields take focus.
        if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
      }}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="text-sm font-semibold">{a.kind === "signature" ? "Signature options" : "Image options"}</div>
        <button type="button" onClick={onClose} className="p-1 rounded-md text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700" aria-label="Close">
          <MdClose size={16} />
        </button>
      </div>

      <Section title="Size">
        <div className="flex items-center gap-1.5">
          <ScrubField label="W" value={width} display={lenDisplay} parse={lenParse} step={lenStep} min={16} suffix={unit} onCommit={setWidth} className="flex-1" />
          <button
            type="button"
            onClick={() => setLocked((v) => !v)}
            className={`shrink-0 p-1.5 rounded-md ${locked ? "text-blue-600 bg-blue-50 dark:bg-blue-500/15" : "text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"}`}
            data-tip={locked ? "Proportions locked" : "Proportions free"}
            aria-label="Lock proportions"
            aria-pressed={locked}
          >
            {locked ? <MdLink size={16} /> : <MdLinkOff size={16} />}
          </button>
          <ScrubField label="H" value={height} display={lenDisplay} parse={lenParse} step={lenStep} min={16} suffix={unit} onCommit={setHeight} className="flex-1" />
        </div>
        <div className="mt-2 flex items-center gap-1">
          {[0.25, 0.5, 0.75, 1].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => fitShare(s)}
              className="flex-1 h-7 rounded-md text-xs font-medium text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700/60 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              data-tip={`${s * 100}% of the text width`}
            >
              {s * 100}%
            </button>
          ))}
          <button type="button" onClick={resetSize} className="h-7 px-2 rounded-md text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 inline-flex items-center gap-1" data-tip="Original size (fitted to the page)">
            <MdRefresh size={14} />
            Reset
          </button>
        </div>
      </Section>

      <Section title="Rotation">
        <div className="flex items-center gap-1.5">
          <ScrubField
            label="Angle"
            suffix="°"
            value={a.rotation}
            display={(v) => String(Math.round(v * 10) / 10)}
            parse={(s) => {
              const v = parseFloat(s);
              return Number.isFinite(v) ? v : null;
            }}
            step={1}
            min={-180}
            max={180}
            onCommit={(v) => onChange({ rotation: Math.round(v * 10) / 10 })}
            className="flex-1"
          />
          <button type="button" onClick={() => rotateBy(-90)} className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700" data-tip="Rotate left 90°" aria-label="Rotate left">
            <MdRotateLeft size={18} />
          </button>
          <button type="button" onClick={() => rotateBy(90)} className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700" data-tip="Rotate right 90°" aria-label="Rotate right">
            <MdRotateRight size={18} />
          </button>
        </div>
        {!free && a.rotation !== 0 && <p className="mt-1.5 text-[11px] text-neutral-400">Rotation doesn’t move the text around the picture.</p>}
      </Section>

      {free && (
        <Section title="Position from paragraph">
          <div className="flex items-center gap-1.5">
            <ScrubField label="X" value={a.x} display={lenDisplay} parse={lenParse} step={lenStep} suffix={unit} onCommit={(v) => onChange({ x: Math.round(v) })} className="flex-1" />
            <ScrubField label="Y" value={a.y} display={lenDisplay} parse={lenParse} step={lenStep} suffix={unit} onCommit={(v) => onChange({ y: Math.round(v) })} className="flex-1" />
          </div>
          <p className="mt-1.5 text-[11px] text-neutral-400">Drag it on the page, or nudge with the arrow keys (Shift: 10px). Hold Alt while dragging to turn snapping off.</p>
        </Section>
      )}

      <Section title="Appearance">
        <div className="flex items-center justify-between text-xs text-neutral-500 mb-1">
          <span>Transparency</span>
          <span className="tabular-nums">{Math.round((1 - a.opacity) * 100)}%</span>
        </div>
        <Slider label="Transparency" value={Math.round((1 - a.opacity) * 100)} min={0} max={90} onChange={(v) => onChange({ opacity: Math.round((1 - v / 100) * 100) / 100 })} />

        <div className="flex items-center justify-between text-xs text-neutral-500 mt-3 mb-1">
          <span>Border</span>
          <span className="tabular-nums">{a.borderWidth ? `${a.borderWidth}px` : "None"}</span>
        </div>
        <Slider label="Border width" value={a.borderWidth} min={0} max={12} onChange={(v) => onChange({ borderWidth: v })} />
        <div className="mt-2 flex items-center gap-1.5">
          {BORDER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChange({ borderColor: c, borderWidth: a.borderWidth || 2 })}
              className={`w-5 h-5 rounded-full ring-1 ring-black/10 ${a.borderColor === c && a.borderWidth ? "outline outline-2 outline-offset-2 outline-blue-500" : ""}`}
              style={{ background: c }}
              aria-label={`Border colour ${c}`}
            />
          ))}
          <label className="relative w-5 h-5 rounded-full ring-1 ring-black/10 overflow-hidden cursor-pointer" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }} data-tip="Custom colour">
            <input type="color" className="absolute inset-0 opacity-0 cursor-pointer" value={a.borderColor} onChange={(e) => onChange({ borderColor: e.target.value, borderWidth: a.borderWidth || 2 })} />
          </label>
        </div>

        <div className="flex items-center justify-between text-xs text-neutral-500 mt-3 mb-1">
          <span>Rounded corners</span>
          <span className="tabular-nums">{a.radius}px</span>
        </div>
        <Slider label="Corner radius" value={a.radius} min={0} max={Math.max(48, Math.round(Math.min(width, height) / 2))} onChange={(v) => onChange({ radius: v })} />

        <label className="mt-3 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
          <span>Drop shadow</span>
          <input type="checkbox" checked={a.shadow} onChange={(e) => onChange({ shadow: e.target.checked })} className="accent-blue-600 w-4 h-4" />
        </label>
      </Section>

      <Section title="Alt text">
        <textarea
          rows={2}
          value={a.alt ?? ""}
          onChange={(e) => onChange({ alt: e.target.value || null })}
          placeholder="Describe the picture for screen readers and exports"
          className="w-full resize-none rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 px-2 py-1.5 text-[13px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        />
      </Section>

      {docId && (
        <div className="px-4 pb-3 pt-1">
          <button
            type="button"
            onClick={() => void replace()}
            className="w-full h-8 rounded-lg inline-flex items-center justify-center gap-1.5 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700/60"
          >
            <MdSwapHoriz size={16} />
            Replace image…
          </button>
        </div>
      )}
    </div>,
    document.body
  );
};

export default DocImageOptionsPanel;
