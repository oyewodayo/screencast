// components/video/WebcamBubbleMarker.tsx
//
// "Fix webcam background" for a screen recording with the camera baked in: an outline over the
// bubble - found exactly when the recording saved where it put it (webcamBubble.ts), otherwise at
// the usual spot for the user to drag onto theirs - and one button. Everything outside the outline
// dims, so it's obvious what's being picked.
//
// Drags use window listeners (the same WebView2 reliability reason as ClipCropOverlay).
import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { IoPersonCircleOutline } from "react-icons/io5";
import type { FrameRect } from "../../utils/videoFrameRect";
import { bubbleRegion, defaultBubbleRegion, loadBubbleSettings, type BubbleRegion } from "../../utils/webcamBubble";
import type { PipShape } from "../../utils/videoEditTypes";

interface Props {
  frameRect: FrameRect;
  sourcePath: string;
  onConfirm: (region: BubbleRegion) => void;
  onCancel: () => void;
}

const SHAPES: { value: PipShape; label: string }[] = [
  { value: "circle", label: "Circle" },
  { value: "rounded", label: "Rounded" },
  { value: "rectangle", label: "Box" },
];

type Drag = { kind: "move" | "resize"; x: number; y: number; start: BubbleRegion };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const WebcamBubbleMarker: React.FC<Props> = ({ frameRect, sourcePath, onConfirm, onCancel }) => {
  const [region, setRegion] = useState<BubbleRegion | null>(null);
  const [found, setFound] = useState(false);
  const regionRef = useRef(region);
  regionRef.current = region;
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef(frameRect);
  frameRef.current = frameRect;

  // Where it is: the recording's own record of it, or the default spot - in the source's own size.
  useEffect(() => {
    let live = true;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = async () => {
      const W = video.videoWidth || 1920;
      const H = video.videoHeight || 1080;
      const settings = await loadBubbleSettings(sourcePath);
      if (!live) return;
      setFound(!!settings);
      setRegion(settings ? bubbleRegion(settings, W, H) : defaultBubbleRegion(W, H));
    };
    video.src = convertFileSrc(sourcePath);
    return () => {
      live = false;
      video.removeAttribute("src");
    };
  }, [sourcePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter" && regionRef.current) {
        e.stopPropagation();
        onConfirm(regionRef.current);
      }
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const fr = frameRef.current;
      if (!d || fr.width <= 0) return;
      const dx = (e.clientX - d.x) / fr.width;
      const dy = (e.clientY - d.y) / fr.height;
      const s = d.start;
      if (d.kind === "move") {
        setRegion({ ...s, x: clamp(s.x + dx, 0, 1 - s.width), y: clamp(s.y + dy, 0, 1 - s.height) });
      } else {
        // From the top-left corner; a circle or rounded bubble stays square on screen.
        let width = clamp(s.width + dx, 0.03, 1 - s.x);
        let height = clamp(s.height + dy, 0.03, 1 - s.y);
        if (s.shape !== "rectangle") {
          const side = Math.min(Math.max(width * fr.width, height * fr.height), (1 - s.x) * fr.width, (1 - s.y) * fr.height);
          width = side / fr.width;
          height = side / fr.height;
        }
        setRegion({ ...s, width, height });
      }
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onCancel, onConfirm]);

  if (!region) return null;
  const left = region.x * frameRect.width;
  const top = region.y * frameRect.height;
  const w = region.width * frameRect.width;
  const h = region.height * frameRect.height;
  const radius = region.shape === "circle" ? "50%" : region.shape === "rounded" ? (region.cornerRadius ?? 0.125) * h : 0;
  const begin = (kind: Drag["kind"]) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind, x: e.clientX, y: e.clientY, start: region };
  };
  const setShape = (shape: PipShape) => {
    // Square on screen for the round ones, centred where it was.
    if (shape === "rectangle") return setRegion({ ...region, shape, cornerRadius: undefined });
    const side = Math.min(w, h);
    setRegion({
      ...region,
      shape,
      cornerRadius: shape === "rounded" ? 0.125 : undefined,
      x: region.x + (w - side) / 2 / frameRect.width,
      y: region.y + (h - side) / 2 / frameRect.height,
      width: side / frameRect.width,
      height: side / frameRect.height,
    });
  };
  const panelTop = top > 120 ? top - 108 : top + h + 10;
  const panelLeft = clamp(left + w / 2 - 140, 8, Math.max(8, frameRect.width - 288));

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "auto", zIndex: 102 }} onPointerDown={(e) => e.stopPropagation()}>
      {/* Everything but the bubble, dimmed - the outline's own huge shadow. */}
      <div
        onPointerDown={begin("move")}
        title="Drag to move onto your webcam bubble"
        className="absolute cursor-move ring-2 ring-emerald-400"
        style={{ left, top, width: w, height: h, borderRadius: radius, boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)", touchAction: "none" }}
      />
      <div
        onPointerDown={begin("resize")}
        title="Drag to resize"
        className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full bg-emerald-400 ring-2 ring-white cursor-nwse-resize"
        style={{ left: left + w, top: top + h, touchAction: "none" }}
      />
      <div
        className="absolute w-[280px] p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-2"
        style={{ left: panelLeft, top: panelTop }}
      >
        <div className="flex items-center gap-2 text-xs font-medium">
          <IoPersonCircleOutline size={16} className="text-emerald-300" />
          {found ? "Found your webcam bubble" : "Fit the outline to your webcam bubble"}
        </div>
        <div className="flex items-center gap-1">
          {SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setShape(s.value)}
              className={`px-2 py-0.5 rounded text-[11px] ${region.shape === s.value ? "text-emerald-300 bg-emerald-500/15 ring-1 ring-emerald-400/40" : "text-white/70 hover:bg-white/10"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="px-2.5 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10">
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(region)} className="px-3 py-1 rounded-md text-[11px] font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950">
            Replace background
          </button>
        </div>
      </div>
    </div>
  );
};

export default WebcamBubbleMarker;
