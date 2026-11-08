// components/video/StageArrangePanel.tsx
//
// Where an element is and how big: X, Y, width, height and rotation as exact numbers - each label
// drags to scrub its value (Shift: ten times as fast), the way design tools do - width and height
// linked to keep proportions, and one click to line it up with the stage's edges or centre. Every
// change lands in the beat under the playhead, so a box can grow, move or turn from beat to beat.
import React, { useRef, useState } from "react";
import { IoLinkOutline, IoUnlinkOutline } from "react-icons/io5";
import { MdAlignHorizontalCenter, MdAlignHorizontalLeft, MdAlignHorizontalRight, MdAlignVerticalBottom, MdAlignVerticalCenter, MdAlignVerticalTop } from "react-icons/md";
import { IconButton } from "./StagePanelParts";
import { setElementProps } from "../../utils/stage/stageEditing";
import { STAGE_HEIGHT, StageElement, StageProps, StageScene } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;

// A number whose label scrubs it: drag the label left/right, or type into the field.
export const ScrubField: React.FC<{
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  title?: string;
  digits?: number;
}> = ({ label, value, onChange, step = 1, min = -Infinity, max = Infinity, suffix, title, digits = 0 }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const scrub = useRef<{ x: number; v: number } | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const round = (v: number) => Math.round(v * 10 ** digits) / 10 ** digits;
  const shown = round(value);
  return (
    <label className="flex items-center min-w-0 rounded-md bg-black/30 ring-1 ring-white/10 focus-within:ring-teal-400" title={title}>
      <span
        className="shrink-0 pl-2 pr-1 text-[10px] text-white/45 cursor-ew-resize select-none hover:text-teal-200"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          scrub.current = { x: e.clientX, v: value };
        }}
        onPointerMove={(e) => {
          if (!scrub.current) return;
          const d = (e.clientX - scrub.current.x) * step * (e.shiftKey ? 10 : 1);
          const next = clamp(round(scrub.current.v + d));
          if (next !== shown) onChange(next);
        }}
        onPointerUp={() => (scrub.current = null)}
        onPointerCancel={() => (scrub.current = null)}
      >
        {label}
      </span>
      <input
        value={draft ?? `${shown}${suffix ?? ""}`}
        onFocus={(e) => {
          setDraft(String(shown));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const n = Number(draft.replace(/[−–]/g, "-").replace(/[^\d.+-eE]/g, ""));
            if (draft.trim() !== "" && Number.isFinite(n) && round(n) !== shown) onChange(clamp(round(n)));
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          // Up/down step the value, as in any design tool.
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const next = clamp(round(value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
            onChange(next);
            setDraft(String(next));
          }
        }}
        className="w-full min-w-0 bg-transparent py-1 pr-1.5 text-right text-[11px] tabular-nums text-white outline-none"
      />
    </label>
  );
};

export const ArrangeSection: React.FC<{
  scene: StageScene;
  beat: number;
  element: StageElement;
  here: StageProps;
  onUpdate: Update;
  // Kept proportions by default (pictures, icons, equations).
  lockByDefault?: boolean;
}> = ({ scene, beat, element, here, onUpdate, lockByDefault }) => {
  const [linked, setLinked] = useState(!!lockByDefault);
  const set = (patch: Partial<StageProps>) => onUpdate((s) => setElementProps(s, beat, element.id, patch));
  const placed = !!element.parent && scene.elements.find((e) => e.id === element.parent)?.kind === "stack";
  const square = element.kind === "icon";
  const aspect = here.height > 0 ? here.width / here.height : 1;
  const setW = (w: number) => set(square ? { width: w, height: w } : linked ? { width: w, height: Math.max(1, Math.round((w / aspect) * 10) / 10) } : { width: w });
  const setH = (h: number) => set(square ? { width: h, height: h } : linked ? { height: h, width: Math.max(1, Math.round(h * aspect * 10) / 10) } : { height: h });
  const align = (where: "left" | "centre" | "right" | "top" | "middle" | "bottom") =>
    set(
      where === "left"
        ? { x: 0 }
        : where === "centre"
          ? { x: Math.round((scene.width - here.width) / 2) }
          : where === "right"
            ? { x: Math.round(scene.width - here.width) }
            : where === "top"
              ? { y: 0 }
              : where === "middle"
                ? { y: Math.round((STAGE_HEIGHT - here.height) / 2) }
                : { y: Math.round(STAGE_HEIGHT - here.height) }
    );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-white/60">Position and size</span>
      {placed ? (
        <span className="text-[10px] text-white/40">Its group places it - move the group, or take it out of the group to place it freely.</span>
      ) : (
        <div className="grid grid-cols-2 gap-1">
          <ScrubField label="X" value={here.x} onChange={(v) => set({ x: v })} title="Left edge, in stage units (the stage is 1080 tall)" />
          <ScrubField label="Y" value={here.y} onChange={(v) => set({ y: v })} title="Top edge" />
        </div>
      )}
      {element.kind !== "connector" && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
          <ScrubField label="W" value={here.width} min={1} max={20000} onChange={setW} title="Width" />
          {square ? (
            <span className="w-6" />
          ) : (
            <IconButton title={linked ? "Proportions kept - click to change width and height separately" : "Keep proportions"} onClick={() => setLinked((l) => !l)}>
              {linked ? <IoLinkOutline size={13} className="text-teal-300" /> : <IoUnlinkOutline size={13} />}
            </IconButton>
          )}
          <ScrubField label="H" value={here.height} min={1} max={20000} onChange={setH} title="Height" />
        </div>
      )}
      {element.kind !== "connector" && element.kind !== "stack" && (
        <div className="grid grid-cols-2 gap-1">
          <ScrubField label="Turn" value={here.rotation} step={1} suffix="°" digits={1} onChange={(v) => set({ rotation: v })} title="Rotation, degrees clockwise - it springs to it between beats" />
          <ScrubField label="Scale" value={here.scale * 100} step={1} min={1} max={2000} suffix="%" onChange={(v) => set({ scale: v / 100 })} title="Scale about its anchor - grows or shrinks everything in it" />
        </div>
      )}
      {!placed && element.kind !== "connector" && (
        <div className="flex items-center justify-between rounded-md bg-white/[0.04] px-0.5">
          {(
            [
              ["left", <MdAlignHorizontalLeft size={14} />, "Align to the stage's left edge"],
              ["centre", <MdAlignHorizontalCenter size={14} />, "Centre across the stage"],
              ["right", <MdAlignHorizontalRight size={14} />, "Align to the stage's right edge"],
              ["top", <MdAlignVerticalTop size={14} />, "Align to the stage's top"],
              ["middle", <MdAlignVerticalCenter size={14} />, "Centre down the stage"],
              ["bottom", <MdAlignVerticalBottom size={14} />, "Align to the stage's bottom"],
            ] as const
          ).map(([id, icon, title]) => (
            <IconButton key={id} title={title} onClick={() => align(id)}>
              {icon}
            </IconButton>
          ))}
        </div>
      )}
    </div>
  );
};
