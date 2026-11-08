// utils/docImagePlacement.ts
//
// Geometry for free pictures (in front of / behind text - docImageLayout.ts): where the page's
// text area is on screen, which paragraph a picture at a given spot anchors to, committing a moved
// or newly placed picture, and the snapping that makes placement feel exact:
//   - smart guides: the picture's edges/centre snap to the margins and the page's centre line
//   - ink lines: a signature dropped near a signing line ("________", a dotted leader, a bottom-
//     bordered paragraph, a rule) settles onto it, the way a pen signature sits on the line with
//     its lower loops just crossing it. That's Briefcast's signature touch for signing.
// Shared by DocImageView.tsx (dragging a picture) and DocSignaturePlacer.tsx (placing a new one).
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The page card and its text area (inside the margins), in viewport px.
export interface PageFrame {
  card: DOMRect;
  content: { left: number; top: number; right: number; bottom: number };
}

export function pageFrame(view: EditorView): PageFrame | null {
  const card = view.dom.closest(".doc-page-card") as HTMLElement | null;
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  const pad = (v: string) => parseFloat(v) || 0;
  return {
    card: rect,
    content: {
      left: rect.left + pad(cs.paddingLeft),
      top: rect.top + pad(cs.paddingTop),
      right: rect.right - pad(cs.paddingRight),
      bottom: rect.bottom - pad(cs.paddingBottom),
    },
  };
}

// The paragraph (textblock) a free picture whose top-left is at (clientX, clientY) anchors to, and
// the corner its x/y are measured from: the block's padding box, the containing block of an
// absolutely positioned child once docImageLayout.ts makes it position:relative.
export interface Anchor {
  insertPos: number; // where the image node goes - the start of the block
  blockPos: number; // the block's own position
  origin: { left: number; top: number };
}

const canHoldImage = (block: PMNode): boolean => {
  const type = block.type.schema.nodes.image;
  return !!type && block.isTextblock && block.type.contentMatch.matchType(type) !== null;
};

export function anchorAt(view: EditorView, clientX: number, clientY: number, frame: PageFrame | null = pageFrame(view)): Anchor | null {
  const { doc } = view.state;
  const x = frame ? Math.min(Math.max(clientX, frame.content.left + 2), frame.content.right - 2) : clientX;
  // posAtCoords hit-tests the screen: free pictures (including the one being moved) would answer
  // for the text under them, so they're see-through for the moment of the lookup.
  const frees = Array.from(view.dom.querySelectorAll<HTMLElement>(".doc-image-free"));
  const saved = frees.map((el) => el.style.pointerEvents);
  frees.forEach((el) => (el.style.pointerEvents = "none"));
  let hit: ReturnType<EditorView["posAtCoords"]>;
  try {
    hit = view.posAtCoords({ left: x, top: clientY });
    // Above the first line or below the last, posAtCoords can miss - try the nearest text edge.
    if (!hit && frame) hit = view.posAtCoords({ left: x, top: Math.min(Math.max(clientY, frame.content.top + 2), frame.content.bottom - 2) });
  } finally {
    frees.forEach((el, i) => (el.style.pointerEvents = saved[i]));
  }
  const pos = hit ? hit.pos : doc.content.size;
  let $t = TextSelection.near(doc.resolve(Math.min(pos, doc.content.size))).$from;
  // A code block (text only) can't hold a picture: walk to the nearest block that can.
  if (!canHoldImage($t.parent)) {
    let found: number | null = null;
    doc.descendants((node, p) => {
      if (found !== null && p > pos) return false;
      if (node.isTextblock && canHoldImage(node)) {
        if (found === null || Math.abs(p - pos) < Math.abs(found - pos)) found = p;
        return false;
      }
      return true;
    });
    if (found === null) return null;
    $t = doc.resolve((found as number) + 1);
  }
  const blockPos = $t.before($t.depth);
  const dom = view.nodeDOM(blockPos) as HTMLElement | null;
  if (!dom || !(dom instanceof HTMLElement)) return null;
  const r = dom.getBoundingClientRect();
  return { insertPos: $t.start($t.depth), blockPos, origin: { left: r.left + dom.clientLeft, top: r.top + dom.clientTop } };
}

// Puts a free picture whose top-left lands at (left, top) on screen into the document: re-anchored
// to the paragraph under its top edge, so it then moves with that paragraph. `fromPos` is the
// picture's current position when moving one, undefined when placing a new one. Returns the new
// position (selected), or null if there was nowhere to anchor it.
export function commitFreeImage(
  view: EditorView,
  // `anchorAt`: the point whose paragraph to anchor to, when not the picture's top-left - a
  // signature settled on a signing line belongs to the line's paragraph, so it moves with it.
  opts: { fromPos?: number; attrs: Record<string, unknown>; left: number; top: number; anchorAt?: { x: number; y: number } }
): number | null {
  const frame = pageFrame(view);
  const anchor = anchorAt(view, opts.anchorAt?.x ?? opts.left + 1, opts.anchorAt?.y ?? opts.top + 1, frame);
  if (!anchor) return null;
  const x = Math.round(opts.left - anchor.origin.left);
  const y = Math.round(opts.top - anchor.origin.top);
  const { state } = view;
  const type = state.schema.nodes.image;
  let tr = state.tr;
  let at: number;
  if (opts.fromPos !== undefined) {
    const current = state.doc.nodeAt(opts.fromPos);
    if (!current) return null;
    const $from = state.doc.resolve(opts.fromPos);
    const sameBlock = $from.depth > 0 && $from.before($from.depth) === anchor.blockPos;
    if (sameBlock) {
      // Attribute steps only: the node (and its node view) stays, so nothing flickers.
      for (const [k, v] of Object.entries({ ...opts.attrs, x, y })) tr = tr.setNodeAttribute(opts.fromPos, k, v);
      at = opts.fromPos;
    } else {
      tr = tr.delete(opts.fromPos, opts.fromPos + current.nodeSize);
      at = tr.mapping.map(anchor.insertPos);
      tr = tr.insert(at, type.create({ ...current.attrs, ...opts.attrs, x, y }));
    }
  } else {
    at = anchor.insertPos;
    tr = tr.insert(at, type.create({ ...opts.attrs, x, y }));
  }
  tr = tr.setSelection(NodeSelection.create(tr.doc, at));
  view.dispatch(tr);
  return at;
}

