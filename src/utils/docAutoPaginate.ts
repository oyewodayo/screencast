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
import type { DocMargins, DocPageSize } from "./docTypes";
import { DEFAULT_MARGINS, PAGE_GAP_PX, inToPx, pageContentHeightPx } from "./docPageGeometry";

interface PaginationState {
  // Pages in the live preview (gaps + 1) - shown in the editor header next to the word count.
  pageCount: number;
  pageSize: DocPageSize;
  margins: DocMargins;
  // 2 = two-column page (docLayout.ts): the browser's own multicol layout breaks columns and pages
  // (see DocsEditor.tsx's column rules), so this plugin draws no gaps and only counts the pages.
  columns: 1 | 2;
  decorations: DecorationSet;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docAutoPaginate: {
      setPaginationLayout: (pageSize: DocPageSize, margins: DocMargins, columns?: 1 | 2) => ReturnType;
    };
  }
}

export const DocAutoPaginatePluginKey = new PluginKey<PaginationState>("docAutoPaginate");

// A gap is everything between the last line of one page and the first line of the next, exactly
// as on paper: the unused rest of the page, its bottom margin, the canvas strip between sheets,
// then the next sheet's top margin. The previous version had only the leftover space plus two
// fixed 20px caps standing in for both margins and painted the leftover as canvas, so when a page
// happened to be nearly full the "break" collapsed to a hairline and the next page's text started
// 20px below its edge.
interface GapParts {
  pageEnd: number; // leftover space + bottom margin (white)
  canvas: number;
  pageStart: number; // next page's top margin (white)
}

function gapParts(spaceLeftPx: number, margins: DocMargins): GapParts {
  return { pageEnd: Math.max(0, spaceLeftPx) + inToPx(margins.bottom), canvas: PAGE_GAP_PX, pageStart: inToPx(margins.top) };
}

function gapTotal(parts: GapParts): number {
  return parts.pageEnd + parts.canvas + parts.pageStart;
}

function buildGapWidget(pos: number, parts: GapParts, margins: DocMargins): HTMLElement {
  const el = document.createElement("div");
  // print:hidden - this is a live-editing-only preview; the actual print/PDF pagination is owned
  // entirely by the @page/break-after CSS and must never be duplicated or fought with here.
  el.className = "doc-page-gap print:hidden";
  el.style.height = `${Math.round(gapTotal(parts))}px`;
  // Reaches past the card's padding (the page margins) plus 4px to paint over its ring/shadow -
  // see docPageLayout.css.
  el.style.marginLeft = `-${inToPx(margins.left) + 4}px`;
  el.style.marginRight = `-${inToPx(margins.right) + 4}px`;
  el.contentEditable = "false";
  for (const [cls, h] of [
    ["doc-page-gap-end", parts.pageEnd],
    ["doc-page-gap-canvas", parts.canvas],
    ["doc-page-gap-start", parts.pageStart],
  ] as const) {
    const part = document.createElement("div");
    part.className = cls;
    part.style.height = `${Math.round(h)}px`;
    el.appendChild(part);
  }
  // Read back by the *next* measurement pass (see gapHeightBefore below) to undo this gap's own
  // effect on later blocks' rendered positions - without this, each pass measures a layout that
  // already includes the previous pass's gaps, feeding back into itself and never settling (gaps
  // visibly growing and shrinking in a loop instead of converging).
  el.dataset.pos = String(pos);
  return el;
}

function buildTailWidget(height: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "doc-page-tail print:hidden";
  el.style.height = `${height}px`;
  el.contentEditable = "false";
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
    // Its layout contribution, not just its box: the gap's -1rem bottom margin (docPageLayout.css)
    // means it pushes later blocks down by height - 1rem. Subtracting the bare height measured
    // every block after a gap 16px off, so the next pass placed the following break 16px late.
    if (!Number.isNaN(pos) && pos <= offset) total += el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).marginBottom) || 0);
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

function keepsWithNext(block: import("@tiptap/pm/model").Node, next: import("@tiptap/pm/model").Node): boolean {
  if (block.type.name === "heading") return true;
  if (block.type.name === "caption" && block.attrs.kind === "table") return next.type.name === "table";
  // A table captioned underneath (theses often do) keeps its caption on its page.
  if (block.type.name === "table" && next.type.name === "caption") return true;
  if (next.type.name === "caption" && next.attrs.kind === "figure") {
    let hasImage = false;
    block.descendants((n) => {
      if (n.type.name === "image") hasImage = true;
      return !hasImage;
    });
    return hasImage;
  }
  return false;
}

// One O(n) pass over top-level blocks, reading each one's already-rendered layout - no block is
// measured more than once, and no mid-pass re-measurement is needed, since every decoration this
// produces only adds vertical space *after* the point it's measuring (so earlier measurements in
// the same pass are never invalidated by a later decoration).
// Distance from one page's text area to the next in the two-column view: the text height plus the
// bottom margin, the canvas strip and the next top margin - the multicol row gap.
export function columnRowGapPx(margins: DocMargins): number {
  return inToPx(margins.bottom + margins.top) + PAGE_GAP_PX;
}

