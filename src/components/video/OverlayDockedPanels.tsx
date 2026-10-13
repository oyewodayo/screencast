// components/video/OverlayDockedPanels.tsx
//
// The sidebar (Tools tab) versions of the text / image / blur overlay settings - laid out for a
// tall, narrow panel (labelled sections, sliders with live values, segmented pickers, a mini-frame
// position pad, icon actions) rather than the one-row strip VideoOverlayLayer floats over the
// video when there's no sidebar to dock into. Purely presentational: VideoOverlayLayer owns all
// state and passes values + callbacks in.
//
// Every control here keeps focus where it is (mousedown default prevented, sliders included) -
// the text panel only exists while TextNoteEditor is open, and that editor commits and closes the
// moment its textarea loses focus. The blur panel's X/Y/W/H fields are the one exception (real
// inputs), safe there since a blur region has no editing session to end.
import { KEYFRAME_EASINGS, KEYFRAME_SNAP_SEC, KeyframeEasing, OverlayKeyframe, keyframeAt, keyframeStateAt, removeKeyframeAt, upsertKeyframe } from "../../utils/keyframes";
import React from "react";
import {
  IoArrowDown,
  IoArrowUp,
  IoCopyOutline,
  IoCropOutline,
  IoLocateOutline,
  IoRefreshOutline,
  IoSwapHorizontalOutline,
  IoSwapVerticalOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { MdFormatAlignCenter, MdFormatAlignJustify, MdFormatAlignLeft, MdFormatAlignRight } from "react-icons/md";
import Slider from "../docker/Slider";
import NumberStepper from "../docker/NumberStepper";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";
import { BlurShape, OverlayAnimation, TextOverlayCornerStyle } from "../../utils/videoEditTypes";
import { TextAlign } from "../../utils/pdfAnnotationTypes";

const keepFocus = (e: React.MouseEvent) => e.preventDefault();

// ---------- primitives ----------

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-2">
    <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">{title}</span>
    {children}
  </div>
);

function Segmented<T extends string>({
  options,
  value,
  onChange,
  columns,
}: {
  options: { value: T; label: React.ReactNode; title: string }[];
  value: T;
  onChange: (next: T) => void;
  columns?: number;
}) {
  return (
    <div
      className="grid gap-0.5 rounded-lg bg-white/[0.06] p-0.5"
      style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onMouseDown={keepFocus}
          onClick={() => onChange(o.value)}
          className={`h-7 flex items-center justify-center gap-1 rounded-md text-[11px] transition-colors ${
            value === o.value ? "bg-white/15 text-white shadow-sm" : "text-white/55 hover:text-white hover:bg-white/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Label, slider and a live value readout on one row. The wrapper swallows mousedown's default so
// the slider never takes focus (see this file's header).
const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  marks?: readonly number[];
  format: (v: number) => string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, marks, format, onChange }) => (
  <div className="flex items-center gap-2.5 text-[11px]">
    <span className="w-[58px] shrink-0 text-white/60">{label}</span>
    <div className="flex-1 min-w-0" onMouseDown={keepFocus}>
      <Slider value={value} min={min} max={max} step={step} marks={marks} onChange={onChange} />
    </div>
    <span className="w-10 shrink-0 text-right tabular-nums text-white/85">{format(value)}</span>
  </div>
);

const Switch: React.FC<{ on: boolean; onChange: (next: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    title={label}
    onMouseDown={keepFocus}
    onClick={() => onChange(!on)}
    className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors ${on ? "bg-blue-500" : "bg-white/20"}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${on ? "translate-x-[14px]" : ""}`} />
  </button>
);

const LabeledRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2.5 text-[11px] min-h-7">
    <span className="w-[58px] shrink-0 text-white/60">{label}</span>
    <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
  </div>
);

