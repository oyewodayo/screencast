// components/video/StageValuesPanel.tsx
//
// The scene panel's data side. Values: numbers that run with the scene's time (a clock, a battery,
// a score), each drawn as a curve you shape by dragging its keys or by typing a value at the
// playhead. And for the selected element: properties that follow a value, changes when a value
// crosses a threshold, the group it's laid out in, and how it arrives and leaves.
import React, { useEffect, useRef, useState } from "react";
import { IoAdd, IoArrowDown, IoArrowUp, IoTrashOutline } from "react-icons/io5";
import { Swatches, SliderRow } from "./OverlayDockedPanels";
import { IconButton, Section, Segmented, STAGE_INKS, Toggle, field } from "./StagePanelParts";
import type { KeyframeEasing } from "../../utils/keyframes";
import { StageChannel, StageValueFormat, channelValue, formatValue } from "../../utils/stage/stageChannels";
import {
  addChannel,
  bindProperty,
  deleteChannel,
  deleteChannelKey,
  displayValue,
  groupElement,
  moveChannelKey,
  moveInGroup,
  parseValue,
  renameChannel,
  setChannelFormat,
  setChannelKey,
  setConditions,
  setGroupLayout,
  setKeyEasing,
  ungroupElement,
} from "../../utils/stage/stageValues";
import { sceneDuration } from "../../utils/stage/stageEditing";
import type { StageBindableProp, StageCondition, StageElement, StageProps, StageScene } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;

const FORMATS: { value: StageValueFormat | "number"; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "pct", label: "Percent" },
  { value: "fixed1", label: "0.0" },
  { value: "fixed2", label: "0.00" },
  { value: "time", label: "Clock" },
  { value: "clock24", label: "24h" },
  { value: "duration", label: "Timer" },
];
const EASINGS: { value: KeyframeEasing; label: string; title: string }[] = [
  { value: "linear", label: "Even", title: "At an even rate to the next key" },
  { value: "ease", label: "Ease", title: "Easing out of this key and into the next" },
  { value: "ease-in", label: "In", title: "Starting slow, speeding up" },
  { value: "ease-out", label: "Out", title: "Starting fast, settling" },
  { value: "hold", label: "Hold", title: "Staying put until the next key, then jumping" },
];

// ---- A value's curve -----------------------------------------------------------------------------

const W = 280;
const H = 92;
const PAD = 8;