// The page (1-based) a top-level block at `top` px below the editor's top lands on, in the
// two-column view.
function columnPageAt(top: number, pageSize: DocPageSize, margins: DocMargins): number {
  const pitch = pageContentHeightPx(pageSize, margins) + columnRowGapPx(margins);
  return Math.max(1, Math.floor((top + 0.5) / pitch) + 1);
}

function columnPageCount(view: EditorView, pageSize: DocPageSize, margins: DocMargins): number {
  const content = pageContentHeightPx(pageSize, margins);
  const gap = columnRowGapPx(margins);
  return Math.max(1, Math.round((view.dom.getBoundingClientRect().height + gap) / (content + gap)));
}

function computeDecorations(view: EditorView, pageSize: DocPageSize, margins: DocMargins, columns: 1 | 2): PaginationResult & { pageCount?: number } {
  const { state } = view;
  if (columns === 2) {
    // A page break is a forced column break (docLayout.css); one in the left column gets a second
    // break right after it, so what follows starts the next page, not the right-hand column.
    const decorations: Decoration[] = [];
    const breaks: number[] = [];
    const box = view.dom.getBoundingClientRect();
    state.doc.forEach((node, offset) => {
      if (node.type.name !== "pageBreak") return;
      const dom = view.nodeDOM(offset);
      if (!(dom instanceof HTMLElement)) return;
      if (dom.getBoundingClientRect().left - box.left < box.width / 3) {
        const pos = offset + node.nodeSize;
        decorations.push(
          Decoration.widget(
            pos,
            () => {
              const el = document.createElement("div");
              el.className = "doc-col-break";
              el.contentEditable = "false";
              return el;
            },
            { side: -1, key: `colbreak:${pos}` }
          )
        );
        breaks.push(pos);
      }
    });
    const pageCount = columnPageCount(view, pageSize, margins);
    return {
      decorations: DecorationSet.create(state.doc, decorations),
      pageCount,
      signature: `cols:${pageSize}:${margins.top},${margins.right},${margins.bottom},${margins.left}|${pageCount}|${breaks.join(",")}`,
    };
  }
  const contentHeight = pageContentHeightPx(pageSize, margins);
  const containerTop = view.dom.getBoundingClientRect().top;
  const decorations: Decoration[] = [];
  const signatureParts: string[] = [];
  let pageTop = 0;

  const addGap = (pos: number, side: -1 | 1, spaceLeft: number) => {
    const parts = gapParts(spaceLeft, margins);
    const rounded = Math.round(gapTotal(parts));
    // ProseMirror reuses a widget's DOM while its key is unchanged, so the key holds every value the
    // DOM is built from - a top-margin change can leave the total height identical (less leftover,
    // more top margin) and the old widget would otherwise stay on screen.
    decorations.push(Decoration.widget(pos, () => buildGapWidget(pos, parts, margins), { side, key: `gap:${pos}:${Math.round(parts.pageEnd)}:${parts.pageStart}:${margins.left}:${margins.right}` }));
    signatureParts.push(`${pos}:${rounded}`);
  };
  // Bottom of the previous block - a page's leftover space runs from there, not from the next
  // block's top, because the block spacing between them doesn't belong to either page (the gap
  // cancels the next block's top margin in docPageLayout.css). That keeps every sheet exactly
  // pageHeight tall, so page k starts at k * (pageHeight + PAGE_GAP_PX) - DocRuler.tsx's vertical
  // ruler relies on it.
  let lastBottom = 0;
  let pageStartPending = false;
  // The block before the current one, for keep-with-next: where it starts, and where the page's
  // content ended before it.
  let prev: { node: import("@tiptap/pm/model").Node; offset: number; top: number; bottomBefore: number } | null = null;

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
    // Including any bottom margin the block keeps (the page-break tag has one) - the next thing
    // starts after it, so it belongs to this page.
    const bottom = rect.bottom + (parseFloat(getComputedStyle(dom).marginBottom) || 0) - containerTop - alreadyShifted;

    if (pageStartPending) {
      pageTop = top;
      pageStartPending = false;
    }

    if (node.type.name === "pageBreak") {
      // A manual break always starts a fresh page immediately after it, regardless of how much
      // room was left - composes with automatic breaks the same way a real page break would. The
      // new page begins at the next block's top.
      addGap(offset + node.nodeSize, 1, pageTop + contentHeight - bottom);
      pageTop = bottom;
      pageStartPending = true;
      prev = null; // nothing keeps with a block across a manual break
      lastBottom = bottom;
      return;
    }

    const overflowsPage = bottom - pageTop > contentHeight;
    const tallerThanWholePage = bottom - top > contentHeight;
    // A block taller than an entire page (a huge image, a long table) has nowhere better to go -
    // it just overflows that one page rather than triggering an endless string of empty pages.
    // `top > pageTop` guards the degenerate case of a block that's *already* at the top of the
    // current page but still overflows - moving it "to the next page" would just repeat forever.
    if (overflowsPage && !tallerThanWholePage && top > pageTop) {
      // Keep-with-next, as in Word and LaTeX: a heading never ends a page alone, a table caption
      // stays with its table, a figure with the caption under it - the pair moves together,
      // unless the first of them already starts the page.
      if (prev && prev.top > pageTop && keepsWithNext(prev.node, node)) {
        addGap(prev.offset, -1, pageTop + contentHeight - prev.bottomBefore);
        pageTop = prev.top;
      } else {
        addGap(offset, -1, pageTop + contentHeight - lastBottom);
        pageTop = top;
      }
    }
    prev = { node, offset, top, bottomBefore: lastBottom };
    lastBottom = bottom;
  });

  // Fills the last page out to full height, so the document ends on a whole sheet the way it will
  // print rather than wherever the text stops.
  const tail = Math.round(pageTop + contentHeight - lastBottom);
  if (tail > 0) {
    decorations.push(
      Decoration.widget(state.doc.content.size, () => buildTailWidget(tail), { side: 1, key: `tail:${tail}`, ignoreSelection: true })
    );
    signatureParts.push(`tail:${tail}`);
  }

  // Layout is part of the signature: gap widgets carry the side margins, so a margin change must
  // redraw them even when every break lands in the same place.
  const layout = `${pageSize}:${margins.top},${margins.right},${margins.bottom},${margins.left}`;
  return { decorations: DecorationSet.create(state.doc, decorations), signature: `${layout}|${signatureParts.join("|")}` };
}

