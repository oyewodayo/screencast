// components/video/StageLayer.tsx
//
// Stage scenes on the player (src/utils/stage). Mounted twice by Dashboard, as export stacks them:
//   "render"   - the scenes drawn by the same GPU renderer export uses, over the video and its
//                tracks, beneath blur regions, pictures and text;
//   "controls" - on top: the selected scene's elements picked, dragged and typed into on the canvas,
//                and its panel (StageDockedPanel) in the tool dock.
// The renderer only draws when something changed (the playhead moved, a scene was edited, an element
// is being dragged), prepares the scenes about to play in idle time, and settles on a new canvas
// size only once the window stops resizing - text is drawn for a size, so it isn't redrawn per pixel.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoChevronDown, IoChevronUp, IoClose, IoLayersOutline } from "react-icons/io5";
import { FrameRect } from "../../utils/videoFrameRect";
import { StageRenderer } from "../../utils/stage/stageRenderer";
import { CompiledStage, SampledElement, sampleStage } from "../../utils/stage/stageEngine";
import { compiledFor, stageDrag, whenCompiled } from "../../utils/stage/stageLive";
import { beatIndexAt, beatRestTime, deleteElement, duplicateElement, elementInBeat, sceneEnd, setElementProps } from "../../utils/stage/stageEditing";
import { STAGE_HEIGHT, StageElement, StageScene } from "../../utils/stage/stageTypes";
import { GeoBox, HANDLES, Handle, boxCorners, insideBox, resizeBox, turnBox } from "../../utils/stage/stageGeometry";
import { setPath } from "../../utils/stage/stageValues";
import { titleFontCss } from "../../utils/titleFonts";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "../docker/ToolPanelHost";
import StageDockedPanel from "./StageDockedPanel";

const isActive = (s: StageScene, t: number) => t >= s.startTime && t < sceneEnd(s);
// Scenes kept ready around the playhead: the one playing, and those starting in the next few seconds.
const isNear = (s: StageScene, t: number) => sceneEnd(s) > t - 2 && s.startTime < t + 6;
const SIZE_SETTLE_MS = 150;

interface RenderProps {
  frameRect: FrameRect;
  scenes: StageScene[];
  currentOutputTime: number;
  getOutputTime?: () => number | null;
  isPlaying?: boolean;
}

