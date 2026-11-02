// utils/docImageLayout.ts
//
// How an image sits in the text - Word's "Wrap text" choices - and the look of the picture itself.
// The image node stays inline in the schema (docSchemaExtensions.ts) in every layout, so it always
// has an anchor in the text the way Word's floating pictures do; the layout only changes how it's
// drawn:
//   inline     - a character in the line (Word "In line with text"); the paragraph's alignment
//                places it, so a picture alone in a centred paragraph is centred
//   block      - on a line of its own, aligned left/centre/right (Word "Top and bottom")
//   wrapLeft   - floats at the left margin with the text flowing round its right side (Word
//   wrapRight    "Square"), and the mirror image
//   front      - free on the page, over the text (Word "In front of text") - signatures, stamps
//   behind     - free on the page, under the text (Word "Behind text") - a letterhead, a seal
// Free pictures (front/behind) are positioned by x/y px from the top-left of the paragraph they're
// anchored to, so they move with that paragraph like Word's "Move with text"; moving one re-anchors
// it to the paragraph under its new top edge (DocImageView.tsx).
//
// The live editor draws images through DocImageView's node view; renderHTML below carries the same
// layout as inline CSS + data attributes, so copy/paste and the .html export keep it.
import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { CSSProperties } from "react";

export type ImageLayout = "inline" | "block" | "wrapLeft" | "wrapRight" | "front" | "behind";
export type ImageAlign = "left" | "center" | "right";
export type ImageKind = "image" | "signature";

export const IMAGE_LAYOUTS: { id: ImageLayout; label: string; hint: string }[] = [
  { id: "inline", label: "In line", hint: "Moves with the text like a character" },
  { id: "block", label: "Break text", hint: "On its own line, aligned left, centre or right" },
  { id: "wrapLeft", label: "Wrap left", hint: "Left of the text, which flows round it" },
  { id: "wrapRight", label: "Wrap right", hint: "Right of the text, which flows round it" },
  { id: "front", label: "In front of text", hint: "Free on the page, over the text" },
  { id: "behind", label: "Behind text", hint: "Free on the page, under the text" },
];

export interface DocImageAttrs {
  src: string;
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
  layout: ImageLayout;
  align: ImageAlign;
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  borderWidth: number;
  borderColor: string;
  radius: number;
  shadow: boolean;
  kind: ImageKind;
  // Signatures: who signed and when (ISO), shown on hover and kept in exports' alt text.
  signer: string | null;
  signedAt: string | null;
}

