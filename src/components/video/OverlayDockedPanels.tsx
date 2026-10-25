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
import { REVEAL_STYLES, revealStartingMask, type LayerMask, type RevealStyle } from "../../utils/layerMask";
import { KEYFRAME_EASINGS, KEYFRAME_SNAP_SEC, KeyframeEasing, OverlayKeyframe, keyframeAt, keyframeStateAt, removeKeyframeAt, upsertKeyframe } from "../../utils/keyframes";
import React, { useEffect, useRef, useState } from "react";
import RevealText from "./RevealText";
import TitleLookTile from "./TitleLookTile";
import { TITLE_FONTS, TITLE_FONT_CATEGORIES, TitleFontCategory, loadTitleFonts, titleFont, titleFontStyle } from "../../utils/titleFonts";
import { TITLE_STYLES, TitleStyle, wearsTitleStyle } from "../../utils/titleStyles";
import { overlayAnimationStyle } from "../../utils/overlayAnimation";
import {
  IoArrowDown,
  IoArrowUp,
  IoCopyOutline,
  IoCropOutline,
  IoLocateOutline,
  IoNavigateOutline,
  IoRefreshOutline,
  IoSwapHorizontalOutline,
  IoSwapVerticalOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { MdFormatAlignCenter, MdFormatAlignJustify, MdFormatAlignLeft, MdFormatAlignRight } from "react-icons/md";
import Slider from "../docker/Slider";
import NumberStepper from "../docker/NumberStepper";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";
import { AdjustmentLayer, AdjustmentPlacement, AdjustmentRegion, BlendMode, BlurShape, ColorFilterPreset, OverlayAnimation, OverlayTrackInfo, TextOverlay, TextOverlayCornerStyle } from "../../utils/videoEditTypes";
import { MAX_ADJUSTMENT_BLUR } from "../../utils/adjustmentLayers";
import { BLEND_MODES } from "../../utils/blendModes";
import { TextAlign } from "../../utils/pdfAnnotationTypes";
import { ImageRevealDirection, ImageRevealSettings, ImageRevealStyle } from "../../utils/imageReveal";
import { CANVAS_TEXT_REVEALS, TEXT_REVEAL_SPEED_MAX, TEXT_REVEAL_SPEED_MIN, TextReveal, TextRevealSettings, isTextReveal, textRevealSeconds } from "../../utils/textReveal";
import { ASSET_ENTRANCES, ASSET_LOOPS, AssetEntrance, AssetLoop, OverlayAsset, assetEntry, assetSupportsOutline, assetUsesColor2, countdownPlan } from "../../utils/videoAssets";

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
  { value: "pop", label: "Pop", title: "Pop in with a springy overshoot" },
  { value: "flip", label: "Flip", title: "Spin in like a tossed coin" },
  { value: "zoom", label: "Zoom", title: "Rush in from big, fading in" },
  { value: "drop", label: "Drop", title: "Fall from above and bounce to rest" },
  { value: "slide-left", label: "← Slide", title: "Slide in from the right, out to the left" },
  { value: "slide-right", label: "Slide →", title: "Slide in from the left, out to the right" },
  { value: "slide-up", label: "↑ Slide", title: "Slide up" },
  { value: "slide-down", label: "↓ Slide", title: "Slide down" },
];

// Letter-by-letter title reveals - text only (textReveal.ts).
const TEXT_REVEALS: { value: OverlayAnimation; label: string; title: string }[] = [
  { value: "typewriter", label: "Type", title: "Typewriter - letters type on with a caret" },
  { value: "words", label: "Words", title: "Word by word - each word rises into place" },
  { value: "rise", label: "Rise", title: "Letters bounce up one after another" },
  { value: "blur", label: "Blur in", title: "Letters rise out of a soft blur" },
  { value: "scatter", label: "Scatter", title: "Letters fly in from all around and settle" },
  { value: "drop", label: "Drop", title: "Letters fall from above and bounce to rest" },
  { value: "spread", label: "Spread", title: "Letters close up from far apart" },
  { value: "wave", label: "Wave", title: "Letters hop up one after another" },
  { value: "popin", label: "Pop up", title: "Letters spring up from nothing, one after another" },
  { value: "mask", label: "Mask rise", title: "Each word slides up out of its line" },
  { value: "zoomin", label: "Zoom in", title: "Letters land from big and soft" },
  { value: "bounce", label: "Bounce", title: "Letters drop in tilted and bounce upright - sticker titles" },
  { value: "flicker", label: "Flicker", title: "A neon sign warming up" },
  { value: "roll", label: "Roll", title: "Letters and digits spin like a slot machine and land in turn" },
];

// The animation picker's tiles play each animation on a sample title, on a loop: on screen for
// SAMPLE_LIFE_SEC (entering and leaving), then a short empty pause. Drawn with the player's own
// functions (overlayAnimationStyle, RevealText), so a tile moves exactly like the overlay will.
const SAMPLE_LIFE_SEC = 2.2;
const SAMPLE_CYCLE_SEC = SAMPLE_LIFE_SEC + 0.6;
const SAMPLE_TEXT = "Title";
const sampleOverlay = (animation: OverlayAnimation): TextOverlay => ({
  id: `sample-${animation}`,
  text: SAMPLE_TEXT,
  color: "#ffffff",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  fontSize: 0.3,
  startTime: 0,
  endTime: SAMPLE_LIFE_SEC,
  createdAt: 0,
  updatedAt: 0,
});