// The value over the scene's length: its keys as handles to drag (time and value), the playhead
// through it. Click to move the playhead there; double-click to add a key on the curve.
const ValueCurve: React.FC<{
  channel: StageChannel;
  duration: number;
  local: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onMove: (i: number, t: number, v: number) => void;
  onAdd: (t: number, v: number) => void;
  onSeek: (t: number) => void;
}> = ({ channel, duration, local, selected, onSelect, onMove, onAdd, onSeek }) => {
  const ref = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<null | { i: number; t: number; v: number }>(null);
  const keys = [...channel.keys].sort((a, b) => a.t - b.t);
  const shown = drag ? keys.map((k, i) => (i === drag.i ? { ...k, t: drag.t, value: drag.v } : k)) : keys;
  const span = Math.max(duration, shown[shown.length - 1]?.t ?? 0, 0.1);
  let lo = Math.min(...shown.map((k) => k.value));
  let hi = Math.max(...shown.map((k) => k.value));
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const x = (t: number) => PAD + (t / span) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const toT = (px: number) => Math.max(0, ((px - PAD) / (W - 2 * PAD)) * span);
  const toV = (py: number) => lo + ((H - PAD - py) / (H - 2 * PAD)) * (hi - lo);
  const local01 = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  };
  const preview: StageChannel = { ...channel, keys: shown };
  const path = Array.from({ length: 97 }, (_, i) => {
    const t = (i / 96) * span;
    return `${i ? "L" : "M"}${x(t).toFixed(1)},${y(channelValue(preview, t)).toFixed(1)}`;
  }).join("");
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-[92px] rounded-md bg-black/30 ring-1 ring-white/10 cursor-crosshair touch-none select-none"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget && (e.target as Element).getAttribute("data-key") === null) return;
        if (e.target === e.currentTarget) {
          onSelect(null);
          onSeek(toT(local01(e).px));
        }
      }}
      onDoubleClick={(e) => {
        const { px } = local01(e);
        const t = toT(px);
        onAdd(t, channelValue(channel, t));
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const { px, py } = local01(e);
        setDrag({ ...drag, t: Math.round(toT(px) * 30) / 30, v: toV(py) });
      }}
      onPointerUp={() => {
        if (drag) onMove(drag.i, drag.t, drag.v);
        setDrag(null);
      }}
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - 2 * PAD)} y2={PAD + f * (H - 2 * PAD)} stroke="white" strokeOpacity={0.05} />
      ))}
      <path d={path} fill="none" stroke="#5eead4" strokeWidth={1.6} strokeLinejoin="round" pointerEvents="none" />
      {local >= 0 && local <= span && <line x1={x(local)} x2={x(local)} y1={2} y2={H - 2} stroke="white" strokeOpacity={0.7} pointerEvents="none" />}
      {shown.map((k, i) => (
        <circle
          key={i}
          data-key={i}
          cx={x(k.t)}
          cy={y(k.value)}
          r={selected === i ? 5.5 : 4.5}
          fill={selected === i ? "#14b8a6" : "#0f172a"}
          stroke={selected === i ? "white" : "#5eead4"}
          strokeWidth={1.5}
          className="cursor-grab active:cursor-grabbing"
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
            onSelect(i);
            setDrag({ i, t: k.t, v: k.value });
          }}
        >
          <title>{`${k.t.toFixed(2)}s - ${formatValue(k.value, channel.format)}`}</title>
        </circle>
      ))}
    </svg>
  );
};

// A value input that reads and shows the value's own format (11:30 PM, 46%, 1:02:03).
const ValueInput: React.FC<{ value: number; format: StageValueFormat | undefined; onCommit: (v: number) => void; placeholder?: string; className?: string }> = ({ value, format, onCommit, placeholder, className }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseValue(draft, format);
    if (v !== null) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      value={draft ?? formatValue(value, format)}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(null);
      }}
      className={`${field} tabular-nums ${className ?? ""}`}
    />
  );
};

// ---- Values (scene) ------------------------------------------------------------------------------

