// components/docker/TransitionLookControls.tsx
//
// The "look" of the transitions that have one (ClipTransitionIn.look): a light leak's colour,
// strength, sweep direction and spot size; a flash's colour and strength; a whip's flash strength;
// which way a bar opens; a page curl's corner, curl, paper, shadow and motion; how soft a wipe's
// edge is; a dissolve's grain. Export reads the same values (transition_glow_filter, conversion.rs) and
// the live preview draws them (TransitionPreviewLayer), so what you dial in is what you get.
import React from "react";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";
import { IrisShape, LeakDirection, PeelFrom, TransitionEasing, TransitionLook, TransitionType } from "../../utils/videoEditTypes";
import { DEFAULT_SWEEP_COLOR } from "../video/transitionFrame";
import { DEFAULT_BEAM_COLOR } from "../video/transitionCanvas";
import { DEFAULT_PAPER_COLOR, DEFAULT_SEE_THROUGH } from "../video/pageCurl";

const LOOK_TYPES = new Set<TransitionType>([
  "lightleak",
  "fadewhite",
  "whip",
  "horzopen",
  "zoomblur",
  "colorsweep",
  "push",
  "cube",
  "flip",
  "spin",
  "strips",
  "beam",
  "slider",
  "iris",
  "pagecurl",
  "wipeleft",
  "wiperight",
  "circleopen",
  "radial",
  "dissolve",
  "pixelize",
]);
export const transitionHasLook = (type: TransitionType | null): boolean => !!type && LOOK_TYPES.has(type);

// Which way the pictures travel (push, cube, flip).
const MOVE_DIRECTIONS: { value: LeakDirection; label: string; title: string }[] = [
  { value: "left", label: "←", title: "Moves to the left" },
  { value: "right", label: "→", title: "Moves to the right" },
  { value: "up", label: "↑", title: "Moves up" },
  { value: "down", label: "↓", title: "Moves down" },
];
const IRIS_SHAPES: { value: IrisShape; label: string }[] = [
  { value: "triangle", label: "▼ Triangle" },
  { value: "diamond", label: "◆ Diamond" },
  { value: "hexagon", label: "⬢ Hexagon" },
  { value: "star", label: "★ Star" },
  { value: "heart", label: "♥ Heart" },
];
const BEAM_COLORS: { color: string; name: string }[] = [
  { color: DEFAULT_BEAM_COLOR, name: "Warm white" },
  { color: "#ffffff", name: "White" },
  { color: "#7dd3fc", name: "Ice" },
  { color: "#c084fc", name: "Violet" },
  { color: "#fbbf24", name: "Gold" },
];

// Where a page curl lifts from - the glyph marks the corner or edge.
const PEEL_FROM: { value: PeelFrom; label: string; title: string }[] = [
  { value: "bottomRight", label: "◢", title: "From the bottom-right corner" },
  { value: "bottomLeft", label: "◣", title: "From the bottom-left corner" },
  { value: "topRight", label: "◥", title: "From the top-right corner" },
  { value: "topLeft", label: "◤", title: "From the top-left corner" },
  { value: "right", label: "▐", title: "From the right edge, like turning a page" },
  { value: "left", label: "▌", title: "From the left edge" },
  { value: "bottom", label: "▄", title: "From the bottom edge" },
  { value: "top", label: "▀", title: "From the top edge" },
];
const PAPER_COLORS: { color: string; name: string }[] = [
  { color: DEFAULT_PAPER_COLOR, name: "Cream" },
  { color: "#ffffff", name: "White" },
  { color: "#c9a77c", name: "Kraft" },
  { color: "#9aa3ad", name: "Grey" },
  { color: "#1c1c1e", name: "Black" },
];
const EASINGS: { value: TransitionEasing; label: string; title: string }[] = [
  { value: "smooth", label: "Smooth", title: "Eases in and out" },
  { value: "linear", label: "Steady", title: "Constant speed" },
  { value: "in", label: "Speed up", title: "Starts slowly, finishes fast" },
  { value: "out", label: "Slow down", title: "Starts fast, settles at the end" },
];

const SWEEP_COLORS: { color: string; name: string }[] = [
  { color: DEFAULT_SWEEP_COLOR, name: "Golden" },
  { color: "#ff6a1a", name: "Orange" },
  { color: "#ff3b6b", name: "Pink" },
  { color: "#2563eb", name: "Blue" },
  { color: "#10b981", name: "Green" },
  { color: "#111111", name: "Black" },
];
const SWEEP_DIRECTIONS: { value: LeakDirection; label: string; title: string }[] = [
  { value: "up", label: "↑", title: "Sweeps up from the bottom" },
  { value: "down", label: "↓", title: "Sweeps down from the top" },
  { value: "right", label: "→", title: "Sweeps left to right" },
  { value: "left", label: "←", title: "Sweeps right to left" },
];

