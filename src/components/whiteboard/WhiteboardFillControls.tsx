// Fill, gradient, image-fill, and pattern inspector controls extracted from WhiteboardStylePanel.tsx.
import React from "react";
import { TbAngle, TbArrowRight, TbArrowsExchange, TbBan, TbMinus, TbPhoto } from "react-icons/tb";
import {
  DEFAULT_FILL_PATTERN_OPACITY,
  DEFAULT_FILL_PATTERN_SPACING,
  DEFAULT_GRADIENT_ANGLE,
  resolveGradientStops,
  type WhiteboardFillPattern,
  type WhiteboardFillType,
  type WhiteboardGradientStop,
  type WhiteboardNode,
} from "../../utils/whiteboardTypes";
import { fillImageRect, fillPatternTile } from "../../handlers/whiteboardHandlers";
import { preloadWhiteboardImage } from "../../utils/whiteboardImageCache";
import {
  ClampedNumberField,
  ColorField,
  Field,
  FOOTER_BUTTON_CLASS,
  HexColorInput,
  INPUT_SURFACE_CLASS,
  PrefixedNumber,
  SegmentButton,
  Segmented,
  SliderField,
} from "./WhiteboardStylePrimitives";

// ---- Fill & pattern -------------------------------------------------------------------------------

// Curated starting points for a gradient - picked to cover the ramps a figure actually reaches for
// (a cool sequential, a warm one, a diverging pair, a neutral) plus a couple of expressive ones for
// slides/thumbnails. A preset only seeds the stops; every stop stays editable afterwards.
const GRADIENT_PRESETS: { name: string; stops: WhiteboardGradientStop[] }[] = [
  { name: "Ocean", stops: [{ offset: 0, color: "#0ea5e9" }, { offset: 1, color: "#1e3a8a" }] },
  { name: "Sunset", stops: [{ offset: 0, color: "#f97316" }, { offset: 0.5, color: "#ec4899" }, { offset: 1, color: "#7c3aed" }] },
  { name: "Mint", stops: [{ offset: 0, color: "#a7f3d0" }, { offset: 1, color: "#059669" }] },
  { name: "Ember", stops: [{ offset: 0, color: "#fde047" }, { offset: 0.55, color: "#f97316" }, { offset: 1, color: "#b91c1c" }] },
  { name: "Diverging", stops: [{ offset: 0, color: "#2563eb" }, { offset: 0.5, color: "#f8fafc" }, { offset: 1, color: "#dc2626" }] },
  { name: "Aurora", stops: [{ offset: 0, color: "#22d3ee" }, { offset: 0.5, color: "#a78bfa" }, { offset: 1, color: "#f472b6" }] },
  { name: "Graphite", stops: [{ offset: 0, color: "#f5f5f5" }, { offset: 1, color: "#404040" }] },
  { name: "Spectrum", stops: [{ offset: 0, color: "#ef4444" }, { offset: 0.25, color: "#eab308" }, { offset: 0.5, color: "#22c55e" }, { offset: 0.75, color: "#3b82f6" }, { offset: 1, color: "#a855f7" }] },
];

function cssStops(stops: WhiteboardGradientStop[]): string {
  return stops.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(", ");
}

const CHECKER_BG = "bg-[conic-gradient(#d4d4d4_25%,#fff_0_50%,#d4d4d4_0_75%,#fff_0)] bg-[length:8px_8px]";

// Tiny glyphs for the fill-type and pattern pickers - each one IS a miniature of what it produces,
// so the row reads without labels.
function FillTypeGlyph({ type }: { type: WhiteboardFillType }) {
  const base = "w-3.5 h-3.5 rounded-[3px] ring-1 ring-inset ring-black/15 dark:ring-white/20";
  if (type === "solid") return <span className={`${base} bg-current`} />;
  if (type === "linear") return <span className={base} style={{ background: "linear-gradient(135deg, currentColor, transparent)" }} />;
  if (type === "radial") return <span className={base} style={{ background: "radial-gradient(circle, currentColor, transparent 75%)" }} />;
  return <TbPhoto size={14} />;
}