export const isFreeLayout = (layout: unknown): layout is "front" | "behind" => layout === "front" || layout === "behind";
const LAYOUT_IDS = new Set<string>(IMAGE_LAYOUTS.map((l) => l.id));
const asLayout = (v: unknown): ImageLayout => (typeof v === "string" && LAYOUT_IDS.has(v) ? (v as ImageLayout) : "inline");
const asAlign = (v: unknown): ImageAlign => (v === "left" || v === "right" ? v : "center");
const num = (v: string | null, fallback: number): number => {
  const n = v === null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// The picture's own look - the same in every layout. Rotation is a transform, so it never moves
// the text (as in Word, where a rotated picture keeps its unrotated wrap box).
export function imageLookStyle(a: Pick<DocImageAttrs, "rotation" | "opacity" | "borderWidth" | "borderColor" | "radius" | "shadow">): CSSProperties {
  const style: CSSProperties = {};
  if (a.rotation) style.transform = `rotate(${a.rotation}deg)`;
  if (a.opacity < 1) style.opacity = a.opacity;
  // An inset outline, not a border: it never changes the picture's size or the text around it.
  if (a.borderWidth > 0) {
    style.outline = `${a.borderWidth}px solid ${a.borderColor}`;
    style.outlineOffset = -a.borderWidth;
  }
  if (a.radius > 0) style.borderRadius = a.radius;
  if (a.shadow) style.boxShadow = "0 6px 18px rgba(15, 23, 42, 0.22), 0 1px 4px rgba(15, 23, 42, 0.16)";
  return style;
}

// Where the picture's box goes - for renderHTML (the node view does the same with its wrapper).
export function imagePlacementCss(a: Pick<DocImageAttrs, "layout" | "align" | "x" | "y">): string {
  switch (a.layout) {
    case "block":
      return `display:block;margin-top:4pt;margin-bottom:4pt;${a.align === "left" ? "margin-right:auto" : a.align === "right" ? "margin-left:auto" : "margin-left:auto;margin-right:auto"}`;
    case "wrapLeft":
      return "float:left;margin:2pt 12pt 6pt 0";
    case "wrapRight":
      return "float:right;margin:2pt 0 6pt 12pt";
    case "front":
    case "behind":
      return `position:absolute;left:${Math.round(a.x)}px;top:${Math.round(a.y)}px;z-index:${a.layout === "front" ? 3 : -1}`;
    default:
      return "";
  }
}

const cssFromStyle = (style: CSSProperties): string =>
  Object.entries(style)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${typeof v === "number" && k !== "opacity" ? `${v}px` : v}`)
    .join(";");

// Attribute specs merged into DocImage.addAttributes(). Default values match a plain pasted image,
// so documents from before this layer read back unchanged (an inline picture).
export function docImageAttributeSpecs() {
  const data = (name: string, fallback: number) => ({
    default: fallback,
    parseHTML: (el: HTMLElement) => num(el.getAttribute(`data-${name}`), fallback),
    renderHTML: () => ({}),
  });
  return {
    layout: {
      default: "inline" as ImageLayout,
      parseHTML: (el: HTMLElement) => asLayout(el.getAttribute("data-layout")),
      // One renderHTML owns the whole style string (layout + look), so per-attribute style
      // fragments can't come out in a different order and override each other.
      renderHTML: (attrs: Record<string, unknown>) => {
        const a = attrs as unknown as DocImageAttrs;
        const out: Record<string, string> = {};
        if (a.layout !== "inline") out["data-layout"] = a.layout;
        if (a.layout === "block") out["data-align"] = a.align;
        if (isFreeLayout(a.layout)) {
          out["data-x"] = String(Math.round(a.x));
          out["data-y"] = String(Math.round(a.y));
        }
        if (a.rotation) out["data-rotation"] = String(a.rotation);
        if (a.opacity < 1) out["data-opacity"] = String(a.opacity);
        if (a.borderWidth > 0) {
          out["data-border-width"] = String(a.borderWidth);
          out["data-border-color"] = a.borderColor;
        }
        if (a.radius > 0) out["data-radius"] = String(a.radius);
        if (a.shadow) out["data-shadow"] = "";
        if (a.kind === "signature") out["data-kind"] = "signature";
        if (a.signer) out["data-signer"] = a.signer;
        if (a.signedAt) out["data-signed-at"] = a.signedAt;
        const style = [imagePlacementCss(a), cssFromStyle(imageLookStyle(a))].filter(Boolean).join(";");
        if (style) out.style = style;
        return out;
      },
    },
    align: { default: "center" as ImageAlign, parseHTML: (el: HTMLElement) => asAlign(el.getAttribute("data-align")), renderHTML: () => ({}) },
    x: data("x", 0),
    y: data("y", 0),
    rotation: data("rotation", 0),
    opacity: data("opacity", 1),
    borderWidth: data("border-width", 0),
    borderColor: { default: "#1f2937", parseHTML: (el: HTMLElement) => el.getAttribute("data-border-color") || "#1f2937", renderHTML: () => ({}) },
    radius: data("radius", 0),
    shadow: { default: false, parseHTML: (el: HTMLElement) => el.hasAttribute("data-shadow"), renderHTML: () => ({}) },
    kind: { default: "image" as ImageKind, parseHTML: (el: HTMLElement) => (el.getAttribute("data-kind") === "signature" ? "signature" : "image"), renderHTML: () => ({}) },
    signer: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-signer"), renderHTML: () => ({}) },
    signedAt: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-signed-at"), renderHTML: () => ({}) },
  };
}

// The textblock a free picture is anchored to: its x/y are measured from this block's box, so the
// block gets position:relative (a decoration - never stored in the document).
const ANCHOR_CLASS = "doc-img-anchor";

function buildAnchorDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const seen = new Set<number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "image" || !isFreeLayout(node.attrs.layout)) return true;
    const $pos = doc.resolve(pos);
    if ($pos.depth === 0) return false;
    const from = $pos.before($pos.depth);
    if (seen.has(from)) return false;
    seen.add(from);
    decos.push(Decoration.node(from, $pos.after($pos.depth), { class: ANCHOR_CLASS }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const layoutKey = new PluginKey<DecorationSet>("docImageLayout");

// Whether a letter is drawn under the point (not just a paragraph's empty box).
function pointIsOnText(x: number, y: number): boolean {
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return false;
  const text = range.startContainer as Text;
  const probe = document.createRange();
  for (const off of [range.startOffset - 1, range.startOffset]) {
    if (off < 0 || off >= text.length) continue;
    probe.setStart(text, off);
    probe.setEnd(text, off + 1);
    const b = probe.getBoundingClientRect();
    if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top && y <= b.bottom) return true;
  }
  return false;
}

// Arrow keys nudge a selected free picture (Shift: 10px), as in Word and every design tool -
// instead of collapsing the selection and moving the caret past it.
const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export const DocImageLayout = Extension.create({
  name: "docImageLayout",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: layoutKey,
        state: {
          init: (_, state) => buildAnchorDecorations(state.doc),
          apply: (tr, prev) => (tr.docChanged ? buildAnchorDecorations(tr.doc) : prev),
        },
        props: {
          decorations: (state) => layoutKey.getState(state),
          handleDOMEvents: {
            // A picture behind the text sits under the paragraphs, so clicks land on them. Clicking
            // the picture where there's no letter under the pointer (or Alt+click anywhere on it)
            // selects it, as Word does; it then lifts above the text for editing (DocImageView).
            mousedown: (view, event) => {
              if (event.button !== 0) return false;
              const behind = view.dom.querySelectorAll<HTMLElement>('[data-free-layout="behind"]');
              for (const el of Array.from(behind)) {
                const r = el.getBoundingClientRect();
                if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) continue;
                if (!event.altKey && pointIsOnText(event.clientX, event.clientY)) return false;
                let target: number | null = null;
                view.state.doc.descendants((node, pos) => {
                  if (target !== null) return false;
                  if (node.type.name === "image" && (view.nodeDOM(pos) as HTMLElement | null)?.contains(el)) target = pos;
                  return true;
                });
                if (target === null) continue;
                event.preventDefault();
                view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, target)));
                view.focus();
                return true;
              }
              return false;
            },
          },
          handleKeyDown: (view, event) => {
            const step = NUDGE[event.key];
            const sel = view.state.selection;
            if (!step || !(sel instanceof NodeSelection) || sel.node.type.name !== "image" || !isFreeLayout(sel.node.attrs.layout)) return false;
            const d = event.shiftKey ? 10 : 1;
            const tr = view.state.tr
              .setNodeAttribute(sel.from, "x", Math.round((sel.node.attrs.x as number) + step[0] * d))
              .setNodeAttribute(sel.from, "y", Math.round((sel.node.attrs.y as number) + step[1] * d));
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});