const AnimationSection: React.FC<{ value: OverlayAnimation | undefined; onChange: (next: OverlayAnimation) => void; text?: boolean }> = ({ value, onChange, text }) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<OverlayAnimation, HTMLSpanElement>());
  const startRef = useRef(performance.now());
  const loopTime = () => ((performance.now() - startRef.current) / 1000) % SAMPLE_CYCLE_SEC;
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = loopTime();
      boxes.current.forEach((el, animation) => {
        const box = el.parentElement;
        if (!box) return;
        if (t >= SAMPLE_LIFE_SEC) {
          el.style.opacity = "0";
          return;
        }
        const s = overlayAnimationStyle(animation, 0, SAMPLE_LIFE_SEC, t, box.clientWidth, box.clientHeight);
        el.style.opacity = String(s.opacity);
        el.style.transform = `translate(${s.translateXPx}px, ${s.translateYPx}px) scale(${s.scale * (s.scaleX ?? 1)}, ${s.scale})`;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <Section title="Animation">
      <div ref={gridRef} className="grid grid-cols-4 gap-1">
        {(text ? [...ANIMATIONS, ...TEXT_REVEALS] : ANIMATIONS).map((a) => {
          const selected = (value ?? "none") === a.value;
          return (
            <button
              key={a.value}
              type="button"
              title={a.title}
              onMouseDown={keepFocus}
              onClick={() => onChange(a.value)}
              className={`flex flex-col items-stretch gap-0.5 p-0.5 rounded-md transition-colors ${selected ? "bg-blue-500/20 ring-1 ring-blue-400/50" : "bg-white/[0.04] hover:bg-white/10"}`}
            >
              <span className="relative h-7 rounded-[5px] bg-neutral-950/70 overflow-hidden flex items-center justify-center text-[12px] font-semibold text-white">
                {CANVAS_TEXT_REVEALS.has(a.value) ? (
                  <TitleLookTile look={{ fontFamily: "montserrat-bold", color: "#ffffff" }} text={SAMPLE_TEXT} width={64} height={28} animation={a.value} loopSec={SAMPLE_LIFE_SEC} />
                ) : isTextReveal(a.value) ? (
                  <span className="relative">
                    <RevealText overlay={sampleOverlay(a.value)} kind={a.value} paddingPx={0} getTime={loopTime} />
                  </span>
                ) : (
                  <span
                    ref={(el) => {
                      if (el && a.value !== "none") boxes.current.set(a.value, el);
                      else boxes.current.delete(a.value);
                    }}
                    className="inline-block"
                  >
                    {SAMPLE_TEXT}
                  </span>
                )}
              </span>
              <span className={`truncate text-center text-[10px] leading-tight ${selected ? "text-blue-200" : "text-white/60"}`}>{a.label}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
};

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
  // Blend mode (blendModes.ts) - omitted where it doesn't apply.
  blendMode?: BlendMode;
  onBlendMode?: (mode: BlendMode | undefined) => void;
  // Motion tracking (motionTracking.ts): what the keyframes were tracked from, and starting a
  // track (Dashboard shows the target picker).
  track?: OverlayTrackInfo;
  onTrackMotion?: () => void;
}

// How the overlay mixes with the picture under it.
const BlendSection: React.FC<{ value: BlendMode | undefined; onChange: (mode: BlendMode | undefined) => void }> = ({ value, onChange }) => {
  const current = BLEND_MODES.find((m) => m.value === (value ?? "normal")) ?? BLEND_MODES[0];
  return (
    <Section title="Blend">
      <select
        value={current.value}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value === "normal" ? undefined : (e.target.value as BlendMode))}
        title="How this mixes with the video under it - the export renders exactly the same"
        className="w-full bg-white/10 rounded-md px-2 py-1.5 text-[12px] text-white outline-none"
      >
        {BLEND_MODES.map((m) => (
          <option key={m.value} value={m.value} className="bg-neutral-900">
            {m.label}
          </option>
        ))}
      </select>
      <p className="text-[11px] leading-snug text-white/45">{current.hint}</p>
    </Section>
  );
};

const formatSpan = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${sec.toFixed(1)}s`);

// Motion tracking: pin to something moving (the picker opens on the video), or the state of an
// existing track - re-track it, or let go of it.
const TrackingBlock: React.FC<{ track?: OverlayTrackInfo; onTrack?: () => void; onRemove: () => void; keyframeCount: number; span: number }> = ({ track, onTrack, onRemove, keyframeCount, span }) => {
  if (!onTrack && !track) return null;
  if (!track) {
    return (
      <button
        type="button"
        onClick={onTrack}
        title="Drag a box over something moving and this follows it - preview and export alike"
        className="self-start flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10"
      >
        <IoNavigateOutline size={12} />
        Track motion…
      </button>
    );
  }
  const lost = Math.round(track.lostFraction * 100);
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-emerald-500/10 ring-1 ring-emerald-400/20 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-emerald-200">
        <IoNavigateOutline size={12} />
        <span className="flex-1">Following motion{track.followScale ? " and size" : ""}</span>
        <span className="tabular-nums text-emerald-200/60">{formatSpan(span)}</span>
      </div>
      <p className="text-[10px] leading-snug text-white/45">
        {keyframeCount} keyframes{lost > 0 ? ` · lost sight of it ${lost}% of the time (held in place there)` : ""}. Drag the overlay to move it along the whole path.
      </p>
      <div className="flex items-center gap-2">
        {onTrack && (
          <button type="button" onClick={onTrack} className="px-2 py-0.5 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10">
            Track again…
          </button>
        )}
        <button type="button" onClick={onRemove} className="ml-auto text-[10px] text-white/40 hover:text-white/80">
          Stop following
        </button>
      </div>
    </div>
  );
};

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
  const tracking = (
    <TrackingBlock track={props.track} onTrack={props.onTrackMotion} onRemove={() => onKeyframes(undefined)} keyframeCount={sorted.length} span={props.endTime - props.startTime} />
  );
  if (props.track && keyframes && keyframes.length > 0) {
    return (
      <Section title="Motion">
        {tracking}
        <SliderRow label="Opacity" value={Math.round(state.opacity * 100)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => inRange && onKeyframes(keyframes.map((k) => ({ ...k, opacity: v / 100 })))} />
      </Section>
    );
  }
  return (
    <Section title="Motion">
      {tracking}
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
  // The overlay as it looks now - what the look gallery, font and effects controls show.
  look: Partial<TextOverlay>;
  // A ready-made look (titleStyles.ts), and single look fields (face, tracking, gradient, glow, shadow).
  onApplyLook: (style: TitleStyle) => void;
  onLook: (patch: Pick<Partial<TextOverlay>, "fontFamily" | "letterSpacing" | "fill" | "glow" | "shadow" | "rotation">) => void;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle;
  animation?: OverlayAnimation;
  fontSizePx: number;
  paddingPx: number;
  onFontSizePx: (px: number) => void;
  onPaddingPx: (px: number) => void;
  onCornerStyle: (corner: TextOverlayCornerStyle) => void;
  onStroke: (patch: { strokeColor?: string; strokeWidth?: number }) => void;
  onAnimation: (next: OverlayAnimation) => void;
  // A title reveal's controls (textReveal.ts) - shown while the animation is one.
  text?: string;
  reveal?: TextRevealSettings;
  onReveal?: (patch: Partial<TextRevealSettings>) => void;
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
const UNDERLINE_COLORS = ["#facc15", "#f97316", "#ef4444", "#ffffff", "#22d3ee", "#a855f7"];

// Pace, timing, caret and exit for a typewriter / word-by-word / rise title.
const RevealSection: React.FC<{
  kind: TextReveal;
  text: string;
  duration: number;
  settings: TextRevealSettings;
  onChange: (patch: Partial<TextRevealSettings>) => void;
}> = ({ kind, text, duration, settings, onChange }) => {
  const typewriter = kind === "typewriter";
  const caretOn = settings.caret !== false;
  const revealSec = textRevealSeconds(text, kind, duration, settings);
  return (
    <Section title={typewriter ? "Typing" : "Reveal"}>
      {typewriter && (
        <LabeledRow label="Type by">
          <div className="flex-1">
            <Segmented
              value={settings.unit ?? "letter"}
              onChange={(unit) => onChange({ unit })}
              options={[
                { value: "letter", title: "One letter at a time", label: "Letter" },
                { value: "word", title: "A whole word at a time", label: "Word" },
              ]}
            />
          </div>
        </LabeledRow>
      )}
      {!typewriter && (
        <LabeledRow label="From">
          <div className="flex-1">
            <Segmented
              value={settings.from ?? "below"}
              onChange={(from) => onChange({ from })}
              options={[
                { value: "below", title: "Letters come up from below", label: "Below" },
                { value: "above", title: "Letters drop in from above", label: "Above" },
              ]}
            />
          </div>
        </LabeledRow>
      )}
      <SliderRow
        label="Speed"
        value={settings.speed ?? 1}
        min={TEXT_REVEAL_SPEED_MIN}
        max={TEXT_REVEAL_SPEED_MAX}
        step={0.05}
        marks={[1]}
        format={(v) => `${v.toFixed(v < 1 ? 2 : 1)}×`}
        onChange={(speed) => onChange({ speed })}
      />
      <SliderRow
        label="Delay"
        value={settings.delay ?? 0}
        min={0}
        max={Math.max(0.5, Math.min(10, duration * 0.8))}
        step={0.05}
        format={(v) => `${v.toFixed(1)}s`}
        onChange={(delay) => onChange({ delay })}
      />
      {typewriter && (
        <>
          <LabeledRow label="Caret">
            <Switch on={caretOn} label="Typing caret" onChange={(caret) => onChange({ caret })} />
            {caretOn && (
              <div className="flex-1">
                <Segmented
                  value={settings.caretStyle ?? "bar"}
                  onChange={(caretStyle) => onChange({ caretStyle })}
                  options={[
                    { value: "bar", title: "Thin bar", label: <span className="w-[2px] h-3 bg-current" /> },
                    { value: "block", title: "Block", label: <span className="w-2 h-3 bg-current opacity-80" /> },
                    { value: "underscore", title: "Underscore", label: <span className="w-2.5 h-[2px] mt-2.5 bg-current" /> },
                  ]}
                />
              </div>
            )}
          </LabeledRow>
          {caretOn && (
            <LabeledRow label="Blink">
              <Switch on={!!settings.caretHold} label="Keep the caret blinking after typing" onChange={(caretHold) => onChange({ caretHold })} />
              <span className="text-white/40">after typing</span>
            </LabeledRow>
          )}
          <LabeledRow label="Rhythm">
            <Switch on={!!settings.humanize} label="Uneven, human typing rhythm" onChange={(humanize) => onChange({ humanize })} />
            <span className="text-white/40">human</span>
          </LabeledRow>
        </>
      )}
      <LabeledRow label="Underline">
        <Switch on={!!settings.underline} label="Accent line that draws in under the title" onChange={(on) => onChange({ underline: on ? UNDERLINE_COLORS[0] : undefined })} />
        {settings.underline && <Swatches colors={UNDERLINE_COLORS} value={settings.underline} onPick={(c) => c && onChange({ underline: c })} />}
      </LabeledRow>
      <LabeledRow label="Exit">
        <div className="flex-1">
          <Segmented
            value={settings.exit ?? "fade"}
            onChange={(exit) => onChange({ exit })}
            options={[
              { value: "fade", title: "Fade out at the end", label: "Fade" },
              { value: "reverse", title: typewriter ? "Delete the text, letter by letter" : "Play the reveal backwards", label: typewriter ? "Untype" : "Reverse" },
              { value: "none", title: "Stay until the end, then cut", label: "None" },
            ]}
          />
        </div>
      </LabeledRow>
      <span className="text-[10px] text-white/40 tabular-nums">Fully revealed after {(revealSec + Math.min(settings.delay ?? 0, duration * 0.9)).toFixed(1)}s</span>
    </Section>
  );
};

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

// ---------- title looks, fonts and effects ----------

// Every ready-made look as a tile drawn by the real text renderer - what you see is what you get.
const TitleLookGallery: React.FC<{ look: Partial<TextOverlay>; onApply: (style: TitleStyle) => void }> = ({ look, onApply }) => (
  <Section title="Style">
    <div className="grid grid-cols-3 gap-1.5">
      {TITLE_STYLES.map((style) => {
        const selected = wearsTitleStyle(look, style);
        return (
          <button
            key={style.id}
            type="button"
            title={style.label}
            onMouseDown={keepFocus}
            onClick={() => onApply(style)}
            className={`group flex flex-col items-stretch gap-0.5 p-0.5 rounded-lg transition-shadow ${selected ? "ring-2 ring-blue-400 bg-blue-500/10" : "ring-1 ring-white/10 hover:ring-white/30"}`}
          >
            <span className="relative h-[44px] rounded-md overflow-hidden bg-[linear-gradient(135deg,#3f3f46,#18181b)] flex items-center justify-center">
              <TitleLookTile look={style.look} text={style.sample} width={84} height={44} />
            </span>
            <span className={`truncate text-center text-[10px] leading-tight ${selected ? "text-blue-200" : "text-white/55 group-hover:text-white/80"}`}>{style.label}</span>
          </button>
        );
      })}
    </div>
  </Section>
);

// Every face, each name set in itself, a category at a time.
const FontSection: React.FC<{ value: string | undefined; onChange: (id: string | undefined) => void }> = ({ value, onChange }) => {
  const [category, setCategory] = useState<TitleFontCategory | "All">(() => titleFont(value)?.category ?? "All");
  const [, setLoaded] = useState(0);
  useEffect(() => {
    // The picker shows each face in itself - redraw once they're all in.
    void loadTitleFonts(TITLE_FONTS.map((f) => f.id)).then(() => setLoaded((n) => n + 1));
  }, []);
  const fonts = TITLE_FONTS.filter((f) => category === "All" || f.category === category);
  return (
    <Section title="Font">
      <div className="flex flex-wrap gap-1">
        {(["All", ...TITLE_FONT_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            onMouseDown={keepFocus}
            onClick={() => setCategory(c)}
            className={`h-6 px-2 rounded-full text-[10.5px] transition-colors ${category === c ? "bg-white text-neutral-900" : "bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10"}`}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 max-h-[210px] overflow-y-auto pr-0.5">
        {category === "All" && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onChange(undefined)}
            className={`h-9 px-2 rounded-md text-left text-[14px] truncate transition-colors ${!value ? "bg-blue-500/25 text-white ring-1 ring-blue-400/60" : "bg-white/[0.05] text-white/80 hover:bg-white/10"}`}
            style={titleFontStyle(undefined)}
          >
            System
          </button>
        )}
        {fonts.map((f) => (
          <button
            key={f.id}
            type="button"
            title={f.label}
            onMouseDown={keepFocus}
            onClick={() => onChange(f.id)}
            className={`h-9 px-2 rounded-md text-left text-[15px] leading-none truncate transition-colors ${value === f.id ? "bg-blue-500/25 text-white ring-1 ring-blue-400/60" : "bg-white/[0.05] text-white/80 hover:bg-white/10"}`}
            style={titleFontStyle(f.id)}
          >
            {f.caps ? f.label.toUpperCase() : f.label}
          </button>
        ))}
      </div>
    </Section>
  );
};

const GRADIENTS: { from: string; to: string; title: string }[] = [
  { from: "#ffffff", to: "#8be9ff", title: "Ice" },
  { from: "#fff3c4", to: "#e0a526", title: "Gold" },
  { from: "#fff59d", to: "#ef4444", title: "Fire" },
  { from: "#fbcfe8", to: "#8b5cf6", title: "Candy" },
  { from: "#a7f3d0", to: "#0ea5e9", title: "Ocean" },
  { from: "#ffffff", to: "#6b7280", title: "Chrome" },
  { from: "#f0abfc", to: "#22d3ee", title: "Neon" },
];
const GLOW_COLORS = ["#22d3ee", "#2f8bff", "#ff2d95", "#a855f7", "#f97316", "#facc15", "#ffffff"];
const SHADOWS: { value: TextOverlay["shadow"]; label: string; title: string }[] = [
  { value: undefined, label: "None", title: "No shadow" },
  { value: { color: "rgba(0,0,0,0.55)", x: 0, y: 0.04, blur: 0.12 }, label: "Soft", title: "Soft shadow under the letters" },
  { value: { color: "rgba(0,0,0,0.6)", x: 0.04, y: 0.06, blur: 0 }, label: "Hard", title: "A solid offset copy behind - poster style" },
  { value: { color: "rgba(0,0,0,0.75)", x: 0, y: 0, blur: 0.3 }, label: "Halo", title: "A dark halo all round - legible on anything" },
];

// Tracking, gradient fill, glow and shadow.
const TextEffectsSection: React.FC<{ look: Partial<TextOverlay>; onLook: TextDockedPanelProps["onLook"] }> = ({ look, onLook }) => {
  const shadowIndex = Math.max(0, SHADOWS.findIndex((s) => JSON.stringify(s.value ?? null) === JSON.stringify(look.shadow ?? null)));
  return (
    <Section title="Effects">
      <SliderRow label="Spacing" value={look.letterSpacing ?? 0} min={-0.05} max={0.5} step={0.01} marks={[0]} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onLook({ letterSpacing: Math.abs(v) < 0.005 ? undefined : v })} />
      <LabeledRow label="Gradient">
        <Switch on={!!look.fill} label={look.fill ? "Solid colour instead" : "Gradient fill"} onChange={(on) => onLook({ fill: on ? { from: GRADIENTS[0].from, to: GRADIENTS[0].to } : undefined })} />
      </LabeledRow>
      {look.fill && (
        <div className="flex flex-wrap gap-1.5">
          {GRADIENTS.map((g) => {
            const selected = look.fill?.from === g.from && look.fill?.to === g.to;
            return (
              <button
                key={g.title}
                type="button"
                title={g.title}
                onMouseDown={keepFocus}
                onClick={() => onLook({ fill: { from: g.from, to: g.to } })}
                className={`w-[22px] h-[22px] rounded-full transition-transform hover:scale-110 ${selected ? "ring-2 ring-blue-400 ring-offset-2 ring-offset-neutral-900" : "ring-1 ring-white/25"}`}
                style={{ background: `linear-gradient(180deg, ${g.from}, ${g.to})` }}
              />
            );
          })}
        </div>
      )}
      <LabeledRow label="Glow">
        <Switch on={!!look.glow} label={look.glow ? "Remove glow" : "Add glow"} onChange={(on) => onLook({ glow: on ? { color: GLOW_COLORS[0], size: 0.35 } : undefined })} />
      </LabeledRow>
      {look.glow && (
        <>
          <Swatches colors={GLOW_COLORS} value={look.glow.color} onPick={(c) => c && onLook({ glow: { color: c, size: look.glow?.size ?? 0.35 } })} />
          <SliderRow label="Glow size" value={look.glow.size} min={0.05} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(size) => onLook({ glow: { color: look.glow?.color ?? GLOW_COLORS[0], size } })} />
        </>
      )}
      <LabeledRow label="Shadow">
        <div className="flex-1">
          <Segmented value={String(shadowIndex)} onChange={(i) => onLook({ shadow: SHADOWS[Number(i)].value })} options={SHADOWS.map((s, i) => ({ value: String(i), title: s.title, label: s.label }))} />
        </div>
      </LabeledRow>
    </Section>
  );
};


export const TextDockedPanel: React.FC<TextDockedPanelProps> = (props) => {
  const outlineOn = !!props.strokeWidth;
  return (
    <>
      <TitleLookGallery look={props.look} onApply={props.onApplyLook} />
      <FontSection value={props.look.fontFamily} onChange={(fontFamily) => props.onLook({ fontFamily })} />

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

      <TextEffectsSection look={props.look} onLook={props.onLook} />
      <Section title="Rotate">
        <SliderRow
          label="Angle"
          value={props.look.rotation ?? 0}
          min={-180}
          max={180}
          step={1}
          marks={[0, -90, 90]}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => props.onLook({ rotation: Math.abs(v) < 0.5 ? undefined : v })}
        />
        <div className="grid grid-cols-4 gap-1">
          {[
            { v: 0, label: "Level", title: "Straight" },
            { v: -90, label: "Up ↑", title: "Vertical, reading bottom to top" },
            { v: 90, label: "Down ↓", title: "Vertical, reading top to bottom" },
            { v: -8, label: "Tilt", title: "A slight, lively tilt" },
          ].map((r) => (
            <button
              key={r.v}
              type="button"
              title={r.title}
              onMouseDown={keepFocus}
              onClick={() => props.onLook({ rotation: r.v || undefined })}
              className={`h-7 rounded-md text-[11px] transition-colors ${
                (props.look.rotation ?? 0) === r.v ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/50" : "bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
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

      {props.onBlendMode && <BlendSection value={props.blendMode} onChange={props.onBlendMode} />}
      <AnimationSection text value={props.animation} onChange={props.onAnimation} />
      {isTextReveal(props.animation) && props.onReveal && (
        <RevealSection
          kind={props.animation}
          text={props.text ?? ""}
          duration={props.endTime - props.startTime}
          settings={props.reveal ?? {}}
          onChange={props.onReveal}
        />
      )}
      <MotionSection {...props} />
      <KeyframeAwarePosition {...props} />
      <TimingSection start={props.startTime} end={props.endTime} playhead={props.playhead} onSet={props.onSetTime} />
      <ActionBar onDuplicate={props.onDuplicate} onFront={props.onFront} onBack={props.onBack} onDelete={props.onDelete} />
    </>
  );
};

// ---------- shapes & elements ----------

function ChipGrid<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (next: T) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onMouseDown={keepFocus}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-md text-[11px] transition-colors ${
            value === o.value ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/50" : "bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A text input that commits on Enter or blur - one undo step per edit, not per keystroke.
const DraftTextField: React.FC<{ value: string; placeholder?: string; onCommit: (v: string) => void }> = ({ value, placeholder, onCommit }) => {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <input
      type="text"
      value={draft ?? value}
      placeholder={placeholder}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(null);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className="flex-1 min-w-0 h-7 px-2 rounded-md bg-black/40 ring-1 ring-white/10 text-[11px] text-white outline-none focus:ring-blue-400"
    />
  );
};

// Countdown numbers (from/to, pace) and the timer's starting time.
const CounterSection: React.FC<{
  asset: OverlayAsset;
  onAsset: (patch: Partial<OverlayAsset>) => void;
  startTime: number;
  endTime: number;
  onSetTime?: (edge: "start" | "end", time: number) => void;
}> = ({ asset, onAsset, startTime, endTime, onSetTime }) => {
  if (asset.kind === "timer") {
    return (
      <Section title="Timer">
        <LabeledRow label="Start at">
          <NumberStepper value={asset.countFrom ?? 0} min={0} max={359999} step={1} decimals={0} suffix=" s" onChange={(v) => onAsset({ countFrom: Math.round(v) })} />
          <span className="text-white/40">counts up</span>
        </LabeledRow>
      </Section>
    );
  }
  const plan = countdownPlan(asset, endTime - startTime);
  const pace = asset.countPace ?? "second";
  const fitsLength = Math.abs(endTime - startTime - plan.steps) < 0.05;
  return (
    <Section title="Count">
      <LabeledRow label="From">
        <NumberStepper value={plan.from} min={-9999} max={9999} step={1} decimals={0} suffix="" onChange={(v) => onAsset({ countFrom: Math.round(v) })} />
        <span className="text-white/40">to</span>
        <NumberStepper value={plan.to} min={-9999} max={9999} step={1} decimals={0} suffix="" onChange={(v) => onAsset({ countTo: Math.round(v) })} />
      </LabeledRow>
      <LabeledRow label="Pace">
        <div className="flex-1">
          <Segmented
            value={pace}
            onChange={(countPace) => onAsset({ countPace })}
            options={[
              { value: "second", title: "One number per second, then hold the last", label: "1 per second" },
              { value: "fit", title: "Spread the numbers over the element's whole length", label: "Fit length" },
            ]}
          />
        </div>
      </LabeledRow>
      {pace === "second" && onSetTime && !fitsLength && (
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={() => onSetTime("end", startTime + plan.steps)}
          className="h-7 rounded-md bg-white/[0.06] text-[11px] text-white/70 hover:text-white hover:bg-white/10 transition-colors"
        >
          Make it {plan.steps}s long to match the count
        </button>
      )}
    </Section>
  );
};

// Colours, style and the element's own built-in effects (videoAssets.ts) - separate from the
// box-level Animation/Motion sections below, which still apply on top.
export const AssetSettingsSections: React.FC<{
  asset: OverlayAsset;
  onAsset: (patch: Partial<OverlayAsset>) => void;
  startTime: number;
  endTime: number;
  onSetTime?: (edge: "start" | "end", time: number) => void;
}> = ({ asset, onAsset, startTime, endTime, onSetTime }) => (
  <>
    {(asset.kind === "countdown" || asset.kind === "timer") && (
      <CounterSection asset={asset} onAsset={onAsset} startTime={startTime} endTime={endTime} onSetTime={onSetTime} />
    )}
    {assetEntry(asset.kind).text && (
      <Section title="Text">
        <LabeledRow label={assetEntry(asset.kind).text![0]}>
          <DraftTextField value={asset.text ?? ""} onCommit={(text) => onAsset({ text })} />
        </LabeledRow>
        {assetEntry(asset.kind).text![1] && (
          <LabeledRow label={assetEntry(asset.kind).text![1]!}>
            <DraftTextField value={asset.subtext ?? ""} onCommit={(subtext) => onAsset({ subtext })} />
          </LabeledRow>
        )}
      </Section>
    )}
    <Section title="Element">
      <LabeledRow label="Colour">
        <div onMouseDown={keepFocus} title="Main colour">
          <ColorSwatchPicker color={asset.color} onChange={(c) => onAsset({ color: c })} size="sm" />
        </div>
        {assetUsesColor2(asset.kind) && (
          <>
            <Switch on={!!asset.color2} label={asset.color2 ? "Use a single colour" : "Add a second colour (gradient / accent)"} onChange={(on) => onAsset({ color2: on ? "#8b5cf6" : undefined })} />
            {asset.color2 && (
              <div onMouseDown={keepFocus} title="Second colour">
                <ColorSwatchPicker color={asset.color2} onChange={(c) => onAsset({ color2: c })} size="sm" />
              </div>
            )}
          </>
        )}
      </LabeledRow>
      {assetSupportsOutline(asset.kind) && (
        <LabeledRow label="Style">
          <div className="flex-1">
            <Segmented
              value={asset.outline ? "outline" : "fill"}
              onChange={(v) => onAsset({ outline: v === "outline" })}
              options={[
                { value: "fill", title: "Filled", label: <span className="w-3 h-3 rounded-sm bg-current" /> },
                { value: "outline", title: "Outline only", label: <span className="w-3 h-3 rounded-sm border-[1.5px] border-current" /> },
              ]}
            />
          </div>
        </LabeledRow>
      )}
      <LabeledRow label="Glow">
        <Switch on={!!asset.glow} label="Neon glow" onChange={(glow) => onAsset({ glow })} />
      </LabeledRow>
    </Section>
    <Section title="Entrance">
      <ChipGrid<AssetEntrance> options={ASSET_ENTRANCES} value={asset.entrance} onChange={(entrance) => onAsset({ entrance })} />
      <LabeledRow label="Exit">
        <Switch on={asset.exit} label="Play the entrance backwards on the way out" onChange={(exit) => onAsset({ exit })} />
        <span className="text-white/40">reverse entrance</span>
      </LabeledRow>
    </Section>
    <Section title="Loop">
      <ChipGrid<AssetLoop> options={ASSET_LOOPS} value={asset.loop} onChange={(loop) => onAsset({ loop })} />
    </Section>
  </>
);

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
  // Set for a shape/animated element instead of a picture.
  asset?: OverlayAsset;
  onAsset?: (patch: Partial<OverlayAsset>) => void;
  // The picture's own reveal (imageReveal.ts); undefined = none.
  reveal?: ImageRevealSettings;
  onReveal?: (reveal: ImageRevealSettings | undefined) => void;
  // Its mask (layerMask.ts).
  mask?: LayerMask;
  maskEditing?: boolean;
  onMaskShape?: (shape: LayerMask["shape"] | null) => void;
  onMask?: (mask: LayerMask) => void;
  onToggleMaskEdit?: () => void;
}