function PatternGlyph({ pattern }: { pattern: WhiteboardFillPattern }) {
  if (pattern === "none") return <TbBan size={13} />;
  const tile = fillPatternTile(pattern, 5);
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" className="rounded-[2px]">
      <defs>
        <pattern id={`wb-glyph-${pattern}`} patternUnits="userSpaceOnUse" width={5} height={5}>
          {tile.dots ? <path d={tile.d} fill="currentColor" /> : <path d={tile.d} fill="none" stroke="currentColor" strokeWidth={1} />}
        </pattern>
      </defs>
      <rect x={0.5} y={0.5} width={13} height={13} rx={2} fill={`url(#wb-glyph-${pattern})`} stroke="currentColor" strokeOpacity={0.35} />
    </svg>
  );
}

// The gradient ramp itself, with one draggable handle per stop. Dragging a handle previews live on
// the canvas and commits once on release (same one-gesture-one-undo-step rule as every slider here);
// clicking the bar between handles drops a new stop there in the color the ramp already has at that
// point, so adding a stop never visibly changes the gradient until you recolor it.
function GradientBar({
  stops,
  selected,
  onSelect,
  onCommit,
  onPreview,
}: {
  stops: WhiteboardGradientStop[];
  selected: number;
  onSelect: (index: number) => void;
  onCommit: (stops: WhiteboardGradientStop[]) => void;
  onPreview: (stops: WhiteboardGradientStop[] | null) => void;
}) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ index: number; moved: boolean } | null>(null);
  const [live, setLive] = React.useState<WhiteboardGradientStop[] | null>(null);
  const shown = live ?? stops;

  const offsetAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const colorAt = (offset: number): string => {
    const sorted = [...stops].sort((a, b) => a.offset - b.offset);
    const after = sorted.findIndex((s) => s.offset >= offset);
    if (after <= 0) return sorted[Math.max(0, after)].color;
    const a = sorted[after - 1];
    const b = sorted[after];
    const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
    const mix = (i: number) => Math.round(parseInt(a.color.slice(i, i + 2), 16) * (1 - t) + parseInt(b.color.slice(i, i + 2), 16) * t);
    if (!/^#[0-9a-f]{6}$/i.test(a.color) || !/^#[0-9a-f]{6}$/i.test(b.color)) return a.color;
    return `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
  };

  return (
    <div className="relative h-7 pt-0.5 px-[7px]">
      <div
        ref={barRef}
        className={`relative h-5 rounded-md ring-1 ring-inset ring-black/10 dark:ring-white/10 cursor-copy ${CHECKER_BG}`}
        title="Click to add a stop - drag a stop to move it"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const offset = offsetAt(e.clientX);
          const next = [...stops, { offset, color: colorAt(offset) }];
          onCommit(next);
          onSelect(next.length - 1);
        }}
      >
        <div className="absolute inset-0 rounded-md pointer-events-none" style={{ background: `linear-gradient(90deg, ${cssStops([...shown].sort((a, b) => a.offset - b.offset))})` }} />
        {shown.map((stop, i) => (
          <button
            key={i}
            type="button"
            title={`${stop.color.toUpperCase()} at ${Math.round(stop.offset * 100)}%`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              dragRef.current = { index: i, moved: false };
              onSelect(i);
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current;
              if (!drag) return;
              drag.moved = true;
              const next = stops.map((s, j) => (j === drag.index ? { ...s, offset: offsetAt(e.clientX) } : s));
              setLive(next);
              onPreview(next);
            }}
            onPointerUp={() => {
              const drag = dragRef.current;
              dragRef.current = null;
              onPreview(null);
              if (drag?.moved && live) onCommit(live);
              setLive(null);
            }}
            className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-[26px] rounded-[4px] cursor-ew-resize transition-shadow ${
              selected === i ? "shadow-[0_0_0_2px_#fff,0_0_0_3.5px_#3b82f6,0_2px_6px_rgba(0,0,0,0.25)] z-10" : "shadow-[0_0_0_2px_#fff,0_0_0_2.5px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.2)]"
            }`}
            style={{ left: `${stop.offset * 100}%`, backgroundColor: stop.color }}
          />
        ))}
      </div>
    </div>
  );
}

