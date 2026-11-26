// Shared low-level inspector controls & layout primitives extracted from WhiteboardStylePanel.tsx.
import React from "react";
import {
  TbArrowDown,
  TbArrowLeft,
  TbArrowRight,
  TbArrowUp,
  TbFlipHorizontal,
  TbFlipVertical,
  TbRotateClockwise,
} from "react-icons/tb";
import type { WhiteboardNode } from "../../utils/whiteboardTypes";
import ColorInput from "../common/ColorInput";

export function ClampedNumberField({
  initialValue,
  min,
  max,
  step,
  integer = true,
  onCommit,
  className,
  title,
}: {
  initialValue: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean; // false keeps typed decimals (e.g. a 0.05-step fraction) instead of rounding to a whole number
  onCommit: (n: number) => void;
  className: string;
  title?: string;
}) {
  const [text, setText] = React.useState(String(initialValue));
  const [focused, setFocused] = React.useState(false);
  // Tracks what was last actually dispatched (as opposed to `initialValue`, a mount-time snapshot),
  // so blur doesn't re-dispatch an identical value on top of the live commit that already fired for
  // the same keystroke - each edit becomes exactly one undo step.
  const lastCommittedRef = React.useRef(initialValue);
  React.useEffect(() => {
    lastCommittedRef.current = initialValue;
    if (!focused) setText(String(initialValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `focused` deliberately excluded: a
    // focus change alone shouldn't re-sync text, only a genuinely new initialValue while unfocused.
  }, [initialValue]);
  const parseClamped = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    const parsed = integer ? Math.round(num) : num;
    return Math.max(min, Math.min(max, parsed));
  };
  const commitIfChanged = (clamped: number) => {
    if (clamped === lastCommittedRef.current) return;
    lastCommittedRef.current = clamped;
    onCommit(clamped);
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step ?? (integer ? 1 : "any")}
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const clamped = parseClamped(raw);
        if (clamped !== null) commitIfChanged(clamped);
      }}
      onBlur={() => {
        setFocused(false);
        const clamped = parseClamped(text) ?? initialValue;
        setText(String(clamped));
        commitIfChanged(clamped);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      className={className}
      title={title}
    />
  );
}

// Same "stage locally, commit once per gesture" discipline WhiteboardCanvas.tsx's own canvas
// drags already use (see its top-of-file comment: a whole drag becomes exactly one undo step) -
// a plain onChange on a <input type="range"> fires on every native `input` event mid-drag, and
// every commit here goes through onBatchEditNodes/onEditEdge, which pushes a new undo-stack entry
// AND triggers a full page re-render (or, for the lattice fields specifically, LatticeGaugeWidget's
// own full 3D mesh dispose+rebuild) on EVERY tick. A single drag sweep across a slider's range can
// fire dozens of those in well under a second - severe enough for the lattice-size slider in
// particular (disposing/rebuilding up to tens of thousands of meshes per tick) to freeze the whole
// app while a screen recording's own GDI capture was also active (see
// RECORDING_UPGRADE_NOTES.md). This keeps the thumb tracking the drag in real time via local
// `liveValue` state, but only calls `onCommit` once the gesture actually ends - pointer release, a
// keyboard nudge, or focus leaving the control - so a whole drag becomes exactly one undo step and
// one rebuild, not one per pixel of travel.
// `onPreview` is what makes the shape itself track the drag in real time WITHOUT paying the cost
// above: it renders through the canvas's display-only preview channel (see WhiteboardCanvas's
// previewNodes prop) and never touches the store or the undo stack, so the whole drag still commits
// exactly once on release. A slider given no onPreview keeps the original behavior - thumb tracks,
// shape updates at the end.
export function LiveRangeSlider({
  value,
  min,
  max,
  step,
  onCommit,
  onPreview,
  className,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
  onPreview?: (n: number | null) => void;
  className?: string;
  title?: string;
}) {
  const [liveValue, setLiveValue] = React.useState(value);
  // Tracks what was last actually committed, same "don't re-dispatch an identical value" guard
  // ClampedNumberField's own lastCommittedRef uses - onPointerUp/onKeyUp/onBlur can otherwise all
  // fire for the same single gesture (e.g. a mouse drag that ends by tabbing away).
  const lastCommittedRef = React.useRef(value);
  // True between the first input event of a drag and its commit. Needed because `value` FLOWS BACK
  // during a live preview: the preview re-renders the selection, so this component's own `value`
  // prop becomes the previewed number mid-drag. Without this guard the resync effect below would
  // then record that previewed number as "last committed", and the real commit on release would see
  // n === lastCommittedRef and skip - the drag would preview correctly and then silently snap back.
  const draggingRef = React.useRef(false);

  // Resync when the committed value changes from elsewhere (undo/redo, another edit path) -
  // otherwise this slider would keep showing a stale drag-in-progress value forever. Skipped while
  // dragging, for the reason above.
  React.useEffect(() => {
    if (draggingRef.current) return;
    setLiveValue(value);
    lastCommittedRef.current = value;
  }, [value]);

  const commit = (n: number) => {
    // The preview always has to be torn down, even when the value ended up unchanged - otherwise a
    // drag that returns to where it started would leave the canvas pinned to a preview forever.
    draggingRef.current = false;
    onPreview?.(null);
    if (n === lastCommittedRef.current) return;
    lastCommittedRef.current = n;
    onCommit(n);
  };

  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={liveValue}
      onChange={(e) => {
        const next = Number(e.target.value);
        draggingRef.current = true;
        setLiveValue(next);
        onPreview?.(next);
      }}
      onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      onBlur={(e) => commit(Number((e.target as HTMLInputElement).value))}
      className={className ?? SLIDER_CLASS}
      style={{ ["--pct" as string]: `${max > min ? ((Math.min(max, Math.max(min, liveValue)) - min) / (max - min)) * 100 : 0}%` } as React.CSSProperties}
      title={title}
    />
  );
}