const LEAK_COLORS: { color: string; name: string }[] = [
  { color: "#ff7a2e", name: "Warm" },
  { color: "#ffb020", name: "Golden" },
  { color: "#ff4d6d", name: "Rose" },
  { color: "#d946ef", name: "Magenta" },
  { color: "#14b8a6", name: "Teal" },
  { color: "#3b82f6", name: "Cool" },
];
const FLASH_COLORS: { color: string; name: string }[] = [
  { color: "#ffffff", name: "White" },
  { color: "#ffd6a0", name: "Warm" },
  { color: "#ff3b3b", name: "Red" },
  { color: "#60a5fa", name: "Blue" },
  { color: "#000000", name: "Black" },
];
const DIRECTIONS: { value: LeakDirection; label: string; title: string }[] = [
  { value: "right", label: "→", title: "Sweeps left to right" },
  { value: "left", label: "←", title: "Sweeps right to left" },
  { value: "down", label: "↓", title: "Pours down from the top" },
  { value: "up", label: "↑", title: "Rises from the bottom" },
  { value: "diagonal", label: "↘", title: "Sweeps corner to corner" },
  { value: "center", label: "◎", title: "Blooms from the centre" },
];

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="w-16 shrink-0 text-white/60">{label}</span>
    <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">{children}</div>
  </div>
);

const Chip: React.FC<{ active: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`min-w-7 h-6 px-1.5 rounded text-[11px] transition-colors ${active ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/50" : "bg-white/[0.06] text-white/65 hover:text-white hover:bg-white/10"}`}
  >
    {children}
  </button>
);

const ColorRow: React.FC<{ label?: string; colors: { color: string; name: string }[]; value: string; onChange: (c: string) => void }> = ({ label = "Colour", colors, value, onChange }) => (
  <Row label={label}>
    {colors.map((c) => (
      <button
        key={c.color}
        type="button"
        title={c.name}
        onClick={() => onChange(c.color)}
        className={`w-5 h-5 rounded-full ring-offset-1 ring-offset-neutral-900 transition-shadow ${value.toLowerCase() === c.color ? "ring-2 ring-blue-400" : "ring-1 ring-white/20 hover:ring-white/50"}`}
        style={{ background: c.color }}
      />
    ))}
    <span title="Custom colour">
      <ColorSwatchPicker color={value} onChange={onChange} size="sm" />
    </span>
  </Row>
);

const SliderRow: React.FC<{ label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }> = ({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}) => (
  <Row label={label}>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-blue-400" />
    <span className="w-10 shrink-0 text-right tabular-nums text-white/60">{format(value)}</span>
  </Row>
);

