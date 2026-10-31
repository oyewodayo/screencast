// components/video/FindHideTool.tsx
//
// Find & hide, on the picture: draw around something once - a logo, an email address on screen,
// a face, a number plate - pick how to hide it, and every place it appears in the video gets that
// treatment, following it as it moves (objectFind.ts does the finding and turns each appearance
// into ordinary overlays).
//
// Drags use window listeners (the same WebView2 reliability reason as ClipCropOverlay).
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoEyeOffOutline, IoImageOutline, IoPencil } from "react-icons/io5";
import type { FrameRect } from "../../utils/videoFrameRect";
import type { HideEffect, HideShape, OutlineKind } from "../../utils/objectFind";
import { BACKGROUND_SWATCHES } from "../../utils/cutoutBackground";

export type FindStatus =
  | { phase: "idle" }
  | { phase: "downloading"; progress: number }
  | { phase: "searching"; progress: number; found: number }
  | { phase: "done"; found: number }
  | { phase: "error"; message: string };

interface Props {
  frameRect: FrameRect;
  status: FindStatus;
  // `anchorTime`: the output time of the frame the outline was drawn on.
  // `person`: find the person whose face is outlined, not the pattern.
  onFind: (target: { x: number; y: number; width: number; height: number }, effect: HideEffect, shape: HideShape, sensitivity: number, anchorTime: number, person: boolean) => void;
  // Whether the outline (drawn at `anchorTime`) is around a face - false until face matching is
  // downloaded - and what face matching would need first.
  onProbe: (target: { x: number; y: number; width: number; height: number }, anchorTime: number) => Promise<OutlineKind>;
  faceMatching: { state: "ready" | "needs-download" | "unsupported"; downloadMb: number } | null;
  // The edit's time now (exact, per frame) and as the timeline reports it (a few times a second).
  getTime: () => number | null;
  currentTime: number;
  // Drawing starts: playback stops, so the outline stays on the frame it was drawn on.
  onDrawStart: () => void;
  onCancelSearch: () => void;
  onClose: () => void;
}

type Point = { x: number; y: number };

// The panel's width (w-72) and its gap from the picture.
const PANEL_WIDTH = 288;
const PANEL_GAP = 12;

// What the panel says once it knows what's outlined - and so what will be found and covered.
const KIND_NOTE: Record<Exclude<OutlineKind, "unknown">, string> = {
  face: "A face - hidden in every shot they're in, at any angle or size.",
  person: "A person - this much of them hidden wherever they appear, sized to them each time.",
  faces: "These faces - each one hidden in every shot it's in.",
  people: "These people - each one covered wherever they appear, sized to them.",
  thing: "An object - found wherever it appears looking like this, at any size or light.",
};

// How far the playhead may drift from the outlined frame before the outline no longer fits it.
const ANCHOR_DRIFT_SEC = 0.1;

const pointInPolygon = (p: Point, pts: Point[]) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