const SHINE_COLORS = ["#ffffff", "#fde68a", "#fbbf24", "#93c5fd", "#f9a8d4"];
const WIPE_DIRECTIONS: { value: ImageRevealDirection; label: string; title: string }[] = [
  { value: "right", label: "→", title: "Left to right" },
  { value: "left", label: "←", title: "Right to left" },
  { value: "down", label: "↓", title: "Top to bottom" },
  { value: "up", label: "↑", title: "Bottom to top" },
  { value: "diagonal", label: "↘", title: "Corner to corner" },
];

// Wipe / glare / focus / fade-in of the picture inside its box, with its direction, length,
// repeating shine and exit.
const ImageRevealSection: React.FC<{ reveal?: ImageRevealSettings; onChange: (reveal: ImageRevealSettings | undefined) => void }> = ({ reveal, onChange }) => {
  const set = (patch: Partial<ImageRevealSettings>) => reveal && onChange({ ...reveal, ...patch });
  const style = reveal?.style ?? "none";
  const wipes = style === "wipe" || style === "glare";
  return (
    <Section title="Reveal">
      <ChipGrid<ImageRevealStyle | "none">
        options={[
          { value: "none", label: "None" },
          { value: "wipe", label: "Wipe" },
          { value: "glare", label: "Glare" },
          { value: "focus", label: "Focus" },
          { value: "fade", label: "Fade" },
        ]}
        value={style}
        onChange={(next) => onChange(next === "none" ? undefined : { ...(reveal ?? {}), style: next })}
      />
      {reveal && (
        <>
          {wipes && (
            <LabeledRow label="Direction">
              <div className="flex-1">
                <Segmented value={reveal.direction ?? "right"} onChange={(direction) => set({ direction })} options={WIPE_DIRECTIONS} />
              </div>
            </LabeledRow>
          )}
          <SliderRow label="Length" value={reveal.seconds ?? 1.2} min={0.3} max={4} step={0.05} format={(v) => `${v.toFixed(1)}s`} onChange={(seconds) => set({ seconds })} />
          <LabeledRow label="Shine">
            <div className="flex-1">
              <Segmented
                value={String(reveal.shineEvery ?? 0)}
                onChange={(v) => set({ shineEvery: Number(v) || undefined })}
                options={[
                  { value: "0", title: style === "glare" ? "Only the streak in the reveal" : "No shine", label: style === "glare" ? "Once" : "Off" },
                  { value: "2", title: "A light streak every 2 seconds", label: "2s" },
                  { value: "3", title: "A light streak every 3 seconds", label: "3s" },
                  { value: "5", title: "A light streak every 5 seconds", label: "5s" },
                ]}
              />
            </div>
          </LabeledRow>
          {(style === "glare" || (reveal.shineEvery ?? 0) > 0) && (
            <LabeledRow label="Shine colour">
              <Swatches colors={SHINE_COLORS} value={reveal.shineColor ?? "#ffffff"} onPick={(c) => c && set({ shineColor: c })} />
            </LabeledRow>
          )}
          <LabeledRow label="Exit">
            <Switch on={!!reveal.exit} label="Play the reveal backwards at the end" onChange={(exit) => set({ exit })} />
            <span className="text-white/40">reverse at the end</span>
          </LabeledRow>
        </>
      )}
    </Section>
  );
};