const DocAutoPaginate = Extension.create({
  name: "docAutoPaginate",

  addCommands() {
    return {
      setPaginationLayout:
        (pageSize: DocPageSize, margins: DocMargins, columns: 1 | 2 = 1) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(DocAutoPaginatePluginKey, { pageSize, margins, columns }));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<PaginationState>({
        key: DocAutoPaginatePluginKey,
        state: {
          init: (): PaginationState => ({ pageSize: "letter", margins: DEFAULT_MARGINS, columns: 1, decorations: DecorationSet.empty, pageCount: 1 }),
          apply(tr, prev) {
            const meta = tr.getMeta(DocAutoPaginatePluginKey) as Partial<PaginationState> | undefined;
            if (meta?.pageSize) return { ...prev, pageSize: meta.pageSize, margins: meta.margins ?? prev.margins, columns: meta.columns ?? prev.columns };
            if (meta?.decorations)
              return {
                ...prev,
                decorations: meta.decorations,
                pageCount: meta.pageCount ?? meta.decorations.find(undefined, undefined, (spec) => String(spec.key ?? "").startsWith("gap:")).length + 1,
              };
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
              const st = DocAutoPaginatePluginKey.getState(editorView.state);
              const result = computeDecorations(editorView, st?.pageSize ?? "letter", st?.margins ?? DEFAULT_MARGINS, st?.columns ?? 1);
              if (result.signature === lastSignature) return;
              lastSignature = result.signature;
              editorView.dispatch(editorView.state.tr.setMeta(DocAutoPaginatePluginKey, { decorations: result.decorations, pageCount: result.pageCount }));
              // New gaps move everything after them; check once more against that layout rather
              // than relying on the ResizeObserver, which stays silent when the total height
              // happens not to change. Settles as soon as a pass reproduces the same signature.
              scheduleRecompute();
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
              const prev = DocAutoPaginatePluginKey.getState(prevState);
              const next = DocAutoPaginatePluginKey.getState(view.state);
              if (prev?.pageSize !== next?.pageSize || prev?.margins !== next?.margins || prev?.columns !== next?.columns) scheduleRecompute();
              // Two columns: the rows have a fixed height, so an edit that moves a page break
              // between columns may not resize anything - re-check after every edit (one per frame).
              else if (next?.columns === 2 && !prevState.doc.eq(view.state.doc)) scheduleRecompute();
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

export function getPaginationPageCount(state: import("@tiptap/pm/state").EditorState): number {
  return DocAutoPaginatePluginKey.getState(state)?.pageCount ?? 1;
}

// The page (1-based) that the top-level block containing `pos` starts on, in the live view - what
// the table of contents prints. Single column: one page per gap widget before it. Two columns: from
// the block's rendered position in the multicol rows.
export function pageAtPos(view: EditorView, pos: number): number {
  const $pos = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size));
  const top = $pos.depth >= 1 ? $pos.before(1) : pos;
  const st = DocAutoPaginatePluginKey.getState(view.state);
  if (st?.columns === 2) {
    const dom = view.nodeDOM(top);
    if (!(dom instanceof HTMLElement)) return 1;
    return columnPageAt(dom.getBoundingClientRect().top - view.dom.getBoundingClientRect().top, st.pageSize, st.margins);
  }
  let page = 1;
  view.dom.querySelectorAll<HTMLElement>(".doc-page-gap").forEach((gap) => {
    const gapPos = Number(gap.dataset.pos);
    if (!Number.isNaN(gapPos) && gapPos <= top) page++;
  });
  return page;
}
