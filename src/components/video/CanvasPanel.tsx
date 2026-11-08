// components/video/CanvasPanel.tsx
//
// Picks the canvas the edit is made in (canvasFormats.ts): the video's own shape, a platform's or
// a phone's whole screen. Each choice is drawn in its real shape - phones as phones - and the
// player takes it on at once: the picture fitted in, every layer kept as it looks, split screens
// re-flowed to fill it. One undo step.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoPhonePortraitOutline } from "react-icons/io5";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { CANVAS_PRESETS, CanvasBackground, CanvasFormat, CanvasPreset, aspectLabel, canvasFromPreset } from "../../utils/canvasFormats";
import { usePhonePreview } from "../../hooks/usePhonePreview";

interface CanvasPanelProps {
  anchor: PopoverAnchor;
  canvas: CanvasFormat | null;
  // The open video's own size.
  native: { width: number; height: number } | null;
  onChange: (canvas: CanvasFormat | null) => void;
  onClose: () => void;
}

// A shape `width` x `height` drawn at most 40 tall / 52 wide.
const ShapeIcon: React.FC<{ width: number; height: number; phone?: boolean; active: boolean }> = ({ width, height, phone, active }) => {
  const scale = Math.min(52 / width, 40 / height);
  const w = Math.max(10, width * scale);
  const h = Math.max(10, height * scale);
  return (
    <span
      className={`relative block transition-colors ${active ? "bg-blue-400/80" : "bg-white/25 group-hover:bg-white/40"}`}
      style={{ width: w, height: h, borderRadius: phone ? w * 0.2 : 3, boxShadow: phone ? "0 0 0 2px rgba(255,255,255,0.18)" : undefined }}
    >
      {phone && <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/70" style={{ top: w * 0.07, width: w * 0.32, height: Math.max(2, w * 0.09) }} />}
    </span>
  );
};

const CanvasPanel: React.FC<CanvasPanelProps> = ({ anchor, canvas, native, onChange, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const [phonePreview, setPhonePreview] = usePhonePreview();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tile = (key: string, label: string, hint: string, width: number, height: number, active: boolean, pick: () => void, phone?: boolean) => (
    <button
      key={key}
      type="button"
      onClick={pick}
      title={`${label} - ${hint}`}
      className={`group flex flex-col items-center gap-1 px-1 pt-2 pb-1.5 rounded-lg transition-colors ${active ? "bg-blue-500/20 ring-1 ring-blue-400/60" : "bg-white/[0.04] hover:bg-white/10"}`}
    >
      <span className="h-11 flex items-center justify-center">
        <ShapeIcon width={width} height={height} phone={phone} active={active} />
      </span>
      <span className="text-[10px] leading-tight text-white/85 text-center">{label}</span>
      <span className="text-[9px] leading-tight text-white/40 text-center tabular-nums">{hint}</span>
    </button>
  );
  const group = (title: string, presets: CanvasPreset[]) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-white/40">{title}</span>
      <div className="grid grid-cols-3 gap-1.5">
        {presets.map((p) => tile(p.id, p.label, p.hint, p.width, p.height, canvas?.preset === p.id, () => onChange(canvasFromPreset(p, canvas?.background ?? "blur")), p.group === "phone"))}
      </div>
    </div>
  );

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Canvas"
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-[340px] max-h-[86vh] overflow-y-auto p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Canvas</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 -m-1 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {native && tile("original", "Original", `${aspectLabel(native.width, native.height)} · ${native.width}×${native.height}`, native.width, native.height, !canvas, () => onChange(null))}
      </div>
      {group("For social", CANVAS_PRESETS.filter((p) => p.group === "social"))}
      {group("Phone screens", CANVAS_PRESETS.filter((p) => p.group === "phone"))}
      {canvas && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="flex-1">
            Around the picture
            <span className="block text-[10px] text-white/40">When a clip doesn't fill the canvas</span>
          </span>
          <div className="flex rounded-md bg-white/[0.06] p-0.5">
            {(["blur", "black"] as CanvasBackground[]).map((bg) => (
              <button
                key={bg}
                type="button"
                onClick={() => onChange({ ...canvas, background: bg })}
                className={`h-6 px-2.5 rounded text-[11px] transition-colors ${(canvas.background ?? "black") === bg ? "bg-blue-500/30 text-blue-100" : "text-white/60 hover:text-white"}`}
              >
                {bg === "blur" ? "Blur" : "Black"}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="flex items-center gap-2 text-[11px] cursor-pointer select-none">
        <IoPhonePortraitOutline size={14} className="text-white/60 shrink-0" />
        <span className="flex-1">
          Phone preview
          <span className="block text-[10px] text-white/40">The screen's corners and camera, and where an app's buttons and captions sit</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={phonePreview}
          onClick={() => setPhonePreview(!phonePreview)}
          className={`relative w-8 h-[18px] rounded-full transition-colors shrink-0 ${phonePreview ? "bg-blue-500" : "bg-white/20"}`}
        >
          <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-[left] ${phonePreview ? "left-[16px]" : "left-[2px]"}`} />
        </button>
      </label>
      <p className="text-[10px] leading-snug text-white/40">
        Your video is fitted in and every layer keeps its shape and place on the picture. Split screens re-flow to fill the new shape. Saves at this size.
      </p>
    </div>,
    document.body
  );
};

export default CanvasPanel;