// A layer's mask (layerMask.ts): its shape ("Draw" outlines one on the video), feather, invert, and
// on-video editing.
export const MaskSection: React.FC<{
  mask: LayerMask | undefined;
  editing: boolean;
  onShape: (shape: LayerMask["shape"] | null) => void;
  onMask: (mask: LayerMask) => void;
  onToggleEdit: () => void;
}> = ({ mask, editing, onShape, onMask, onToggleEdit }) => (
  <Section title="Mask">
    <ChipGrid<LayerMask["shape"] | "none">
      options={[
        { value: "none", label: "None" },
        { value: "ellipse", label: "Ellipse" },
        { value: "rectangle", label: "Box" },
        { value: "path", label: "Draw" },
      ]}
      value={mask?.shape ?? "none"}
      onChange={(next) => onShape(next === "none" ? null : next)}
    />
    {mask && (
      <>
        <SliderRow label="Feather" value={Math.round(mask.feather * 400)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => onMask({ ...mask, feather: v / 400 })} />
        {mask.shape === "rectangle" && (
          <SliderRow label="Corners" value={Math.round((mask.cornerRadius ?? 0) * 200)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => onMask({ ...mask, cornerRadius: v / 200 })} />
        )}
        <LabeledRow label="Invert">
          <Switch on={mask.invert} label="Show everything except the masked area" onChange={(invert) => onMask({ ...mask, invert })} />
        </LabeledRow>
        <button
          type="button"
          onClick={onToggleEdit}
          className={`self-start px-2 py-1 rounded text-[11px] ${editing ? "bg-teal-500/20 text-teal-300 ring-1 ring-teal-400/40" : "bg-white/5 text-white/80 hover:bg-white/10"}`}
        >
          {editing ? "Done editing" : "Move / resize on the video"}
        </button>
      </>
    )}
    <LabeledRow label="Opens">
      <div className="flex-1">
        <ChipGrid<RevealStyle | "none">
          options={[{ value: "none", label: "At once" }, ...REVEAL_STYLES.map((r) => ({ value: r.value, label: r.label }))]}
          value={mask?.reveal?.style ?? "none"}
          onChange={(style) => {
            if (style === "none") {
              if (mask) onMask({ ...mask, reveal: undefined });
              return;
            }
            // No mask yet: one that covers the whole picture once open.
            onMask({ ...(mask ?? revealStartingMask(style)), reveal: { style, duration: mask?.reveal?.duration ?? 0.8, exit: mask?.reveal?.exit } });
          }}
        />
      </div>
    </LabeledRow>
    {mask?.reveal && (
      <>
        <SliderRow label="Duration" value={mask.reveal.duration} min={0.2} max={4} step={0.05} format={(v) => `${v.toFixed(1)}s`} onChange={(duration) => onMask({ ...mask, reveal: { ...mask.reveal!, duration } })} />
        <LabeledRow label="Close">
          <Switch on={!!mask.reveal.exit} label="Close the same way over the picture's last moments" onChange={(exit) => onMask({ ...mask, reveal: { ...mask.reveal!, exit } })} />
          <span className="text-white/40">{mask.reveal.exit ? "at the end too" : "stays open"}</span>
        </LabeledRow>
      </>
    )}
  </Section>
);