// A slider paired with a numeric box, the standard control shape for every numeric setting in this
// panel. The box is not a nicety: a slider's range is a convenience for the common case, and without
// a place to type an exact value, anything outside that range (or any precise figure) is simply
// unreachable. Both halves drive the same commit path, and the slider previews live while dragged.
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  integer = false,
  sliderMax,
  onCommit,
  onPreview,
  title,
  resetKey,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  // Lets the slider cover a narrower, more useful span than the field accepts - e.g. stroke width
  // sliding over a sensible range while the box still takes any value up to the hard cap.
  sliderMax?: number;
  onCommit: (n: number) => void;
  onPreview?: (n: number | null) => void;
  title?: string;
  // Forces the numeric box to re-seed from `value` - pass the selection's identity so switching
  // shapes reloads the field rather than leaving the previous shape's text in it.
  resetKey?: string;
}) {
  const topOfSlider = sliderMax ?? max;
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <ClampedNumberField
          key={resetKey}
          initialValue={value}
          min={min}
          max={max}
          step={step}
          integer={integer}
          onCommit={onCommit}
          className={NUMBER_INPUT_CLASS}
          title={title}
        />
        <LiveRangeSlider min={min} max={topOfSlider} step={step} value={Math.min(topOfSlider, Math.max(min, value))} onCommit={onCommit} onPreview={onPreview} title={title} />
      </div>
    </Field>
  );
}

// Same "track raw typed text locally, commit a parsed value, never fight mid-edit" discipline as
// ClampedNumberField above, just parsing a comma-separated number LIST instead of one number -
// commits on every keystroke that currently parses to at least one valid number (so the chart
// updates live as you type, same as every other field here), tolerating trailing junk like "3, 5,"
// while you're still typing the next value rather than dropping the whole edit.
export function ChartDataField({ initialValue, onCommit, className }: { initialValue: number[]; onCommit: (values: number[]) => void; className: string }) {
  const [text, setText] = React.useState(initialValue.join(", "));
  const lastCommittedKey = React.useRef(text);
  const parse = (raw: string): number[] =>
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  return (
    <input
      type="text"
      value={text}
      placeholder="3, 7, 5, 9"
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const values = parse(raw);
        if (values.length === 0) return;
        const key = values.join(",");
        if (key === lastCommittedKey.current) return;
        lastCommittedKey.current = key;
        onCommit(values);
      }}
      onBlur={() => {
        const values = parse(text);
        if (values.length > 0) setText(values.join(", "));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
      className={className}
    />
  );
}

export const FIELD_INPUT_CLASS = "w-32 h-7 px-2 rounded-md border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.065] dark:hover:bg-white/[0.09] focus:bg-white dark:focus:bg-neutral-900 focus:border-blue-500/70 focus:ring-[3px] focus:ring-blue-500/15 outline-none transition-[background-color,border-color,box-shadow] duration-150 text-neutral-800 dark:text-neutral-100 text-[12px]";
// Ceiling for a node's stroke/ink width. Not a design limit - purely a guard against a typo (an
// accidental extra zero) producing a ring so thick it swallows the shape and leaves nothing visible
// to click back onto in order to undo it.
export const MAX_STROKE_WIDTH = 400;

