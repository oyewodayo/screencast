// components/video/StageShapePanel.tsx
//
// A shape's look, all of it: the form (a gallery of 26, drawn from the same outlines the GPU draws),
// what the form takes - sides or points, a star's depth, a ring's hole, an arrow's shaft, a pie's
// sweep and where it starts, round or flat ends, a bubble's tail, mirrored - its corners, fill
// (flat, linear or radial gradient, or none), outline (inside, on or outside the edge) and shadow
// (soft, lifted, hard or a glow). A picture gets the same form as a mask, with corners, outline and
// shadow. Form, corners, depth and sweep are set in the beat under the playhead: in a later beat a
// new form morphs from the old, and a sweep springs - a ring filling up.
import React, { useState } from "react";
import { IoChevronDown, IoChevronForward } from "react-icons/io5";
import { MdFlip } from "react-icons/md";
import { SliderRow, Swatches } from "./OverlayDockedPanels";
import { Segmented, STAGE_INKS, Toggle } from "./StagePanelParts";
import { FORM_INFO, FORM_KIND, SHAPE_PRESETS, ShapePreset, formDefaults, presetSvgPath } from "../../utils/stage/stageShapes";
import { setElementProps } from "../../utils/stage/stageEditing";
import type { StageElement, StageProps, StageScene } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;
type ShapeLook = NonNullable<StageElement["shape"]>;

// A preset's thumbnail, filled in the current colour.
export const ShapeThumb: React.FC<{ preset: ShapePreset; size?: number }> = ({ preset, size = 22 }) => {
  const k = Math.min(size / preset.w, size / preset.h) * 0.92;
  const w = preset.w * k;
  const h = preset.h * k;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <path d={presetSvgPath(preset, w, h)} transform={`translate(${(size - w) / 2} ${(size - h) / 2})`} fill="currentColor" />
    </svg>
  );
};

export const ShapeGallery: React.FC<{ onPick: (p: ShapePreset) => void; current?: string; columns?: number }> = ({ onPick, current, columns = 7 }) => (
  <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
    {SHAPE_PRESETS.map((p) => (
      <button
        key={p.id}
        type="button"
        title={p.label}
        aria-label={p.label}
        onClick={() => onPick(p)}
        className={`h-9 flex items-center justify-center rounded-md transition-colors ${current === p.id ? "bg-teal-500 text-white" : "bg-white/[0.05] text-white/75 hover:bg-white/10 hover:text-white"}`}
      >
        <ShapeThumb preset={p} />
      </button>
    ))}
  </div>
);

// Which preset a shape currently is, if any (for the gallery's highlight).
function presetOf(p: StageProps, radius: number): string | undefined {
  const form = p.form ?? "rect";
  const minSide = Math.min(p.width, p.height);
  const found = SHAPE_PRESETS.find((pr) => {
    if (pr.form !== form) return false;
    if (FORM_INFO[form].sides && (p.sides ?? formDefaults(form).sides) !== pr.sides) return false;
    if (FORM_KIND[form] >= 3) return Math.abs((p.sweep ?? 360) - (pr.sweep ?? 360)) < 1 && Math.abs((p.inner ?? formDefaults(form).inner) - (pr.inner ?? formDefaults(form).inner)) < 0.02;
    if (form === "rect") return Math.abs(radius - (pr.round ?? 0) * minSide) < 2 || (pr.round === 0.5 && radius >= minSide / 2 - 1);
    if (form === "ellipse") return pr.id === (Math.abs(p.width - p.height) < 1 ? "circle" : "ellipse");
    return true;
  });
  return found?.id;
}

const SHADOWS: Record<string, (fill: string | undefined) => ShapeLook["shadow"]> = {
  soft: () => ({ color: "rgba(0,0,0,0.18)", blur: 48, y: 18 }),
  lifted: () => ({ color: "rgba(0,0,0,0.38)", blur: 22, y: 10 }),
  hard: () => ({ color: "rgba(0,0,0,0.92)", blur: 0, x: 10, y: 10 }),
  glow: (fill) => ({ color: fill ?? "#58c4dd", blur: 64, x: 0, y: 0 }),
};
function shadowKind(sh: ShapeLook["shadow"]): string {
  if (!sh) return "none";
  if (sh.blur === 0) return "hard";
  if (!sh.x && !sh.y) return "glow";
  return sh.blur >= 36 ? "soft" : "lifted";
}