export const ImageDockedPanel: React.FC<ImageDockedPanelProps> = (props) => (
  <>
    {props.asset && props.onAsset && (
      <AssetSettingsSections asset={props.asset} onAsset={props.onAsset} startTime={props.startTime} endTime={props.endTime} onSetTime={props.onSetTime} />
    )}
    <Section title="Appearance">
      <SliderRow label="Opacity" value={Math.round(props.opacity * 100)} min={10} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => props.onOpacity(v / 100)} />
      {!props.asset && (
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
      )}
      {!props.asset && (
        <LabeledRow label="Border">
          <Switch on={!!props.borderColor} label={props.borderColor ? "Remove border" : "Add border"} onChange={(on) => props.onBorderColor(on ? "#ffffff" : undefined)} />
          {props.borderColor && (
            <div onMouseDown={keepFocus} title="Border colour">
              <ColorSwatchPicker color={props.borderColor} onChange={(c) => props.onBorderColor(c)} size="sm" />
            </div>
          )}
        </LabeledRow>
      )}
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
        {!props.asset && (
          <>
            <IconButton title="Crop the picture" onClick={props.onCrop}>
              <IoCropOutline size={15} />
            </IconButton>
            <IconButton title="Replace the picture (keeps position, size and style)" onClick={props.onReplace}>
              <IoRefreshOutline size={15} />
            </IconButton>
          </>
        )}
      </div>
    </Section>

    {props.onBlendMode && <BlendSection value={props.blendMode} onChange={props.onBlendMode} />}
    {!props.asset && props.onMaskShape && props.onMask && props.onToggleMaskEdit && (
      <MaskSection mask={props.mask} editing={!!props.maskEditing} onShape={props.onMaskShape} onMask={props.onMask} onToggleEdit={props.onToggleMaskEdit} />
    )}
    {!props.asset && props.onReveal && <ImageRevealSection reveal={props.reveal} onChange={props.onReveal} />}
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

    {(props.onTrackMotion || props.track) && props.onKeyframes && (
      <Section title="Motion">
        <TrackingBlock
          track={props.keyframes?.length ? props.track : undefined}
          onTrack={props.onTrackMotion}
          onRemove={() => props.onKeyframes?.(undefined)}
          keyframeCount={props.keyframes?.length ?? 0}
          span={props.endTime - props.startTime}
        />
        {!props.keyframes?.length && <p className="text-[11px] leading-snug text-white/45">Keep a face or a number plate hidden as it moves.</p>}
      </Section>
    )}
    <KeyframeAwarePosition {...props} />
    <TimingSection start={props.startTime} end={props.endTime} playhead={props.playhead} onSet={props.onSetTime} />
    <ActionBar onDuplicate={props.onDuplicate} onDelete={props.onDelete} />
  </>
);

