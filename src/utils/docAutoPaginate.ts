// utils/docAutoPaginate.ts
//
// Live-editing pagination preview - purely visual (decorations only, never touches document
// content), so it can't desync from the Yjs-synced doc or interfere with autosave/collaboration.
// This is NOT what controls the actual print/PDF output - that's the `@page`/`break-after` CSS
// added alongside page setup, which does real line-accurate pagination natively in Chromium's
// print engine. This extension approximates that at block granularity (a paragraph/heading/list-
// item/image/table never splits mid-block) so the editing view visually matches what printing will
// produce, without attempting to reimplement a text layout engine.
//
// Block-level was a deliberate choice over line-accurate breaking inside a paragraph: measuring
// individual line boxes correctly across every mark/inline-node combination is a much larger and
// more fragile undertaking, and most paragraphs are short enough relative to a page that "the whole
// paragraph moves to the next page" costs at most a few lines of trailing whitespace on the page
// before it.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { DocPageSize } from "./docTypes";
import { pageContentHeightPx } from "./docPageGeometry";

interface PaginationState {
  pageSize: DocPageSize;
  decorations: DecorationSet;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docAutoPaginate: {
      setPaginationPageSize: (pageSize: DocPageSize) => ReturnType;
    };
  }
}

export const DocAutoPaginatePluginKey = new PluginKey<PaginationState>("docAutoPaginate");

// Extra visual height a gap adds on top of "however much space was actually left on the page" -
// matches docPageLayout.css's ::before/::after caps (20px each), giving the closing/opening page
// edges room to render instead of being squeezed to nothing when a block happens to end almost
// exactly at the page boundary already.
const PAGE_GAP_VISUAL_PX = 40;

function gapHeight(spaceLeftPx: number): number {
  return Math.max(0, spaceLeftPx) + PAGE_GAP_VISUAL_PX;
}

function buildGapWidget(pos: number, height: number): HTMLElement {
  const el = document.createElement("div");
  // print:hidden - this is a live-editing-only preview; the actual print/PDF pagination is owned
  // entirely by the @page/break-after CSS and must never be duplicated or fought with here.
  el.className = "doc-page-gap print:hidden";
  el.style.height = `${height}px`;
  el.contentEditable = "false";
  // Read back by the *next* measurement pass (see gapHeightBefore below) to undo this gap's own
  // effect on later blocks' rendered positions - without this, each pass measures a layout that
  // already includes the previous pass's gaps, feeding back into itself and never settling (gaps
  // visibly growing and shrinking in a loop instead of converging).
  el.dataset.pos = String(pos);
  return el;
}

// Sum of the heights of every gap widget *currently rendered* at or before `offset`, read straight
// from the live DOM rather than tracked separately - this is what lets computeDecorations undo the
// previous pass's own gaps before doing its break-point math, so every pass reasons about the same
// gap-free coordinate space regardless of what's already been inserted.
function existingGapHeightBefore(view: EditorView, offset: number): number {
  const gaps = view.dom.querySelectorAll<HTMLElement>(".doc-page-gap");
  let total = 0;
  gaps.forEach((el) => {
    const pos = Number(el.dataset.pos);
    if (!Number.isNaN(pos) && pos <= offset) total += el.getBoundingClientRect().height;
  });
  return total;
}

interface PaginationResult {
  decorations: DecorationSet;
  // A cheap fingerprint (rounded pos+height pairs) of what was just computed - inserting these
  // gap widgets itself changes view.dom's rendered height, which the same ResizeObserver below is
  // watching, so every dispatch would otherwise re-trigger *another* scheduled recompute. Comparing
  // against this before dispatching stops that at "one harmless extra pass" instead of a
  // dispatch-triggers-observer-triggers-dispatch loop - the second pass recomputes an identical
  // signature (nodeDOM only ever resolves real content nodes, never these widgets themselves, so
  // the breaks it finds don't change once the layout has settled) and is simply dropped.
  signature: string;
}

