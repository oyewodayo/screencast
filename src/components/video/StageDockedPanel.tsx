// components/video/StageDockedPanel.tsx
//
// The selected Stage scene's panel (StageLayer's "controls"): its beats - a strip as long as each
// one holds, the playhead running through it; pick one to park the playhead where it's at rest - its
// elements, the selected element as it is in the beat under the playhead, and the scene's look and
// motion. Edits made "in a beat" carry forward to the beats after it until one of them changes the
// same thing (stageEditing.ts); a face, size or alignment is the element's own, the same in every
// beat.
import React, { useEffect, useState } from "react";
import { IoAdd, IoCopyOutline, IoEllipsisHorizontal, IoEyeOffOutline, IoEyeOutline, IoFolderOutline, IoImageOutline, IoShapesOutline, IoSquareOutline, IoText, IoTrashOutline } from "react-icons/io5";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import { loadStageImage } from "../../utils/stage/stageImages";
import { parseStageColor } from "../../utils/stage/stageColor";
import { MdFormatAlignCenter, MdFormatAlignLeft, MdFormatAlignRight } from "react-icons/md";
import { STICKER_ICONS, StickerIcon, drawStickerIcon, searchIcons } from "../../utils/stickerIcons";
import { FontSection, SliderRow, Swatches } from "./OverlayDockedPanels";
import { IconButton, Section, Segmented, STAGE_INKS, Toggle, field } from "./StagePanelParts";
import { FollowSection, GroupSection, ValuesSection, WhenSection } from "./StageValuesPanel";
import { MotionSection } from "./StageMotionPanel";
import { MathEditor } from "./StageMathPanel";
import { GraphEditor } from "./StageGraphPanel";
import { ArrangeSection } from "./StageArrangePanel";
import { ShapeGallery, ShapeSection } from "./StageShapePanel";
import type { ShapePreset } from "../../utils/stage/stageShapes";
import { valueToken } from "../../utils/stage/stageValues";
import {
  addBeat,
  addElement,
  beatIndexAt,
  beatRestTime,
  duplicateElement,
  renameElement,
  beatStarts,
  deleteBeat,
  deleteElement,
  elementInBeat,
  makeConnectorElement,
  makeIconElement,
  makeImageElement,
  makeMathElement,
  makeGraphElement,
  reinkScene,
  makeShapeElement,
  makeTextElement,
  sceneDuration,
  setBeatHold,
  setElementProps,
} from "../../utils/stage/stageEditing";
import { STAGE_HEIGHT, StageConnector, StageElement, StageScene, StageTextLook } from "../../utils/stage/stageTypes";
import type { SpringPreset } from "../../utils/stage/springs";

