// components/docs/DocImageView.tsx
//
// The node view behind every picture in a document (registered via DocImage.addNodeView() in
// docSchemaExtensions.ts). It draws the picture in its layout (docImageLayout.ts: in line, on its
// own line, wrapped, or free in front of / behind the text) and - while selected - the editing
// chrome: resize handles, a rotate handle for free pictures, and a floating toolbar with the
// layout choices, alignment, crop, caption, the options panel (DocImageOptionsPanel.tsx) and
// delete.
//
// Moving:
//   - a free picture is dragged by its body, anywhere on the page, snapping to the margins and the
//     page's centre line (and, for a signature, onto a signing line - docImagePlacement.ts); on
//     release it re-anchors to the paragraph under its new top edge, like Word's "Move with text"
//   - any other picture, once selected, is dragged into a new place in the text, with a caret
//     showing exactly where it will land
// All of these stage locally (React state) and write the document once, on release, so a drag
// never floods the Y.Doc with intermediate steps.
//
// The node stays inline in every layout, so the NodeViewWrapper is a <span> - a block-level tag
// can't legally sit inside a <p>. Block and float layouts are CSS on that span.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeViewWrapper, NodeViewProps } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { MdCrop, MdDeleteOutline, MdOutlineSubtitles, MdTune, MdVerified } from "react-icons/md";
import DocImageCropModal from "./DocImageCropModal";
import DocImageOptionsPanel from "./DocImageOptionsPanel";
import { AlignIcon, LayoutIcon } from "./DocImageIcons";
import { IMAGE_LAYOUTS, imageLookStyle, isFreeLayout, type DocImageAttrs, type ImageAlign, type ImageLayout } from "../../utils/docImageLayout";
import { collectInkLines, commitFreeImage, pageFrame, snapBox, type Guide, type InkLine, type PageFrame } from "../../utils/docImagePlacement";
import { PAGE_GAP_PX } from "../../utils/docPageGeometry";
import { takeJustPlaced } from "./signatureStore";
import "./docImages.css";
import "./docSignature.css";

const MIN_SIZE = 16;
type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const HANDLES: Handle[] = ["nw", "ne", "sw", "se", "n", "s", "e", "w"];
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
const HANDLE_POS: Record<Handle, React.CSSProperties> = {
  nw: { left: 0, top: 0 },
  ne: { left: "100%", top: 0 },
  sw: { left: 0, top: "100%" },
  se: { left: "100%", top: "100%" },
  n: { left: "50%", top: 0 },
  s: { left: "50%", top: "100%" },
  e: { left: "100%", top: "50%" },
  w: { left: 0, top: "50%" },
};

interface ResizeDrag {
  handle: Handle;
  startX: number;
  startY: number;
  w: number;
  h: number;
  aspect: number;
  rotation: number;
  shift: boolean;
}

interface MoveDrag {
  startX: number;
  startY: number;
  box: { left: number; top: number; width: number; height: number };
  frame: PageFrame | null;
  ink: InkLine[] | null;
  moved: boolean;
}

interface RotateDrag {
  cx: number;
  cy: number;
  startAngle: number;
  startRotation: number;
}