const Sub: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="flex flex-col gap-2 pl-2 border-l border-white/10">{children}</div>;

export const ShapeSection: React.FC<{
  scene: StageScene;
  beat: number;
  element: StageElement;
  here: StageProps;
  onUpdate: Update;
}> = ({ beat, element, here, onUpdate }) => {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const inBeat = (patch: Partial<StageProps>) => onUpdate((s) => setElementProps(s, beat, element.id, patch));
  const look = element.shape ?? {};
  const setLook = (patch: Partial<ShapeLook>) => onUpdate((s) => ({ ...s, elements: s.elements.map((e) => (e.id === element.id ? { ...e, shape: { ...e.shape, ...patch } } : e)) }));
  const isPicture = element.kind === "image";
  const form = here.form ?? "rect";
  const info = FORM_INFO[form];
  const kind = FORM_KIND[form];
  const radius = here.radius ?? look.radius ?? 0;
  const inner = here.inner ?? formDefaults(form).inner;
  const sweep = here.sweep ?? 360;
  const sides = here.sides ?? formDefaults(form).sides;
  const minSide = Math.min(here.width, here.height);
  const current = presetOf(here, radius);
  const mirrorable = ["right-triangle", "arrow", "chevron", "bubble", "parallelogram", "trapezoid"].includes(form);

  const pick = (p: ShapePreset) => {
    const patch: Partial<StageProps> = { form: p.form, sides: p.sides, inner: p.inner ?? formDefaults(p.form).inner, sweep: p.sweep ?? 360, radius: (p.round ?? 0) * minSide };
    // Forms that only read right square (a circle, a ring, a pie) square the box about its centre.
    if (p.w === p.h && Math.abs(here.width - here.height) > 1) {
      const side = minSide;
      Object.assign(patch, { width: side, height: side, x: here.x + (here.width - side) / 2, y: here.y + (here.height - side) / 2, radius: (p.round ?? 0) * side });
    }
    inBeat(patch);
  };

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setGalleryOpen((o) => !o)} className="flex items-center gap-1.5 text-left text-[11px] text-white/60 hover:text-white" aria-expanded={galleryOpen}>
        {galleryOpen ? <IoChevronDown size={12} /> : <IoChevronForward size={12} />}
        <span className="flex-1">{isPicture ? "Mask" : "Form"}</span>
        <span className="flex items-center gap-1 text-white/80">
          {current && <ShapeThumb preset={SHAPE_PRESETS.find((p) => p.id === current)!} size={16} />}
          {SHAPE_PRESETS.find((p) => p.id === current)?.label ?? form}
        </span>
      </button>
      {galleryOpen && (
        <>
          <ShapeGallery current={current} onPick={pick} />
          <span className="-mt-1 text-[10px] text-white/35">Picked in a later beat, it morphs from the form before.</span>
        </>
      )}

      {info.sides && <SliderRow label={info.sides.label} value={sides} min={info.sides.min} max={info.sides.max} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => inBeat({ sides: Math.round(v) })} />}
      {info.inner && <SliderRow label={info.inner.label} value={Math.round(inner * 100)} min={Math.round(info.inner.min * 100)} max={Math.round(info.inner.max * 100)} step={1} format={(v) => `${Math.round(v)}%`} reset={Math.round(info.inner.default * 100)} onChange={(v) => inBeat({ inner: v / 100 })} />}
      {info.sweep && (
        <>
          <SliderRow label="Sweep" value={sweep} min={0} max={360} step={1} format={(v) => `${Math.round(v)}° · ${Math.round((v / 360) * 100)}%`} reset={360} onChange={(v) => inBeat({ sweep: v })} />
          <SliderRow label="Starts at" value={look.start ?? 0} min={-180} max={180} step={1} format={(v) => `${Math.round(v)}°`} reset={0} onChange={(v) => setLook({ start: v })} />
          {form === "ring" && sweep < 360 && (
            <Segmented
              value={look.caps ?? "round"}
              onChange={(v) => setLook({ caps: v })}
              options={[
                { value: "round", label: "Round ends", title: "Round ends, like a progress ring" },
                { value: "flat", label: "Flat ends", title: "Cut square across" },
              ]}
            />
          )}
          <span className="-mt-1 text-[10px] text-white/35">Change the sweep in a later beat and it fills or empties on the beat's spring - or make it follow a value below for a live progress ring.</span>
        </>
      )}
      {(info.corners || isPicture) && kind !== 1 && (
        <SliderRow label="Corners" value={Math.round(radius)} min={0} max={Math.max(1, Math.round(minSide / 2))} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => inBeat({ radius: v })} />
      )}
      {form === "bubble" && <SliderRow label="Tail" value={Math.round((look.tail ?? 0.28) * 100)} min={15} max={85} step={1} format={(v) => `${Math.round(v)}%`} reset={28} onChange={(v) => setLook({ tail: v / 100 })} />}
      {mirrorable && (
        <div className="grid grid-cols-2 gap-1">
          <button type="button" onClick={() => setLook({ flipX: !look.flipX })} className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] ${look.flipX ? "bg-teal-500/30 text-white" : "bg-white/[0.06] text-white/75 hover:bg-white/10"}`}>
            <MdFlip size={13} /> Mirror
          </button>
          <button type="button" onClick={() => setLook({ flipY: !look.flipY })} className={`flex items-center justify-center gap-1 rounded-md py-1.5 text-[11px] ${look.flipY ? "bg-teal-500/30 text-white" : "bg-white/[0.06] text-white/75 hover:bg-white/10"}`}>
            <MdFlip size={13} className="rotate-90" /> Flip
          </button>
        </div>
      )}

      {!isPicture && (
        <>
          <span className="text-[11px] text-white/60">Fill</span>
          <Swatches colors={["rgba(0,0,0,0)", ...STAGE_INKS]} titles={["No fill - just its outline", ...STAGE_INKS]} value={here.color} onPick={(c) => c && inBeat({ color: c })} custom />
          <Segmented
            value={look.gradient ? look.gradient.type ?? "linear" : "flat"}
            onChange={(v) => setLook({ gradient: v === "flat" ? undefined : { to: look.gradient?.to ?? "#1e3a8a", angle: look.gradient?.angle ?? 135, type: v } })}
            options={[
              { value: "flat", label: "Flat" },
              { value: "linear", label: "Linear", title: "Fade into a second colour across it" },
              { value: "radial", label: "Radial", title: "Fade into a second colour from its centre out" },
            ]}
          />
          {look.gradient && (
            <Sub>
              <Swatches colors={STAGE_INKS} value={look.gradient.to} onPick={(c) => c && setLook({ gradient: { ...look.gradient!, to: c } })} custom />
              {look.gradient.type !== "radial" && <SliderRow label="Angle" value={look.gradient.angle ?? 180} min={0} max={360} step={5} format={(v) => `${Math.round(v)}°`} reset={180} onChange={(v) => setLook({ gradient: { ...look.gradient!, angle: v } })} />}
            </Sub>
          )}
        </>
      )}

      <Toggle label="Outline" value={!!look.stroke} onChange={(v) => setLook({ stroke: v ? { color: here.color && here.color !== "rgba(0,0,0,0)" ? "#111111" : "#ffffff", width: 4 } : undefined })} />
      {look.stroke && (
        <Sub>
          <Swatches colors={STAGE_INKS} value={look.stroke.color} onPick={(c) => c && setLook({ stroke: { ...look.stroke!, color: c } })} custom />
          <SliderRow label="Weight" value={look.stroke.width} min={0.5} max={40} step={0.5} format={(v) => `${v}`} onChange={(v) => setLook({ stroke: { ...look.stroke!, width: v } })} />
          <Segmented
            value={look.stroke.align ?? "inside"}
            onChange={(v) => setLook({ stroke: { ...look.stroke!, align: v } })}
            options={[
              { value: "inside", label: "Inside", title: "Inside the edge - the shape keeps its size" },
              { value: "center", label: "Centre", title: "Centred on the edge" },
              { value: "outside", label: "Outside", title: "Outside the edge - around it" },
            ]}
          />
          <Segmented
            value={look.stroke.dash?.style ?? "solid"}
            onChange={(v) =>
              setLook({
                stroke: {
                  ...look.stroke!,
                  dash: v === "solid" ? undefined : { style: v, length: look.stroke!.dash?.length ?? Math.max(8, look.stroke!.width * 4), gap: look.stroke!.dash?.gap ?? Math.max(6, look.stroke!.width * (v === "dot" ? 1.5 : 2.5)), flow: look.stroke!.dash?.flow },
                },
              })
            }
            options={[
              { value: "solid", label: "Solid" },
              { value: "dash", label: <span className="flex gap-0.5">{[0, 1, 2].map((k) => <span key={k} className="block w-1.5 h-[2px] rounded bg-current" />)}</span>, title: "Dashed" },
              { value: "dot", label: <span className="tracking-[0.2em] text-[13px] leading-none">•••</span>, title: "Dotted" },
            ]}
          />
          {look.stroke.dash && (
            <>
              {look.stroke.dash.style === "dash" && <SliderRow label="Dash" value={look.stroke.dash.length} min={1} max={200} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setLook({ stroke: { ...look.stroke!, dash: { ...look.stroke!.dash!, length: v } } })} />}
              <SliderRow label="Gap" value={look.stroke.dash.gap} min={1} max={200} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setLook({ stroke: { ...look.stroke!, dash: { ...look.stroke!.dash!, gap: v } } })} />
              <SliderRow label="March" value={look.stroke.dash.flow ?? 0} min={-300} max={300} step={5} format={(v) => (v === 0 ? "still" : `${Math.round(v)}/s`)} reset={0} onChange={(v) => setLook({ stroke: { ...look.stroke!, dash: { ...look.stroke!.dash!, flow: v || undefined } } })} />
              <span className="-mt-1 text-[10px] text-white/35">Spacing evens out so the pattern closes seamlessly round the shape. Marching dashes flow along the edge - a selection, a live connection.</span>
            </>
          )}
        </Sub>
      )}

      <span className="text-[11px] text-white/60">Shadow</span>
      <Segmented
        value={shadowKind(look.shadow)}
        onChange={(v) => setLook({ shadow: v === "none" ? undefined : SHADOWS[v](here.color) })}
        options={[
          { value: "none", label: "None" },
          { value: "soft", label: "Soft", title: "A soft shadow, as if lifted off the page" },
          { value: "lifted", label: "Lifted", title: "Closer and darker - a card" },
          { value: "hard", label: "Hard", title: "A solid offset shadow, no blur" },
          { value: "glow", label: "Glow", title: "A glow of its own colour around it" },
        ]}
      />
      {look.shadow && (
        <Sub>
          <Swatches colors={["rgba(0,0,0,0.18)", "rgba(0,0,0,0.5)", "#000000", ...STAGE_INKS.slice(3)]} value={look.shadow.color} onPick={(c) => c && setLook({ shadow: { ...look.shadow!, color: c } })} custom />
          <SliderRow label="Softness" value={look.shadow.blur} min={0} max={160} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setLook({ shadow: { ...look.shadow!, blur: v } })} />
          <SliderRow label="Across" value={look.shadow.x ?? 0} min={-80} max={80} step={1} format={(v) => `${Math.round(v)}`} reset={0} onChange={(v) => setLook({ shadow: { ...look.shadow!, x: v } })} />
          <SliderRow label="Down" value={look.shadow.y ?? 0} min={-80} max={80} step={1} format={(v) => `${Math.round(v)}`} reset={0} onChange={(v) => setLook({ shadow: { ...look.shadow!, y: v } })} />
        </Sub>
      )}
    </div>
  );
};