interface Props {
  scene: StageScene;
  // The beat under the playhead - what the element settings show and change.
  beat: number;
  playhead: number;
  selectedElementId: string | null;
  onSelectElement: (id: string | null) => void;
  onUpdate: (edit: (s: StageScene) => StageScene) => void;
  onSeek: (t: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  // What's on the stage now (stage units) - new elements are placed clear of it.
  occupied?: { id?: string; x: number; y: number; width: number; height: number }[];
}

const STAGE_BACKGROUNDS = [undefined, "#f2f1ee", "#ffffff", "#e8e8e6", "#111111", "#0b1020", "#1e3a8a"];
const MOTIONS: { value: SpringPreset; label: string; title: string }[] = [
  { value: "slow", label: "Slow", title: "A long, even settle" },
  { value: "gentle", label: "Gentle", title: "Unhurried, no overshoot" },
  { value: "smooth", label: "Smooth", title: "Quick, with the faintest settle" },
  { value: "snappy", label: "Snappy", title: "Fast and crisp" },
  { value: "bouncy", label: "Bouncy", title: "A visible overshoot and settle" },
];


function label(e: StageElement, scene: StageScene): string {
  if (e.name) return e.name;
  if (e.kind === "text") return (e.props.text ?? "Text").slice(0, 28) || "Text";
  if (e.kind === "shape") return "Shape";
  if (e.kind === "math") return `Equation${e.props.text ? ` · ${e.props.text.slice(0, 18)}` : ""}`;
  if (e.kind === "graph") {
    const f = e.props.graph?.series.find((s) => s.kind === "function")?.expr;
    return `Graph${f ? ` · ${f.slice(0, 18)}` : ""}`;
  }
  if (e.kind === "image") return e.image?.src.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Picture";
  if (e.kind === "icon") return STICKER_ICONS.find((i) => i.value === e.icon?.name)?.label ?? "Icon";
  if (e.kind === "connector") {
    const end = (id: string | undefined) => {
      const x = scene.elements.find((el) => el.id === id);
      return x ? label(x, scene).slice(0, 14) : "?";
    };
    return `${end(e.connector?.from)} → ${end(e.connector?.to)}`;
  }
  // A group is known by what's in it.
  const firstText = (id: string): StageElement | undefined => {
    for (const x of scene.elements.filter((k) => k.parent === id)) {
      const found = x.kind === "text" ? x : x.kind === "stack" ? firstText(x.id) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const named = firstText(e.id);
  return named ? `Group · ${label(named, scene)}` : "Group";
}

// An icon drawn as it will be on the stage (white on the panel), sharp at the screen's density.
const IconThumb: React.FC<{ name: string; size?: number }> = ({ name, size = 20 }) => {
  const ref = React.useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = Math.round(size * dpr);
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawStickerIcon(ctx, name as StickerIcon, c.width / 2, c.height / 2, c.width * 0.9, "#ffffff");
  }, [name, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} />;
};

// A tiny axes-and-curve mark for graphs.
const GraphGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 2v12h12" />
    <path d="M4 11c2-6 4-6 5-3s2 3 5-4" />
  </svg>
);

const KindIcon: React.FC<{ e: StageElement }> = ({ e }) => {
  if (e.kind === "text") return <IoText size={12} />;
  if (e.kind === "math") return <span className="text-[12px] leading-none font-serif">∑</span>;
  if (e.kind === "graph") return <GraphGlyph size={12} />;
  if (e.kind === "icon") return <IconThumb name={e.icon?.name ?? "star"} size={12} />;
  if (e.kind === "connector") return <IoEllipsisHorizontal size={12} />;
  if (e.kind === "stack") return <IoFolderOutline size={12} />;
  if (e.kind === "image") return <IoImageOutline size={12} />;
  return <IoSquareOutline size={12} />;
};

// The beats as one bar, each as wide as it holds; the playhead runs through it.
const BeatStrip: React.FC<{ scene: StageScene; beat: number; local: number; onPick: (i: number) => void; onAdd: () => void }> = ({ scene, beat, local, onPick, onAdd }) => {
  const total = Math.max(0.001, sceneDuration(scene));
  const starts = beatStarts(scene);
  const inside = local >= 0 && local <= total;
  return (
    <div className="flex items-stretch gap-1.5">
      <div className="relative flex-1 flex gap-0.5 h-9 rounded-lg bg-white/[0.06] p-0.5">
        {scene.beats.map((b, i) => (
          <button
            key={b.id}
            type="button"
            title={`Beat ${i + 1} - holds ${b.hold.toFixed(1)}s. Click to see it at rest.`}
            onClick={() => onPick(i)}
            style={{ flexGrow: Math.max(b.hold, 0.05), flexBasis: 0 }}
            className={`min-w-[22px] flex flex-col items-center justify-center rounded-md overflow-hidden leading-none transition-colors ${i === beat ? "bg-teal-500 text-white" : "bg-white/[0.04] text-white/60 hover:bg-white/10 hover:text-white"}`}
          >
            <span className="text-[11px] font-semibold">{i + 1}</span>
            <span className={`text-[9px] mt-0.5 ${i === beat ? "text-white/80" : "text-white/35"}`}>{b.hold.toFixed(1)}s</span>
          </button>
        ))}
        {inside && (
          <span
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
            style={{ left: `calc(2px + (100% - 4px) * ${local / total})` }}
          />
        )}
        {starts.length === 0 && <span className="text-[11px] text-white/40 m-auto">No beats</span>}
      </div>
      <button type="button" title="Add the next beat - it starts out like this one; change what should change" onClick={onAdd} className="w-9 rounded-lg bg-white/[0.06] hover:bg-teal-500/30 text-white/80 flex items-center justify-center">
        <IoAdd size={16} />
      </button>
    </div>
  );
};

const StageDockedPanel: React.FC<Props> = ({ scene, beat, playhead, selectedElementId, onSelectElement, onUpdate, onSeek, onDuplicate, onDelete, occupied = [] }) => {
  const element = scene.elements.find((e) => e.id === selectedElementId) ?? null;
  const here = element ? elementInBeat(scene, beat, element.id) : null;
  // Typing edits a draft; it lands in the scene when the field is left (or on Enter), so a word
  // isn't recompiled letter by letter.
  const [draft, setDraft] = useState<string | null>(null);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(null), [selectedElementId, beat]);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  useEffect(() => setNameDraft(null), [scene.id]);
  const [iconQuery, setIconQuery] = useState("");
  // 3D settings stay folded away until asked for, or while the element already uses them.
  const [show3d, setShow3d] = useState(false);
  const in3d = !!here && (!!here.rotateX || !!here.rotateY || !!here.z);

  const inBeat = (patch: Parameters<typeof setElementProps>[3]) => element && onUpdate((s) => setElementProps(s, beat, element.id, patch));
  const own = (edit: (e: StageElement) => StageElement) => element && onUpdate((s) => ({ ...s, elements: s.elements.map((e) => (e.id === element.id ? edit(e) : e)) }));
  const look = (patch: Partial<StageTextLook>) => own((e) => ({ ...e, textLook: { ...(e.textLook ?? { fontSize: 44 }), ...patch } }));
  const line = (patch: Partial<StageConnector>) => own((e) => (e.connector ? { ...e, connector: { ...e.connector, ...patch } } : e));
  const commitDraft = () => {
    if (draft !== null && here && draft !== here.text) inBeat({ text: draft });
    setDraft(null);
  };
  const commitName = () => {
    if (nameDraft !== null) onUpdate((s) => ({ ...s, name: nameDraft.trim() || undefined }));
    setNameDraft(null);
  };
  const toggleShown = (id: string) => onUpdate((s) => setElementProps(s, beat, id, { visible: !elementInBeat(s, beat, id)?.visible }));

