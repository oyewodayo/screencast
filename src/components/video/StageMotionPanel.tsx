// components/video/StageMotionPanel.tsx
//
// How an element moves: how it arrives and leaves (24 styles - moves, scales, turns in 2D and 3D,
// wipes - each previewed on hover as it really moves), its spring, the loops it keeps doing by
// itself (pulse, float, spin...: each previewed live from the same maths the stage runs), the
// route it takes into this beat (straight, or bent into an arc, optionally turning along it), and
// for text, how it's revealed - letter by letter, word by word or line by line, in a style.
import React, { useRef } from "react";
import { IoAdd, IoTrashOutline } from "react-icons/io5";
import { SliderRow } from "./OverlayDockedPanels";
import { IconButton, Segmented, Toggle } from "./StagePanelParts";
import { LOOP_INFO, loopsAt } from "../../utils/stage/stageLoops";
import { TRANSITION_PRESETS, TransitionPreset, presetsFor, setElementSpring, setLoops, setPath, setTextReveal, setTransition, transitionPresetOf } from "../../utils/stage/stageValues";
import { elementInBeat } from "../../utils/stage/stageEditing";
import type { SpringPreset } from "../../utils/stage/springs";
import type { StageElement, StageLoop, StageLoopKind, StageProps, StageScene, StageTextReveal, StageTransitionStyle } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;

const MOTION_CHOICES: { value: SpringPreset | "scene"; label: string }[] = [
  { value: "scene", label: "Scene's" },
  { value: "slow", label: "Slow" },
  { value: "gentle", label: "Gentle" },
  { value: "smooth", label: "Smooth" },
  { value: "snappy", label: "Snappy" },
  { value: "bouncy", label: "Bouncy" },
];

// A transition as CSS keyframes for its preview chip (k: stage units to chip px).
function previewFrames(style: Partial<StageTransitionStyle>, leaving: boolean): Keyframe[] {
  const k = 0.12;
  const wipes: Record<string, [string, string]> = {
    right: ["inset(0 100% 0 0)", "inset(0 0 0 0)"],
    left: ["inset(0 0 0 100%)", "inset(0 0 0 0)"],
    up: ["inset(100% 0 0 0)", "inset(0 0 0 0)"],
    down: ["inset(0 0 100% 0)", "inset(0 0 0 0)"],
    centre: ["inset(0 50% 0 50%)", "inset(0 0 0 0)"],
  };
  const away: Keyframe = {
    transform: `perspective(60px) translate(${(style.dx ?? 0) * k}px, ${(style.dy ?? 0) * k}px) scale(${style.scale ?? 1}) rotate(${style.rotate ?? 0}deg) rotateX(${style.rotateX ?? 0}deg) rotateY(${style.rotateY ?? 0}deg)`,
    filter: `blur(${(style.blur ?? 0) * k * 0.6}px)`,
    opacity: style.opacity ?? 0,
    clipPath: style.wipe ? wipes[style.wipe][0] : "inset(0 0 0 0)",
  };
  const here: Keyframe = { transform: "perspective(60px) translate(0px, 0px) scale(1) rotate(0deg) rotateX(0deg) rotateY(0deg)", filter: "blur(0px)", opacity: 1, clipPath: "inset(0 0 0 0)" };
  return leaving ? [here, here, away, away] : [away, here, here, here];
}