// ---- Panel design tokens -------------------------------------------------------------------------
//
// One place for every control's appearance, so the panel reads as a single designed surface rather
// than a pile of independently-styled inputs. Anything added here should reuse these rather than
// spelling out its own border/height/radius - that drift is exactly what made the panel look
// assembled rather than designed.
// Inputs are "filled" (a faint tint, no outline) rather than outlined boxes - a column of
// outlined boxes reads as a form, a column of filled wells reads as an inspector, and the focus ring
// then has the whole stage to itself.
export const INPUT_SURFACE_CLASS =
  "rounded-md border border-transparent bg-black/[0.04] dark:bg-white/[0.06] hover:bg-black/[0.065] dark:hover:bg-white/[0.09] focus:bg-white dark:focus:bg-neutral-900 focus:border-blue-500/70 focus:ring-[3px] focus:ring-blue-500/15 outline-none transition-[background-color,border-color,box-shadow] duration-150 text-neutral-800 dark:text-neutral-100";
export const NUMBER_INPUT_CLASS = `w-14 h-7 px-2 ${INPUT_SURFACE_CLASS} text-[12px] tabular-nums`;
export const SELECT_CLASS = `w-36 h-7 pl-2 pr-1 ${INPUT_SURFACE_CLASS} text-[12px] cursor-pointer`;
// A thin track with a filled "progress" portion up to the thumb (driven by the --pct custom property
// LiveRangeSlider sets) and a soft white thumb - the native accent-color slider was the single most
// "default browser widget" looking thing in the panel.
export const SLIDER_CLASS =
  "wb-slider w-[84px] h-4 appearance-none bg-transparent cursor-pointer focus:outline-none [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,#3b82f6_var(--pct,0%),rgba(0,0,0,0.1)_var(--pct,0%))] dark:[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,#60a5fa_var(--pct,0%),rgba(255,255,255,0.14)_var(--pct,0%))] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-[5.5px] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.25)] [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150 hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-125 focus-visible:[&::-webkit-slider-thumb]:ring-[3px] focus-visible:[&::-webkit-slider-thumb]:ring-blue-500/25";
export const SWATCH_CLASS = "w-7 h-7 rounded-md border border-black/10 dark:border-white/10 bg-transparent cursor-pointer p-0.5";
export const CHECKBOX_CLASS = "h-4 w-4 rounded accent-blue-600 cursor-pointer";

// Readable names for the header. Only the shapeTypes whose raw identifier doesn't already read as a
// name need an entry - everything else falls back to its own camelCase split into words, which is
// correct for "rectangle", "ellipse", "hexagon" and the rest without listing all seventy of them.