// ---------------------------------------------------------------------------------------------
// Snapping

export interface Guide {
  axis: "x" | "y";
  at: number; // viewport px
  from: number;
  to: number;
}

export interface InkLine {
  left: number;
  right: number;
  y: number; // the line's own y (the underscores' baseline / the border), viewport px
}

const SNAP_PX = 6;

// Signing lines on screen: runs of 4+ underscores or 6+ dots (leaders), bottom-bordered
// paragraphs, horizontal rules, and bottom-bordered table cells. Collected once when a drag starts
// (positions relative to the page card, so they survive scrolling), then hit-tested every frame.
export function collectInkLines(view: EditorView, frame: PageFrame): InkLine[] {
  const lines: InkLine[] = [];
  const root = view.dom;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const RUN = /_{4,}|\.{6,}|…{3,}/g;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const text = n.nodeValue ?? "";
    if (text.length < 4) continue;
    RUN.lastIndex = 0;
    for (let m = RUN.exec(text); m; m = RUN.exec(text)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      // A run that wraps onto several lines has one rect per line.
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 24) continue;
        // Underscores draw at the bottom of the line box; dots sit on the baseline a little higher.
        const y = m[0][0] === "_" ? r.bottom - r.height * 0.12 : r.bottom - r.height * 0.22;
        lines.push({ left: r.left - frame.card.left, right: r.right - frame.card.left, y: y - frame.card.top });
      }
    }
  }
  root.querySelectorAll("hr, [data-border-bottom], td, th").forEach((el) => {
    const h = el as HTMLElement;
    const cs = getComputedStyle(h);
    if (h.tagName !== "HR" && (parseFloat(cs.borderBottomWidth) || 0) <= 0) return;
    if (h.tagName !== "HR" && cs.borderBottomStyle === "none") return;
    const r = h.getBoundingClientRect();
    if (r.width < 40) return;
    lines.push({ left: r.left - frame.card.left, right: r.right - frame.card.left, y: r.bottom - frame.card.top });
  });
  return lines;
}

export interface SnapResult {
  left: number;
  top: number;
  guides: Guide[];
  ink: InkLine | null; // viewport coords, when settled on a signing line
}

// Snaps a picture's box (viewport px). Ink lines win over guides vertically when `ink` is given -
// a signature belongs on its line - and keep the horizontal smart guides working along it.
export function snapBox(box: Box, frame: PageFrame, ink: InkLine[] | null, disabled = false): SnapResult {
  if (disabled) return { left: box.left, top: box.top, guides: [], ink: null };
  const { content } = frame;
  const cx = (content.left + content.right) / 2;
  const guides: Guide[] = [];
  let { left, top } = box;

  // Horizontal: left edge to the left margin, right edge to the right margin, centre to centre.
  const xTargets: { edge: number; target: number }[] = [
    { edge: box.left, target: content.left },
    { edge: box.left + box.width, target: content.right },
    { edge: box.left + box.width / 2, target: cx },
  ];
  let bestX: { d: number; shift: number; at: number } | null = null;
  for (const t of xTargets) {
    const d = Math.abs(t.edge - t.target);
    if (d <= SNAP_PX && (!bestX || d < bestX.d)) bestX = { d, shift: t.target - t.edge, at: t.target };
  }
  if (bestX) {
    left += bestX.shift;
    guides.push({ axis: "x", at: bestX.at, from: frame.card.top, to: frame.card.bottom });
  }

  let settled: InkLine | null = null;
  if (ink && ink.length) {
    // The line nearest the picture's bottom edge that it overlaps horizontally by at least a third.
    let best: { d: number; line: InkLine } | null = null;
    for (const l of ink) {
      const line = { left: l.left + frame.card.left, right: l.right + frame.card.left, y: l.y + frame.card.top };
      const overlap = Math.min(left + box.width, line.right) - Math.max(left, line.left);
      if (overlap < Math.min(box.width, line.right - line.left) / 3) continue;
      // A wider catch than the guides: a signature is aimed by eye at a line, not at a pixel.
      const target = line.y + box.height * 0.14 - box.height;
      const d = Math.abs(top - target);
      if (d <= Math.max(18, box.height * 0.35) && (!best || d < best.d)) best = { d, line };
    }
    if (best) {
      top = best.line.y + box.height * 0.14 - box.height;
      settled = best.line;
    }
  }

  if (!settled) {
    const yTargets: { edge: number; target: number }[] = [
      { edge: box.top, target: content.top },
      { edge: box.top + box.height, target: content.bottom },
    ];
    for (const t of yTargets) {
      if (Math.abs(t.edge - t.target) <= SNAP_PX) {
        top += t.target - t.edge;
        guides.push({ axis: "y", at: t.target, from: frame.card.left, to: frame.card.right });
        break;
      }
    }
  }
  return { left, top, guides, ink: settled };
}