const PresetChip: React.FC<{ id: TransitionPreset | "default"; label: string; style: Partial<StageTransitionStyle>; leaving: boolean; active: boolean; onPick: () => void }> = ({ label, style, leaving, active, onPick }) => {
  const box = useRef<HTMLSpanElement>(null);
  const anim = useRef<Animation | null>(null);
  return (
    <button
      type="button"
      title={label}
      onClick={onPick}
      onMouseEnter={() => {
        if (!box.current || typeof box.current.animate !== "function") return;
        anim.current = box.current.animate(previewFrames(style, leaving), { duration: 1300, iterations: Infinity, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      }}
      onMouseLeave={() => {
        anim.current?.cancel();
        anim.current = null;
      }}
      className={`h-12 flex flex-col items-center justify-center gap-1 rounded-md text-[9.5px] leading-none transition-colors ${active ? "bg-teal-500 text-white" : "bg-white/[0.05] text-white/70 hover:bg-white/10 hover:text-white"}`}
    >
      <span className="w-7 h-5 flex items-center justify-center overflow-hidden">
        <span ref={box} className={`block w-4 h-3 rounded-[2px] ${active ? "bg-white" : "bg-teal-300"}`} />
      </span>
      <span className="truncate max-w-full px-0.5">{label}</span>
    </button>
  );
};

const TransitionPicker: React.FC<{ element: StageElement; which: "enter" | "exit"; onUpdate: Update }> = ({ element, which, onUpdate }) => {
  const current = transitionPresetOf(element[which]);
  const presets = presetsFor(element.kind);
  const defaultStyle = which === "enter" ? TRANSITION_PRESETS[0].style : TRANSITION_PRESETS.find((p) => p.id === "blur")!.style;
  return (
    <div className="grid grid-cols-5 gap-1">
      <PresetChip id="default" label={which === "enter" ? "Rise ·default" : "Blur ·default"} style={defaultStyle} leaving={which === "exit"} active={current === null} onPick={() => onUpdate((s) => setTransition(s, element.id, which, null))} />
      {presets.map((p) => (
        <PresetChip key={p.id} id={p.id} label={p.label} style={p.style} leaving={which === "exit"} active={current === p.id} onPick={() => onUpdate((s) => setTransition(s, element.id, which, p.id))} />
      ))}
    </div>
  );
};

// A loop's preview: sampled from loopsAt over a cycle, played on hover.
const LoopChip: React.FC<{ kind: StageLoopKind; onPick: () => void }> = ({ kind, onPick }) => {
  const box = useRef<HTMLSpanElement>(null);
  const anim = useRef<Animation | null>(null);
  const info = LOOP_INFO[kind];
  return (
    <button
      type="button"
      title={info.hint}
      onClick={onPick}
      onMouseEnter={() => {
        if (!box.current || typeof box.current.animate !== "function") return;
        const period = info.period.default;
        const frames: Keyframe[] = [];
        // Well into a run that started long ago - no ease-in - over one cycle.
        for (let i = 0; i <= 24; i++) {
          const { delta } = loopsAt([{ kind }], 100 + (i / 24) * period, [0], Infinity);
          const k = 0.35;
          frames.push({ transform: `perspective(60px) translate(${delta.dx * k}px, ${delta.dy * k}px) rotate(${delta.rotation}deg) rotateY(${delta.rotateY}deg) scale(${delta.scale})`, opacity: delta.opacity });
        }
        anim.current = box.current.animate(frames, { duration: period * 1000, iterations: Infinity });
      }}
      onMouseLeave={() => {
        anim.current?.cancel();
        anim.current = null;
      }}
      className="h-12 flex flex-col items-center justify-center gap-1 rounded-md bg-white/[0.05] text-[9.5px] leading-none text-white/70 hover:bg-white/10 hover:text-white"
    >
      <span className="w-7 h-5 flex items-center justify-center">
        <span ref={box} className="block w-3.5 h-3.5 rounded-[3px] bg-amber-300" />
      </span>
      <span className="truncate max-w-full px-0.5">{info.label}</span>
    </button>
  );
};

const LoopsSection: React.FC<{ scene: StageScene; element: StageElement; onUpdate: Update }> = ({ scene, element, onUpdate }) => {
  const loops = element.loops ?? [];
  const set = (next: StageLoop[]) => onUpdate((s) => setLoops(s, element.id, next));
  const edit = (i: number, patch: Partial<StageLoop>) => set(loops.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const beats = scene.beats.length;
  const [adding, setAdding] = React.useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <span className="flex-1 text-[11px] text-white/60">Keeps moving</span>
        <button type="button" onClick={() => setAdding((a) => !a)} className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${adding ? "bg-teal-500/30 text-white" : "text-teal-200 hover:bg-white/10"}`}>
          <IoAdd size={12} /> Loop
        </button>
      </div>
      {adding && (
        <div className="grid grid-cols-4 gap-1">
          {(Object.keys(LOOP_INFO) as StageLoopKind[]).map((k) => (
            <LoopChip
              key={k}
              kind={k}
              onPick={() => {
                set([...loops, { kind: k }]);
                setAdding(false);
              }}
            />
          ))}
        </div>
      )}
      {loops.length === 0 && !adding && <span className="text-[10px] text-white/35">A pulse, a float, a slow spin - motion it keeps up by itself while it's shown, over the beats you choose.</span>}
      {loops.map((l, i) => {
        const info = LOOP_INFO[l.kind];
        const a = info.amount;
        return (
          <div key={i} className="flex flex-col gap-1 rounded-md bg-white/[0.04] p-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="flex-1 font-medium text-white/85">{info.label}</span>
              <IconButton title="Stop this loop" danger onClick={() => set(loops.filter((_, j) => j !== i))}>
                <IoTrashOutline size={12} />
              </IconButton>
            </div>
            {l.kind === "spin" ? (
              <Segmented
                value={(l.amount ?? 1) < 0 ? "ccw" : "cw"}
                onChange={(v) => edit(i, { amount: v === "ccw" ? -1 : 1 })}
                options={[
                  { value: "cw", label: "Clockwise" },
                  { value: "ccw", label: "Anticlockwise" },
                ]}
              />
            ) : (
              <SliderRow label={a.label} value={l.amount ?? a.default} min={a.min} max={a.max} step={a.step} format={(v) => `${Math.round(v)}${a.unit}`} reset={a.default} onChange={(v) => edit(i, { amount: v })} />
            )}
            <SliderRow label="Cycle" value={l.period ?? info.period.default} min={info.period.min} max={info.period.max} step={0.05} format={(v) => `${v.toFixed(2)}s`} reset={info.period.default} onChange={(v) => edit(i, { period: v })} />
            {beats > 1 && (
              <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1 text-[10px] text-white/45">
                <span>from</span>
                <select value={l.from ?? 0} onChange={(e) => edit(i, { from: Number(e.target.value) || undefined })} className="min-w-0 rounded bg-black/30 ring-1 ring-white/10 px-1 py-0.5 text-white text-[11px] outline-none">
                  {scene.beats.map((_, b) => (
                    <option key={b} value={b}>
                      beat {b + 1}
                    </option>
                  ))}
                </select>
                <span>until</span>
                <select value={l.until ?? -1} onChange={(e) => edit(i, { until: Number(e.target.value) < 0 ? undefined : Number(e.target.value) })} className="min-w-0 rounded bg-black/30 ring-1 ring-white/10 px-1 py-0.5 text-white text-[11px] outline-none">
                  <option value={-1}>the end</option>
                  {scene.beats.map((_, b) =>
                    b > (l.from ?? 0) ? (
                      <option key={b} value={b}>
                        beat {b + 1}
                      </option>
                    ) : null
                  )}
                </select>
              </div>
            )}
            <SliderRow label="Offset" value={Math.round((l.phase ?? 0) * 100)} min={0} max={100} step={1} format={(v) => `${Math.round(v)}%`} reset={0} onChange={(v) => edit(i, { phase: v / 100 || undefined })} />
          </div>
        );
      })}
    </div>
  );
};

// The route into this beat - shown when it moves in this beat.
const PathSection: React.FC<{ scene: StageScene; beat: number; element: StageElement; here: StageProps; onUpdate: Update }> = ({ scene, beat, element, here, onUpdate }) => {
  if (beat === 0) return null;
  const before = elementInBeat(scene, beat - 1, element.id);
  if (!before || !before.visible || !here.visible || Math.hypot(before.x - here.x, before.y - here.y) < 1) return null;
  const path = scene.beats[beat].paths?.[element.id];
  const set = (p: { bend: number; orient?: boolean } | null) => onUpdate((s) => setPath(s, beat, element.id, p));
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-white/60">Route into beat {beat + 1}</span>
      <Segmented
        value={!path ? "straight" : path.bend > 0 ? "over" : "under"}
        onChange={(v) => set(v === "straight" ? null : { bend: v === "over" ? Math.abs(path?.bend ?? 0.3) : -Math.abs(path?.bend ?? 0.3), orient: path?.orient })}
        options={[
          { value: "straight", label: "Straight" },
          { value: "over", label: "Arc ⌒", title: "Curving up and over (to the left of where it's heading)" },
          { value: "under", label: "Arc ⌣", title: "Curving down and under" },
        ]}
      />
      {path && (
        <>
          <SliderRow label="Bend" value={Math.round(Math.abs(path.bend) * 100)} min={5} max={100} step={1} format={(v) => `${Math.round(v)}%`} onChange={(v) => set({ ...path, bend: (Math.sign(path.bend) || 1) * (v / 100) })} />
          <Toggle label="Tilt into the curve" value={!!path.orient} onChange={(v) => set({ ...path, orient: v || undefined })} title="Lean along the arc as it travels, level again where it lands" />
          <span className="-mt-1 text-[10px] text-white/35">Or drag the handle on the arc on the stage.</span>
        </>
      )}
    </div>
  );
};

const REVEAL_STYLES: { value: StageTextReveal["style"]; label: string }[] = [
  { value: "rise", label: "Rise" },
  { value: "fade", label: "Fade" },
  { value: "type", label: "Type" },
  { value: "pop", label: "Pop" },
  { value: "zoom", label: "Zoom" },
  { value: "blur", label: "Blur" },
  { value: "drop", label: "Drop" },
  { value: "slide", label: "Slide" },
];

const RevealSection: React.FC<{ element: StageElement; onUpdate: Update }> = ({ element, onUpdate }) => {
  if (element.kind !== "text") return null;
  const r = element.textReveal;
  const set = (next: StageTextReveal | undefined) => onUpdate((s) => setTextReveal(s, element.id, next));
  const defaultStagger = { letter: 0.035, word: 0.09, line: 0.18 };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-white/60">Reveal</span>
      <Segmented
        value={r?.by ?? "whole"}
        onChange={(v) => set(v === "whole" ? undefined : { style: r?.style ?? (v === "letter" ? "rise" : "rise"), ...r, by: v, stagger: undefined })}
        options={[
          { value: "whole", label: "Whole" },
          { value: "letter", label: "Letters" },
          { value: "word", label: "Words" },
          { value: "line", label: "Lines" },
        ]}
      />
      {r && (
        <>
          <div className="grid grid-cols-4 gap-1">
            {REVEAL_STYLES.map((st) => (
              <button key={st.value} type="button" onClick={() => set({ ...r, style: st.value })} className={`rounded-md py-1 text-[11px] ${r.style === st.value ? "bg-teal-500 text-white" : "bg-white/[0.05] text-white/70 hover:bg-white/10"}`}>
                {st.label}
              </button>
            ))}
          </div>
          <SliderRow label="Between" value={Math.round((r.stagger ?? defaultStagger[r.by]) * 1000)} min={5} max={600} step={5} format={(v) => `${Math.round(v)}ms`} reset={defaultStagger[r.by] * 1000} onChange={(v) => set({ ...r, stagger: v / 1000 })} />
          <Toggle label="Leaves the same way" value={!!r.exit} onChange={(v) => set({ ...r, exit: v || undefined })} title="When it's hidden, its letters, words or lines go one by one too" />
        </>
      )}
    </div>
  );
};

export const MotionSection: React.FC<{ scene: StageScene; beat: number; element: StageElement; here: StageProps; onUpdate: Update }> = ({ scene, beat, element, here, onUpdate }) => {
  if (element.kind === "stack" || element.kind === "connector") return null;
  return (
    <div className="flex flex-col gap-3">
      <RevealSection element={element} onUpdate={onUpdate} />
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-white/60">Arrives</span>
        {element.textReveal ? <span className="text-[10px] text-white/35">Unit by unit, as its reveal above sets.</span> : <TransitionPicker element={element} which="enter" onUpdate={onUpdate} />}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-white/60">Leaves</span>
        {element.textReveal?.exit ? <span className="text-[10px] text-white/35">It leaves the way it was revealed.</span> : <TransitionPicker element={element} which="exit" onUpdate={onUpdate} />}
      </div>
      <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-2 text-[11px] text-white/60">
        <span>Motion</span>
        <select
          value={element.spring ?? "scene"}
          onChange={(e) => onUpdate((s) => setElementSpring(s, element.id, e.target.value === "scene" ? undefined : (e.target.value as SpringPreset)))}
          className="flex-1 min-w-0 rounded bg-black/30 ring-1 ring-white/10 outline-none px-1.5 py-1 text-white text-[11px]"
        >
          {MOTION_CHOICES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <PathSection scene={scene} beat={beat} element={element} here={here} onUpdate={onUpdate} />
      <LoopsSection scene={scene} element={element} onUpdate={onUpdate} />
    </div>
  );
};