export const ValuesSection: React.FC<{ scene: StageScene; local: number; onUpdate: Update; onSeekLocal: (t: number) => void }> = ({ scene, local, onUpdate, onSeekLocal }) => {
  const channels = scene.channels ?? [];
  const [open, setOpen] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  useEffect(() => setSelectedKey(null), [open]);
  const duration = sceneDuration(scene);
  const at = Math.max(0, Math.min(duration, local));
  return (
    <Section
      title="Values"
      aside={
        <IconButton
          title="Add a value - a number that runs with the scene: a clock, a battery level, a score"
          onClick={() => {
            const { scene: next, id } = addChannel(scene, `Value ${channels.length + 1}`, { duration });
            onUpdate(() => next);
            setOpen(id);
          }}
        >
          <IoAdd size={14} />
        </IconButton>
      }
    >
      {channels.length === 0 && (
        <span className="text-[11px] text-white/40 leading-snug">
          Numbers that change over the scene - a clock through the night, a draining battery, a rising score. Elements can follow one, show it live in their text, or change when it crosses a line.
        </span>
      )}
      {channels.map((c) => {
        const expanded = open === c.id;
        const keys = [...c.keys].sort((a, b) => a.t - b.t);
        const key = selectedKey !== null ? keys[selectedKey] : undefined;
        return (
          <div key={c.id} className={`flex flex-col gap-2 rounded-lg ${expanded ? "bg-white/[0.04] p-2 -mx-1" : ""}`}>
            <button type="button" onClick={() => setOpen(expanded ? null : c.id)} className="flex items-center gap-2 text-left text-[11px] text-white/80 hover:text-white">
              <span className="flex-1 truncate font-medium">{c.name ?? c.id}</span>
              <span className="tabular-nums text-teal-200">{displayValue(c, at)}</span>
            </button>
            {expanded && (
              <>
                <div className="flex gap-1.5">
                  <input
                    defaultValue={c.name ?? c.id}
                    key={c.name}
                    onBlur={(e) => {
                      const name = e.target.value;
                      let renamedTo = c.id;
                      onUpdate((s) => {
                        const r = renameChannel(s, c.id, name);
                        renamedTo = r.id;
                        return r.scene;
                      });
                      window.setTimeout(() => setOpen(renamedTo), 0);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                    title="Its name"
                    className={`${field} flex-1`}
                  />
                  <select
                    value={c.format ?? "number"}
                    onChange={(e) => onUpdate((s) => setChannelFormat(s, c.id, e.target.value === "number" ? undefined : (e.target.value as StageValueFormat)))}
                    title="How it reads - and how live text shows it"
                    className="rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 outline-none px-1.5 text-white text-[11px]"
                  >
                    {FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
                <ValueCurve
                  channel={c}
                  duration={duration}
                  local={local}
                  selected={selectedKey}
                  onSelect={setSelectedKey}
                  onMove={(i, t, v) => onUpdate((s) => moveChannelKey(s, c.id, i, t, v))}
                  onAdd={(t, v) => onUpdate((s) => setChannelKey(s, c.id, t, v))}
                  onSeek={onSeekLocal}
                />
                <label className="flex items-center gap-2 text-[11px] text-white/60">
                  <span className="shrink-0">At {at.toFixed(2)}s</span>
                  <ValueInput value={channelValue(c, at)} format={c.format} onCommit={(v) => onUpdate((s) => setChannelKey(s, c.id, at, v))} className="flex-1" />
                </label>
                <span className="-mt-1 text-[10px] text-white/35">Type a value to set it at the playhead. Drag keys on the curve; double-click to add one.</span>
                {key && selectedKey !== null && (
                  <div className="flex flex-col gap-1.5 pl-2 border-l border-teal-400/40">
                    <div className="flex items-center gap-1.5 text-[11px] text-white/60">
                      <span className="shrink-0">Key at {key.t.toFixed(2)}s</span>
                      <ValueInput value={key.value} format={c.format} onCommit={(v) => onUpdate((s) => moveChannelKey(s, c.id, selectedKey, key.t, v))} className="flex-1" />
                      <IconButton
                        title="Remove this key"
                        danger
                        disabled={keys.length <= 1}
                        onClick={() => {
                          onUpdate((s) => deleteChannelKey(s, c.id, selectedKey));
                          setSelectedKey(null);
                        }}
                      >
                        <IoTrashOutline size={12} />
                      </IconButton>
                    </div>
                    {selectedKey < keys.length - 1 && <Segmented value={key.easing ?? "linear"} onChange={(e) => onUpdate((s) => setKeyEasing(s, c.id, selectedKey, e))} options={EASINGS} />}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onUpdate((s) => deleteChannel(s, c.id));
                    setOpen(null);
                  }}
                  className="self-start flex items-center gap-1 text-[11px] text-white/40 hover:text-red-300"
                >
                  <IoTrashOutline size={11} /> Delete value
                </button>
              </>
            )}
          </div>
        );
      })}
    </Section>
  );
};

// ---- Following a value (element) ---------------------------------------------------------------

const BINDABLE: { prop: StageBindableProp; label: string; shapes?: boolean }[] = [
  { prop: "width", label: "Width" },
  { prop: "height", label: "Height" },
  { prop: "x", label: "Left" },
  { prop: "y", label: "Top" },
  { prop: "opacity", label: "Opacity" },
  { prop: "scale", label: "Scale" },
  { prop: "rotation", label: "Rotation" },
  // A ring's or pie's sweep following a value is a progress ring or a live pie chart.
  { prop: "sweep", label: "Sweep (ring, pie)", shapes: true },
  { prop: "inner", label: "Inner ratio", shapes: true },
  { prop: "radius", label: "Corners", shapes: true },
];

const NumberField: React.FC<{ value: number; onCommit: (v: number) => void; title?: string }> = ({ value, onCommit, title }) => {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      title={title}
      value={draft ?? String(Math.round(value * 100) / 100)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const v = Number(draft);
        if (draft !== null && Number.isFinite(v)) onCommit(v);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`${field} tabular-nums text-center px-1`}
    />
  );
};

export const FollowSection: React.FC<{ scene: StageScene; element: StageElement; here: StageProps; onUpdate: Update }> = ({ scene, element, here, onUpdate }) => {
  const channels = scene.channels ?? [];
  const bound = Object.entries(element.bind ?? {}) as [StageBindableProp, NonNullable<StageElement["bind"]>[StageBindableProp]][];
  const shaped = element.kind === "shape" || element.kind === "image";
  const free = BINDABLE.filter((b) => !element.bind?.[b.prop] && (!b.shapes || shaped));
  if (channels.length === 0 && bound.length === 0) return null;
  const range = (c: StageChannel): [number, number] => {
    const vs = c.keys.map((k) => k.value);
    return [Math.min(...vs), Math.max(...vs)];
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-white/60">Follows a value</span>
      {bound.map(([prop, b]) =>
        b ? (
          <div key={prop} className="flex flex-col gap-1.5 rounded-md bg-white/[0.04] p-2">
            <div className="flex items-center gap-1.5 text-[11px] text-white/70">
              <span className="font-medium text-white/85">{BINDABLE.find((x) => x.prop === prop)?.label}</span>
              <span>follows</span>
              <select
                value={b.channel}
                onChange={(e) => onUpdate((s) => bindProperty(s, element.id, prop, { ...b, channel: e.target.value }))}
                className="flex-1 min-w-0 rounded bg-black/30 ring-1 ring-white/10 outline-none px-1 py-0.5 text-white text-[11px]"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name ?? c.id}
                  </option>
                ))}
              </select>
              <IconButton title="Stop following" danger onClick={() => onUpdate((s) => bindProperty(s, element.id, prop, null))}>
                <IoTrashOutline size={12} />
              </IconButton>
            </div>
            <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-1 text-[10px] text-white/45">
              <span>value</span>
              <NumberField value={b.from[0]} onCommit={(v) => onUpdate((s) => bindProperty(s, element.id, prop, { ...b, from: [v, b.from[1]] }))} />
              <span>→</span>
              <NumberField value={b.to[0]} onCommit={(v) => onUpdate((s) => bindProperty(s, element.id, prop, { ...b, to: [v, b.to[1]] }))} />
              <span>value</span>
              <NumberField value={b.from[1]} onCommit={(v) => onUpdate((s) => bindProperty(s, element.id, prop, { ...b, from: [b.from[0], v] }))} />
              <span>→</span>
              <NumberField value={b.to[1]} onCommit={(v) => onUpdate((s) => bindProperty(s, element.id, prop, { ...b, to: [b.to[0], v] }))} />
            </div>
          </div>
        ) : null
      )}
      {channels.length > 0 && free.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const prop = e.target.value as StageBindableProp;
            if (!prop) return;
            const c = channels[0];
            const current = prop === "opacity" || prop === "scale" ? (here[prop] as number) || 1 : prop === "sweep" ? 360 : prop === "inner" ? 0.9 : (here[prop] as number) || 0;
            onUpdate((s) => bindProperty(s, element.id, prop, { channel: c.id, from: range(c), to: [0, current] }));
          }}
          title="Let a property follow a value: a bar's width tracking a level, an element moving with a score"
          className="rounded-md bg-white/[0.06] hover:bg-white/10 outline-none px-2 py-1.5 text-white/80 text-[11px] cursor-pointer"
        >
          <option value="">+ Make a property follow a value…</option>
          {free.map((b) => (
            <option key={b.prop} value={b.prop}>
              {b.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};

// ---- When a value crosses a line (element) -------------------------------------------------------

export const WhenSection: React.FC<{ scene: StageScene; element: StageElement; onUpdate: Update }> = ({ scene, element, onUpdate }) => {
  const channels = scene.channels ?? [];
  const rules = element.when ?? [];
  if (channels.length === 0 && rules.length === 0) return null;
  const set = (next: StageCondition[]) => onUpdate((s) => setConditions(s, element.id, next));
  const edit = (i: number, patch: Partial<StageCondition>) => set(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const editChanges = (i: number, patch: Partial<StageProps>) => {
    const changes = { ...rules[i].changes, ...patch };
    for (const k of Object.keys(changes) as (keyof StageProps)[]) if (changes[k] === undefined) delete changes[k];
    edit(i, { changes });
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-white/60">When a value crosses a line</span>
      {rules.map((r, i) => {
        const c = channels.find((x) => x.id === r.channel);
        const below = r.below !== undefined;
        return (
          <div key={i} className="flex flex-col gap-1.5 rounded-md bg-white/[0.04] p-2">
            <div className="flex items-center gap-1 text-[11px] text-white/70">
              <select value={r.channel} onChange={(e) => edit(i, { channel: e.target.value })} className="min-w-0 flex-1 rounded bg-black/30 ring-1 ring-white/10 outline-none px-1 py-0.5 text-white text-[11px]">
                {channels.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name ?? x.id}
                  </option>
                ))}
              </select>
              <select
                value={below ? "below" : "above"}
                onChange={(e) => {
                  const line = r.below ?? r.atOrAbove ?? 0;
                  edit(i, e.target.value === "below" ? { below: line, atOrAbove: undefined } : { atOrAbove: line, below: undefined });
                }}
                className="rounded bg-black/30 ring-1 ring-white/10 outline-none px-1 py-0.5 text-white text-[11px]"
              >
                <option value="below">is below</option>
                <option value="above">reaches</option>
              </select>
              <ValueInput value={r.below ?? r.atOrAbove ?? 0} format={c?.format} onCommit={(v) => edit(i, below ? { below: v } : { atOrAbove: v })} className="w-20 py-0.5" />
              <IconButton title="Remove this rule" danger onClick={() => set(rules.filter((_, j) => j !== i))}>
                <IoTrashOutline size={12} />
              </IconButton>
            </div>
            <Toggle label="Change colour" value={r.changes.color !== undefined} onChange={(v) => editChanges(i, { color: v ? "#ef4444" : undefined })} />
            {r.changes.color !== undefined && <Swatches colors={STAGE_INKS} value={r.changes.color} onPick={(col) => col && editChanges(i, { color: col })} custom />}
            <Toggle label="Change opacity" value={r.changes.opacity !== undefined} onChange={(v) => editChanges(i, { opacity: v ? 0.4 : undefined })} />
            {r.changes.opacity !== undefined && <SliderRow label="Opacity" value={r.changes.opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => editChanges(i, { opacity: v })} />}
            {element.kind === "text" && <Toggle label="Change the words" value={r.changes.text !== undefined} onChange={(v) => editChanges(i, { text: v ? element.props.text ?? "" : undefined })} />}
            {element.kind === "text" && r.changes.text !== undefined && (
              <input
                defaultValue={r.changes.text}
                onBlur={(e) => editChanges(i, { text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className={field}
              />
            )}
          </div>
        );
      })}
      {channels.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const c = channels[0];
            const vs = c.keys.map((k) => k.value);
            set([...rules, { channel: c.id, below: (Math.min(...vs) + Math.max(...vs)) / 2, changes: { color: "#ef4444" } }]);
          }}
          title="Change this element when a value crosses a line: turn red below 20%, show a message once the clock passes 3:10"
          className="flex items-center justify-center gap-1 rounded-md bg-white/[0.06] hover:bg-white/10 px-2 py-1.5 text-[11px] text-white/80"
        >
          <IoAdd size={12} /> Add a rule
        </button>
      )}
    </div>
  );
};

// ---- Group (element) -----------------------------------------------------------------------------

export const GroupSection: React.FC<{ scene: StageScene; element: StageElement; at?: { x: number; y: number }; onUpdate: Update; onSelect: (id: string | null) => void }> = ({ scene, element, at, onUpdate, onSelect }) => {
  const groups = scene.elements.filter((e) => e.kind === "stack" && e.id !== element.id);
  const groupName = (g: StageElement) => g.name ?? `${g.stack?.direction === "row" ? "Row" : "Column"} ${groups.indexOf(g) + 1}`;
  if (element.kind === "stack" && element.stack) {
    const st = element.stack;
    const update = (patch: Partial<typeof st>) => onUpdate((s) => setGroupLayout(s, element.id, patch));
    return (
      <div className="flex flex-col gap-2">
        <span className="text-[11px] text-white/60">Lays out what's in it</span>
        <Segmented value={st.direction} onChange={(d) => update({ direction: d })} options={[{ value: "column", label: "Column" }, { value: "row", label: "Row" }]} />
        <SliderRow label="Gap" value={st.gap} min={0} max={200} step={1} format={(v) => `${Math.round(v)}`} reset={24} onChange={(v) => update({ gap: v })} />
        <Segmented
          value={st.align}
          onChange={(a) => update({ align: a })}
          options={[
            { value: "start", label: st.direction === "column" ? "Left" : "Top", title: "Lined up along the start" },
            { value: "center", label: "Middle", title: "Centred across" },
            { value: "end", label: st.direction === "column" ? "Right" : "Bottom", title: "Lined up along the end" },
          ]}
        />
        <span className="text-[10px] text-white/35">Hidden elements take no room - the others close up and make space as they arrive.</span>
      </div>
    );
  }
  const parent = element.parent ? scene.elements.find((e) => e.id === element.parent) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] text-white/60">Group</span>
      {parent ? (
        <div className="flex items-center gap-1.5 text-[11px] text-white/70">
          <button type="button" onClick={() => onSelect(parent.id)} className="flex-1 truncate text-left hover:text-white" title="Select the group to set its layout">
            In {groupName(parent)}
          </button>
          <IconButton title="Earlier in the group" onClick={() => onUpdate((s) => moveInGroup(s, element.id, -1))}>
            <IoArrowUp size={12} />
          </IconButton>
          <IconButton title="Later in the group" onClick={() => onUpdate((s) => moveInGroup(s, element.id, 1))}>
            <IoArrowDown size={12} />
          </IconButton>
          <button type="button" onClick={() => onUpdate((s) => ungroupElement(s, element.id, at))} className="rounded-md bg-white/[0.06] hover:bg-white/10 px-2 py-1 text-[11px] text-white/80">
            Leave
          </button>
        </div>
      ) : (
        <select
          value=""
          onChange={(e) => {
            const target = e.target.value;
            if (!target) return;
            onUpdate((s) => groupElement(s, element.id, target as "new-column").scene);
          }}
          title="Lay it out with others: a list that grows a row at a time, a row of icons"
          className="rounded-md bg-white/[0.06] hover:bg-white/10 outline-none px-2 py-1.5 text-white/80 text-[11px] cursor-pointer"
        >
          <option value="">Not in a group - put it in…</option>
          <option value="new-column">A new column</option>
          <option value="new-row">A new row</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {groupName(g)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};


