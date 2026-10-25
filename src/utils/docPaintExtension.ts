// utils/docPaintExtension.ts
//
// "Highlighter mode" for text colour and highlight - Word's highlighter pen, for both colours.
//
// Picking a colour with text selected just applies it (DocToolbar.tsx). Picking one with nothing
// selected arms this mode instead: the pointer turns into a marker in that colour and every
// selection the user then makes - a drag, a double-click on a word, Shift+arrows - is painted the
// moment it's finished, with a live preview while the drag is still in progress. Painting text
// that already carries exactly that colour removes it again (an eraser for the same pen), so a
// mis-stroke is fixed by stroking it again. Esc, the toolbar button, or picking "None" ends it.
//
// Each stroke is a single transaction, so Undo steps back one stroke at a time.
import { Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isKeyHandled } from "./keyEvents";

export type PaintKind = "color" | "highlight";

export interface PaintState {
  kind: PaintKind;
  color: string;
}

export const paintPluginKey = new PluginKey<PaintState | null>("docPaint");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docPaint: {
      startPaint: (kind: PaintKind, color: string) => ReturnType;
      stopPaint: () => ReturnType;
    };
  }
}

export function getPaintState(editor: Editor): PaintState | null {
  return paintPluginKey.getState(editor.state) ?? null;
}

// Marker-pen cursor tinted with the active colour; hotspot at the pen tip.
function cursorFor(paint: PaintState): string {
  const fill = paint.color.replace(/#/g, "%23");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<path d='M14.5 3.2l6.3 6.3-9.4 9.4-4.6.9.9-4.6z' fill='${fill}' stroke='%23111' stroke-width='1.3' stroke-linejoin='round'/>` +
    `<path d='M3 21.5h8' stroke='${fill}' stroke-width='3' stroke-linecap='round'/>` +
    `</svg>`;
  return `url("data:image/svg+xml;utf8,${svg}") 4 20, text`;
}

// Applies (or, if the whole range already has exactly this colour, removes) the paint on [from,to].
function paintRange(editor: Editor, paint: PaintState, from: number, to: number) {
  const markName = paint.kind === "highlight" ? "highlight" : "textStyle";
  let sameColor = true;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    if (node.marks.find((m) => m.type.name === markName)?.attrs.color !== paint.color) sameColor = false;
    return false;
  });
  const chain = editor.chain().setTextSelection({ from, to });
  if (paint.kind === "color") (sameColor ? chain.unsetColor() : chain.setColor(paint.color)).run();
  else (sameColor ? chain.unsetHighlight() : chain.setHighlight({ color: paint.color })).run();
  // Collapse to the end of the stroke so the colour is visible rather than hidden under the
  // selection highlight, ready for the next stroke.
  editor.commands.setTextSelection(to);
}

const DocPaint = Extension.create({
  name: "docPaint",

  addCommands() {
    return {
      startPaint:
        (kind: PaintKind, color: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(paintPluginKey, { kind, color } satisfies PaintState);
          return true;
        },
      stopPaint:
        () =>
        ({ tr, dispatch, state }) => {
          if (!paintPluginKey.getState(state)) return false;
          if (dispatch) tr.setMeta(paintPluginKey, null);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    let dragging = false;

    const commit = () => {
      const paint = paintPluginKey.getState(editor.state);
      const sel = editor.state.selection;
      if (!paint || sel.empty || !(sel instanceof TextSelection)) return;
      // Windows' double-click word selection includes the trailing space - don't paint it, or the
      // highlight visibly runs past the word.
      let { from, to } = sel;
      const text = editor.state.doc.textBetween(from, to, "\n", "\u0000");
      from += text.length - text.trimStart().length;
      to -= text.length - text.trimEnd().length;
      if (to <= from) return;
      paintRange(editor, paint, from, to);
    };

    return [
      new Plugin<PaintState | null>({
        key: paintPluginKey,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(paintPluginKey) as PaintState | null | undefined;
            return meta === undefined ? value : meta;
          },
        },
        props: {
          // Live preview of the stroke while the drag (or Shift-selection) is still going.
          decorations(state) {
            const paint = paintPluginKey.getState(state);
            const { selection } = state;
            if (!paint || selection.empty) return null;
            const style = paint.kind === "highlight" ? `background-color: ${paint.color}` : `color: ${paint.color}`;
            return DecorationSet.create(state.doc, [Decoration.inline(selection.from, selection.to, { class: "doc-paint-preview", style })]);
          },
          handleDOMEvents: {
            mousedown: () => {
              dragging = true;
              return false;
            },
            keyup: (_view, event) => {
              if (!dragging && event.key === "Shift") commit();
              return false;
            },
          },
        },
        view(view) {
          const sync = () => {
            const paint = paintPluginKey.getState(view.state);
            view.dom.classList.toggle("doc-paint-active", !!paint);
            view.dom.style.cursor = paint ? cursorFor(paint) : "";
          };
          sync();
          // On the window, not the editor: a drag released outside the page still ends the stroke.
          const onUp = () => {
            if (!dragging) return;
            dragging = false;
            // After ProseMirror has read the final DOM selection (and a double-click's word
            // selection has landed).
            setTimeout(commit, 0);
          };
          window.addEventListener("mouseup", onUp);
          // Esc ends the mode wherever focus is - after clicking the banner, the toolbar or the page
          // background the editor isn't focused, and an editor-only key handler never saw it. An
          // open menu gets Esc first (it closes), and so does a text field such as the title.
          const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || !paintPluginKey.getState(view.state)) return;
            if (isKeyHandled(e) || document.querySelector('[role="menu"], [role="dialog"]')) return;
            const t = e.target as HTMLElement | null;
            if (t && t !== view.dom && !view.dom.contains(t) && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
            e.preventDefault();
            editor.commands.stopPaint();
          };
          document.addEventListener("keydown", onKey);
          return {
            update: sync,
            destroy() {
              window.removeEventListener("mouseup", onUp);
              document.removeEventListener("keydown", onKey);
              view.dom.classList.remove("doc-paint-active");
              view.dom.style.cursor = "";
            },
          };
        },
      }),
    ];
  },
});

export default DocPaint;