// One O(n) pass over top-level blocks, reading each one's already-rendered layout - no block is
// measured more than once, and no mid-pass re-measurement is needed, since every decoration this
// produces only adds vertical space *after* the point it's measuring (so earlier measurements in
// the same pass are never invalidated by a later decoration).
function computeDecorations(view: EditorView, pageSize: DocPageSize): PaginationResult {
  const { state } = view;
  const contentHeight = pageContentHeightPx(pageSize);
  const containerTop = view.dom.getBoundingClientRect().top;
  const decorations: Decoration[] = [];
  const signatureParts: string[] = [];
  let pageTop = 0;

  const addGap = (pos: number, side: -1 | 1, height: number) => {
    const rounded = Math.round(height);
    decorations.push(Decoration.widget(pos, () => buildGapWidget(pos, rounded), { side }));
    signatureParts.push(`${pos}:${rounded}`);
  };

  state.doc.forEach((node, offset) => {
    // view.nodeDOM (not raw DOM child indexing) - this extension's own previously-inserted gap
    // widgets are themselves extra top-level DOM siblings that don't correspond to any doc node,
    // which would desync a plain positional index; nodeDOM resolves correctly regardless.
    const dom = view.nodeDOM(offset);
    if (!(dom instanceof HTMLElement)) return;

    // Normalized back to "as if no gaps existed yet" - the live DOM already reflects whatever this
    // extension inserted last pass, so the raw rect alone would double-count that on every
    // subsequent measurement (see existingGapHeightBefore's own comment).
    const alreadyShifted = existingGapHeightBefore(view, offset);
    const rect = dom.getBoundingClientRect();
    const top = rect.top - containerTop - alreadyShifted;
    const bottom = rect.bottom - containerTop - alreadyShifted;

    if (node.type.name === "pageBreak") {
      // A manual break always starts a fresh page immediately after it, regardless of how much
      // room was left - composes with automatic breaks the same way a real page break would.
      addGap(offset + node.nodeSize, 1, gapHeight(pageTop + contentHeight - bottom));
      pageTop = bottom;
      return;
    }

    const overflowsPage = bottom - pageTop > contentHeight;
    const tallerThanWholePage = bottom - top > contentHeight;
    // A block taller than an entire page (a huge image, a long table) has nowhere better to go -
    // it just overflows that one page rather than triggering an endless string of empty pages.
    // `top > pageTop` guards the degenerate case of a block that's *already* at the top of the
    // current page but still overflows - moving it "to the next page" would just repeat forever.
    if (overflowsPage && !tallerThanWholePage && top > pageTop) {
      addGap(offset, -1, gapHeight(pageTop + contentHeight - top));
      pageTop = top;
    }
  });

  return { decorations: DecorationSet.create(state.doc, decorations), signature: signatureParts.join("|") };
}

const DocAutoPaginate = Extension.create({
  name: "docAutoPaginate",

  addCommands() {
    return {
      setPaginationPageSize:
        (pageSize: DocPageSize) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(DocAutoPaginatePluginKey, { pageSize }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<PaginationState>({
        key: DocAutoPaginatePluginKey,
        state: {
          init: (): PaginationState => ({ pageSize: "letter", decorations: DecorationSet.empty }),
          apply(tr, prev) {
            const meta = tr.getMeta(DocAutoPaginatePluginKey) as Partial<PaginationState> | undefined;
            if (meta?.pageSize) return { ...prev, pageSize: meta.pageSize };
            if (meta?.decorations) return { ...prev, decorations: meta.decorations };
            // Map existing decorations through the edit so they don't vanish/misplace for the
            // brief window before the next debounced recompute (triggered by the ResizeObserver
            // below, since view.dom's own height changes on essentially every edit that matters
            // here) actually lands.
            if (tr.docChanged) return { ...prev, decorations: prev.decorations.map(tr.mapping, tr.doc) };
            return prev;
          },
        },
        props: {
          decorations(state) {
            return DocAutoPaginatePluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
        view(editorView) {
          let frame: number | null = null;
          let lastSignature = "";
          const scheduleRecompute = () => {
            if (frame !== null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              const pageSize = DocAutoPaginatePluginKey.getState(editorView.state)?.pageSize ?? "letter";
              const result = computeDecorations(editorView, pageSize);
              if (result.signature === lastSignature) return;
              lastSignature = result.signature;
              editorView.dispatch(editorView.state.tr.setMeta(DocAutoPaginatePluginKey, { decorations: result.decorations }));
            });
          };

          // view.dom's own rendered height changes on every reflow that matters here - text
          // wrapping, an image finishing loading, a table edit, a page-size change re-triggering
          // layout - so this single observer covers all of those without also needing a separate
          // per-transaction hook for content edits.
          const observer = new ResizeObserver(scheduleRecompute);
          observer.observe(editorView.dom);

          return {
            update(view, prevState) {
              // A page-size change (meta-only, no docChanged) doesn't itself resize view.dom, so
              // the ResizeObserver above wouldn't fire for it on its own - catch that case here.
              const prevSize = DocAutoPaginatePluginKey.getState(prevState)?.pageSize;
              const nextSize = DocAutoPaginatePluginKey.getState(view.state)?.pageSize;
              if (prevSize !== nextSize) scheduleRecompute();
            },
            destroy() {
              observer.disconnect();
              if (frame !== null) cancelAnimationFrame(frame);
            },
          };
        },
      }),
    ];
  },
});

export default DocAutoPaginate;
