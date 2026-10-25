// components/video/FindHideTool.tsx
//
// Find & hide, on the picture: draw around something once - a logo, an email address on screen,
// a face, a number plate - pick how to hide it, and every place it appears in the video gets that
// treatment, following it as it moves (objectFind.ts does the finding and turns each appearance
// into ordinary overlays).
//
// Drags use window listeners (the same WebView2 reliability reason as ClipCropOverlay).
import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoEyeOffOutline, IoImageOutline } from "react-icons/io5";
import type { FrameRect } from "../../utils/videoFrameRect";
import type { HideEffect, HideShape } from "../../utils/objectFind";
import { BACKGROUND_SWATCHES } from "../../utils/cutoutBackground";

export type FindStatus = { phase: "idle" } | { phase: "searching"; progress: number; found: number } | { phase: "done"; found: number } | { phase: "error"; message: string };

interface Props {
  frameRect: FrameRect;
  status: FindStatus;
  onFind: (target: { x: number; y: number; width: number; height: number }, effect: HideEffect, shape: HideShape, sensitivity: number) => void;
  onCancelSearch: () => void;
  onClose: () => void;
}

type Point = { x: number; y: number };

const FindHideTool: React.FC<Props> = ({ frameRect, status, onFind, onCancelSearch, onClose }) => {
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [effect, setEffect] = useState<HideEffect>({ kind: "blur", strength: 0.8 });
  const [shape, setShape] = useState<HideShape>("ellipse");
  const [sensitivity, setSensitivity] = useState(0.5);
  const drawingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(frameRect);
  frameRef.current = frameRect;

  useEffect(() => {
    const toFrac = (e: PointerEvent): Point | null => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r || r.width <= 0) return null;
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    };
    const move = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      const p = toFrac(e);
      if (p) setStroke((s) => (s ? [...s, p] : [p]));
    };
    const up = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      setStroke((s) => {
        if (s && s.length > 2) setOutline(s);
        return null;
      });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const bbox = (pts: Point[]) => {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  const box = outline ? bbox(outline) : null;
  const tooSmall = !!box && (box.width * frameRect.width < 12 || box.height * frameRect.height < 12);
  const busy = status.phase === "searching";
  const W = frameRect.width;
  const H = frameRect.height;
  const path = (pts: Point[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x * W},${p.y * H}`).join(" ") + (pts === outline ? " Z" : "");

  const pickPicture = async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }] });
    if (typeof selected === "string") setEffect({ kind: "image", path: selected });
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: "auto", zIndex: 103 }}>
      <div
        ref={rootRef}
        className="absolute inset-0 cursor-crosshair"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0 || busy) return;
          e.stopPropagation();
          e.preventDefault();
          drawingRef.current = true;
          const r = e.currentTarget.getBoundingClientRect();
          setOutline(null);
          setStroke([{ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }]);
        }}
      >
        <svg width={W} height={H} className="absolute inset-0 pointer-events-none overflow-visible">
          {(stroke ?? outline) && (
            <>
              <path d={path((stroke ?? outline)!)} fill={outline ? "rgba(52,211,153,0.15)" : "none"} stroke="black" strokeOpacity={0.6} strokeWidth={3} />
              <path d={path((stroke ?? outline)!)} fill="none" stroke="#6ee7b7" strokeWidth={1.5} strokeDasharray="5 4" />
            </>
          )}
        </svg>
        {!stroke && !outline && (
          <div className="absolute left-1/2 top-3 -translate-x-1/2 px-3 py-1 rounded-full bg-emerald-600/90 text-white text-xs shadow pointer-events-none">
            Draw around what you want to hide - it'll be found everywhere it appears
          </div>
        )}
      </div>

      <div
        className="absolute right-3 top-3 w-72 p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <IoEyeOffOutline size={14} className="text-emerald-300" /> Find & hide
          </span>
          <button type="button" title="Close" onClick={onClose} className="p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ["blur", "Blur", <span key="b" className="absolute inset-0 bg-gradient-to-br from-amber-200 via-sky-400 to-indigo-600 blur-[3px] scale-125" />],
              ["color", "Cover", <span key="c" className="absolute inset-0" style={{ background: effect.kind === "color" ? effect.color : "#0f172a" }} />],
              [
                "image",
                "Picture",
                effect.kind === "image" ? (
                  <img key="i" src={convertFileSrc(effect.path)} alt="" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <span key="i" className="absolute inset-0 flex items-center justify-center bg-neutral-700 text-white/60">
                    <IoImageOutline size={13} />
                  </span>
                ),
              ],
            ] as const
          ).map(([kind, label, art]) => (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => (kind === "blur" ? setEffect({ kind: "blur", strength: effect.kind === "blur" ? effect.strength : 0.8 }) : kind === "color" ? setEffect({ kind: "color", color: effect.kind === "color" ? effect.color : "#0f172a" }) : void pickPicture())}
              className="flex flex-col items-center gap-1"
            >
              <span className={`relative w-full h-9 rounded-md overflow-hidden ${effect.kind === kind ? "ring-2 ring-emerald-400" : "ring-1 ring-white/15 hover:ring-white/40"}`}>{art}</span>
              <span className={`text-[10px] ${effect.kind === kind ? "text-emerald-300" : "text-white/60"}`}>{label}</span>
            </button>
          ))}
        </div>

        {effect.kind === "blur" && (
          <label className="flex items-center gap-2 text-[11px]">
            <span className="w-14 text-white/60">Strength</span>
            <input type="range" min={0.2} max={1} step={0.01} value={effect.strength} onChange={(e) => setEffect({ kind: "blur", strength: Number(e.target.value) })} className="flex-1 accent-emerald-400" />
          </label>
        )}
        {effect.kind === "color" && (
          <div className="flex flex-wrap gap-1.5">
            {BACKGROUND_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => setEffect({ kind: "color", color: c })}
                className={`w-5 h-5 rounded-full ${effect.color.toLowerCase() === c ? "ring-2 ring-emerald-400 ring-offset-1 ring-offset-neutral-900" : "ring-1 ring-white/20"}`}
                style={{ background: c }}
              />
            ))}
            <label className="relative w-5 h-5 rounded-full overflow-hidden ring-1 ring-white/20 cursor-pointer" style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} title="Any colour">
              <input type="color" value={effect.color} onChange={(e) => setEffect({ kind: "color", color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
            </label>
          </div>
        )}

        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-14 text-white/60">Shape</span>
          {(["ellipse", "rectangle"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setShape(s)} className={`px-2 py-0.5 rounded ${shape === s ? "text-emerald-300 bg-emerald-500/15 ring-1 ring-emerald-400/40" : "text-white/70 hover:bg-white/10"}`}>
              {s === "ellipse" ? "Oval" : "Box"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[11px]" title="Exact: only identical copies. Similar: also slightly different ones (other lighting, a little blur).">
          <span className="w-14 text-white/60">Match</span>
          <span className="text-[10px] text-white/40">Exact</span>
          <input type="range" min={0} max={1} step={0.01} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} className="flex-1 accent-emerald-400" />
          <span className="text-[10px] text-white/40">Similar</span>
        </label>

        {status.phase === "searching" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] text-white/75">
              <span>Searching the video…{status.found > 0 ? ` found ${status.found}` : ""}</span>
              <button type="button" onClick={onCancelSearch} className="text-[10px] text-white/55 hover:text-white">
                Stop
              </button>
            </div>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-400 transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={!box || tooSmall}
            onClick={() => box && onFind(box, effect, shape, sensitivity)}
            className="w-full py-1.5 rounded-lg text-xs font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950 disabled:opacity-40 disabled:hover:bg-emerald-500"
          >
            {!box ? "Draw around it first" : tooSmall ? "Draw a little bigger" : "Find everywhere & hide"}
          </button>
        )}
        {status.phase === "done" && (
          <p className="text-[11px] leading-snug text-emerald-300">
            Hidden in {status.found} {status.found === 1 ? "place" : "places"} - each one follows it and can be adjusted on the timeline. Draw again to hide something else.
          </p>
        )}
        {status.phase === "error" && <p className="text-[11px] leading-snug text-red-300">{status.message}</p>}
      </div>
    </div>
  );
};

export default FindHideTool;