export function HexColorInput({ value, onChange, title }: { value: string; onChange: (color: string) => void; title?: string }) {
  const [text, setText] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(value);
  }, [value, focused]);
  const normalize = (raw: string): string | null => {
    const t = raw.trim().replace(/^#?/, "#");
    if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t.slice(1).replace(/./g, (c) => c + c)}`.toLowerCase();
    return null;
  };
  return (
    <span
      title={title}
      className={`flex items-center gap-1.5 h-7 w-[112px] pl-1 pr-1.5 ${INPUT_SURFACE_CLASS} focus-within:bg-white dark:focus-within:bg-neutral-900 focus-within:border-blue-500/70 focus-within:ring-[3px] focus-within:ring-blue-500/15`}
    >
      <span className="relative shrink-0 w-5 h-5 rounded-[5px] overflow-hidden ring-1 ring-inset ring-black/10 dark:ring-white/15 bg-[conic-gradient(#d4d4d4_25%,#fff_0_50%,#d4d4d4_0_75%,#fff_0)] bg-[length:8px_8px]">
        <span className="absolute inset-0" style={{ backgroundColor: value }} />
        <ColorInput value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      </span>
      <input
        type="text"
        value={focused ? text : text.replace(/^#/, "").toUpperCase()}
        spellCheck={false}
        onFocus={() => {
          setFocused(true);
          setText(value.replace(/^#/, "").toUpperCase());
        }}
        onChange={(e) => {
          setText(e.target.value);
          const next = normalize(e.target.value);
          if (next) onChange(next);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        className="flex-1 min-w-0 bg-transparent text-[11px] font-mono uppercase tabular-nums text-neutral-700 dark:text-neutral-200 outline-none"
      />
    </span>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <Field label={label}>
      <HexColorInput value={value} onChange={onChange} />
    </Field>
  );
}

// A row of mutually-related toggle buttons drawn as one control (B/I/U, alignment, flip, fill type)
// - a recessed track with the active option raised out of it, the segmented look the Mindmap
// inspector uses for its font steps. `stretch` makes the options share the full row width.
export function Segmented({ children, stretch }: { children: React.ReactNode; stretch?: boolean }) {
  return (
    <div className={`flex items-center p-[2px] gap-[2px] rounded-md bg-black/[0.045] dark:bg-white/[0.06] ${stretch ? "w-full [&>button]:flex-1" : ""}`}>{children}</div>
  );
}

export function SegmentButton({ active, onClick, title, children }: { active: boolean; onClick: (e: React.MouseEvent) => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`h-6 min-w-[26px] px-1.5 flex items-center justify-center gap-1 rounded-[5px] text-[11px] font-medium transition-[background-color,color,box-shadow] duration-150 active:scale-[0.96] ${
        active
          ? "bg-white dark:bg-neutral-600 text-neutral-900 dark:text-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.12)]"
          : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      }`}
    >
      {children}
    </button>
  );
}

// A number field with its label inside the well ("X 120"), the compact form design tools use for
// geometry - the label reads as part of the value rather than a separate row competing with it.
// Dragging the label left/right scrubs the value (Shift for 10x), the Figma/After Effects gesture
// for nudging a number without leaving the mouse - a whole scrub commits once, on release.
export function PrefixedNumber({
  prefix,
  title,
  suffix,
  resetKey,
  value,
  min,
  max,
  onCommit,
}: {
  prefix: React.ReactNode;
  title: string;
  suffix?: string;
  resetKey: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  const [scrub, setScrub] = React.useState<number | null>(null);
  const scrubRef = React.useRef<{ startX: number; startValue: number; moved: boolean } | null>(null);
  const shown = scrub ?? value;
  return (
    <label
      title={title}
      className={`group flex items-center h-7 min-w-0 ${INPUT_SURFACE_CLASS} focus-within:bg-white dark:focus-within:bg-neutral-900 focus-within:border-blue-500/70 focus-within:ring-[3px] focus-within:ring-blue-500/15`}
    >
      <span
        className="shrink-0 w-6 h-full flex items-center justify-center text-[11px] font-medium text-gray-400 dark:text-neutral-500 select-none cursor-ew-resize group-hover:text-gray-500"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          scrubRef.current = { startX: e.clientX, startValue: value, moved: false };
        }}
        onPointerMove={(e) => {
          const s = scrubRef.current;
          if (!s) return;
          const dx = e.clientX - s.startX;
          if (!s.moved && Math.abs(dx) < 2) return;
          s.moved = true;
          setScrub(Math.max(min, Math.min(max, Math.round(s.startValue + dx * (e.shiftKey ? 10 : 1)))));
        }}
        onPointerUp={() => {
          const s = scrubRef.current;
          scrubRef.current = null;
          if (s?.moved && scrub !== null && scrub !== value) onCommit(scrub);
          setScrub(null);
        }}
      >
        {prefix}
      </span>
      <ClampedNumberField
        key={`${resetKey}-${scrub === null ? "idle" : "scrub"}`}
        initialValue={Math.round(shown)}
        min={min}
        max={max}
        onCommit={onCommit}
        className="flex-1 min-w-0 h-full bg-transparent text-[12px] tabular-nums outline-none pr-1"
      />
      {suffix && <span className="shrink-0 pr-2 text-[11px] text-gray-400 dark:text-neutral-500 select-none">{suffix}</span>}
    </label>
  );
}

// Position, size, rotation and flip for the selection, as one compact block: X/Y and W/H in a 2x2
// grid (single shape only - a multi-selection shares no one position), then rotation and the flip
// toggles side by side.
export function TransformBlock({
  nodes,
  onCommit,
  onFlip,
}: {
  nodes: WhiteboardNode[];
  onCommit: (patch: Partial<WhiteboardNode>) => void;
  onFlip: (axis: "horizontal" | "vertical") => void;
}) {
  const node = nodes[0];
  const ids = nodes.map((n) => n.id).join(",");
  return (
    <div className="flex flex-col gap-1.5">
      {nodes.length === 1 && (
        <div className="grid grid-cols-2 gap-1.5">
          <PrefixedNumber prefix="X" title="Horizontal position - drag the label to scrub" resetKey={`${ids}-x`} value={node.x} min={-100000} max={100000} onCommit={(x) => onCommit({ x })} />
          <PrefixedNumber prefix="Y" title="Vertical position - drag the label to scrub" resetKey={`${ids}-y`} value={node.y} min={-100000} max={100000} onCommit={(y) => onCommit({ y })} />
          <PrefixedNumber prefix="W" title="Width - drag the label to scrub" resetKey={`${ids}-w`} value={node.width} min={1} max={100000} onCommit={(width) => onCommit({ width })} />
          <PrefixedNumber prefix="H" title="Height - drag the label to scrub" resetKey={`${ids}-h`} value={node.height} min={1} max={100000} onCommit={(height) => onCommit({ height })} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <PrefixedNumber
          prefix={<TbRotateClockwise size={12} />}
          title="Rotation in degrees - drag the icon to scrub"
          suffix="°"
          resetKey={`${ids}-r`}
          value={((Math.round(node.rotation ?? 0) % 360) + 360) % 360}
          min={0}
          max={360}
          // 360 is visually identical to 0 (no rotation) - normalize both to "unset" rather than
          // clamping a typed 360 down to 359, which read as an arbitrary, unexplained cap.
          onCommit={(n) => {
            const norm = ((Math.round(n) % 360) + 360) % 360;
            onCommit({ rotation: norm === 0 ? undefined : norm });
          }}
        />
        <Segmented stretch>
          <SegmentButton active={false} onClick={() => onFlip("horizontal")} title="Flip horizontal (mirror left to right)">
            <TbFlipHorizontal size={14} />
          </SegmentButton>
          <SegmentButton active={false} onClick={() => onFlip("vertical")} title="Flip vertical (mirror top to bottom)">
            <TbFlipVertical size={14} />
          </SegmentButton>
        </Segmented>
      </div>
    </div>
  );
}

// Four arrows in one segmented row - the same 1px (10px with Shift) steps as the canvas's arrow keys.
export function NudgeBar({ onNudge }: { onNudge: (dx: number, dy: number) => void }) {
  const steps: [React.ReactNode, string, (big: boolean) => [number, number]][] = [
    [<TbArrowLeft size={13} />, "left", (b) => [b ? -10 : -1, 0]],
    [<TbArrowUp size={13} />, "up", (b) => [0, b ? -10 : -1]],
    [<TbArrowDown size={13} />, "down", (b) => [0, b ? 10 : 1]],
    [<TbArrowRight size={13} />, "right", (b) => [b ? 10 : 1, 0]],
  ];
  return (
    <Segmented>
      {steps.map(([glyph, name, delta]) => (
        <SegmentButton
          key={name}
          active={false}
          onClick={(e) => {
            const [dx, dy] = delta(e.shiftKey);
            onNudge(dx, dy);
          }}
          title={`Nudge ${name} (Shift for 10px)`}
        >
          {glyph}
        </SegmentButton>
      ))}
    </Segmented>
  );
}

export const FOOTER_BUTTON_CLASS =
  "h-7 w-7 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] hover:text-neutral-900 dark:hover:text-neutral-100 active:scale-95 transition";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 min-h-[28px] text-[12px] text-neutral-500 dark:text-neutral-400">
      {/* The label truncates rather than wrapping: a two-line label would break the even row rhythm
          that makes a long panel scannable, and the full text is still reachable on hover. */}
      <span className="truncate" title={label}>
        {label}
      </span>
      {children}
    </label>
  );
}

export const MINI_BUTTON_CLASS =
  "px-2.5 h-7 rounded-md bg-black/[0.04] dark:bg-white/[0.06] text-[12px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-black/[0.08] dark:hover:bg-white/[0.1] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none transition";

// A sub-panel for a cluster that needs to read as one unit (crop, figure layout, one annotation's
// settings) rather than as loose rows in its parent section.
export function Card({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5 rounded-lg bg-black/[0.025] dark:bg-white/[0.04] ring-1 ring-inset ring-black/[0.05] dark:ring-white/[0.06] p-2">{children}</div>;
}

// The chart title / x-axis / y-axis caption inputs. Committed on every keystroke (rather than on
// blur) to match how the "graph" Expression field next to it already behaves - a caption is short
// enough that the per-keystroke re-render costs nothing, and seeing it appear as you type is the
// point.