export function FillControls({
  nodes,
  updateNodes,
  onPreviewNodes,
  onPickFillImage,
  assetUrlFor,
}: {
  nodes: WhiteboardNode[];
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
  onPreviewNodes?: (patch: Partial<WhiteboardNode> | null) => void;
  onPickFillImage?: () => Promise<string | null>;
  assetUrlFor?: (fileName: string) => string | null;
}) {
  const node = nodes[0];
  const ids = nodes.map((n) => n.id).join(",");
  const type = node.fillType ?? "solid";
  const stops = resolveGradientStops(node);
  const [selectedStop, setSelectedStop] = React.useState(0);
  const stop = stops[Math.min(selectedStop, stops.length - 1)];
  const stopIndex = Math.min(selectedStop, stops.length - 1);
  const [picking, setPicking] = React.useState(false);
  const [imgNatural, setImgNatural] = React.useState<{ w: number; h: number } | null>(null);
  const [dragOffset, setDragOffset] = React.useState<{ x: number; y: number } | null>(null);
  const [boxSize, setBoxSize] = React.useState<{ w: number; h: number }>({ w: 240, h: 80 });
  const previewBoxRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOx: number;
    startOy: number;
    boxW: number;
    boxH: number;
    moved: boolean;
  } | null>(null);

  const pickImage = async () => {
    if (!onPickFillImage || picking) return;
    setPicking(true);
    try {
      const asset = await onPickFillImage();
      if (asset) {
        updateNodes({
          fillType: "image",
          fillImageAsset: asset,
          fillImageOffsetX: undefined,
          fillImageOffsetY: undefined,
          fillImageScale: undefined,
        });
      }
    } finally {
      setPicking(false);
    }
  };

  const setType = (next: WhiteboardFillType) => {
    if (next === type) return;
    if (next === "image") {
      if (node.fillImageAsset) updateNodes({ fillType: "image" });
      else void pickImage();
      return;
    }
    if (next === "solid") {
      updateNodes({ fillType: undefined, fillColor: node.fillColor ?? stops[0].color });
      return;
    }
    // Materialize the stops so the gradient keeps the colors it's showing even if fillColor later
    // changes (resolveGradientStops derives its fallback ramp from fillColor).
    updateNodes({ fillType: next, fillGradientStops: stops, fillColor: node.fillColor ?? stops[0].color });
  };

  const commitStops = (next: WhiteboardGradientStop[]) => updateNodes({ fillGradientStops: next });
  const imageUrl = node.fillImageAsset && assetUrlFor ? assetUrlFor(node.fillImageAsset) : null;
  const pattern = node.fillPattern ?? "none";

  React.useEffect(() => {
    if (!previewBoxRef.current) return;
    const rect = previewBoxRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setBoxSize({ w: rect.width, h: rect.height });
    }
  }, [type, imageUrl]);

  return (
    <>
      <Segmented stretch>
        {(["solid", "linear", "radial", "image"] as const).map((t) => (
          <SegmentButton key={t} active={type === t} onClick={() => setType(t)} title={t === "solid" ? "Solid color" : t === "linear" ? "Linear gradient" : t === "radial" ? "Radial gradient" : "Image fill"}>
            <FillTypeGlyph type={t} />
          </SegmentButton>
        ))}
      </Segmented>

      {type === "solid" && <ColorField label="Color" value={node.fillColor ?? "#ffffff"} onChange={(fillColor) => updateNodes({ fillColor })} />}

      {(type === "linear" || type === "radial") && (
        <div className="flex flex-col gap-1.5">
          <GradientBar
            stops={stops}
            selected={stopIndex}
            onSelect={setSelectedStop}
            onCommit={commitStops}
            onPreview={(next) => onPreviewNodes?.(next ? { fillGradientStops: next } : null)}
          />
          <div className="flex items-center gap-1.5">
            <HexColorInput value={stop.color} onChange={(color) => commitStops(stops.map((s, i) => (i === stopIndex ? { ...s, color } : s)))} title="Selected stop's color" />
            <label className={`flex items-center h-7 w-[64px] ${INPUT_SURFACE_CLASS} focus-within:bg-white dark:focus-within:bg-neutral-900 focus-within:border-blue-500/70`} title="Selected stop's position">
              <ClampedNumberField
                key={`${ids}-stop-${stopIndex}-${stop.offset}`}
                initialValue={Math.round(stop.offset * 100)}
                min={0}
                max={100}
                onCommit={(n) => commitStops(stops.map((s, i) => (i === stopIndex ? { ...s, offset: n / 100 } : s)))}
                className="flex-1 min-w-0 h-full pl-2 bg-transparent text-[12px] tabular-nums outline-none"
              />
              <span className="pr-1.5 text-[11px] text-gray-400 dark:text-neutral-500">%</span>
            </label>
            <div className="ml-auto flex items-center">
              <button
                type="button"
                className={FOOTER_BUTTON_CLASS}
                title="Reverse the gradient"
                onClick={() => commitStops(stops.map((s) => ({ ...s, offset: 1 - s.offset })))}
              >
                <TbArrowsExchange size={14} />
              </button>
              <button
                type="button"
                className={`${FOOTER_BUTTON_CLASS} disabled:opacity-30 disabled:pointer-events-none`}
                title="Remove the selected stop"
                disabled={stops.length <= 2}
                onClick={() => {
                  commitStops(stops.filter((_, i) => i !== stopIndex));
                  setSelectedStop(Math.max(0, stopIndex - 1));
                }}
              >
                <TbMinus size={14} />
              </button>
            </div>
          </div>
          {type === "linear" && (
            <Field label="Angle">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={FOOTER_BUTTON_CLASS}
                  title="Rotate 45°"
                  onClick={() => updateNodes({ fillGradientAngle: ((node.fillGradientAngle ?? DEFAULT_GRADIENT_ANGLE) + 45) % 360 })}
                >
                  <span className="inline-block transition-transform duration-200" style={{ transform: `rotate(${node.fillGradientAngle ?? DEFAULT_GRADIENT_ANGLE}deg)` }}>
                    <TbArrowRight size={14} />
                  </span>
                </button>
                <div className="w-[76px]">
                  <PrefixedNumber
                    prefix={<TbAngle size={12} />}
                    title="Gradient direction in degrees - 0 runs left to right, 90 top to bottom"
                    suffix="°"
                    resetKey={`${ids}-ga`}
                    value={node.fillGradientAngle ?? DEFAULT_GRADIENT_ANGLE}
                    min={0}
                    max={360}
                    onCommit={(n) => updateNodes({ fillGradientAngle: n % 360 })}
                  />
                </div>
              </div>
            </Field>
          )}
          <div className="grid grid-cols-8 gap-1 pt-0.5">
            {GRADIENT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                title={preset.name}
                onClick={() => {
                  setSelectedStop(0);
                  commitStops(preset.stops);
                }}
                className="h-5 rounded-[5px] ring-1 ring-inset ring-black/10 dark:ring-white/10 hover:scale-110 hover:shadow-md active:scale-95 transition"
                style={{ background: `linear-gradient(135deg, ${cssStops(preset.stops)})` }}
              />
            ))}
          </div>
        </div>
      )}

      {type === "image" && (() => {
        const fit = node.fillImageFit ?? "cover";
        const ox = dragOffset ? dragOffset.x : (node.fillImageOffsetX ?? 0);
        const oy = dragOffset ? dragOffset.y : (node.fillImageOffsetY ?? 0);
        const scale = Math.max(0.1, node.fillImageScale ?? 1);
        const hasTransform = ox !== 0 || oy !== 0 || Math.abs(scale - 1) > 1e-3;
        const previewRect = imgNatural
          ? fillImageRect(fit, boxSize.w, boxSize.h, imgNatural.w, imgNatural.h, ox, oy, scale)
          : null;

        return (
          <div className="flex flex-col gap-1.5">
            {imageUrl ? (
              <div
                ref={previewBoxRef}
                title="Drag to move the image on the shape"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const rect = e.currentTarget.getBoundingClientRect();
                  const boxW = Math.max(1, rect.width);
                  const boxH = Math.max(1, rect.height);
                  setBoxSize({ w: boxW, h: boxH });
                  const startOx = node.fillImageOffsetX ?? 0;
                  const startOy = node.fillImageOffsetY ?? 0;
                  dragRef.current = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    startOx,
                    startOy,
                    boxW,
                    boxH,
                    moved: false,
                  };
                  setDragOffset({ x: startOx, y: startOy });
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.pointerId !== e.pointerId) return;
                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) d.moved = true;
                  const nextOx = +(d.startOx + dx / d.boxW).toFixed(4);
                  const nextOy = +(d.startOy + dy / d.boxH).toFixed(4);
                  setDragOffset({ x: nextOx, y: nextOy });
                  onPreviewNodes?.({ fillImageOffsetX: nextOx, fillImageOffsetY: nextOy });
                }}
                onPointerUp={(e) => {
                  const d = dragRef.current;
                  if (!d || d.pointerId !== e.pointerId) return;
                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  const moved = d.moved;
                  const nextOx = +(d.startOx + dx / d.boxW).toFixed(4);
                  const nextOy = +(d.startOy + dy / d.boxH).toFixed(4);
                  dragRef.current = null;
                  setDragOffset(null);
                  onPreviewNodes?.(null);
                  if (moved) {
                    updateNodes({ fillImageOffsetX: nextOx, fillImageOffsetY: nextOy });
                  }
                }}
                onPointerCancel={(e) => {
                  if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
                  dragRef.current = null;
                  setDragOffset(null);
                  onPreviewNodes?.(null);
                }}
                className={`group relative h-[80px] w-full overflow-hidden rounded-md ring-1 ring-inset ring-black/10 dark:ring-white/10 cursor-grab active:cursor-grabbing select-none touch-none ${CHECKER_BG}`}
              >
                <img
                  src={imageUrl}
                  alt=""
                  draggable={false}
                  onLoad={(e) => {
                    const nw = e.currentTarget.naturalWidth;
                    const nh = e.currentTarget.naturalHeight;
                    if (nw > 0 && nh > 0) setImgNatural({ w: nw, h: nh });
                    void preloadWhiteboardImage(imageUrl);
                  }}
                  style={
                    previewRect
                      ? {
                          position: "absolute",
                          left: previewRect.x,
                          top: previewRect.y,
                          width: previewRect.w,
                          height: previewRect.h,
                          maxWidth: "none",
                          maxHeight: "none",
                          pointerEvents: "none",
                        }
                      : {
                          position: "absolute",
                          left: `${((1 - scale) / 2 + ox) * 100}%`,
                          top: `${((1 - scale) / 2 + oy) * 100}%`,
                          width: `${scale * 100}%`,
                          height: `${scale * 100}%`,
                          objectFit: fit,
                          maxWidth: "none",
                          maxHeight: "none",
                          pointerEvents: "none",
                        }
                  }
                />
                <div
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {hasTransform && (
                    <button
                      type="button"
                      onClick={() =>
                        updateNodes({
                          fillImageOffsetX: undefined,
                          fillImageOffsetY: undefined,
                          fillImageScale: undefined,
                        })
                      }
                      title="Reset image position and zoom"
                      className="h-5 px-1.5 rounded bg-black/65 hover:bg-black/80 text-white text-[10px] font-medium backdrop-blur-sm transition"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void pickImage()}
                    disabled={!onPickFillImage || picking}
                    title="Replace image"
                    className="h-5 px-1.5 rounded bg-black/65 hover:bg-black/80 text-white text-[10px] font-medium backdrop-blur-sm flex items-center gap-1 transition"
                  >
                    <TbPhoto size={11} />
                    <span>{picking ? "…" : "Replace"}</span>
                  </button>
                </div>
                <span className="pointer-events-none absolute bottom-1 left-1.5 px-1.5 py-0.5 rounded bg-black/55 text-white/90 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                  Drag to move
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void pickImage()}
                disabled={!onPickFillImage || picking}
                title="Choose the picture this shape is filled with"
                className={`group relative h-[72px] w-full overflow-hidden rounded-md ring-1 ring-inset ring-black/10 dark:ring-white/10 ${CHECKER_BG}`}
              >
                <span className="absolute inset-0 flex items-center justify-center gap-1.5 text-[11px] font-medium text-neutral-500">
                  <TbPhoto size={14} />
                  {picking ? "Choosing…" : "Choose image…"}
                </span>
              </button>
            )}
            <Segmented stretch>
              {(["cover", "contain", "fill"] as const).map((f) => (
                <SegmentButton
                  key={f}
                  active={fit === f}
                  onClick={() => updateNodes({ fillImageFit: f })}
                  title={f === "cover" ? "Crop to fill the shape" : f === "contain" ? "Fit the whole picture inside" : "Stretch to the shape"}
                >
                  {f === "cover" ? "Fill" : f === "contain" ? "Fit" : "Stretch"}
                </SegmentButton>
              ))}
            </Segmented>
            {imageUrl && (
              <SliderField
                label="Zoom"
                resetKey={`fis-${ids}`}
                value={Math.round(scale * 100)}
                min={25}
                max={300}
                step={5}
                onCommit={(n) => updateNodes({ fillImageScale: n === 100 ? undefined : n / 100 })}
                onPreview={(n) => onPreviewNodes?.(n === null ? null : { fillImageScale: n / 100 })}
                title="Zoom the background image in or out"
              />
            )}
          </div>
        );
      })()}

      {/* Fades only the interior - outline and text stay solid - so a shape can sit over the image or
          plot it annotates without hiding it. */}
      <SliderField
        label="Opacity"
        resetKey={`fo-${ids}`}
        value={Math.round((node.fillOpacity ?? 1) * 100)}
        min={0}
        max={100}
        step={1}
        onCommit={(n) => updateNodes({ fillOpacity: n >= 100 ? undefined : n / 100, fillColor: node.fillColor ?? "#ffffff" })}
        onPreview={(n) => onPreviewNodes?.(n === null ? null : { fillOpacity: n / 100, fillColor: node.fillColor ?? "#ffffff" })}
        title="100% is a solid fill, 0% fully see-through - the outline and text are unaffected"
      />

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[12px] text-neutral-500 dark:text-neutral-400">Pattern</span>
        <Segmented>
          {(["none", "grid", "dots", "lines", "diagonal"] as const).map((p) => (
            <SegmentButton key={p} active={pattern === p} onClick={() => updateNodes({ fillPattern: p === "none" ? undefined : p })} title={p === "none" ? "No pattern" : `${p[0].toUpperCase()}${p.slice(1)} pattern`}>
              <PatternGlyph pattern={p} />
            </SegmentButton>
          ))}
        </Segmented>
      </div>
      {pattern !== "none" && (
        <>
          <ColorField label="Pattern color" value={node.fillPatternColor ?? node.strokeColor} onChange={(fillPatternColor) => updateNodes({ fillPatternColor })} />
          <SliderField
            label="Pattern opacity"
            resetKey={`fpo-${ids}`}
            value={Math.round((node.fillPatternOpacity ?? DEFAULT_FILL_PATTERN_OPACITY) * 100)}
            min={0}
            max={100}
            onCommit={(n) => updateNodes({ fillPatternOpacity: n / 100 })}
            onPreview={(n) => onPreviewNodes?.(n === null ? null : { fillPatternOpacity: n / 100 })}
          />
          <SliderField
            label="Spacing"
            resetKey={`fps-${ids}`}
            value={node.fillPatternSpacing ?? DEFAULT_FILL_PATTERN_SPACING}
            min={4}
            max={400}
            sliderMax={80}
            onCommit={(n) => updateNodes({ fillPatternSpacing: n })}
            onPreview={(n) => onPreviewNodes?.(n === null ? null : { fillPatternSpacing: n })}
          />
        </>
      )}
    </>
  );
}