interface Live {
  width?: number;
  height?: number;
  dx?: number;
  dy?: number;
  rotation?: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

// The caret position a dragged in-line picture would land at.
function textPosAt(view: EditorView, clientX: number, clientY: number): number | null {
  const coords = view.posAtCoords({ left: clientX, top: clientY });
  return coords ? coords.pos : null;
}

const DocImageView: React.FC<NodeViewProps> = ({ node, selected, deleteNode, extension, view, getPos, editor }) => {
  const docId = (extension.options as { docId: string | null }).docId;
  const a = node.attrs as DocImageAttrs;
  const free = isFreeLayout(a.layout);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLSpanElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [showCrop, setShowCrop] = useState(false);
  // A signature placed a moment ago writes itself onto the page, once.
  const [inkIn, setInkIn] = useState(() => a.kind === "signature" && takeJustPlaced(a.src));
  const [showOptions, setShowOptions] = useState(false);
  const [live, setLiveState] = useState<Live | null>(null);
  // Mirrors `live` for the release handlers, which commit to the document once (never from inside
  // a state updater, which React may run twice).
  const liveRef = useRef<Live | null>(null);
  const setLive = (next: Live | null) => {
    liveRef.current = next;
    setLiveState(next);
  };
  const [guides, setGuides] = useState<Guide[]>([]);
  const [inkHit, setInkHitState] = useState<InkLine | null>(null);
  const inkRef = useRef<InkLine | null>(null);
  const setInkHit = (line: InkLine | null) => {
    inkRef.current = line;
    setInkHitState(line);
  };
  const [caret, setCaret] = useState<{ left: number; top: number; height: number } | null>(null);
  const [toolbarAt, setToolbarAt] = useState<{ left: number; top: number; below: boolean; frame: { left: number; top: number; right: number; bottom: number } } | null>(null);

  const resizeRef = useRef<ResizeDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  const rotateRef = useRef<RotateDrag | null>(null);
  const textMoveRef = useRef<{ pos: number | null } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number; shift: boolean; alt: boolean } | null>(null);

  const width = live?.width ?? a.width ?? undefined;
  const height = live?.height ?? a.height ?? undefined;
  const rotation = live?.rotation ?? a.rotation;
  const dragging = live !== null;

  // Attribute changes go through AttrSteps (setNodeAttribute), not Tiptap's updateAttributes: that
  // replaces the whole leaf node, which drops the picture's selection - the toolbar and options
  // panel would vanish after every change.
  const setAttrs = useCallback(
    (attrs: Partial<DocImageAttrs>) => {
      const pos = getPos();
      if (typeof pos !== "number") return;
      let tr = view.state.tr;
      for (const [k, v] of Object.entries(attrs)) tr = tr.setNodeAttribute(pos, k, v);
      view.dispatch(tr);
    },
    [getPos, view]
  );