const StageCanvas: React.FC<RenderProps> = ({ frameRect, scenes, currentOutputTime, getOutputTime, isPlaying }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const live = useRef({ scenes, frameRect, currentOutputTime, getOutputTime, isPlaying });
  live.current = { scenes, frameRect, currentOutputTime, getOutputTime, isPlaying };
  // Moves on whenever a scene finishes compiling - the loop redraws then.
  const readyRef = useRef(0);

  useEffect(() => {
    for (const s of scenes) {
      if (!compiledFor(s))
        void whenCompiled(s).then(() => {
          readyRef.current++;
        });
    }
  }, [scenes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: StageRenderer | null = null;
    let raf = 0;
    let lastKey = "";
    let shown = false;
    let applied = { w: 0, h: 0 };
    let sizeTimer = 0;
    let wanted = { w: 0, h: 0 };
    let prepared: CompiledStage[] = [];
    // Each scene's last compilation drawn - drawn on while an edit of it compiles, so it never blinks.
    const lastDrawn = new Map<string, CompiledStage>();
    let idle = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { scenes: all, frameRect: fr, currentOutputTime: ct, getOutputTime: get, isPlaying: playing } = live.current;
      const t = get?.() ?? ct;
      const active = all.filter((s) => isActive(s, t));
      if (active.length === 0) {
        if (shown) {
          renderer?.clear();
          canvas.style.visibility = "hidden";
          shown = false;
        }
        lastKey = "";
        return;
      }
      // The drawing buffer at the screen's density, settled once a resize stops (stretched meanwhile).
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(fr.width * dpr));
      const h = Math.max(1, Math.round(fr.height * dpr));
      if (w !== wanted.w || h !== wanted.h) {
        wanted = { w, h };
        window.clearTimeout(sizeTimer);
        sizeTimer = window.setTimeout(() => {
          applied = { ...wanted };
          renderer?.setSize(applied.w, applied.h);
          prepared = [];
          lastKey = "";
        }, applied.w === 0 ? 0 : SIZE_SETTLE_MS);
        if (applied.w === 0) return;
      }
      if (applied.w === 0) return;
      renderer ??= rendererRef.current = new StageRenderer(canvas, applied.w, applied.h);
      const drawable = active.map((s) => compiledFor(s) ?? lastDrawn.get(s.id)).filter((c): c is CompiledStage => !!c);
      for (const c of drawable) lastDrawn.set(c.scene.id, c);
      if (drawable.length === 0) return;
      const key = `${t}|${applied.w}x${applied.h}|${readyRef.current}|${stageDrag.version}|${drawable.map((c) => c.scene.id).join(",")}|${drawable.map((c) => compiledVersion(c)).join(",")}`;
      if (key === lastKey) return;
      lastKey = key;
      // Keep the scenes about to play ready too - added in idle time while playing, so preparing
      // the next scene never costs a frame of this one.
      const near = all.filter((s) => isNear(s, t)).map((s) => compiledFor(s)).filter((c): c is CompiledStage => !!c);
      const missingActive = drawable.some((c) => !prepared.includes(c));
      const sameNear = near.length === prepared.length && near.every((c, i) => c === prepared[i]);
      if (missingActive || (!sameNear && !playing)) {
        prepared = near;
        renderer.prepareAll(near);
      } else if (!sameNear && !idle) {
        idle = requestIdle(() => {
          idle = 0;
          prepared = near;
          renderer?.prepareAll(near);
          lastKey = "";
        });
      }
      // Offsets cleared before drawing, not after: on release the moved scene and the end of the drag
      // arrive together, and a leftover offset on top of the new position drew the element twice as
      // far - a frame that then stayed, nothing having changed since.
      drawable.forEach((c, i) => {
        // A drag's shift belongs to the compilation it began on (stageDrag) - set before drawing,
        // never left over from the frame before.
        for (const e of c.scene.elements) {
          const off = stageDrag.offsets.get(e.id);
          renderer!.setOffset(e.id, off && (off.from === null || off.from === c) ? off : null);
        }
        renderer!.render(c, t - c.scene.startTime, i === 0);
      });
      if (!shown) {
        canvas.style.visibility = "visible";
        shown = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(sizeTimer);
      if (idle) cancelIdle(idle);
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute left-0 top-0 pointer-events-none" style={{ width: frameRect.width, height: frameRect.height, visibility: "hidden" }} />;
};

// A compiled scene's identity for change detection - the compiled object itself, numbered.
const versions = new WeakMap<CompiledStage, number>();
let nextVersion = 1;
function compiledVersion(c: CompiledStage): number {
  let v = versions.get(c);
  if (!v) versions.set(c, (v = nextVersion++));
  return v;
}

// Idle-time callbacks, falling back to a short timer where the browser has none.
const idleApi = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
const requestIdle = (fn: () => void): number => (idleApi.requestIdleCallback ? idleApi.requestIdleCallback(fn, { timeout: 500 }) : window.setTimeout(fn, 50));
const cancelIdle = (id: number) => (idleApi.cancelIdleCallback ? idleApi.cancelIdleCallback(id) : window.clearTimeout(id));

// ---------- controls ----------

interface ControlsProps {
  frameRect: FrameRect;
  scenes: StageScene[];
  currentOutputTime: number;
  getOutputTime?: () => number | null;
  selectedSceneId: string | null;
  onSelectScene: (id: string | null) => void;
  onUpdateScene: (id: string, edit: (s: StageScene) => StageScene) => void;
  onDeleteScene: (id: string) => void;
  onDuplicateScene: (id: string) => void;
  onSeek: (t: number) => void;
}

// The element a drag moves: a stacked element moves its stack (the stack places what's in it).
// Where a dragged box may snap: the stage's edges and centre lines, and every other element's
// edges and centre - the nearest within `reach` (stage units) on each axis. Returns the snapped
// shift and the guides to draw (stage units).
type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
function snapMove(box: { x: number; y: number; width: number; height: number }, dx: number, dy: number, others: SampledElement[], stageW: number, reach: number): { dx: number; dy: number; guides: Guide[] } {
  const guides: Guide[] = [];
  const axis = (pos: number, size: number, d: number, targets: { at: number; from: number; to: number }[], key: "x" | "y") => {
    let best: { delta: number; at: number; from: number; to: number } | null = null;
    for (const edge of [pos + d, pos + d + size / 2, pos + d + size]) {
      for (const t of targets) {
        const delta = t.at - edge;
        if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, ...t };
      }
    }
    if (!best) return d;
    guides.push({ axis: key, at: best.at, from: best.from, to: best.to });
    return d + best.delta;
  };
  const xs = [
    { at: 0, from: 0, to: STAGE_HEIGHT },
    { at: stageW / 2, from: 0, to: STAGE_HEIGHT },
    { at: stageW, from: 0, to: STAGE_HEIGHT },
    ...others.flatMap((o) => [o.x, o.x + o.width / 2, o.x + o.width].map((at) => ({ at, from: Math.min(o.y, box.y + dy), to: Math.max(o.y + o.height, box.y + dy + box.height) }))),
  ];
  const ys = [
    { at: 0, from: 0, to: stageW },
    { at: STAGE_HEIGHT / 2, from: 0, to: stageW },
    { at: STAGE_HEIGHT, from: 0, to: stageW },
    ...others.flatMap((o) => [o.y, o.y + o.height / 2, o.y + o.height].map((at) => ({ at, from: Math.min(o.x, box.x + dx), to: Math.max(o.x + o.width, box.x + dx + box.width) }))),
  ];
  return { dx: axis(box.x, box.width, dx, xs, "x"), dy: axis(box.y, box.height, dy, ys, "y"), guides };
}

// Distance (stage units) from a point to a connector as drawn now - between its two ends' boxes.
function connectorDistance(x: number, y: number, a: SampledElement, b: SampledElement): number {
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2));
  return Math.hypot(x - (ax + vx * t), y - (ay + vy * t));
}