  // What's being chosen before it's placed: an icon from the set, or a shape's form.
  const [adding, setAdding] = useState<null | "icon" | "shape">(null);
  useEffect(() => setAdding(null), [scene.id]);
  // Ink that reads on the scene's background: dark on a light one, light on a dark one or on video.
  const bg = scene.background.kind === "color" ? parseStageColor(scene.background.color) : null;
  const lightBg = !!bg && (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 > 0.55;
  const ink = lightBg ? "#111111" : "#f5f5f4";
  // A spot clear of what's on the stage: the centre if it's free, else the nearest free one around
  // it (below, above, beside, the corners), inside the frame. With nowhere free, the centre, stepped
  // past anything placed there before.
  const placeAt = (w: number, h: number, shrink = false): { x: number; y: number; scale: number } => {
    const cx = scene.width / 2 - w / 2;
    const cy = STAGE_HEIGHT / 2 - h / 2;
    const margin = 24;
    // Off the scene nothing is on screen to go by - its elements' own places in this beat instead.
    const taken = occupied.length
      ? occupied
      : scene.elements
          .filter((e) => !e.parent && e.kind !== "stack" && e.kind !== "connector")
          .map((e) => elementInBeat(scene, beat, e.id))
          .filter((p): p is NonNullable<typeof p> => !!p && p.visible);
    const clear = (x: number, y: number) =>
      x >= margin && y >= margin && x + w <= scene.width - margin && y + h <= STAGE_HEIGHT - margin &&
      !taken.some((o) => x < o.x + o.width + margin && x + w + margin > o.x && y < o.y + o.height + margin && y + h + margin > o.y);
    const steps = [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1], [0, 2], [0, -2], [2, 0], [-2, 0]];
    for (const [i, j] of steps) {
      const x = Math.round(cx + i * (w + margin * 2));
      const y = Math.round(cy + j * (h + margin * 2));
      if (clear(x, y)) return { x, y, scale: 1 };
    }
    // Something big (a graph) would rather be smaller than sit on what's there: the largest size,
    // down to half, that fits a clear spot - searched across the frame, nearest the centre first.
    if (shrink && taken.length) {
      for (let scale = 0.92; scale >= 0.5; scale -= 0.04) {
        const sw = w * scale;
        const sh = h * scale;
        let found: { x: number; y: number; d: number } | null = null;
        for (let gx = 0; gx <= 16; gx++)
          for (let gy = 0; gy <= 16; gy++) {
            const x = Math.round(margin + ((scene.width - sw - margin * 2) * gx) / 16);
            const y = Math.round(margin + ((STAGE_HEIGHT - sh - margin * 2) * gy) / 16);
            const ok = !taken.some((o) => x < o.x + o.width + margin && x + sw + margin > o.x && y < o.y + o.height + margin && y + sh + margin > o.y);
            const d = Math.hypot(x + sw / 2 - scene.width / 2, y + sh / 2 - STAGE_HEIGHT / 2);
            if (ok && (!found || d < found.d)) found = { x, y, d };
          }
        if (found) return { x: found.x, y: found.y, scale };
      }
    }
    // Too big for a clear spot (a graph, a large picture): the place inside the frame covering the
    // least of what's there, searched on a grid, ties going to the one nearest the centre.
    if (taken.length && w < scene.width && h < STAGE_HEIGHT) {
      const cover = (x: number, y: number) =>
        taken.reduce((sum, o) => sum + Math.max(0, Math.min(x + w, o.x + o.width) - Math.max(x, o.x)) * Math.max(0, Math.min(y + h, o.y + o.height) - Math.max(y, o.y)), 0);
      let best = { x: Math.round(cx), y: Math.round(cy), c: cover(cx, cy), d: 0 };
      for (let gx = 0; gx <= 12; gx++)
        for (let gy = 0; gy <= 12; gy++) {
          const x = Math.round(margin + ((scene.width - w - margin * 2) * gx) / 12);
          const y = Math.round(margin + ((STAGE_HEIGHT - h - margin * 2) * gy) / 12);
          const c = cover(x, y);
          const d = Math.hypot(x - cx, y - cy);
          if (c < best.c - 1 || (Math.abs(c - best.c) <= 1 && d < best.d)) best = { x, y, c, d };
        }
      if (best.c < cover(cx, cy)) return { x: best.x, y: best.y, scale: 1 };
    }
    let x = Math.round(cx);
    let y = Math.round(cy);
    for (let i = 0; i < 12 && scene.elements.some((e) => !e.parent && Math.abs(e.props.x - x) < 8 && Math.abs(e.props.y - y) < 8); i++) {
      x += 36;
      y += 36;
    }
    return { x, y, scale: 1 };
  };
  // New elements land where they can be seen: the playhead comes into the scene first when it's out.
  const place = (made: StageElement) => {
    if (local < 0 || local >= duration) onSeek(beatRestTime(scene, beat));
    onUpdate((s) => addElement(s, beat, made));
    onSelectElement(made.id);
    setAdding(null);
  };
  const addText = () => place(makeTextElement(scene.width, { text: "New text", fontSize: 56, color: ink, y: placeAt(scene.width * 0.6, 73).y }));
  const addMath = () => {
    const made = makeMathElement({ ...placeAt(480, 140), color: ink });
    place(made);
    // Straight into its editor, ready to type.
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("stage-edit-math", { detail: made.id })), 60);
  };
  const addGraph = () => {
    const at = placeAt(1000, 620, true);
    place(makeGraphElement({ x: at.x, y: at.y, width: Math.round(1000 * at.scale), height: Math.round(620 * at.scale), color: ink, curve: lightBg ? "#2563eb" : undefined }));
  };
  const addIcon = (name: string) => place(makeIconElement({ ...placeAt(96, 96), size: 96, name, color: ink }));
  const addShape = (p: ShapePreset) =>
    place(makeShapeElement({ ...placeAt(p.w, p.h), width: p.w, height: p.h, radius: (p.round ?? 0) * Math.min(p.w, p.h), color: lightBg ? "#2563eb" : "#58c4dd", form: p.form, sides: p.sides, inner: p.inner, sweep: p.sweep }));
  // Elements a line can run between; a new line starts at the selected one.
  const connectable = scene.elements.filter((e) => e.kind !== "stack" && e.kind !== "connector");
  const addLine = () => {
    const from = element && connectable.includes(element) ? element : connectable[0];
    const to = connectable.find((e) => e.id !== from?.id);
    if (!from || !to) return;
    place(makeConnectorElement(from.id, to.id));
  };
  // A picture from disk, at its own proportions - or, with an element selected, in its place.
  const pickPicture = async (replace?: string) => {
    const chosen = await openFileDialog({ multiple: false, filters: [{ name: "Picture", extensions: FILE_CATEGORY_EXTENSIONS.image }] });
    if (!chosen || Array.isArray(chosen)) return;
    const img = await loadStageImage(chosen);
    if (!img) return;
    if (replace) {
      onUpdate((s) => ({ ...s, elements: s.elements.map((e) => (e.id === replace ? { ...e, image: { ...e.image, src: chosen } } : e)) }));
      return;
    }
    place(makeImageElement(scene.width, chosen, img));
  };
  const icons = (iconQuery.trim() ? searchIcons(iconQuery) : STICKER_ICONS).filter((i) => i.value !== "none");
  const changedHere = scene.beats[beat]?.changes ?? {};
  const duration = sceneDuration(scene);
  // Going to a beat just added: the seek waits until the scene holding it is the one on screen -
  // sooner, the timeline is still the old length and the playhead is held back in the old beat,
  // so the next edit would land in the wrong one.
  const [pendingSeek, setPendingSeek] = useState<null | { beats: number; t: number }>(null);
  useEffect(() => {
    if (!pendingSeek || scene.beats.length < pendingSeek.beats) return;
    const t = pendingSeek.t;
    setPendingSeek(null);
    // A frame later, once the player has the new length too.
    requestAnimationFrame(() => requestAnimationFrame(() => onSeek(t)));
  }, [scene, pendingSeek, onSeek]);
  const goToBeat = (target: { scene: StageScene; index: number }) => {
    const t = beatRestTime(target.scene, target.index);
    if (target.scene === scene) return onSeek(t);
    onUpdate(() => target.scene);
    setPendingSeek({ beats: target.scene.beats.length, t });
  };
  const local = playhead - scene.startTime;
  const fallbackName = scene.elements.find((e) => e.kind === "text")?.props.text ?? "Scene";

  return (
    <div className="flex flex-col gap-5">
      {/* The scene: its name (click to rename), how long it runs, and what can be done to it. */}
      <div className="flex items-center gap-1.5">
        <input
          value={nameDraft ?? scene.name ?? ""}
          placeholder={fallbackName}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setNameDraft(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          title="Rename the scene"
          className="flex-1 min-w-0 bg-transparent rounded-md px-1.5 py-1 -ml-1.5 text-[13px] font-semibold text-white outline-none hover:bg-white/5 focus:bg-black/30 focus:ring-1 focus:ring-teal-400 placeholder:text-white/80 truncate"
        />
        <span className="shrink-0 rounded-full bg-teal-500/15 text-teal-200 px-2 py-0.5 text-[10px] tabular-nums">{duration.toFixed(1)}s</span>
        <IconButton title="Duplicate the scene" onClick={onDuplicate}>
          <IoCopyOutline size={13} />
        </IconButton>
        <IconButton title="Delete the scene" onClick={onDelete} danger>
          <IoTrashOutline size={13} />
        </IconButton>
      </div>

      <Section
        title={`Beat ${beat + 1} of ${scene.beats.length}`}
        aside={
          <IconButton title={`Remove beat ${beat + 1} - the beats after it look just as they did`} onClick={() => onUpdate((s) => deleteBeat(s, beat))} disabled={scene.beats.length <= 1} danger>
            <IoTrashOutline size={12} />
          </IconButton>
        }
      >
        <BeatStrip
          scene={scene}
          beat={beat}
          local={local}
          onPick={(i) => onSeek(beatRestTime(scene, i))}
          onAdd={() => goToBeat(addBeat(scene, beat))}
        />
        <SliderRow
          label="Holds"
          value={scene.beats[beat]?.hold ?? 2}
          min={0.3}
          max={10}
          step={0.1}
          format={(v) => `${v.toFixed(1)}s`}
          onChange={(v) => {
            // Shortened past the playhead, the beat would slip out from under it - and the next edit
            // land in the beat after. The playhead stays in this beat.
            const next = setBeatHold(scene, beat, v);
            onUpdate(() => next);
            // Past the end of the last beat counts too - the stage would show nothing at all.
            const start = beatStarts(next)[beat] ?? 0;
            if (local < start || local >= start + v || beatIndexAt(next, Math.max(0, local)) !== beat) onSeek(beatRestTime(next, beat));
          }}
        />
      </Section>

      <Section title="Elements" aside={<span className="text-[10px] text-white/30 normal-case tracking-normal">● changes in this beat</span>}>
        <div className="flex flex-col gap-px max-h-48 overflow-y-auto -mx-1 px-1">
          {scene.elements.map((e) => {
            const shown = elementInBeat(scene, beat, e.id)?.visible;
            const selected = e.id === selectedElementId;
            return (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectElement(selected ? null : e.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    onSelectElement(selected ? null : e.id);
                  }
                }}
                className={`group flex items-center gap-2 h-7 px-2 rounded-md text-left text-[11px] cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-teal-400 ${selected ? "bg-teal-500/25 text-white" : "text-white/70 hover:bg-white/5"} ${e.parent ? "pl-6" : ""}`}
              >
                <span className={`shrink-0 flex ${shown ? "" : "opacity-40"}`}>
                  <KindIcon e={e} />
                </span>
                <span className={`truncate flex-1 ${shown ? "" : "opacity-40"}`}>{label(e, scene)}</span>
                {changedHere[e.id] && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-teal-300" title={`Changes in beat ${beat + 1}`} />}
                {e.kind !== "stack" && (
                  <button
                    type="button"
                    title={shown ? `Hide it from beat ${beat + 1}` : `Show it from beat ${beat + 1}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      toggleShown(e.id);
                    }}
                    className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 ${shown ? "text-white/40 opacity-0 group-hover:opacity-100 focus:opacity-100" : "text-white/50"}`}
                  >
                    {shown ? <IoEyeOutline size={12} /> : <IoEyeOffOutline size={12} />}
                  </button>
                )}
              </div>
            );
          })}
          {scene.elements.length === 0 && <span className="px-2 py-3 text-center text-[11px] text-white/40">Nothing in the scene yet - add something below.</span>}
        </div>
        <div className="grid grid-cols-7 gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
          {[
            { kind: "text" as const, icon: <IoText size={14} />, text: "Text", title: `Add text arriving in beat ${beat + 1}` },
            { kind: "shape" as const, icon: <IoSquareOutline size={14} />, text: "Shape", title: "Choose a shape to add" },
            { kind: "icon" as const, icon: <IoShapesOutline size={14} />, text: "Icon", title: "Choose an icon to add" },
          ].map((b) => (
            <button
              key={b.kind}
              type="button"
              title={b.title}
              aria-expanded={b.kind === "text" ? undefined : adding === b.kind}
              onClick={() => (b.kind === "text" ? addText() : setAdding((a) => (a === b.kind ? null : b.kind)))}
              className={`h-11 flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] transition-colors ${adding === b.kind ? "bg-teal-500 text-white" : "text-white/70 hover:text-white hover:bg-white/10"}`}
            >
              {b.icon}
              {b.text}
            </button>
          ))}
          <button type="button" title={`Add an equation arriving in beat ${beat + 1} - typeset TeX that can rewrite itself beat to beat`} onClick={addMath} className="h-11 flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] text-white/70 hover:text-white hover:bg-white/10">
            <span className="text-[14px] leading-none font-serif">∑</span>
            Maths
          </button>
          <button type="button" title={`Add a graph arriving in beat ${beat + 1} - functions you type, data you paste, points, areas and gradient descent, morphing beat to beat`} onClick={addGraph} className="h-11 flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] text-white/70 hover:text-white hover:bg-white/10">
            <GraphGlyph size={14} />
            Graph
          </button>
          <button type="button" title={`Add a picture arriving in beat ${beat + 1} - a logo, product shot or screenshot`} onClick={() => void pickPicture()} className="h-11 flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] text-white/70 hover:text-white hover:bg-white/10">
            <IoImageOutline size={14} />
            Picture
          </button>
          <button
            type="button"
            disabled={connectable.length < 2}
            onClick={addLine}
            title={connectable.length < 2 ? "A line runs between two elements - add another first" : "Add a line from the selected element to another - it follows both as they move"}
            className="h-11 flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-35 disabled:pointer-events-none"
          >
            <IoEllipsisHorizontal size={14} />
            Line
          </button>
        </div>
        {/* Choose first, then it's placed - in this beat, in view, selected. */}
        {adding === "shape" && (
          <div className="flex flex-col gap-1 rounded-lg bg-black/25 p-1.5">
            <ShapeGallery onPick={addShape} />
            <span className="px-0.5 text-[10px] text-white/35">Every one resizes, rounds, outlines and morphs into another between beats.</span>
          </div>
        )}
        {adding === "icon" && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-black/25 p-1.5">
            <input
              autoFocus
              value={iconQuery}
              onChange={(e) => setIconQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setAdding(null);
                if (e.key === "Enter" && icons[0]) addIcon(icons[0].value);
              }}
              placeholder="Find an icon - Enter adds the first"
              className={field}
            />
            <div className="grid grid-cols-7 gap-1 max-h-40 overflow-y-auto">
              {icons.map((i) => (
                <button key={i.value} type="button" title={i.label} onClick={() => addIcon(i.value)} className="h-8 flex items-center justify-center rounded-md bg-white/5 hover:bg-teal-500/60 transition-colors">
                  <IconThumb name={i.value} />
                </button>
              ))}
              {icons.length === 0 && <span className="col-span-7 py-2 text-center text-[11px] text-white/40">No icon by that name</span>}
            </div>
          </div>
        )}
      </Section>

      <ValuesSection scene={scene} local={local} onUpdate={onUpdate} onSeekLocal={(t) => onSeek(scene.startTime + t)} />

      {element && here && (
        <Section
          title={
            <span className="flex items-center gap-1.5 normal-case tracking-normal text-[11px] text-white/80">
              <KindIcon e={element} />
              <input
                key={element.id + (element.name ?? "")}
                defaultValue={element.name ?? ""}
                placeholder={label(element, scene)}
                title="Name it - names show in the element list, in lines' ends and in rules"
                onBlur={(e) => e.target.value !== (element.name ?? "") && onUpdate((s) => renameElement(s, element.id, e.target.value))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = element.name ?? "";
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="min-w-0 flex-1 truncate bg-transparent rounded px-1 -ml-1 outline-none hover:bg-white/5 focus:bg-black/30 focus:ring-1 focus:ring-teal-400 placeholder:text-white/80"
              />
            </span>
          }
          aside={
            <span className="flex items-center">
              {element.kind !== "stack" && (
                <IconButton
                  title="Duplicate it (Ctrl+D) - look, motion and every beat's changes"
                  onClick={() => {
                    let made = "";
                    onUpdate((s) => {
                      const r = duplicateElement(s, element.id);
                      made = r.id;
                      return r.scene;
                    });
                    window.setTimeout(() => made && onSelectElement(made), 0);
                  }}
                >
                  <IoCopyOutline size={12} />
                </IconButton>
              )}
              <IconButton
                title="Delete it from the scene"
                danger
                onClick={() => {
                  onUpdate((s) => deleteElement(s, element.id));
                  onSelectElement(null);
                }}
              >
                <IoTrashOutline size={12} />
              </IconButton>
            </span>
          }
        >
          <Toggle label={`Shown in beat ${beat + 1}`} value={here.visible} onChange={() => toggleShown(element.id)} title="Show or hide it from this beat on - it arrives or leaves with the scene's motion" />
          {element.kind !== "connector" && <ArrangeSection scene={scene} beat={beat} element={element} here={here} onUpdate={onUpdate} lockByDefault={element.kind === "image" || element.kind === "math"} />}
          {element.kind === "math" && (
            <MathEditor
              scene={scene}
              beat={beat}
              element={element}
              here={here}
              onUpdate={onUpdate}
              onRewriteNext={() => {
                const target = beat + 1 < scene.beats.length ? { scene, index: beat + 1 } : addBeat(scene, beat);
                goToBeat(target);
                window.setTimeout(() => window.dispatchEvent(new CustomEvent("stage-edit-math", { detail: element.id })), 120);
              }}
            />
          )}
          {element.kind === "graph" && (
            <GraphEditor
              scene={scene}
              beat={beat}
              element={element}
              here={here}
              onUpdate={onUpdate}
              onNextBeat={() => {
                const target = beat + 1 < scene.beats.length ? { scene, index: beat + 1 } : addBeat(scene, beat);
                goToBeat(target);
              }}
            />
          )}
          {element.kind === "text" && (
            <>
              <textarea
                ref={textRef}
                value={draft ?? here.text ?? ""}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitDraft}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    commitDraft();
                  }
                  if (e.key === "Escape") setDraft(null);
                }}
                rows={2}
                className={`${field} resize-y`}
                placeholder="Text in this beat"
              />
              <span className="-mt-1 text-[10px] text-white/35">Words it keeps glide into place; new words write on. Shift+Enter for a new line.</span>
              {(scene.channels ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-white/45 mr-0.5">Show live:</span>
                  {(scene.channels ?? []).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      title={`Put ${c.name ?? c.id} into the text at the cursor - it shows the value as it runs`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const current = draft ?? here.text ?? "";
                        const el = textRef.current;
                        const a = el && document.activeElement === el ? el.selectionStart : current.length;
                        const b = el && document.activeElement === el ? el.selectionEnd : current.length;
                        const next = current.slice(0, a) + valueToken(c) + current.slice(b);
                        setDraft(null);
                        inBeat({ text: next });
                      }}
                      className="rounded-full bg-teal-500/15 hover:bg-teal-500/30 px-2 py-0.5 text-[10px] text-teal-100"
                    >
                      {c.name ?? c.id}
                    </button>
                  ))}
                </div>
              )}
              <Swatches colors={STAGE_INKS} value={here.color} onPick={(c) => c && inBeat({ color: c })} custom />
              <SliderRow label="Size" value={element.textLook?.fontSize ?? 44} min={10} max={240} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => look({ fontSize: v })} />
              <Segmented
                value={element.textLook?.textAlign ?? "left"}
                onChange={(a) => look({ textAlign: a })}
                options={[
                  { value: "left", label: <MdFormatAlignLeft size={14} />, title: "Align left" },
                  { value: "center", label: <MdFormatAlignCenter size={14} />, title: "Centre" },
                  { value: "right", label: <MdFormatAlignRight size={14} />, title: "Align right" },
                ]}
              />
              <Toggle label="Even-width digits" value={!!element.textLook?.tabularNums} onChange={(v) => look({ tabularNums: v })} title="Every digit as wide as the widest - numbers that change don't jitter" />
              <FontSection value={element.textLook?.fontFamily} onChange={(id) => look({ fontFamily: id })} />
            </>
          )}
          {element.kind === "image" && (
            <>
              <div className="flex gap-1.5">
                <button type="button" onClick={() => void pickPicture(element.id)} className="flex-1 h-7 rounded-md bg-white/[0.06] hover:bg-white/10 text-[11px] text-white/80">
                  Replace picture…
                </button>
              </div>
              <Segmented
                value={element.image?.fit ?? "cover"}
                onChange={(fit) => own((e) => ({ ...e, image: { ...e.image!, fit } }))}
                options={[
                  { value: "cover", label: "Fill", title: "Fill the box, cropping what doesn't fit" },
                  { value: "contain", label: "Fit", title: "Show all of it, on the box's colour" },
                ]}
              />
              {element.image?.fit === "contain" && <Swatches colors={[undefined, ...STAGE_INKS]} value={here.color} onPick={(c) => inBeat({ color: c ?? "rgba(0,0,0,0)" })} custom />}
              <Toggle
                label="Arrives as dots"
                value={element.image?.reveal === "dots"}
                onChange={(v) => own((e) => ({ ...e, image: { ...e.image!, reveal: v ? "dots" : undefined }, spring: v ? e.spring ?? "slow" : e.spring === "slow" ? undefined : e.spring }))}
                title="It builds itself from coloured dots that take on its colours and merge into the picture"
              />
            </>
          )}
          {(element.kind === "shape" || element.kind === "image") && <ShapeSection scene={scene} beat={beat} element={element} here={here} onUpdate={onUpdate} />}
          {element.kind === "icon" && (
            <>
              <Swatches colors={STAGE_INKS} value={here.color} onPick={(c) => c && inBeat({ color: c })} custom />
              <Toggle
                label="Framed"
                value={!!element.icon?.frame}
                onChange={(v) => own((e) => ({ ...e, icon: { name: e.icon?.name ?? "star", frame: v ? { radius: 0.21 * here.width, width: Math.max(1.5, here.width * 0.06) } : undefined } }))}
                title="Sit it in a rounded outline of its own colour"
              />
              <input value={iconQuery} onChange={(e) => setIconQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} placeholder="Find an icon" className={field} />
              <div className="grid grid-cols-7 gap-1 max-h-36 overflow-y-auto">
                {icons.map((i) => (
                  <button
                    key={i.value}
                    type="button"
                    title={i.label}
                    onClick={() => own((e) => ({ ...e, icon: { ...e.icon, name: i.value } }))}
                    className={`h-8 flex items-center justify-center rounded-md transition-colors ${element.icon?.name === i.value ? "bg-teal-500" : "bg-white/5 hover:bg-white/10"}`}
                  >
                    <IconThumb name={i.value} />
                  </button>
                ))}
                {icons.length === 0 && <span className="col-span-7 py-2 text-center text-[11px] text-white/40">No icon by that name</span>}
              </div>
            </>
          )}
          {element.kind === "connector" && element.connector && (
            <>
              <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-[11px] text-white/60">
                {(["from", "to"] as const).map((end) => (
                  <React.Fragment key={end}>
                    <span className="capitalize">{end}</span>
                    <select value={element.connector![end]} onChange={(e) => line({ [end]: e.target.value })} className="min-w-0 rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 outline-none px-1.5 py-1 text-white text-[11px]">
                      {connectable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {label(c, scene)}
                        </option>
                      ))}
                    </select>
                  </React.Fragment>
                ))}
              </div>
              <Segmented
                value={element.connector.style}
                onChange={(st) => line({ style: st })}
                options={[
                  { value: "solid", label: <span className="block w-6 h-[2px] rounded bg-current" />, title: "Solid" },
                  { value: "dots", label: <span className="tracking-[0.2em] text-[13px] leading-none">•••</span>, title: "Dots" },
                  { value: "dashes", label: <span className="flex gap-0.5">{[0, 1, 2].map((k) => <span key={k} className="block w-1.5 h-[2px] rounded bg-current" />)}</span>, title: "Dashes" },
                ]}
              />
              {element.connector.style === "dots" && <Toggle label="Big and small dots" value={!!element.connector.rhythm} onChange={(v) => line({ rhythm: v ? 3 : undefined })} title="Every third dot full size, the ones between small - a line with a pulse" />}
              <Swatches colors={STAGE_INKS} value={here.color} onPick={(c) => c && inBeat({ color: c })} custom />
              <SliderRow label="Thickness" value={element.connector.thickness} min={1} max={24} step={0.5} format={(v) => `${v}`} onChange={(v) => line({ thickness: v })} />
              <SliderRow label="Gap" value={element.connector.gap} min={0} max={80} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => line({ gap: v })} />
              {element.connector.style !== "solid" && (
                <SliderRow label="Flow" value={element.connector.flow ?? 0} min={-200} max={200} step={5} format={(v) => (v === 0 ? "Still" : v > 0 ? `→ ${v}` : `← ${-v}`)} reset={0} onChange={(v) => line({ flow: v })} />
              )}
              <SliderRow label="Drawn" value={here.draw ?? 1} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} reset={1} onChange={(v) => inBeat({ draw: v })} />
            </>
          )}
          <SliderRow label="Opacity" value={here.opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} reset={1} onChange={(v) => inBeat({ opacity: v })} />
          {element.kind !== "connector" && (
            <>
              <Toggle label="3D" value={show3d || in3d} onChange={(v) => (v ? setShow3d(true) : (setShow3d(false), inBeat({ rotateX: 0, rotateY: 0, z: 0 })))} title="Tilt it in depth and move it nearer or further - seen through the scene's perspective" />
              {(show3d || in3d) && (
                <div className="flex flex-col gap-2 pl-2 border-l border-white/10">
                  <SliderRow label="Turn" value={here.rotateY ?? 0} min={-90} max={90} step={1} format={(v) => `${Math.round(v)}°`} reset={0} onChange={(v) => inBeat({ rotateY: v })} />
                  <SliderRow label="Tilt" value={here.rotateX ?? 0} min={-90} max={90} step={1} format={(v) => `${Math.round(v)}°`} reset={0} onChange={(v) => inBeat({ rotateX: v })} />
                  <SliderRow label="Depth" value={here.z ?? 0} min={-1500} max={800} step={5} format={(v) => (v === 0 ? "On the stage" : v > 0 ? `${Math.round(v)} nearer` : `${Math.round(-v)} back`)} reset={0} onChange={(v) => inBeat({ z: v })} />
                </div>
              )}
            </>
          )}
          <FollowSection scene={scene} element={element} here={here} onUpdate={onUpdate} />
          <WhenSection scene={scene} element={element} onUpdate={onUpdate} />
          <GroupSection scene={scene} element={element} at={occupied.find((o) => o.id === element.id)} onUpdate={onUpdate} onSelect={onSelectElement} />
          <MotionSection scene={scene} beat={beat} element={element} here={here} onUpdate={onUpdate} />
        </Section>
      )}

      <Section title="Look & motion">
        <span className="text-[11px] text-white/60">Background</span>
        <Swatches
          colors={STAGE_BACKGROUNDS}
          titles={["None - over the video", "Paper", "White", "Light grey", "Ink", "Night", "Blue"]}
          value={scene.background.kind === "color" ? scene.background.color : undefined}
          onPick={(c) =>
            onUpdate((s) => {
              const next: StageScene = { ...s, background: c ? { kind: "color", color: c } : { kind: "none" } };
              // Light to dark (or back): the automatic inks follow, so nothing disappears.
              const isLight = (sc: StageScene) => {
                const rgb = sc.background.kind === "color" ? parseStageColor(sc.background.color) : null;
                return !!rgb && (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.55;
              };
              return isLight(s) === isLight(next) ? next : reinkScene(next, !isLight(next));
            })
          }
          custom
        />
        <span className="text-[11px] text-white/60">Motion</span>
        <Segmented value={scene.spring} onChange={(v) => onUpdate((s) => ({ ...s, spring: v }))} options={MOTIONS} />
        <SliderRow label="Perspective" value={scene.perspective ?? 2000} min={600} max={6000} step={50} format={(v) => `${Math.round(v)}`} reset={2000} onChange={(v) => onUpdate((s) => ({ ...s, perspective: v }))} />
        <SliderRow label="Stagger" value={scene.stagger} min={0} max={0.3} step={0.01} format={(v) => `${Math.round(v * 1000)}ms`} onChange={(v) => onUpdate((s) => ({ ...s, stagger: v }))} reset={0.05} />
      </Section>
    </div>
  );
};

export default StageDockedPanel;