  const select = useCallback(() => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (!(view.state.selection instanceof NodeSelection && view.state.selection.from === pos)) {
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    }
    view.focus();
  }, [getPos, view]);

  // One rAF-throttled pointer loop shared by every gesture.
  const schedule = (fn: () => void) => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      fn();
    });
  };
  const cancelFrame = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // ---- resize ---------------------------------------------------------------------------------
  const beginResize = (handle: Handle) => (e: React.PointerEvent) => {
    const img = imgRef.current;
    if (!img || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const w = a.width ?? img.offsetWidth;
    const h = a.height ?? img.offsetHeight;
    resizeRef.current = { handle, startX: e.clientX, startY: e.clientY, w, h, aspect: w / h, rotation: a.rotation, shift: e.shiftKey };
    setLive({ width: w, height: h });
  };

  const resizeFrame = () => {
    const d = resizeRef.current;
    const p = pointerRef.current;
    if (!d || !p) return;
    // Pointer delta in the picture's own (rotated) frame, so a rotated picture's handles still
    // pull along its own edges.
    const gx = p.x - d.startX;
    const gy = p.y - d.startY;
    const c = Math.cos(rad(d.rotation));
    const s = Math.sin(rad(d.rotation));
    const dx = gx * c + gy * s;
    const dy = -gx * s + gy * c;
    const { handle, w: w0, h: h0, aspect } = d;
    let w = w0;
    let h = h0;
    const sx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
    const sy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
    if (sx && sy) {
      // Corners keep the proportions (Shift frees them), driven by the larger pull.
      if (p.shift) {
        w = w0 + dx * sx;
        h = h0 + dy * sy;
      } else if (Math.abs(dx * sx) / aspect >= Math.abs(dy * sy)) {
        w = w0 + dx * sx;
        h = w / aspect;
      } else {
        h = h0 + dy * sy;
        w = h * aspect;
      }
    } else if (sx) {
      w = w0 + dx * sx;
      if (p.shift) h = w / aspect;
    } else if (sy) {
      h = h0 + dy * sy;
      if (p.shift) w = h * aspect;
    }
    w = Math.max(MIN_SIZE, Math.round(w));
    h = Math.max(MIN_SIZE, Math.round(h));
    // A free picture pulled by a left/top handle keeps its right/bottom edge where it was.
    const next: Live = { width: w, height: h };
    if (free) {
      if (sx < 0) next.dx = w0 - w;
      if (sy < 0) next.dy = h0 - h;
    }
    setLive(next);
  };

  const endResize = () => {
    if (!resizeRef.current) return;
    cancelFrame();
    resizeRef.current = null;
    const cur = liveRef.current;
    setLive(null);
    if (cur?.width && cur.height) {
      const attrs: Partial<DocImageAttrs> = { width: cur.width, height: cur.height };
      if (free && (cur.dx || cur.dy)) {
        attrs.x = Math.round(a.x + (cur.dx ?? 0));
        attrs.y = Math.round(a.y + (cur.dy ?? 0));
      }
      setAttrs(attrs);
    }
  };

  // ---- rotate (free pictures) ----------------------------------------------------------------
  const beginRotate = (e: React.PointerEvent) => {
    const frame = frameRef.current;
    if (!frame || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = frame.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    rotateRef.current = { cx, cy, startAngle: Math.atan2(e.clientY - cy, e.clientX - cx), startRotation: a.rotation };
    setLive({ rotation: a.rotation });
  };

  const rotateFrame = () => {
    const d = rotateRef.current;
    const p = pointerRef.current;
    if (!d || !p) return;
    let deg = d.startRotation + ((Math.atan2(p.y - d.cy, p.x - d.cx) - d.startAngle) * 180) / Math.PI;
    deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    if (p.shift) deg = Math.round(deg / 15) * 15;
    else {
      // Magnetic right angles: straight is the usual intent.
      const nearest = Math.round(deg / 90) * 90;
      if (Math.abs(deg - nearest) < 4) deg = nearest;
    }
    if (deg === -180) deg = 180;
    setLive({ rotation: Math.round(deg * 10) / 10 });
  };

  const endRotate = () => {
    if (!rotateRef.current) return;
    cancelFrame();
    rotateRef.current = null;
    const cur = liveRef.current;
    setLive(null);
    if (cur?.rotation !== undefined && cur.rotation !== a.rotation) setAttrs({ rotation: cur.rotation });
  };

  // ---- move ----------------------------------------------------------------------------------
  const onImagePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!free && !selected) return; // first click: ProseMirror selects the picture
    e.preventDefault();
    e.stopPropagation();
    select();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
    if (free) {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const r = wrapper.getBoundingClientRect();
      const frame = pageFrame(view);
      moveRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        box: { left: r.left, top: r.top, width: r.width, height: r.height },
        frame,
        ink: frame && a.kind === "signature" ? collectInkLines(view, frame) : null,
        moved: false,
      };
    } else {
      textMoveRef.current = { pos: null };
    }
  };

  const moveFrame = () => {
    const p = pointerRef.current;
    if (!p) return;
    const m = moveRef.current;
    if (m) {
      const dx = p.x - m.startX;
      const dy = p.y - m.startY;
      if (!m.moved && Math.hypot(dx, dy) < 3) return;
      m.moved = true;
      const raw = { ...m.box, left: m.box.left + dx, top: m.box.top + dy };
      const snap = m.frame ? snapBox(raw, m.frame, m.ink, p.alt) : { left: raw.left, top: raw.top, guides: [], ink: null };
      setGuides(snap.guides);
      setInkHit(snap.ink);
      setLive({ dx: snap.left - m.box.left, dy: snap.top - m.box.top });
      return;
    }
    const t = textMoveRef.current;
    if (t) {
      const pos = textPosAt(view, p.x, p.y);
      t.pos = pos;
      if (pos == null) return setCaret(null);
      try {
        const c = view.coordsAtPos(pos);
        setCaret({ left: c.left, top: c.top, height: c.bottom - c.top });
      } catch {
        setCaret(null);
      }
    }
  };

  const endMove = () => {
    cancelFrame();
    const m = moveRef.current;
    const t = textMoveRef.current;
    moveRef.current = null;
    textMoveRef.current = null;
    const settledInk = inkRef.current;
    setGuides([]);
    setInkHit(null);
    setCaret(null);
    const pos = getPos();
    if (m) {
      const cur = liveRef.current;
      setLive(null);
      const ink = settledInk;
      if (m.moved && cur && typeof pos === "number")
        commitFreeImage(view, {
          fromPos: pos,
          attrs: {},
          left: m.box.left + (cur.dx ?? 0),
          top: m.box.top + (cur.dy ?? 0),
          anchorAt: ink ? { x: (ink.left + ink.right) / 2, y: ink.y - 3 } : undefined,
        });
      return;
    }
    if (t && t.pos != null && typeof pos === "number") {
      const current = view.state.doc.nodeAt(pos);
      if (!current || (t.pos >= pos && t.pos <= pos + current.nodeSize)) return;
      try {
        let tr = view.state.tr.delete(pos, pos + current.nodeSize);
        const target = Math.min(tr.mapping.map(t.pos), tr.doc.content.size);
        tr = tr.insert(target, current);
        tr = tr.setSelection(NodeSelection.create(tr.doc, target));
        view.dispatch(tr);
      } catch (err) {
        console.error("Failed to move image:", err);
      }
    }
  };

  // ---- pointer plumbing ----------------------------------------------------------------------
  const onPointerMove = (e: React.PointerEvent) => {
    if (!resizeRef.current && !rotateRef.current && !moveRef.current && !textMoveRef.current) return;
    e.stopPropagation();
    pointerRef.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey };
    schedule(() => {
      if (resizeRef.current) resizeFrame();
      else if (rotateRef.current) rotateFrame();
      else moveFrame();
    });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (resizeRef.current) endResize();
    else if (rotateRef.current) endRotate();
    else endMove();
  };

  // ---- toolbar actions -----------------------------------------------------------------------
  const setLayout = (layout: ImageLayout) => {
    if (layout === a.layout) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    if (isFreeLayout(layout) && !free) {
      // Becoming free: stay exactly where it is on the page, then drag from there.
      const r = wrapperRef.current?.getBoundingClientRect();
      if (r) {
        commitFreeImage(view, { fromPos: pos, attrs: { layout }, left: r.left, top: r.top });
        return;
      }
    }
    if ((layout === "wrapLeft" || layout === "wrapRight") && !free) {
      // A picture alone in its paragraph would float beside an empty line; move it to the start of
      // the next paragraph so the text flows round it straight away.
      const $pos = view.state.doc.resolve(pos);
      const parent = $pos.parent;
      if ($pos.depth > 0 && parent.isTextblock && parent.childCount === 1) {
        const after = $pos.after($pos.depth);
        const next = view.state.doc.nodeAt(after);
        if (next && next.isTextblock && next.textContent.trim() && next.type.contentMatch.matchType(node.type)) {
          const before = $pos.before($pos.depth);
          // Insert at the next paragraph's start, then drop the emptied one: the picture lands at
          // before + 1 (the next paragraph's first position once the empty one is gone).
          const tr = view.state.tr.insert(after + 1, node.type.create({ ...node.attrs, layout })).delete(before, after);
          view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, before + 1)));
          return;
        }
      }
    }
    setAttrs({ layout });
  };

  // A picture alone in its paragraph aligns by the paragraph's own alignment - exactly what Word
  // and Docs do, and it exports as such; one sharing a line with text goes onto its own line.
  const aloneInBlock = (): { pos: number; align: ImageAlign } | null => {
    const pos = getPos();
    if (typeof pos !== "number") return null;
    const $pos = view.state.doc.resolve(pos);
    const parent = $pos.parent;
    if (!parent.isTextblock || parent.childCount !== 1 || $pos.depth === 0) return null;
    const ta = parent.attrs.textAlign as string | null | undefined;
    return { pos: $pos.before($pos.depth), align: ta === "center" || ta === "right" ? ta : "left" };
  };

  const alone = a.layout === "inline" || a.layout === "block" ? aloneInBlock() : null;
  const currentAlign: ImageAlign | null = a.layout === "block" ? a.align : a.layout === "inline" && alone ? alone.align : null;

  const setAlign = (align: ImageAlign) => {
    const block = aloneInBlock();
    if (block && (a.layout === "inline" || a.layout === "block")) {
      const parent = view.state.doc.nodeAt(block.pos);
      if (!parent) return;
      const pos = getPos() as number;
      let tr = view.state.tr.setNodeAttribute(block.pos, "textAlign", align === "left" ? null : align);
      if (a.layout === "block") tr = tr.setNodeAttribute(pos, "layout", "inline");
      view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
      return;
    }
    setAttrs({ layout: "block", align });
  };

  const handleCropApplied = (newSrc: string) => {
    // Cleared rather than kept, so the cropped image re-renders at its new natural size instead
    // of stretching into the old (now wrong) aspect ratio - the user can re-resize afterward.
    setAttrs({ src: newSrc, width: null, height: null });
    setShowCrop(false);
  };

  // ---- page-relative pictures from Word ---------------------------------------------------------
  // A picture Word placed relative to the page knows its spot on the sheet, not on its paragraph:
  // once the pages are laid out (pagination settles a moment after load), find the sheet its
  // paragraph landed on and turn the spot into x/y from that paragraph - once, outside undo.
  useEffect(() => {
    if (!free || a.pageY == null) return;
    const timer = window.setTimeout(() => {
      const pos = getPos();
      const frame = pageFrame(view);
      const card = view.dom.closest(".doc-page-card") as HTMLElement | null;
      if (typeof pos !== "number" || !frame || !card) return;
      const $pos = view.state.doc.resolve(pos);
      if ($pos.depth === 0) return;
      const host = view.nodeDOM($pos.before($pos.depth)) as HTMLElement | null;
      if (!host) return;
      const pageH = parseFloat(getComputedStyle(card).minHeight) || frame.card.height;
      const pitch = pageH + PAGE_GAP_PX;
      const hr = host.getBoundingClientRect();
      const originLeft = hr.left + host.clientLeft;
      const originTop = hr.top + host.clientTop;
      const sheet = Math.max(0, Math.floor((originTop - frame.card.top) / pitch));
      const sheetTop = frame.card.top + sheet * pitch;
      let tr = view.state.tr
        .setNodeAttribute(pos, "y", Math.round(sheetTop + (a.pageY as number) - originTop))
        .setNodeAttribute(pos, "pageY", null)
        .setNodeAttribute(pos, "pageX", null);
      if (a.pageX != null) tr = tr.setNodeAttribute(pos, "x", Math.round(frame.card.left + a.pageX - originLeft));
      view.dispatch(tr.setMeta("addToHistory", false));
    }, 900);
    return () => window.clearTimeout(timer);
  }, [free, a.pageX, a.pageY, getPos, view]);

  // ---- floating toolbar position -------------------------------------------------------------
  // In a portal (fixed), so it's never clipped, never rotated with the picture, and always above
  // floats and free pictures. Follows scrolling while shown.
  useLayoutEffect(() => {
    if (!selected || dragging) {
      setToolbarAt(null);
      return;
    }
    const place = () => {
      const el = frameRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // A free picture's rotate knob stands 32px above it: the toolbar clears the knob.
      const clearance = free ? 82 : 42;
      const below = r.top < clearance + 70;
      setToolbarAt({ left: Math.max(8, r.left), top: below ? r.bottom + 12 : r.top - clearance, below, frame: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [selected, dragging, free, a.width, a.height, a.x, a.y, a.layout, a.align, a.rotation]);

  // ---- render --------------------------------------------------------------------------------
  const wrapperStyle: React.CSSProperties = (() => {
    switch (a.layout) {
      case "block":
        return { display: "flex", width: "100%", justifyContent: a.align === "left" ? "flex-start" : a.align === "right" ? "flex-end" : "center", margin: "4pt 0" };
      case "wrapLeft":
        return { float: "left", margin: "2pt 12pt 6pt 0", maxWidth: "100%" };
      case "wrapRight":
        return { float: "right", margin: "2pt 0 6pt 12pt", maxWidth: "100%" };
      case "front":
      case "behind":
        return {
          position: "absolute",
          left: a.x + (live?.dx ?? 0),
          top: a.y + (live?.dy ?? 0),
          // Lifted while selected so its handles stay reachable over (or out from under) the text.
          zIndex: selected || dragging ? 6 : a.layout === "front" ? 3 : -1,
          lineHeight: 0,
        };
      default:
        return { display: "inline-block", maxWidth: "100%", position: "relative", verticalAlign: "middle", lineHeight: "normal", margin: "0 0.15em" };
    }
  })();

  const look = imageLookStyle({ ...a, rotation: 0 });
  const signedLabel =
    a.kind === "signature" && a.signedAt
      ? `Signed${a.signer ? ` by ${a.signer}` : ""} · ${new Date(a.signedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
      : null;

  return (
    <NodeViewWrapper
      as="span"
      ref={wrapperRef}
      style={wrapperStyle}
      data-free-layout={free ? a.layout : undefined}
      className={`doc-image ${free ? "doc-image-free" : ""} group/img`}
    >
      <span
        ref={frameRef}
        className="relative inline-block max-w-full align-middle"
        style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined, lineHeight: 1 }}
      >
        <img
          ref={imgRef}
          src={a.src}
          alt={a.alt ?? (signedLabel ?? "")}
          title={a.title ?? undefined}
          draggable={false}
          // The reveal's mask would otherwise stay on and clip the selection outline and shadow.
          onAnimationEnd={() => setInkIn(false)}
          onPointerDown={onImagePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ width, height, verticalAlign: "middle", ...look }}
          className={`my-0 max-w-full block select-none ${inkIn ? "doc-signature-ink-in" : ""} ${free ? (selected ? "cursor-move" : "cursor-pointer") : selected ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${
            selected ? "doc-image-selected" : ""
          }`}
        />

        {selected && (
          <>
            {HANDLES.map((h) => (
              <span
                key={h}
                onPointerDown={beginResize(h)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className={`doc-image-handle ${h === "n" || h === "s" ? "doc-image-handle-ns" : h === "e" || h === "w" ? "doc-image-handle-ew" : ""}`}
                style={{ ...HANDLE_POS[h], cursor: CURSOR[h] }}
              />
            ))}
            {free && (
              <>
                <span className="doc-image-rotate-stem" />
                <span
                  className="doc-image-rotate"
                  onPointerDown={beginRotate}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                  data-tip="Rotate (Shift: 15° steps)"
                />
              </>
            )}
          </>
        )}

        {/* Live readout while resizing or rotating. */}
        {live && (live.width !== undefined || live.rotation !== undefined) && (resizeRef.current || rotateRef.current) && (
          <span className="doc-image-readout" style={{ transform: rotation ? `rotate(${-rotation}deg)` : undefined }}>
            {rotateRef.current ? `${Math.round(live.rotation ?? 0)}°` : `${live.width} × ${live.height}`}
          </span>
        )}
      </span>

      {signedLabel && !selected && (
        <span className="doc-signature-seal print:hidden">
          <MdVerified size={12} />
          {signedLabel}
        </span>
      )}

      {toolbarAt &&
        createPortal(
          <div
            className="doc-image-toolbar print:hidden fixed z-[70] flex items-center gap-0.5 rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 px-1 py-1 shadow-[0_6px_20px_rgba(15,23,42,0.16),0_1px_3px_rgba(15,23,42,0.12)]"
            style={{ left: toolbarAt.left, top: toolbarAt.top }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {IMAGE_LAYOUTS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLayout(l.id)}
                className={`doc-image-tool ${a.layout === l.id ? "is-active" : ""}`}
                data-tip={`${l.label} - ${l.hint}`}
                aria-label={l.label}
                aria-pressed={a.layout === l.id}
              >
                <LayoutIcon layout={l.id} />
              </button>
            ))}
            {(a.layout === "inline" || a.layout === "block") && (
              <>
                <span className="doc-image-sep" />
                {(["left", "center", "right"] as ImageAlign[]).map((al) => (
                  <button
                    key={al}
                    type="button"
                    onClick={() => setAlign(al)}
                    className={`doc-image-tool ${currentAlign === al ? "is-active" : ""}`}
                    data-tip={`Align ${al}`}
                    aria-label={`Align ${al}`}
                  >
                    <AlignIcon align={al} />
                  </button>
                ))}
              </>
            )}
            <span className="doc-image-sep" />
            {docId && (
              <button type="button" onClick={() => setShowCrop(true)} className="doc-image-tool" data-tip="Crop" aria-label="Crop">
                <MdCrop size={17} />
              </button>
            )}
            {!free && (
              <button type="button" onClick={() => editor.chain().focus().insertCaption("figure").run()} className="doc-image-tool" data-tip="Caption" aria-label="Caption">
                <MdOutlineSubtitles size={17} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowOptions((v) => !v)}
              className={`doc-image-tool ${showOptions ? "is-active" : ""}`}
              data-tip="Image options - size, rotation, border, transparency, alt text"
              aria-label="Image options"
            >
              <MdTune size={17} />
            </button>
            <button type="button" onClick={() => deleteNode()} className="doc-image-tool hover:!text-red-600" data-tip="Delete" aria-label="Delete">
              <MdDeleteOutline size={17} />
            </button>
          </div>,
          document.body
        )}

      {showOptions && selected && toolbarAt && (
        <DocImageOptionsPanel
          attrs={a}
          docId={docId}
          // Beside the picture when there's room, so it never covers what it's editing.
          anchor={
            toolbarAt.frame.right + 316 < window.innerWidth
              ? { left: toolbarAt.frame.right + 14, top: Math.max(8, toolbarAt.frame.top - 8) }
              : toolbarAt.frame.left - 316 > 0
                ? { left: toolbarAt.frame.left - 314, top: Math.max(8, toolbarAt.frame.top - 8) }
                : { left: toolbarAt.left, top: toolbarAt.top + 46 }
          }
          naturalSize={() => (imgRef.current ? { width: imgRef.current.naturalWidth, height: imgRef.current.naturalHeight } : null)}
          maxWidth={() => {
            const f = pageFrame(view);
            return f ? Math.floor(f.content.right - f.content.left) : 640;
          }}
          onChange={setAttrs}
          onClose={() => setShowOptions(false)}
        />
      )}

      {(guides.length > 0 || inkHit || caret) &&
        createPortal(
          <>
            {guides.map((g, i) =>
              g.axis === "x" ? (
                <div key={i} className="doc-snap-guide print:hidden fixed z-[9999] pointer-events-none" style={{ left: g.at - 0.5, top: g.from, width: 1, height: g.to - g.from }} />
              ) : (
                <div key={i} className="doc-snap-guide print:hidden fixed z-[9999] pointer-events-none" style={{ top: g.at - 0.5, left: g.from, height: 1, width: g.to - g.from }} />
              )
            )}
            {inkHit && <div className="doc-ink-line fixed z-[9999] pointer-events-none" style={{ left: inkHit.left - 6, top: inkHit.y - 1.5, width: inkHit.right - inkHit.left + 12 }} />}
            {caret && <div className="fixed z-[9999] w-0.5 bg-blue-500 rounded-full pointer-events-none" style={{ left: caret.left - 1, top: caret.top, height: caret.height }} />}
          </>,
          document.body
        )}

      {showCrop && docId && <DocImageCropModal docId={docId} src={a.src} onCancel={() => setShowCrop(false)} onApply={handleCropApplied} />}
    </NodeViewWrapper>
  );
};

export default DocImageView;