// How an element resizes by its handles: which ones it has, whether its proportions are kept unless
// Shift is held (pictures, icons) or kept only with Shift, and whether a corner scales its type.
function resizeRules(e: StageElement | undefined): { handles: string[]; lockAspect: boolean; scalesType: boolean; turns: boolean } {
  const all = HANDLES.map((h) => h.id);
  const corners = ["nw", "ne", "se", "sw"];
  if (!e || e.kind === "connector") return { handles: [], lockAspect: false, scalesType: false, turns: false };
  if (e.kind === "text") return { handles: [...corners, "e", "w"], lockAspect: false, scalesType: true, turns: true };
  if (e.kind === "math") return { handles: corners, lockAspect: true, scalesType: true, turns: true };
  if (e.kind === "icon") return { handles: corners, lockAspect: true, scalesType: false, turns: true };
  if (e.kind === "image") return { handles: all, lockAspect: true, scalesType: false, turns: true };
  if (e.kind === "stack") return { handles: all, lockAspect: false, scalesType: false, turns: false };
  return { handles: all, lockAspect: false, scalesType: false, turns: true };
}

const geoOf = (s: SampledElement): GeoBox => ({ x: s.x, y: s.y, width: s.width, height: s.height, rotation: s.rotation, scale: s.scale, anchorX: s.anchorX, anchorY: s.anchorY });

// The moving edges of a resized, unrotated box snapped to the stage's and the other elements' lines.
function snapResize(r: { x: number; y: number; width: number; height: number }, handle: Handle, others: SampledElement[], stageW: number, reach: number, keepAspect: boolean): { box: typeof r; guides: Guide[] } {
  const guides: Guide[] = [];
  const box = { ...r };
  const xs = [0, stageW / 2, stageW, ...others.flatMap((o) => [o.x, o.x + o.width / 2, o.x + o.width])];
  const ys = [0, STAGE_HEIGHT / 2, STAGE_HEIGHT, ...others.flatMap((o) => [o.y, o.y + o.height / 2, o.y + o.height])];
  const nearest = (v: number, list: number[]) => {
    let best: number | null = null;
    for (const t of list) if (Math.abs(t - v) <= reach && (best === null || Math.abs(t - v) < Math.abs(best - v))) best = t;
    return best;
  };
  if (handle.sx !== 0 && !(keepAspect && handle.sy !== 0)) {
    const edge = handle.sx === 1 ? box.x + box.width : box.x;
    const t = nearest(edge, xs);
    if (t !== null) {
      if (handle.sx === 1) box.width = Math.max(4, t - box.x);
      else (box.width = Math.max(4, box.x + box.width - t)), (box.x = t);
      guides.push({ axis: "x", at: t, from: 0, to: STAGE_HEIGHT });
    }
  }
  if (handle.sy !== 0 && !(keepAspect && handle.sx !== 0)) {
    const edge = handle.sy === 1 ? box.y + box.height : box.y;
    const t = nearest(edge, ys);
    if (t !== null) {
      if (handle.sy === 1) box.height = Math.max(4, t - box.y);
      else (box.height = Math.max(4, box.y + box.height - t)), (box.y = t);
      guides.push({ axis: "y", at: t, from: 0, to: stageW });
    }
  }
  return { box, guides };
}

function dragTarget(scene: StageScene, id: string): StageElement | undefined {
  const byId = new Map(scene.elements.map((e) => [e.id, e]));
  let e = byId.get(id);
  while (e?.parent && byId.get(e.parent)?.kind === "stack") e = byId.get(e.parent);
  return e;
}