const TransitionLookControls: React.FC<{ type: TransitionType; look: TransitionLook | undefined; onChange: (look: TransitionLook) => void }> = ({ type, look = {}, onChange }) => {
  const set = (patch: Partial<TransitionLook>) => onChange({ ...look, ...patch });
  const strength = (
    <SliderRow
      label="Strength"
      value={look.intensity ?? 1}
      min={0.1}
      max={1.5}
      step={0.05}
      format={(v) => `${Math.round(v * 100)}%`}
      onChange={(intensity) => set({ intensity })}
    />
  );

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const softness = (
    <SliderRow label="Softness" value={look.softness ?? 0} min={0} max={1} step={0.02} format={pct} onChange={(softness) => set({ softness })} />
  );

  if (type === "pagecurl")
    return (
      <>
        <Row label="Peel from">
          {PEEL_FROM.map((d) => (
            <Chip key={d.value} active={(look.peelFrom ?? "bottomRight") === d.value} title={d.title} onClick={() => set({ peelFrom: d.value })}>
              {d.label}
            </Chip>
          ))}
        </Row>
        <SliderRow label="Curl size" value={look.size ?? 1} min={0.4} max={2} step={0.05} format={pct} onChange={(size) => set({ size })} />
        <ColorRow label="Paper" colors={PAPER_COLORS} value={look.color ?? DEFAULT_PAPER_COLOR} onChange={(color) => set({ color })} />
        <SliderRow label="See-through" value={look.seeThrough ?? DEFAULT_SEE_THROUGH} min={0} max={1} step={0.05} format={pct} onChange={(seeThrough) => set({ seeThrough })} />
        <SliderRow label="Shadow" value={look.intensity ?? 1} min={0} max={1.5} step={0.05} format={pct} onChange={(intensity) => set({ intensity })} />
        <Row label="Motion">
          {EASINGS.map((e) => (
            <Chip key={e.value} active={(look.easing ?? "smooth") === e.value} title={e.title} onClick={() => set({ easing: e.value })}>
              {e.label}
            </Chip>
          ))}
        </Row>
      </>
    );
  if (type === "wipeleft" || type === "wiperight" || type === "circleopen") return softness;
  if (type === "radial")
    return (
      <>
        <Row label="Turns">
          <Chip active={look.direction !== "left"} title="Clockwise" onClick={() => set({ direction: "right" })}>
            ↻ Clockwise
          </Chip>
          <Chip active={look.direction === "left"} title="Anticlockwise" onClick={() => set({ direction: "left" })}>
            ↺ Anticlockwise
          </Chip>
        </Row>
        {softness}
      </>
    );
  if (type === "dissolve" || type === "pixelize")
    return (
      <SliderRow
        label={type === "dissolve" ? "Grain" : "Blocks"}
        value={look.size ?? 1}
        min={0.3}
        max={3}
        step={0.05}
        format={pct}
        onChange={(size) => set({ size })}
      />
    );
  if (type === "lightleak")
    return (
      <>
        <ColorRow colors={LEAK_COLORS} value={look.color ?? LEAK_COLORS[0].color} onChange={(color) => set({ color })} />
        {strength}
        <Row label="Sweep">
          {DIRECTIONS.map((d) => (
            <Chip key={d.value} active={(look.direction ?? "right") === d.value} title={d.title} onClick={() => set({ direction: d.value })}>
              {d.label}
            </Chip>
          ))}
        </Row>
        <SliderRow label="Spot size" value={look.size ?? 1} min={0.3} max={2.5} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(size) => set({ size })} />
      </>
    );
  if (type === "fadewhite")
    return (
      <>
        <ColorRow colors={FLASH_COLORS} value={look.color ?? "#ffffff"} onChange={(color) => set({ color })} />
        {strength}
      </>
    );
  if (type === "whip" || type === "zoomblur") return strength;
  if (type === "colorsweep") {
    const direction = SWEEP_DIRECTIONS.some((d) => d.value === look.direction) ? look.direction : "up";
    return (
      <>
        <ColorRow colors={SWEEP_COLORS} value={look.color ?? DEFAULT_SWEEP_COLOR} onChange={(color) => set({ color })} />
        <Row label="Sweep">
          {SWEEP_DIRECTIONS.map((d) => (
            <Chip key={d.value} active={direction === d.value} title={d.title} onClick={() => set({ direction: d.value })}>
              {d.label}
            </Chip>
          ))}
        </Row>
      </>
    );
  }
  if (type === "push" || type === "cube" || type === "flip") {
    const direction = MOVE_DIRECTIONS.some((d) => d.value === look.direction) ? look.direction : "left";
    return (
      <Row label="Direction">
        {MOVE_DIRECTIONS.map((d) => (
          <Chip key={d.value} active={direction === d.value} title={d.title} onClick={() => set({ direction: d.value })}>
            {d.label}
          </Chip>
        ))}
      </Row>
    );
  }
  if (type === "spin")
    return (
      <Row label="Turns">
        <Chip active={look.direction !== "left"} title="Clockwise" onClick={() => set({ direction: "right" })}>
          ↻ Clockwise
        </Chip>
        <Chip active={look.direction === "left"} title="Anticlockwise" onClick={() => set({ direction: "left" })}>
          ↺ Anticlockwise
        </Chip>
      </Row>
    );
  if (type === "strips")
    return (
      <Row label="Strips">
        <Chip active={look.orientation !== "horizontal"} title="Columns sliding up and down" onClick={() => set({ orientation: "vertical" })}>
          ║ Columns
        </Chip>
        <Chip active={look.orientation === "horizontal"} title="Rows sliding left and right" onClick={() => set({ orientation: "horizontal" })}>
          ═ Rows
        </Chip>
      </Row>
    );
  if (type === "slider" || type === "beam") {
    const sweep = (
      <Row label="Sweep">
        <Chip active={look.direction !== "left"} title="Left to right" onClick={() => set({ direction: "right" })}>
          →
        </Chip>
        <Chip active={look.direction === "left"} title="Right to left" onClick={() => set({ direction: "left" })}>
          ←
        </Chip>
      </Row>
    );
    if (type === "slider") return sweep;
    return (
      <>
        <ColorRow colors={BEAM_COLORS} value={look.color ?? DEFAULT_BEAM_COLOR} onChange={(color) => set({ color })} />
        {strength}
        {sweep}
      </>
    );
  }
  if (type === "iris")
    return (
      <Row label="Shape">
        {IRIS_SHAPES.map((s) => (
          <Chip key={s.value} active={(look.shape ?? "triangle") === s.value} title={s.label} onClick={() => set({ shape: s.value })}>
            {s.label}
          </Chip>
        ))}
      </Row>
    );
  if (type === "horzopen")
    return (
      <Row label="Opens">
        <Chip active={look.orientation !== "vertical"} title="Out of a horizontal line" onClick={() => set({ orientation: "horizontal" })}>
          ═ From a line
        </Chip>
        <Chip active={look.orientation === "vertical"} title="Out of a vertical line, like doors" onClick={() => set({ orientation: "vertical" })}>
          ║ Doors
        </Chip>
      </Row>
    );
  return null;
};

export default TransitionLookControls;