// ---------- adjustment layer ----------

export interface AdjustmentDockedPanelProps {
  layer: AdjustmentLayer;
  playhead: number;
  onChange: (patch: Partial<AdjustmentLayer>) => void;
  onSetTime?: (edge: "start" | "end", time: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // Follow a subject with the area (motion tracking).
  onTrackMotion?: () => void;
}

const LOOKS: { value: ColorFilterPreset; label: string }[] = [
  { value: "none", label: "None" },
  { value: "vibrant", label: "Vibrant" },
  { value: "cinematic", label: "Film" },
  { value: "warm", label: "Warm" },
  { value: "cool", label: "Cool" },
  { value: "bw", label: "B&W" },
];

export const AdjustmentDockedPanel: React.FC<AdjustmentDockedPanelProps> = ({ layer, playhead, onChange, onSetTime, onDuplicate, onDelete, onTrackMotion }) => {
  const region = layer.region;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const setRegion = (patch: Partial<AdjustmentRegion> | null) =>
    onChange({ region: patch === null ? undefined : { ...(region ?? { x: 0.3, y: 0.25, width: 0.4, height: 0.5, shape: "ellipse", feather: 0.35, invert: false }), ...patch } });
  const span = Math.max(0.1, layer.endTime - layer.startTime);
  return (
    <>
      <Section title="Applies to">
        <Segmented<AdjustmentPlacement>
          value={layer.placement}
          onChange={(placement) => onChange({ placement })}
          options={[
            { value: "under", label: "The video", title: "Grade or blur the footage; titles, pictures and picture-in-picture stay untouched" },
            { value: "over", label: "Everything", title: "Also covers every title, picture and picture-in-picture beneath it (captions stay on top)" },
          ]}
        />
      </Section>

      <Section title="Look">
        <ChipGrid<ColorFilterPreset>
          options={LOOKS}
          value={layer.look?.preset ?? "none"}
          onChange={(preset) => onChange({ look: preset === "none" ? undefined : { preset, intensity: layer.look?.intensity ?? 0.7 } })}
        />
        {layer.look && layer.look.preset !== "none" && (
          <SliderRow label="Amount" value={layer.look.intensity} min={0} max={1} step={0.01} format={pct} onChange={(intensity) => onChange({ look: { ...layer.look!, intensity } })} />
        )}
      </Section>

      <Section title="Adjust">
        <SliderRow label="Brightness" value={layer.brightness ?? 1} min={0.4} max={1.6} step={0.01} marks={[1]} format={pct} onChange={(brightness) => onChange({ brightness })} />
        <SliderRow label="Contrast" value={layer.contrast ?? 1} min={0.4} max={1.6} step={0.01} marks={[1]} format={pct} onChange={(contrast) => onChange({ contrast })} />
        <SliderRow label="Saturation" value={layer.saturation ?? 1} min={0} max={2} step={0.01} marks={[1]} format={pct} onChange={(saturation) => onChange({ saturation })} />
        <SliderRow label="Hue" value={layer.hue ?? 0} min={-180} max={180} step={1} marks={[0]} format={(v) => `${Math.round(v)}°`} onChange={(hue) => onChange({ hue })} />
        <SliderRow label="Blur" value={(layer.blur ?? 0) / MAX_ADJUSTMENT_BLUR} min={0} max={1} step={0.01} format={pct} onChange={(v) => onChange({ blur: v * MAX_ADJUSTMENT_BLUR })} />
        <SliderRow label="Vignette" value={layer.vignette ?? 0} min={0} max={1} step={0.01} format={pct} onChange={(vignette) => onChange({ vignette })} />
      </Section>

      <Section title="Where">
        <Segmented<"frame" | "rectangle" | "ellipse">
          value={region ? region.shape : "frame"}
          onChange={(v) => setRegion(v === "frame" ? null : { shape: v })}
          options={[
            { value: "frame", label: "Whole frame", title: "The whole picture" },
            { value: "rectangle", label: <span className="w-3.5 h-2.5 border-[1.5px] border-current" />, title: "A rectangle - drag it on the video" },
            { value: "ellipse", label: <span className="w-3.5 h-2.5 border-[1.5px] border-current rounded-full" />, title: "An ellipse - drag it on the video" },
          ]}
        />
        {region && (
          <>
            <SliderRow label="Soft edge" value={region.feather} min={0} max={1} step={0.01} format={pct} onChange={(feather) => setRegion({ feather })} />
            <LabeledRow label="Outside">
              <Switch on={region.invert} label="Apply everywhere except the area - blur or darken the background around a subject" onChange={(invert) => setRegion({ invert })} />
              <span className="text-white/40">{region.invert ? "everything but the area" : "inside the area"}</span>
            </LabeledRow>
            {(onTrackMotion || !!region.keyframes?.length) && (
              <TrackingBlock
                track={region.keyframes?.length ? region.track : undefined}
                onTrack={onTrackMotion}
                onRemove={() => setRegion({ keyframes: undefined, track: undefined })}
                keyframeCount={region.keyframes?.length ?? 0}
                span={span}
              />
            )}
            {!region.keyframes?.length && onTrackMotion && (
              <p className="text-[11px] leading-snug text-white/45">Follow a subject - a spotlight that stays on a speaker, a blur that stays on a face.</p>
            )}
          </>
        )}
        <LabeledRow label="Fill">
          <Switch
            on={!!layer.fill}
            label="Cover the area with a solid colour instead - mask out part of the video (inverted: everything around it)"
            onChange={(on) => onChange({ fill: on ? (layer.fill ?? "#000000") : undefined })}
          />
          {layer.fill ? <ColorSwatchPicker color={layer.fill} onChange={(fill) => onChange({ fill })} size="sm" /> : <span className="text-white/40">off</span>}
        </LabeledRow>
      </Section>

      <Section title="Strength">
        <SliderRow label="Mix" value={layer.opacity ?? 1} min={0} max={1} step={0.01} format={pct} onChange={(opacity) => onChange({ opacity })} />
        <SliderRow label="Fade in" value={layer.fadeIn ?? 0} min={0} max={Math.min(5, span / 2)} step={0.05} format={(v) => `${v.toFixed(1)}s`} onChange={(fadeIn) => onChange({ fadeIn })} />
        <SliderRow label="Fade out" value={layer.fadeOut ?? 0} min={0} max={Math.min(5, span / 2)} step={0.05} format={(v) => `${v.toFixed(1)}s`} onChange={(fadeOut) => onChange({ fadeOut })} />
      </Section>

      <TimingSection start={layer.startTime} end={layer.endTime} playhead={playhead} onSet={onSetTime} />
      <ActionBar onDuplicate={onDuplicate} onDelete={onDelete} />
    </>
  );
};