const StageControls: React.FC<ControlsProps> = ({ frameRect, scenes, currentOutputTime, selectedSceneId, onSelectScene, onUpdateScene, onDeleteScene, onDuplicateScene, onSeek }) => {
  const host = useToolPanelHost();
  const scene = scenes.find((s) => s.id === selectedSceneId) ?? null;
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [drag, setDrag] = useState<null | { target: string; startX: number; startY: number; moved: boolean; dx: number; dy: number; guides: Guide[] }>(null);
  // A resize or turn by a handle in progress: the box as it was, and the change so far.
  const [xform, setXform] = useState<null | {
    id: string;
    mode: "resize" | "turn";
    handle: Handle;
    startX: number;
    startY: number;
    box: GeoBox;
    next: { x: number; y: number; width: number; height: number; rotation: number };
    guides: Guide[];
  }>(null);
  const [editing, setEditing] = useState<null | { id: string; value: string }>(null);
  // Bending a route by its handle: the bend so far (committed on release).
  const [bending, setBending] = useState<null | { id: string; bend: number; orient?: boolean }>(null);
  // The floating panel (no tools sidebar) folded to its header, to see the stage under it.
  const [folded, setFolded] = useState(false);
  const [compiled, setCompiled] = useState<CompiledStage | null>(scene ? compiledFor(scene) : null);
  useEffect(() => {
    if (!scene) return setCompiled(null);
    setCompiled(compiledFor(scene));
    let cancelled = false;
    void whenCompiled(scene).then((c) => !cancelled && setCompiled(c));
    return () => {
      cancelled = true;
    };
  }, [scene]);
  // Shifts from finished drags go once the scene they were made on has been replaced by its next
  // compilation (the shift is in it now).
  useEffect(() => {
    if (!compiled) return;
    for (const [id, off] of stageDrag.offsets) {
      if (off.from && off.from !== compiled && off.from.scene.id === compiled.scene.id && !(drag && drag.target === id)) stageDrag.set(id, null);
    }
  }, [compiled, drag]);

  // A selection that no longer exists (deleted, undone) is let go.
  useEffect(() => {
    if (selectedElementId && scene && !scene.elements.some((e) => e.id === selectedElementId)) setSelectedElementId(null);
  }, [scene, selectedElementId]);
  useEffect(() => setSelectedElementId(null), [selectedSceneId]);

  const local = scene ? currentOutputTime - scene.startTime : 0;
  const active = !!scene && isActive(scene, currentOutputTime);
  const beat = scene ? beatIndexAt(scene, Math.max(0, local)) : 0;
  const k = frameRect.height / STAGE_HEIGHT;
  // Everything showing now; boxes are picked by their area, a connector near its line.
  const all: SampledElement[] = useMemo(() => (compiled && active ? sampleStage(compiled, local) : []), [compiled, active, local]);
  const samples = useMemo(() => all.filter((s) => s.kind !== "connector"), [all]);
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Keys while a scene is open: Delete removes the selected element (or, with none, the scene), Esc
  // lets the selection go, arrows nudge it in this beat (Shift: ten units). Typing anywhere is left
  // alone.
  useEffect(() => {
    if (!selectedSceneId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const sc = sceneRef.current;
      // Ctrl+D: a copy of the selected element, selected.
      if (sc && selectedElementId && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        e.stopImmediatePropagation();
        let made = "";
        onUpdateScene(sc.id, (s) => {
          const r = duplicateElement(s, selectedElementId);
          made = r.id;
          return r.scene;
        });
        window.setTimeout(() => made && setSelectedElementId(made), 0);
        return;
      }
      if (!sc || e.ctrlKey || e.metaKey || e.altKey) return;
      const at = Math.max(0, currentOutputTime - sc.startTime);
      const b = beatIndexAt(sc, at);
      if (e.key === "Escape") {
        if (selectedElementId) setSelectedElementId(null);
        else onSelectScene(null);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (selectedElementId) {
          onUpdateScene(sc.id, (s) => deleteElement(s, selectedElementId));
          setSelectedElementId(null);
        } else {
          onDeleteScene(sc.id);
          onSelectScene(null);
        }
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!move || !selectedElementId || !isActive(sc, currentOutputTime)) return;
      const target = dragTarget(sc, selectedElementId);
      const p = target && elementInBeat(sc, b, target.id);
      if (!target || !p) return;
      // The player steps/seeks on arrows too - with an element selected, they're the element's.
      e.preventDefault();
      e.stopImmediatePropagation();
      onUpdateScene(sc.id, (s) => setElementProps(s, b, target.id, { x: p.x + move[0], y: p.y + move[1] }));
    };
    // Capture, so this runs before the player's and the timeline's own key handlers.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedSceneId, selectedElementId, currentOutputTime, onUpdateScene, onDeleteScene, onSelectScene]);

  if (!scene) return null;

  const selected = samples.find((s) => s.id === selectedElementId);
  const hit = (clientX: number, clientY: number, box: DOMRect): SampledElement | null => {
    const x = (clientX - box.left) / k;
    const y = (clientY - box.top) / k;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (insideBox(geoOf(s), x, y)) return s;
    }
    // Nearest line within a few screen pixels.
    let near: SampledElement | null = null;
    let nearest = 8 / k;
    for (const s of all) {
      const c = s.kind === "connector" ? scene.elements.find((el) => el.id === s.id)?.connector : undefined;
      const a = c && byId.get(c.from);
      const b = c && byId.get(c.to);
      if (!a || !b) continue;
      const d = connectorDistance(x, y, a, b);
      if (d < nearest) {
        nearest = d;
        near = s;
      }
    }
    return near;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (editing || e.button !== 0) return;
    const found = hit(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    setSelectedElementId(found?.id ?? null);
    if (!found || found.kind === "connector") return;
    const target = dragTarget(scene, found.id);
    if (!target) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ target: target.id, startX: e.clientX, startY: e.clientY, moved: false, dx: 0, dy: 0, guides: [] });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (xform) {
      const dx = (e.clientX - xform.startX) / k;
      const dy = (e.clientY - xform.startY) / k;
      const element = scene.elements.find((el) => el.id === xform.id);
      const rules = resizeRules(element);
      let next = { ...xform.next };
      let guides: Guide[] = [];
      if (xform.mode === "turn") {
        const origin = { x: xform.startX, y: xform.startY };
        const at = { x: e.clientX, y: e.clientY };
        const rect = (e.currentTarget as HTMLElement).closest("[data-stage-surface]")?.getBoundingClientRect();
        if (rect) {
          const toStage = (p: { x: number; y: number }) => ({ x: (p.x - rect.left) / k, y: (p.y - rect.top) / k });
          next.rotation = turnBox(xform.box, toStage(origin), toStage(at), e.shiftKey);
        }
      } else {
        // Shift flips the proportion rule: kept for pictures and icons unless held, free for the rest unless held.
        const keepAspect = rules.lockAspect !== e.shiftKey || (rules.scalesType && xform.handle.sx !== 0 && xform.handle.sy !== 0);
        const r = resizeBox(xform.box, xform.handle, dx, dy, { keepAspect, fromCentre: e.altKey, minSize: 8 });
        let box = r;
        if (!e.ctrlKey && Math.abs(xform.box.rotation % 360) < 0.01 && xform.box.scale === 1) {
          const others = samples.filter((o) => o.id !== xform.id);
          const snapped = snapResize(r, xform.handle, others, scene.width, 6 / k, keepAspect);
          box = snapped.box;
          guides = snapped.guides;
        }
        next = { ...next, ...box };
      }
      const b = xform.box;
      stageDrag.set(xform.id, { dx: next.x - b.x, dy: next.y - b.y, dw: next.width - b.width, dh: next.height - b.height, dr: next.rotation - b.rotation, from: compiled });
      setXform({ ...xform, next, guides });
      return;
    }
    if (!drag) return;
    let dx = (e.clientX - drag.startX) / k;
    let dy = (e.clientY - drag.startY) / k;
    // Shift keeps the move to one axis - whichever it has gone further along.
    if (e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3;
    let guides: Guide[] = [];
    // Snaps to the stage and the other elements, as in Keynote; Alt moves freely.
    const box = selected ?? samples.find((s) => s.id === drag.target);
    if (moved && box && !e.altKey && !e.shiftKey) {
      const moving = new Set(scene.elements.filter((el) => el.id === drag.target || dragTarget(scene, el.id)?.id === drag.target).map((el) => el.id));
      const snapped = snapMove(box, dx, dy, samples.filter((s) => !moving.has(s.id)), scene.width, 6 / k);
      dx = snapped.dx;
      dy = snapped.dy;
      guides = snapped.guides;
    }
    if (moved) stageDrag.set(drag.target, { dx, dy, from: compiled });
    setDrag({ ...drag, moved, dx, dy, guides });
  };
  const onPointerUp = () => {
    if (xform) {
      const { id, box: b, next } = xform;
      const element = scene.elements.find((el) => el.id === id);
      const at = elementInBeat(scene, beat, id);
      const changed = next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height || next.rotation !== b.rotation;
      if (at && element && changed) {
        const rules = resizeRules(element);
        const corner = xform.handle.sx !== 0 && xform.handle.sy !== 0;
        onUpdateScene(scene.id, (sc) => {
          if (xform.mode === "turn") return setElementProps(sc, beat, id, { rotation: next.rotation });
          const f = b.width > 0 ? next.width / b.width : 1;
          let out = setElementProps(sc, beat, id, { x: at.x + (next.x - b.x), y: at.y + (next.y - b.y), width: Math.max(8, at.width + (next.width - b.width)), height: Math.max(8, at.height + (next.height - b.height)) });
          // A corner on text or an equation scales its type with the box.
          if (rules.scalesType && corner && element.textLook) {
            const size = Math.round(Math.max(6, Math.min(600, element.textLook.fontSize * f)) * 10) / 10;
            out = { ...out, elements: out.elements.map((el) => (el.id === id ? { ...el, textLook: { ...el.textLook!, fontSize: size } } : el)) };
          }
          return out;
        });
      } else stageDrag.set(id, null);
      setXform(null);
      return;
    }
    if (!drag) return;
    // A moved element keeps its shift until the moved scene has compiled (the effect below) - the
    // preview holds it where it was let go instead of snapping back meanwhile.
    if (!drag.moved) stageDrag.set(drag.target, null);
    if (drag.moved) {
      const at = elementInBeat(scene, beat, drag.target);
      if (at) onUpdateScene(scene.id, (s) => setElementProps(s, beat, drag.target, { x: at.x + drag.dx, y: at.y + drag.dy }));
    }
    setDrag(null);
  };
  const startXform = (e: React.PointerEvent, mode: "resize" | "turn", handle: Handle) => {
    if (!selected || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const box = geoOf(selected);
    setXform({ id: selected.id, mode, handle, startX: e.clientX, startY: e.clientY, box, next: { x: box.x, y: box.y, width: box.width, height: box.height, rotation: box.rotation }, guides: [] });
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const found = hit(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
    const element = found && scene.elements.find((el) => el.id === found.id);
    // An equation is edited in the panel, which knows TeX: focus its field.
    if (found && element?.kind === "math") {
      setSelectedElementId(found.id);
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("stage-edit-math", { detail: found.id })), 30);
      return;
    }
    if (!found || element?.kind !== "text") return;
    setSelectedElementId(found.id);
    setEditing({ id: found.id, value: elementInBeat(scene, beat, found.id)?.text ?? "" });
  };
  const commitEdit = () => {
    if (!editing) return;
    const { id, value } = editing;
    setEditing(null);
    if (value !== (elementInBeat(scene, beat, id)?.text ?? "")) onUpdateScene(scene.id, (s) => setElementProps(s, beat, id, { text: value }));
  };

  // Where things stand, for placing new elements clear of them: this beat as it looks at rest -
  // not the playhead's moment, which may be before anything has arrived.
  const occupied = compiled ? sampleStage(compiled, beatRestTime(scene, beat) - scene.startTime).filter((s) => s.kind !== "connector") : [];
  const selectedAny = all.find((s) => s.id === selectedElementId);
  const selectedElement = scene.elements.find((el) => el.id === selectedElementId);
  // The box follows the element exactly: the live drag, then - until the moved scene compiles - the
  // shift the preview still holds it at.
  const targetId = selected ? dragTarget(scene, selected.id)?.id : undefined;
  const held = targetId ? stageDrag.offsets.get(targetId) : undefined;
  const shift = drag?.moved && targetId === drag.target ? { dx: drag.dx, dy: drag.dy } : held && held.from === compiled ? held : { dx: 0, dy: 0 };
  const editingSample = editing ? samples.find((s) => s.id === editing.id) : undefined;
  const editingLook = editing ? scene.elements.find((el) => el.id === editing.id)?.textLook : undefined;

  const panel = (
    <StageDockedPanel
      scene={scene}
      occupied={occupied}
      beat={beat}
      playhead={currentOutputTime}
      selectedElementId={selectedElementId}
      onSelectElement={setSelectedElementId}
      onUpdate={(edit) => onUpdateScene(scene.id, edit)}
      onSeek={onSeek}
      onDuplicate={() => onDuplicateScene(scene.id)}
      onDelete={() => {
        onDeleteScene(scene.id);
        onSelectScene(null);
      }}
    />
  );
  const header = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-teal-300/80 flex items-center gap-1.5">
        <IoLayersOutline size={13} />
        Scene
      </span>
      <span className="flex items-center gap-0.5">
        {!host && (
          <button type="button" title={folded ? "Show the scene's settings" : "Fold the settings away to see the stage"} onClick={() => setFolded((f) => !f)} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            {folded ? <IoChevronDown size={14} /> : <IoChevronUp size={14} />}
          </button>
        )}
        <button type="button" title="Done (Esc)" onClick={() => onSelectScene(null)} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </span>
    </div>
  );
  // With the tools sidebar open the panel lives there (the portal below). Without it, it sits in the
  // dark letterbox left of the stage, never over the scene - narrowing to fit, and only overlapping
  // the frame's left edge when even a narrow panel can't fit beside it.
  const gutter = frameRect.left;
  const PANEL_MIN = 260;
  const panelWidth = Math.min(340, Math.max(PANEL_MIN, gutter - 16));
  const floatingStyle: React.CSSProperties = {
    left: 8 - gutter,
    top: 8 - frameRect.top,
    width: panelWidth,
    // Clear of the player's transport bar along the bottom.
    maxHeight: Math.max(160, frameRect.height + 2 * frameRect.top - 16 - 64),
  };

  return (
    <>
      {active && (
        <div
          className="absolute left-0 top-0"
          data-stage-surface=""
          style={{ width: frameRect.width, height: frameRect.height, pointerEvents: "auto", cursor: drag?.moved ? "grabbing" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          title={selected ? "Drag to move it in this beat (Alt: no snapping) - arrows nudge - double-click text to edit it" : "Click an element to select it"}
        >
          {!drag?.moved &&
            !xform &&
            samples.map((s) =>
              s.id === selectedElementId ? null : (
                <div
                  key={s.id}
                  className="absolute rounded-[3px] outline outline-1 outline-white/0 hover:outline-sky-300/70 transition-[outline-color] duration-100"
                  style={{ left: s.x * k, top: s.y * k, width: s.width * k, height: s.height * k, transformOrigin: `${s.anchorX * 100}% ${s.anchorY * 100}%`, transform: s.rotation || s.scale !== 1 ? `rotate(${s.rotation}deg) scale(${s.scale})` : undefined }}
                />
              )
            )}
          {/* Smart guides while dragging. */}
          {[...(drag?.moved ? drag.guides : []), ...(xform?.guides ?? [])].map((g, i) =>
              g.axis === "x" ? (
                <div key={i} className="absolute w-px bg-fuchsia-400 pointer-events-none" style={{ left: g.at * k, top: g.from * k, height: (g.to - g.from) * k }} />
              ) : (
                <div key={i} className="absolute h-px bg-fuchsia-400 pointer-events-none" style={{ top: g.at * k, left: g.from * k, width: (g.to - g.from) * k }} />
              )
            )}
          {/* The route into this beat: where it was (a ghost), the arc it travels, a handle to bend it. */}
          {selectedElement && !editing && !drag?.moved && !xform && beat > 0 && (() => {
            const id = selectedElement.id;
            if (selectedElement.parent && scene.elements.find((e) => e.id === selectedElement.parent)?.kind === "stack") return null;
            const a = elementInBeat(scene, beat - 1, id);
            const b = elementInBeat(scene, beat, id);
            if (!a || !b || !a.visible || !b.visible) return null;
            const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
            const len = Math.hypot(bx - ax, by - ay);
            if (len < 4) return null;
            const saved = scene.beats[beat].paths?.[id];
            const bend = bending?.id === id ? bending.bend : saved?.bend ?? 0;
            // Sideways, to the left of the direction of travel (as the engine bends it).
            const nx = (by - ay) / len, ny = -(bx - ax) / len;
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            const peak = { x: mx + nx * bend * len, y: my + ny * bend * len };
            const ctrl = { x: mx + nx * 2 * bend * len, y: my + ny * 2 * bend * len };
            // The arrowhead along the curve's direction at its end.
            const tx = bx - ctrl.x, ty = by - ctrl.y;
            const tl = Math.hypot(tx, ty) || 1;
            const ah = 9 / k;
            const head = [
              [bx, by],
              [bx - (tx / tl) * ah * 1.6 + (ty / tl) * ah * 0.8, by - (ty / tl) * ah * 1.6 - (tx / tl) * ah * 0.8],
              [bx - (tx / tl) * ah * 1.6 - (ty / tl) * ah * 0.8, by - (ty / tl) * ah * 1.6 + (tx / tl) * ah * 0.8],
            ];
            return (
              <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={frameRect.width} height={frameRect.height}>
                <rect x={a.x * k} y={a.y * k} width={a.width * k} height={a.height * k} rx={4} fill="none" stroke="rgb(56 189 248 / 0.55)" strokeDasharray="4 4" />
                <path d={`M${ax * k},${ay * k} Q${ctrl.x * k},${ctrl.y * k} ${bx * k},${by * k}`} fill="none" stroke="rgb(56 189 248 / 0.9)" strokeWidth={1.5} strokeDasharray="6 5" />
                <polygon points={head.map(([x, y]) => `${x * k},${y * k}`).join(" ")} fill="rgb(56 189 248)" />
                <circle
                  cx={peak.x * k}
                  cy={peak.y * k}
                  r={6}
                  fill={bend ? "rgb(56 189 248)" : "white"}
                  stroke="rgb(14 165 233)"
                  strokeWidth={1.5}
                  className="pointer-events-auto cursor-move"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    setBending({ id, bend, orient: saved?.orient });
                  }}
                  onPointerMove={(e) => {
                    if (!bending) return;
                    const rect = (e.currentTarget as Element).closest("[data-stage-surface]")!.getBoundingClientRect();
                    const px = (e.clientX - rect.left) / k, py = (e.clientY - rect.top) / k;
                    let next = ((px - mx) * nx + (py - my) * ny) / len;
                    next = Math.max(-1, Math.min(1, next));
                    // Near the line it snaps straight.
                    if (Math.abs(next * len) < 8 / k) next = 0;
                    setBending({ ...bending, bend: Math.round(next * 100) / 100 });
                  }}
                  onPointerUp={() => {
                    if (!bending) return;
                    const { bend: nb, orient } = bending;
                    setBending(null);
                    onUpdateScene(scene.id, (sc) => setPath(sc, beat, id, nb ? { bend: nb, orient } : null));
                  }}
                >
                  <title>Drag to bend its route into this beat - back onto the line for straight</title>
                </circle>
              </svg>
            );
          })()}
          {selected && !editing && (() => {
            const rules = resizeRules(selectedElement);
            // Until a resize or turn has compiled in, the preview holds it - and so does the frame.
            const own = !xform ? stageDrag.offsets.get(selected.id) : undefined;
            const kept = own && own.from === compiled ? own : undefined;
            const live = xform
              ? { ...xform.next, scale: selected.scale }
              : { x: selected.x + shift.dx, y: selected.y + shift.dy, width: selected.width + (kept?.dw ?? 0), height: selected.height + (kept?.dh ?? 0), rotation: selected.rotation + (kept?.dr ?? 0), scale: selected.scale };
            const inv = 1 / (live.scale || 1);
            const showHandles = !drag?.moved && !(xform && xform.mode === "turn");
            return (
            <>
            <div
              className="absolute pointer-events-none"
              style={{
                left: live.x * k,
                top: live.y * k,
                width: live.width * k,
                height: live.height * k,
                transformOrigin: `${selected.anchorX * 100}% ${selected.anchorY * 100}%`,
                transform: live.rotation || live.scale !== 1 ? `rotate(${live.rotation}deg) scale(${live.scale})` : undefined,
              }}
            >
              <div className="absolute -inset-[2px] rounded-[3px] outline outline-2 outline-sky-400" style={{ outlineWidth: 2 * inv }} />
              {showHandles &&
                HANDLES.filter((h) => rules.handles.includes(h.id)).map((h) => (
                  <div
                    key={h.id}
                    onPointerDown={(e) => startXform(e, "resize", h)}
                    className="absolute w-[10px] h-[10px] -ml-[5px] -mt-[5px] rounded-[2px] bg-white ring-1 ring-sky-500 shadow pointer-events-auto hover:scale-125 transition-transform"
                    style={{ left: `${(h.sx + 1) * 50}%`, top: `${(h.sy + 1) * 50}%`, cursor: h.cursor, transform: `scale(${inv})` }}
                    title={rules.scalesType && h.sx !== 0 && h.sy !== 0 ? "Drag to scale it - Alt: from the centre" : rules.lockAspect ? "Drag to resize - Shift: free proportions, Alt: from the centre" : "Drag to resize - Shift: keep proportions, Alt: from the centre, Ctrl: no snapping"}
                  />
                ))}
              {showHandles && rules.turns && (
                <>
                  <div className="absolute left-1/2 w-px bg-sky-400" style={{ top: -22 * inv, height: 20 * inv }} />
                  <div
                    onPointerDown={(e) => startXform(e, "turn", { sx: 0, sy: -1 })}
                    className="absolute left-1/2 w-3 h-3 -ml-1.5 rounded-full bg-white ring-1 ring-sky-500 shadow pointer-events-auto cursor-grab hover:scale-125 transition-transform"
                    style={{ top: -30 * inv, transform: `scale(${inv})` }}
                    title="Drag to turn it - Shift: steps of 15°"
                  />
                </>
              )}
            </div>
            {/* What it is, and where it is while it moves - upright, above the box however it's turned. */}
            {(() => {
              const corners = boxCorners({ ...live, anchorX: selected.anchorX, anchorY: selected.anchorY });
              const left = Math.min(...corners.map((c) => c.x));
              const top = Math.min(...corners.map((c) => c.y));
              const knob = rules.turns && !live.rotation ? 34 : 0;
              return (
                <span className="absolute whitespace-nowrap rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-medium text-white shadow pointer-events-none" style={{ left: left * k, top: top * k - 24 - knob }}>

                {xform?.mode === "turn" ? `${Math.round(live.rotation)}°` : xform ? `${Math.round(live.width)} × ${Math.round(live.height)}` : drag?.moved ? `${Math.round(selected.x + shift.dx)}, ${Math.round(selected.y + shift.dy)}` : selectedElement?.kind === "text" ? "Text · double-click to edit" : selectedElement?.kind === "math" ? "Equation · double-click to edit" : selectedElement?.kind === "graph" ? "Graph" : selectedElement?.kind === "icon" ? "Icon" : selectedElement?.kind === "shape" ? "Shape" : "Element"}
                </span>
              );
            })()}
            </>
            );
          })()}
          {/* A selected line: its two ends ringed. */}
          {selectedAny?.kind === "connector" &&
            (() => {
              const c = selectedElement?.connector;
              return [c && byId.get(c.from), c && byId.get(c.to)].map((end, i) =>
                end ? <div key={i} className="absolute rounded-[3px] outline outline-1 outline-dashed outline-sky-400 pointer-events-none" style={{ left: end.x * k - 3, top: end.y * k - 3, width: end.width * k + 6, height: end.height * k + 6 }} /> : null
              );
            })()}
          {editing && editingSample && (
            <textarea
              autoFocus
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onBlur={commitEdit}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setEditing(null);
                else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                }
              }}
              className="absolute resize-none bg-white text-black rounded-[3px] outline outline-2 outline-sky-400 shadow-lg shadow-black/30 p-0 leading-tight"
              style={{
                left: editingSample.x * k,
                top: editingSample.y * k,
                width: Math.max(80, editingSample.width * k + 24),
                height: Math.max(editingSample.height * k, 24),
                font: titleFontCss(editingLook?.fontFamily, (editingLook?.fontSize ?? 40) * k, { bold: editingLook?.bold, italic: editingLook?.italic }),
                textAlign: editingLook?.textAlign ?? "left",
              }}
            />
          )}
        </div>
      )}
      {!active && (
        <button
          type="button"
          onClick={() => onSeek(scene.startTime + Math.min(sceneEnd(scene) - scene.startTime, 1.5) * 0.9)}
          className="absolute left-1/2 top-3 -translate-x-1/2 px-3 py-1 rounded-full bg-teal-600/95 hover:bg-teal-500 text-white text-xs shadow-lg"
          style={{ pointerEvents: "auto" }}
        >
          The playhead is outside this scene - go to it
        </button>
      )}
      {host
        ? createPortal(
            <div className={`${DOCKED_PANEL_CLASS} p-3.5 gap-4`}>
              {header}
              {panel}
            </div>,
            host
          )
        : (
            <div className={`${DOCKED_PANEL_CLASS} absolute p-3 gap-3 overflow-y-auto shadow-2xl shadow-black/40`} style={{ ...floatingStyle, pointerEvents: "auto", zIndex: 30 }}>
              {header}
              {!folded && panel}
            </div>
          )}
    </>
  );
};

type Props = ({ mode: "render" } & RenderProps) | ({ mode: "controls" } & ControlsProps);

const StageLayer: React.FC<Props> = (props) => (props.mode === "controls" ? <StageControls {...props} /> : <StageCanvas {...props} />);

export default StageLayer;