const FindHideTool: React.FC<Props> = ({ frameRect, status, onFind, onCancelSearch, onClose, getTime, currentTime, onDrawStart, onProbe, faceMatching }) => {
  const [stroke, setStroke] = useState<Point[] | null>(null);
  const [outline, setOutline] = useState<Point[] | null>(null);
  const [effect, setEffect] = useState<HideEffect>({ kind: "blur", strength: 0.8 });
  const [shape, setShape] = useState<HideShape>("ellipse");
  const [sensitivity, setSensitivity] = useState(0.5);
  // What's looked for: the pattern itself, or the person whose face it is. Picked for the user when
  // the outline turns out to be around a face; theirs to change either way.
  const [person, setPerson] = useState(false);
  // What the outline turned out to be around - picks what's looked for, and says so.
  const [kind, setKind] = useState<OutlineKind | null>(null);
  const [probing, setProbing] = useState(false);
  // The check under way, so Find can wait for it rather than search for the wrong kind of thing -
  // and whether the user picked This thing / This person themselves (theirs wins).
  const probeDoneRef = useRef<Promise<OutlineKind> | null>(null);
  const chosenRef = useRef(false);
  const drawingRef = useRef(false);
  // Dragging the finished outline: where the drag started and the outline as it was then.
  const moveRef = useRef<{ from: Point; outline: Point[] } | null>(null);
  // The frame the outline belongs to - zoom and pan move the picture under a still outline, so at
  // another moment it would be around something else.
  const anchorRef = useRef<number | null>(null);
  const [driftedAway, setDriftedAway] = useState(false);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  useEffect(() => {
    if (anchorRef.current === null || !outline || Math.abs(currentTime - anchorRef.current) <= ANCHOR_DRIFT_SEC) return;
    anchorRef.current = null;
    setOutline(null);
    setDriftedAway(true);
  }, [currentTime, outline]);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(frameRect);
  frameRef.current = frameRect;
  // On a narrow picture (a portrait video) the panel would cover most of it - including whatever
  // needs drawing around - so it sits beside the picture whenever the window has room for it.
  const [panelOutside, setPanelOutside] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      setPanelOutside(r.width < PANEL_WIDTH * 2 && r.right + PANEL_GAP + PANEL_WIDTH + PANEL_GAP <= window.innerWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [frameRect.left, frameRect.top, frameRect.width, frameRect.height]);

  useEffect(() => {
    const toFrac = (e: PointerEvent): Point | null => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r || r.width <= 0) return null;
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
    };
    const move = (e: PointerEvent) => {
      const moving = moveRef.current;
      if (moving) {
        const p = toFrac(e);
        if (!p) return;
        // Kept whole on the picture.
        const xs = moving.outline.map((q) => q.x);
        const ys = moving.outline.map((q) => q.y);
        const dx = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), p.x - moving.from.x));
        const dy = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), p.y - moving.from.y));
        setOutline(moving.outline.map((q) => ({ x: q.x + dx, y: q.y + dy })));
        return;
      }
      if (!drawingRef.current) return;
      const p = toFrac(e);
      if (p) setStroke((s) => (s ? [...s, p] : [p]));
    };
    const up = () => {
      if (moveRef.current) {
        moveRef.current = null;
        return;
      }
      if (!drawingRef.current) return;
      drawingRef.current = false;
      anchorRef.current = getTimeRef.current() ?? currentTimeRef.current;
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
  const boxKey = box ? `${box.x.toFixed(4)},${box.y.toFixed(4)},${box.width.toFixed(4)},${box.height.toFixed(4)}` : "";
  const probeRef = useRef(onProbe);
  probeRef.current = onProbe;
  useEffect(() => {
    setKind(null);
    if (!box || anchorRef.current === null || stroke) return;
    let stale = false;
    // Moving the outline fires this on every step - check once it settles.
    const timer = window.setTimeout(() => {
      if (faceMatching?.state === "ready") setProbing(true);
      const done = probeRef.current(box, anchorRef.current ?? currentTimeRef.current);
      probeDoneRef.current = done;
      void done.then((k) => {
        if (stale) return;
        setProbing(false);
        setKind(k);
        if (k !== "unknown" && !chosenRef.current) setPerson(k !== "thing");
      });
    }, 250);
    return () => {
      stale = true;
      setProbing(false);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, !!stroke]);
  const tooSmall = !!box && (box.width * frameRect.width < 12 || box.height * frameRect.height < 12);
  const busy = status.phase === "searching" || status.phase === "downloading";
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
          const r = e.currentTarget.getBoundingClientRect();
          const p = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
          // Inside the outline: move it. Anywhere else: draw a new one.
          if (outline && pointInPolygon(p, outline)) {
            moveRef.current = { from: p, outline };
            return;
          }
          onDrawStart();
          chosenRef.current = false;
          drawingRef.current = true;
          setDriftedAway(false);
          setOutline(null);
          setStroke([p]);
        }}
        onPointerMove={(e) => {
          if (moveRef.current || drawingRef.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          const over = !!outline && pointInPolygon({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, outline);
          e.currentTarget.style.cursor = over ? "move" : "crosshair";
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
          <div className="absolute left-1/2 bottom-3 -translate-x-1/2 max-w-[calc(100%-24px)] w-max px-3 py-1 rounded-full bg-emerald-600/90 text-white text-xs text-center shadow pointer-events-none">
            {driftedAway ? "The picture moved on - draw around it again on this frame" : "Draw around what you want to hide - it'll be found everywhere it appears"}
          </div>
        )}
        {outline && !stroke && status.phase !== "searching" && (
          <div className="absolute left-1/2 bottom-3 -translate-x-1/2 max-w-[calc(100%-24px)] w-max px-3 py-1 rounded-full bg-neutral-900/80 text-white/85 text-[11px] text-center shadow pointer-events-none">
            Drag the outline to move it, or draw a new one
          </div>
        )}
      </div>

      <div
        className="absolute top-3 w-72 p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-2.5"
        style={panelOutside ? { left: `calc(100% + ${PANEL_GAP}px)`, top: 0 } : { right: 12 }}
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
        {faceMatching?.state !== "unsupported" && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-14 text-white/60">Find</span>
              {([false, true] as const).map((p) => (
                <button
                  key={String(p)}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    chosenRef.current = true;
                    setPerson(p);
                  }}
                  title={p ? "The person whose face you outlined - in every photo and shot, from any angle" : "This exact thing wherever it appears - a logo, a sign, a name on screen"}
                  className={`px-2 py-0.5 rounded ${person === p ? "text-emerald-300 bg-emerald-500/15 ring-1 ring-emerald-400/40" : "text-white/70 hover:bg-white/10"}`}
                >
                  {p ? "This person" : "This thing"}
                </button>
              ))}
            </div>
            {person && faceMatching?.state === "needs-download" && (
              <p className="pl-16 text-[10px] leading-snug text-white/50">Recognising faces needs a one-time {faceMatching.downloadMb} MB download - it starts when you search.</p>
            )}
            {probing && <p className="pl-16 text-[10px] leading-snug text-white/50 animate-pulse">Looking at what you outlined…</p>}
            {!probing && kind && kind !== "unknown" && (
              <p className={`pl-16 text-[10px] leading-snug ${person === (kind !== "thing") ? "text-emerald-300/90" : "text-white/50"}`}>{KIND_NOTE[kind]}</p>
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-[11px]" title={person ? "Sure: only clear matches. Looser: also small, blurry or turned faces." : "Exact: only identical copies. Similar: also slightly different ones (other lighting, a little blur)."}>
          <span className="w-14 text-white/60">Match</span>
          <span className="text-[10px] text-white/40">{person ? "Sure" : "Exact"}</span>
          <input type="range" min={0} max={1} step={0.01} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} className="flex-1 accent-emerald-400" />
          <span className="text-[10px] text-white/40">{person ? "Looser" : "Similar"}</span>
        </label>

        {status.phase === "downloading" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] text-white/75">
              <span>Getting face recognition… {Math.round(status.progress * 100)}%</span>
              <button type="button" onClick={onCancelSearch} className="text-[10px] text-white/55 hover:text-white">
                Stop
              </button>
            </div>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-sky-400 transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          </div>
        ) : status.phase === "searching" ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] text-white/75">
              <span>{person ? "Looking for them" : "Searching the video"}…{status.found > 0 ? ` found ${status.found}` : ""}</span>
              <button type="button" onClick={onCancelSearch} className="text-[10px] text-white/55 hover:text-white">
                Stop
              </button>
            </div>
            <div className="h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-emerald-400 transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} />
            </div>
          </div>
        ) : !box ? (
          // Not a disabled button: nothing is wrong yet, the next step just happens on the picture.
          <div className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg text-[11px] text-emerald-200/90 border border-dashed border-emerald-400/40 bg-emerald-500/10">
            <IoPencil size={12} className="animate-pulse" /> Drag on the video to circle what to hide
          </div>
        ) : (
          <button
            type="button"
            disabled={tooSmall}
            onClick={async () => {
              if (!box) return;
              let lookFor = person;
              // Still finding out what's outlined: wait for it (unless the user has said).
              if (probing && probeDoneRef.current && !chosenRef.current) {
                const k = await probeDoneRef.current;
                if (k !== "unknown") lookFor = k !== "thing";
              }
              onFind(box, effect, shape, sensitivity, anchorRef.current ?? getTime() ?? currentTime, lookFor);
            }}
            className="w-full py-1.5 rounded-lg text-xs font-medium bg-emerald-500 hover:bg-emerald-400 text-neutral-950 disabled:opacity-40 disabled:hover:bg-emerald-500"
          >
            {tooSmall ? "Draw a little bigger" : person ? "Find them everywhere & hide" : "Find everywhere & hide"}
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