const IconButton: React.FC<{ title: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode }> = ({
  title,
  onClick,
  active,
  danger,
  children,
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onMouseDown={keepFocus}
    onClick={onClick}
    className={`h-8 flex-1 flex items-center justify-center rounded-lg transition-colors ${
      danger
        ? "text-red-300/90 hover:text-red-300 hover:bg-red-500/15"
        : active
          ? "bg-blue-500/20 text-blue-300"
          : "text-white/65 hover:text-white hover:bg-white/10"
    }`}
  >
    {children}
  </button>
);

// ---------- shared sections ----------

const ANIMATIONS: { value: OverlayAnimation; label: string; title: string }[] = [
  { value: "none", label: "None", title: "No animation" },
  { value: "fade", label: "Fade", title: "Fade in and out" },
  { value: "pop", label: "Pop", title: "Pop in (preview only)" },
  { value: "slide-left", label: "← Slide", title: "Slide in from the right, out to the left" },
  { value: "slide-right", label: "Slide →", title: "Slide in from the left, out to the right" },
  { value: "slide-up", label: "↑ Slide", title: "Slide up" },
  { value: "slide-down", label: "↓ Slide", title: "Slide down" },
];

const AnimationSection: React.FC<{ value: OverlayAnimation | undefined; onChange: (next: OverlayAnimation) => void }> = ({ value, onChange }) => (
  <Section title="Animation">
    <div className="grid grid-cols-4 gap-1">
      {ANIMATIONS.map((a) => (
        <button
          key={a.value}
          type="button"
          title={a.title}
          onMouseDown={keepFocus}
          onClick={() => onChange(a.value)}
          className={`h-7 rounded-md text-[11px] transition-colors ${
            (value ?? "none") === a.value ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/50" : "bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  </Section>
);

const POSITION_MARGIN = 0.04;

// A miniature 16:9 frame with the box drawn where it sits and nine snap targets - click one to
// move the box there (with a small margin from the edges).
const PositionPad: React.FC<{ x: number; y: number; width: number; height: number; onPlace: (x: number, y: number) => void }> = ({
  x,
  y,
  width,
  height,
  onPlace,
}) => {
  const spot = (i: number, size: number) => Math.max(0, i === 0 ? POSITION_MARGIN : i === 1 ? (1 - size) / 2 : 1 - size - POSITION_MARGIN);
  return (
    <div className="relative w-[132px] aspect-video rounded-md bg-black/40 ring-1 ring-white/15 overflow-hidden shrink-0">
      <div
        className="absolute rounded-[2px] bg-blue-400/25 ring-1 ring-blue-300/70 pointer-events-none"
        style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${Math.min(1, width) * 100}%`, height: `${Math.min(1, height) * 100}%` }}
      />
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
        {[0, 1, 2].flatMap((row) =>
          [0, 1, 2].map((col) => {
            const tx = spot(col, width);
            const ty = spot(row, height);
            const active = Math.abs(tx - x) < 0.005 && Math.abs(ty - y) < 0.005;
            return (
              <button
                key={`${row}-${col}`}
                type="button"
                title={`${["Top", "Middle", "Bottom"][row]} ${["left", "centre", "right"][col]}`}
                onMouseDown={keepFocus}
                onClick={() => onPlace(tx, ty)}
                className="group flex items-center justify-center"
              >
                <span className={`w-2 h-2 rounded-full transition-all ${active ? "bg-blue-400 scale-125" : "bg-white/35 group-hover:bg-white group-hover:scale-125"}`} />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

const PositionSection: React.FC<{ x: number; y: number; width: number; height: number; onPlace: (x: number, y: number) => void }> = (props) => (
  <Section title="Position">
    <div className="flex items-center gap-3">
      <PositionPad {...props} />
      <span className="text-[10.5px] leading-snug text-white/40">Click a dot to snap the box there, or drag it on the video.</span>
    </div>
  </Section>
);

const formatTime = (sec: number): string => {
  const t = Math.max(0, sec);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
};

const TimeRow: React.FC<{ label: string; value: number; playhead: number; onSet: (t: number) => void }> = ({ label, value, playhead, onSet }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="w-[58px] shrink-0 text-white/60">{label}</span>
    <div className="flex-1 flex items-center h-7 rounded-lg bg-white/[0.06]">
      <button type="button" title="0.1s earlier" onMouseDown={keepFocus} onClick={() => onSet(value - 0.1)} className="w-7 h-full rounded-l-lg text-white/60 hover:text-white hover:bg-white/10">
        −
      </button>
      <span className="flex-1 text-center tabular-nums text-white/90">{formatTime(value)}</span>
      <button type="button" title="0.1s later" onMouseDown={keepFocus} onClick={() => onSet(value + 0.1)} className="w-7 h-full rounded-r-lg text-white/60 hover:text-white hover:bg-white/10">
        +
      </button>
    </div>
    <button
      type="button"
      title={`Set to the playhead (${formatTime(playhead)})`}
      onMouseDown={keepFocus}
      onClick={() => onSet(playhead)}
      className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10"
    >
      <IoLocateOutline size={13} />
    </button>
  </div>
);

const TimingSection: React.FC<{ start: number; end: number; playhead: number; onSet?: (edge: "start" | "end", time: number) => void }> = ({
  start,
  end,
  playhead,
  onSet,
}) =>
  onSet ? (
    <Section title={`Timing · ${Math.max(0, end - start).toFixed(1)}s on screen`}>
      <TimeRow label="Start" value={start} playhead={playhead} onSet={(t) => onSet("start", t)} />
      <TimeRow label="End" value={end} playhead={playhead} onSet={(t) => onSet("end", t)} />
    </Section>
  ) : null;

const ActionBar: React.FC<{ onDuplicate?: () => void; onFront?: () => void; onBack?: () => void; onDelete: () => void }> = ({
  onDuplicate,
  onFront,
  onBack,
  onDelete,
}) => (
  <div className="flex items-center gap-1 pt-2.5 border-t border-white/10">
    {onDuplicate && (
      <IconButton title="Duplicate" onClick={onDuplicate}>
        <IoCopyOutline size={15} />
      </IconButton>
    )}
    {onFront && (
      <IconButton title="Bring to front" onClick={onFront}>
        <IoArrowUp size={15} />
      </IconButton>
    )}
    {onBack && (
      <IconButton title="Send to back" onClick={onBack}>
        <IoArrowDown size={15} />
      </IconButton>
    )}
    <IconButton title="Delete" onClick={onDelete} danger>
      <IoTrashOutline size={15} />
    </IconButton>
  </div>
);

interface CommonProps {
  x: number;
  y: number;
  width: number;
  height: number;
  startTime: number;
  endTime: number;
  playhead: number;
  onPlace: (x: number, y: number) => void;
  onSetTime?: (edge: "start" | "end", time: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // Keyframed motion (keyframes.ts) - omitted where the overlay type doesn't support it.
  keyframes?: OverlayKeyframe[];
  onKeyframes?: (keyframes: OverlayKeyframe[] | undefined) => void;
}

// Position pad - for a keyframed overlay it shows and sets the keyframe at the playhead (its
// position there), not the base x/y the keyframes have replaced.
const KeyframeAwarePosition: React.FC<CommonProps> = (props) => {
  const { keyframes, onKeyframes } = props;
  if (!keyframes || keyframes.length === 0 || !onKeyframes) {
    return <PositionSection x={props.x} y={props.y} width={props.width} height={props.height} onPlace={props.onPlace} />;
  }
  const local = Math.max(0, Math.min(props.endTime - props.startTime, props.playhead - props.startTime));
  const state = keyframeStateAt(keyframes, local)!;
  const here = keyframeAt(keyframes, local);
  return (
    <PositionSection
      x={state.x}
      y={state.y}
      width={props.width}
      height={props.height}
      onPlace={(x, y) => onKeyframes(upsertKeyframe(keyframes, { time: here?.time ?? local, easing: here?.easing ?? "ease", ...state, x, y }))}
    />
  );
};

// Motion: keyframes for position, scale and opacity. "Add keyframe" captures the overlay as it is
// at the playhead; once it has keyframes, moving it (drag or the position pad) - or the scale and
// opacity sliders here - sets the keyframe at the playhead, creating one if there isn't one.
const MotionSection: React.FC<CommonProps> = (props) => {
  const { keyframes, onKeyframes } = props;
  if (!onKeyframes) return null;
  const local = Math.max(0, Math.min(props.endTime - props.startTime, props.playhead - props.startTime));
  const inRange = props.playhead >= props.startTime && props.playhead <= props.endTime;
  const state = keyframeStateAt(keyframes, local) ?? { x: props.x, y: props.y, scale: 1, opacity: 1 };
  const here = keyframeAt(keyframes, local);
  const setHere = (patch: Partial<OverlayKeyframe>) =>
    onKeyframes(upsertKeyframe(keyframes, { time: local, easing: here?.easing ?? "ease", ...state, ...patch } as OverlayKeyframe));
  const sorted = [...(keyframes ?? [])].sort((a, b) => a.time - b.time);
  return (
    <Section title="Motion">
      {!keyframes || keyframes.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] leading-snug text-white/50">
            Animate position, size and fade: add a keyframe, move the playhead, then move or resize the overlay - it glides between them.
          </p>
          <button
            type="button"
            disabled={!inRange}
            onClick={() => setHere({})}
            title={inRange ? "Keyframe the overlay as it is right now" : "Move the playhead inside the overlay's time first"}
            className="self-start px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10 disabled:opacity-40"
          >
            Add keyframe at playhead
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <SliderRow label="Scale" value={Math.round(state.scale * 100)} min={10} max={400} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => inRange && setHere({ scale: v / 100 })} />
          <SliderRow label="Opacity" value={Math.round(state.opacity * 100)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => inRange && setHere({ opacity: v / 100 })} />
          <div className="flex flex-col gap-0.5">
            {sorted.map((k) => (
              <div key={k.time} className={`flex items-center gap-1.5 text-[11px] px-1 rounded ${Math.abs(k.time - local) <= KEYFRAME_SNAP_SEC ? "bg-amber-500/15" : ""}`}>
                <span className="text-amber-300">◆</span>
                <span className="w-12 tabular-nums text-white/70">{k.time.toFixed(2)}s</span>
                <select
                  value={k.easing}
                  onChange={(e) => onKeyframes(upsertKeyframe(keyframes, { ...k, easing: e.target.value as KeyframeEasing }))}
                  title="How it moves from here to the next keyframe"
                  className="flex-1 min-w-0 bg-white/10 rounded px-1 py-0.5 text-white outline-none"
                >
                  {KEYFRAME_EASINGS.map((e) => (
                    <option key={e.value} value={e.value} className="bg-neutral-900">
                      {e.label}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => onKeyframes(removeKeyframeAt(keyframes, k.time))} title="Remove keyframe" className="px-1 text-white/40 hover:text-red-400">
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {!here && inRange && (
              <button type="button" onClick={() => setHere({})} className="px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10">
                Add keyframe here
              </button>
            )}
            <button type="button" onClick={() => onKeyframes(undefined)} className="ml-auto text-[10px] text-white/40 hover:text-white/80">
              Remove motion
            </button>
          </div>
        </div>
      )}
    </Section>
  );
};

// ---------- text ----------

export interface TextStylePreset {
  name: string;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle;
}

export interface TextDockedPanelProps extends CommonProps {
  presets: TextStylePreset[];
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle;
  animation?: OverlayAnimation;
  fontSizePx: number;
  paddingPx: number;
  onApplyPreset: (preset: TextStylePreset) => void;
  onFontSizePx: (px: number) => void;
  onPaddingPx: (px: number) => void;
  onCornerStyle: (corner: TextOverlayCornerStyle) => void;
  onStroke: (patch: { strokeColor?: string; strokeWidth?: number }) => void;
  onAnimation: (next: OverlayAnimation) => void;
  onFront: () => void;
  onBack: () => void;
  // Character formatting - applied by the in-place editor (VideoTextEditor) to the selected text,
  // or all of it when nothing is selected. Absent when the sidebar isn't driving the editor.
  textColor?: string;
  textAlign?: TextAlign;
  onTextColor?: (color: string) => void;
  onHighlight?: (color: string | undefined) => void;
  onBold?: () => void;
  onItalic?: () => void;
  onAlign?: (align: TextAlign) => void;
}

const TEXT_COLORS = ["#ffffff", "#111827", "#ef4444", "#f97316", "#facc15", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];
const HIGHLIGHTS: { value: string | undefined; title: string }[] = [
  { value: undefined, title: "No highlight" },
  { value: "rgba(0,0,0,0.65)", title: "Dark" },
  { value: "rgba(255,255,255,0.9)", title: "Light" },
  { value: "rgba(250,204,21,0.9)", title: "Yellow" },
  { value: "rgba(59,130,246,0.85)", title: "Blue" },
  { value: "rgba(239,68,68,0.85)", title: "Red" },
];
const OUTLINE_COLORS = ["#000000", "#ffffff", "#ef4444", "#facc15", "#3b82f6", "#a855f7"];

// A row of colour dots - inline (no popup), so it never opens off-screen or steals focus.
const Swatches: React.FC<{ colors: (string | undefined)[]; value: string | undefined; onPick: (c: string | undefined) => void; titles?: string[] }> = ({
  colors,
  value,
  onPick,
  titles,
}) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {colors.map((c, i) => {
      const selected = (c ?? null) === (value ?? null) || (!!c && !!value && c.toLowerCase() === value.toLowerCase());
      return (
        <button
          key={c ?? "none"}
          type="button"
          title={titles?.[i] ?? c ?? "None"}
          onMouseDown={keepFocus}
          onClick={() => onPick(c)}
          className={`relative w-[22px] h-[22px] rounded-full transition-transform hover:scale-110 ${
            selected ? "ring-2 ring-blue-400 ring-offset-2 ring-offset-neutral-900" : "ring-1 ring-white/25"
          }`}
          style={{ background: c ?? "transparent" }}
        >
          {!c && <span className="absolute inset-[5px] border-t-2 border-red-400 rotate-45 origin-center top-1/2 -translate-y-1/2" />}
        </button>
      );
    })}
  </div>
);

const presetMatches = (p: TextStylePreset, props: TextDockedPanelProps): boolean =>
  (p.backgroundColor ?? null) === (props.backgroundColor ?? null) &&
  !!p.strokeWidth === !!props.strokeWidth &&
  (p.cornerStyle ?? "square") === (props.cornerStyle ?? "square");

export const TextDockedPanel: React.FC<TextDockedPanelProps> = (props) => {
  const outlineOn = !!props.strokeWidth;
  return (
    <>
      <Section title="Style">
        <div className="grid grid-cols-3 gap-1.5">
          {props.presets.map((p) => {
            const selected = presetMatches(p, props);
            return (
              <button
                key={p.name}
                type="button"
                title={p.name}
                onMouseDown={keepFocus}
                onClick={() => props.onApplyPreset(p)}
                className={`flex flex-col items-center justify-center gap-1 h-[58px] rounded-lg bg-gradient-to-br from-neutral-600/60 to-neutral-800/80 transition-shadow ${
                  selected ? "ring-2 ring-blue-400" : "ring-1 ring-white/10 hover:ring-white/30"
                }`}
              >
                <span
                  className="text-[15px] font-bold leading-none px-1.5 py-0.5"
                  style={{
                    color: "#fff",
                    background: p.backgroundColor ?? "transparent",
                    borderRadius: p.cornerStyle === "pill" ? 999 : p.cornerStyle === "rounded" ? 4 : 0,
                    WebkitTextStroke: p.strokeWidth ? `${Math.min(p.strokeWidth, 2)}px ${p.strokeColor ?? "#000"}` : undefined,
                    paintOrder: p.strokeWidth ? "stroke fill" : undefined,
                    textShadow: p.backgroundColor || p.strokeWidth ? undefined : "0 1px 3px rgba(0,0,0,0.9)",
                  }}
                >
                  Aa
                </span>
                <span className="text-[10px] text-white/60">{p.name}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Text">
        <SliderRow label="Size" value={props.fontSizePx} min={8} max={200} step={1} format={(v) => `${Math.round(v)}px`} onChange={props.onFontSizePx} />
        {props.onTextColor && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-white/60">Colour</span>
            <Swatches colors={TEXT_COLORS} value={props.textColor} onPick={(c) => c && props.onTextColor?.(c)} />
          </div>
        )}
        {props.onBold && props.onItalic && props.onAlign && (
          <div className="flex items-center gap-1.5">
            <div className="flex gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
              <button type="button" title="Bold (Ctrl+B)" onMouseDown={keepFocus} onClick={props.onBold} className="w-8 h-7 rounded-md text-[13px] font-bold text-white/70 hover:text-white hover:bg-white/10">
                B
              </button>
              <button type="button" title="Italic (Ctrl+I)" onMouseDown={keepFocus} onClick={props.onItalic} className="w-8 h-7 rounded-md text-[13px] italic font-serif text-white/70 hover:text-white hover:bg-white/10">
                I
              </button>
            </div>
            <div className="flex-1">
              <Segmented
                value={props.textAlign ?? "left"}
                onChange={props.onAlign}
                options={[
                  { value: "left", title: "Align left", label: <MdFormatAlignLeft size={15} /> },
                  { value: "center", title: "Centre", label: <MdFormatAlignCenter size={15} /> },
                  { value: "right", title: "Align right", label: <MdFormatAlignRight size={15} /> },
                  { value: "justify", title: "Justify", label: <MdFormatAlignJustify size={15} /> },
                ]}
              />
            </div>
          </div>
        )}
        {props.onBold && <span className="-mt-1 text-[10px] text-white/35">Select words on the video to colour or style just those - otherwise it applies to all the text.</span>}
        {props.onHighlight && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-white/60">Highlight</span>
            <Swatches colors={HIGHLIGHTS.map((h) => h.value)} titles={HIGHLIGHTS.map((h) => h.title)} value={props.backgroundColor} onPick={props.onHighlight} />
          </div>
        )}
        <LabeledRow label="Outline">
          <Switch
            on={outlineOn}
            label={outlineOn ? "Remove outline" : "Add outline"}
            onChange={(on) => props.onStroke(on ? { strokeWidth: 2, strokeColor: props.strokeColor ?? "#000000" } : { strokeWidth: undefined })}
          />
        </LabeledRow>
        {outlineOn && <Swatches colors={OUTLINE_COLORS} value={props.strokeColor ?? "#000000"} onPick={(c) => c && props.onStroke({ strokeColor: c, strokeWidth: props.strokeWidth })} />}
        {outlineOn && (
          <SliderRow
            label="Thickness"
            value={props.strokeWidth ?? 2}
            min={1}
            max={12}
            step={0.5}
            format={(v) => `${v}px`}
            onChange={(w) => props.onStroke({ strokeWidth: w, strokeColor: props.strokeColor ?? "#000000" })}
          />
        )}
      </Section>

      <Section title="Box">
        <SliderRow label="Padding" value={props.paddingPx} min={0} max={60} step={1} format={(v) => `${Math.round(v)}px`} onChange={props.onPaddingPx} />
        <LabeledRow label="Corners">
          <div className="flex-1">
            <Segmented
              value={props.cornerStyle ?? "square"}
              onChange={props.onCornerStyle}
              options={[
                { value: "square", title: "Square corners", label: <span className="w-3 h-3 border-[1.5px] border-current" /> },
                { value: "rounded", title: "Rounded corners", label: <span className="w-3 h-3 border-[1.5px] border-current rounded-[3px]" /> },
                { value: "pill", title: "Pill", label: <span className="w-4 h-3 border-[1.5px] border-current rounded-full" /> },
              ]}
            />
          </div>
        </LabeledRow>
      </Section>

      <AnimationSection value={props.animation} onChange={props.onAnimation} />
      <MotionSection {...props} />
      <KeyframeAwarePosition {...props} />
      <TimingSection start={props.startTime} end={props.endTime} playhead={props.playhead} onSet={props.onSetTime} />
      <ActionBar onDuplicate={props.onDuplicate} onFront={props.onFront} onBack={props.onBack} onDelete={props.onDelete} />
    </>
  );
};

// ---------- image ----------

export type ImageCorner = "square" | "rounded" | "round";

export interface ImageDockedPanelProps extends CommonProps {
  opacity: number;
  corner: ImageCorner | null;
  borderColor?: string;
  shadow: boolean;
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  animation?: OverlayAnimation;
  onOpacity: (v: number) => void;
  onCorner: (corner: ImageCorner) => void;
  onBorderColor: (color: string | undefined) => void;
  onShadow: (on: boolean) => void;
  onRotation: (deg: number) => void;
  onScale: (widthFraction: number) => void;
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
  onAnimation: (next: OverlayAnimation) => void;
  onReplace: () => void;
  onCrop: () => void;
  onFront: () => void;
  onBack: () => void;
}

export const ImageDockedPanel: React.FC<ImageDockedPanelProps> = (props) => (
  <>
    <Section title="Appearance">
      <SliderRow label="Opacity" value={Math.round(props.opacity * 100)} min={10} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => props.onOpacity(v / 100)} />
      <LabeledRow label="Corners">
        <div className="flex-1">
          <Segmented
            value={props.corner ?? ("custom" as ImageCorner)}
            onChange={props.onCorner}
            options={[
              { value: "square", title: "Square corners", label: <span className="w-3 h-3 border-[1.5px] border-current" /> },
              { value: "rounded", title: "Rounded corners", label: <span className="w-3 h-3 border-[1.5px] border-current rounded-[3px]" /> },
              { value: "round", title: "Round", label: <span className="w-3 h-3 border-[1.5px] border-current rounded-full" /> },
            ]}
          />
        </div>
      </LabeledRow>
      <LabeledRow label="Border">
        <Switch on={!!props.borderColor} label={props.borderColor ? "Remove border" : "Add border"} onChange={(on) => props.onBorderColor(on ? "#ffffff" : undefined)} />
        {props.borderColor && (
          <div onMouseDown={keepFocus} title="Border colour">
            <ColorSwatchPicker color={props.borderColor} onChange={(c) => props.onBorderColor(c)} size="sm" />
          </div>
        )}
      </LabeledRow>
      <LabeledRow label="Shadow">
        <Switch on={props.shadow} label="Drop shadow" onChange={props.onShadow} />
      </LabeledRow>
    </Section>

    <Section title="Transform">
      <SliderRow label="Size" value={Math.round(props.width * 100)} min={5} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => props.onScale(v / 100)} />
      <SliderRow label="Rotation" value={props.rotation > 180 ? props.rotation - 360 : props.rotation} min={-180} max={180} step={1} marks={[0]} format={(v) => `${Math.round(v)}°`} onChange={props.onRotation} />
      <div className="flex items-center gap-1">
        <IconButton title="Flip horizontally" onClick={props.onFlipHorizontal} active={props.flipHorizontal}>
          <IoSwapHorizontalOutline size={15} />
        </IconButton>
        <IconButton title="Flip vertically" onClick={props.onFlipVertical} active={props.flipVertical}>
          <IoSwapVerticalOutline size={15} />
        </IconButton>
        <IconButton title="Crop the picture" onClick={props.onCrop}>
          <IoCropOutline size={15} />
        </IconButton>
        <IconButton title="Replace the picture (keeps position, size and style)" onClick={props.onReplace}>
          <IoRefreshOutline size={15} />
        </IconButton>
      </div>
    </Section>

    <AnimationSection value={props.animation} onChange={props.onAnimation} />
    <MotionSection {...props} />
    <KeyframeAwarePosition {...props} />
    <TimingSection start={props.startTime} end={props.endTime} playhead={props.playhead} onSet={props.onSetTime} />
    <ActionBar onDuplicate={props.onDuplicate} onFront={props.onFront} onBack={props.onBack} onDelete={props.onDelete} />
  </>
);

// ---------- blur ----------

export type BlurPreset = "square" | "rounded" | "ellipse";

export interface BlurDockedPanelProps extends CommonProps {
  intensity: number;
  shape: BlurShape;
  preset: BlurPreset;
  cornerRadiusPx: number;
  maxCornerRadiusPx: number;
  rotation: number;
  onIntensity: (v: number) => void;
  onPreset: (preset: BlurPreset) => void;
  onCornerRadiusPx: (px: number) => void;
  onRotation: (deg: number) => void;
  onGeometry: (patch: Partial<Record<"x" | "y" | "width" | "height", number>>) => void;
}

export const BlurDockedPanel: React.FC<BlurDockedPanelProps> = (props) => (
  <>
    <Section title="Effect">
      <SliderRow label="Strength" value={Math.round(props.intensity * 100)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => props.onIntensity(v / 100)} />
      <LabeledRow label="Shape">
        <div className="flex-1">
          <Segmented
            value={props.preset}
            onChange={props.onPreset}
            options={[
              { value: "square", title: "Rectangle", label: <span className="w-3.5 h-2.5 border-[1.5px] border-current" /> },
              { value: "rounded", title: "Rounded rectangle", label: <span className="w-3.5 h-2.5 border-[1.5px] border-current rounded-[3px]" /> },
              { value: "ellipse", title: "Ellipse", label: <span className="w-3.5 h-2.5 border-[1.5px] border-current rounded-full" /> },
            ]}
          />
        </div>
      </LabeledRow>
      {props.shape === "rectangle" && (
        <SliderRow
          label="Rounding"
          value={Math.min(props.cornerRadiusPx, props.maxCornerRadiusPx)}
          min={0}
          max={Math.max(1, props.maxCornerRadiusPx)}
          step={1}
          format={(v) => `${Math.round(v)}px`}
          onChange={props.onCornerRadiusPx}
        />
      )}
    </Section>

    <Section title="Transform">
      <SliderRow label="Rotation" value={props.rotation} min={-180} max={180} step={1} marks={[0]} format={(v) => `${Math.round(v)}°`} onChange={props.onRotation} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {(
          [
            ["X", "x"],
            ["Y", "y"],
            ["W", "width"],
            ["H", "height"],
          ] as const
        ).map(([label, key]) => (
          <div key={key} className="flex items-center justify-between gap-1.5 text-[11px]">
            <span className="w-4 text-white/50">{label}</span>
            <NumberStepper
              value={Math.round(props[key] * 1000) / 10}
              min={key === "width" || key === "height" ? 1 : 0}
              max={100}
              step={0.5}
              decimals={1}
              suffix="%"
              onChange={(v) => props.onGeometry({ [key]: v / 100 })}
            />
          </div>
        ))}
      </div>
    </Section>

    <PositionSection x={props.x} y={props.y} width={props.width} height={props.height} onPlace={props.onPlace} />
    <TimingSection start={props.startTime} end={props.endTime} playhead={props.playhead} onSet={props.onSetTime} />
    <ActionBar onDuplicate={props.onDuplicate} onDelete={props.onDelete} />
  </>
);
