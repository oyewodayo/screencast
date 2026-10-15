// utils/docDictationExtension.ts
//
// Editor-side state for Docs dictation (useDocDictation.ts drives the microphone/whisper side).
// A ProseMirror plugin, not React state, because the thing it tracks - *where* the next chunk of
// dictated text lands - is a document position, and positions have to be mapped through every
// transaction (the user typing above it, a collaborator's remote edit, an earlier chunk landing)
// to stay correct. The previous implementation kept a raw {from, to} in a ref and wrote interim
// text straight into the document, so any edit during dictation shifted the range and the final
// transcript replaced the wrong text; it also churned the Y.Doc and undo stack with every interim
// guess.
//
// Here interim text never touches the document: it's a widget decoration at the anchor (grey,
// with a pulsing "…" while chunks are still transcribing). Only final text is inserted, one
// transaction per chunk, so undo/"scratch that" step back a phrase at a time.
//
// The anchor follows the user: clicking or arrowing somewhere else mid-dictation moves the
// insertion point there (Google Docs' behaviour), detected as a selection change shortly after real
// keyboard/mouse input rather than any selection change - remote Yjs updates and our own inserts
// also move the selection and must not re-anchor.
import { Command, Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { DictationOp, fitToContext, trailingPeriodToDrop } from "./dictationText";

interface DictationRange {
  from: number;
  to: number;
}

export interface DictationPluginState {
  active: boolean;
  anchor: number | null;
  lastRange: DictationRange | null;
  preview: string;
  pending: number;
}

type DictationMeta = Partial<DictationPluginState>;

export const dictationPluginKey = new PluginKey<DictationPluginState>("docDictation");

const IDLE: DictationPluginState = { active: false, anchor: null, lastRange: null, preview: "", pending: 0 };

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docDictation: {
      beginDictation: () => ReturnType;
      pauseDictation: () => ReturnType;
      endDictation: () => ReturnType;
      setDictationPreview: (preview: string) => ReturnType;
      setDictationPending: (pending: number) => ReturnType;
    };
  }
}

export function getDictationState(state: EditorState): DictationPluginState {
  return dictationPluginKey.getState(state) ?? IDLE;
}

function clampPos(state: EditorState, pos: number): number {
  return Math.max(0, Math.min(pos, state.doc.content.size));
}

function buildPreviewWidget(preview: string, pending: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "doc-dictation-preview";
  el.setAttribute("contenteditable", "false");
  el.setAttribute("aria-live", "polite");
  if (preview) {
    const text = document.createElement("span");
    text.className = "doc-dictation-preview-text";
    text.textContent = preview;
    el.appendChild(text);
  }
  if (pending > 0 || !preview) {
    const dots = document.createElement("span");
    dots.className = `doc-dictation-dots${pending > 0 ? " is-working" : ""}`;
    dots.innerHTML = "<i></i><i></i><i></i>";
    el.appendChild(dots);
  }
  return el;
}

const DocDictation = Extension.create({
  name: "docDictation",

  addCommands() {
    const withMeta =
      (meta: DictationMeta): Command =>
      ({ tr, dispatch }) => {
        if (dispatch) tr.setMeta(dictationPluginKey, meta);
        return true;
      };
    return {
      beginDictation:
        () =>
        ({ tr, dispatch, state }) => {
          if (dispatch) tr.setMeta(dictationPluginKey, { ...IDLE, active: true, anchor: state.selection.head } satisfies DictationMeta);
          return true;
        },
      // Stops listening but keeps the anchor - chunks still transcribing land where they belong.
      pauseDictation: () => withMeta({ active: false, preview: "" }),
      endDictation: () => withMeta({ ...IDLE }),
      setDictationPreview: (preview: string) => withMeta({ preview }),
      setDictationPending: (pending: number) => withMeta({ pending }),
    };
  },

  addProseMirrorPlugins() {
    let lastUserInput = 0;
    const markUserInput = () => {
      lastUserInput = Date.now();
      return false;
    };

    return [
      new Plugin<DictationPluginState>({
        key: dictationPluginKey,
        state: {
          init: () => IDLE,
          apply(tr, value) {
            const meta = tr.getMeta(dictationPluginKey) as DictationMeta | undefined;
            let next = value;
            if (tr.docChanged && (value.anchor !== null || value.lastRange)) {
              next = {
                ...value,
                anchor: value.anchor === null ? null : tr.mapping.map(value.anchor, 1),
                lastRange: value.lastRange
                  ? { from: tr.mapping.map(value.lastRange.from, 1), to: tr.mapping.map(value.lastRange.to, -1) }
                  : null,
              };
              if (next.lastRange && next.lastRange.to <= next.lastRange.from) next = { ...next, lastRange: null };
            }
            if (meta) next = { ...next, ...meta };
            return next;
          },
        },
        // A selection change within a moment of a real keypress/click is the user moving the
        // cursor; re-anchor there so the next chunk follows them.
        appendTransaction(trs, _oldState, newState) {
          const st = getDictationState(newState);
          if (!st.active) return null;
          if (Date.now() - lastUserInput > 800) return null;
          const moved = trs.some((tr) => tr.selectionSet && !tr.getMeta(dictationPluginKey));
          if (!moved || newState.selection.head === st.anchor) return null;
          return newState.tr.setMeta(dictationPluginKey, { anchor: newState.selection.head, lastRange: null } satisfies DictationMeta);
        },
        props: {
          handleDOMEvents: {
            mousedown: markUserInput,
            keydown: markUserInput,
            touchstart: markUserInput,
          },
          decorations(state) {
            const st = getDictationState(state);
            if (!st.active && st.pending === 0) return null;
            const decorations: Decoration[] = [];
            if (st.lastRange) {
              decorations.push(Decoration.inline(st.lastRange.from, st.lastRange.to, { class: "doc-dictation-fresh" }));
            }
            if (st.anchor !== null && (st.preview || st.pending > 0 || st.active)) {
              const pos = clampPos(state, st.anchor);
              decorations.push(
                Decoration.widget(pos, () => buildPreviewWidget(st.preview, st.pending), {
                  side: 1,
                  key: `dictation:${st.preview}:${st.pending > 0}`,
                  ignoreSelection: true,
                })
              );
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export default DocDictation;

// The plain text between the start of the anchor's textblock and the anchor - what fitToContext()
// needs to decide spacing and capitalisation. Inline leaf nodes (images, hard breaks) count as a
// newline so "after a line break" reads as a fresh line.
function textBeforeAnchor(state: EditorState, anchor: number): string {
  const $pos = state.doc.resolve(anchor);
  if (!$pos.parent.isTextblock) return "";
  return $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\n").replace(/^[\s\S]*\n/, "");
}

// Up to `max` characters of document text before the anchor, across blocks - context for whisper.
export function documentTextBeforeDictation(editor: Editor, max = 800): string {
  const { state } = editor;
  const anchor = clampPos(state, getDictationState(state).anchor ?? state.selection.head);
  return state.doc.textBetween(Math.max(0, anchor - max * 2), anchor, "\n", " ").slice(-max);
}

// Applies one parsed chunk at the dictation anchor. Returns true when the chunk asked to stop.
export function applyDictationOps(editor: Editor, ops: DictationOp[]): boolean {
  let stop = false;
  for (const op of ops) {
    const st = getDictationState(editor.state);
    const anchor = clampPos(editor.state, st.anchor ?? editor.state.selection.head);
    const resync = ({ tr }: { tr: Transaction }) => {
      tr.setMeta(dictationPluginKey, { anchor: tr.selection.head, lastRange: null } satisfies DictationMeta);
      return true;
    };

    switch (op.kind) {
      case "text": {
        editor
          .chain()
          .command(({ tr, state }) => {
            const before = textBeforeAnchor(state, anchor);
            const drop = trailingPeriodToDrop(before, op.text);
            let from = anchor;
            if (drop) {
              tr.delete(anchor - drop, anchor);
              from = anchor - drop;
            }
            const text = fitToContext(op.text, drop ? before.slice(0, -drop) : before);
            if (!text) return true;
            tr.insertText(text, from);
            const end = from + text.length;
            tr.setSelection(TextSelection.create(tr.doc, end));
            tr.setMeta(dictationPluginKey, { anchor: end, lastRange: { from, to: end } } satisfies DictationMeta);
            return true;
          })
          .run();
        break;
      }
      case "lineBreak":
        editor.chain().setTextSelection(anchor).setHardBreak().command(resync).run();
        break;
      case "paragraph":
        editor
          .chain()
          .setTextSelection(anchor)
          .first(({ commands }) => [() => commands.splitListItem("listItem"), () => commands.splitBlock()])
          .command(resync)
          .run();
        break;
      case "bulletList":
        editor.chain().setTextSelection(anchor).toggleBulletList().command(resync).run();
        break;
      case "orderedList":
        editor.chain().setTextSelection(anchor).toggleOrderedList().command(resync).run();
        break;
      case "heading":
        editor.chain().setTextSelection(anchor).setHeading({ level: op.level }).command(resync).run();
        break;
      case "normalText":
        editor.chain().setTextSelection(anchor).setParagraph().command(resync).run();
        break;
      case "scratch": {
        const range = st.lastRange;
        if (!range) break;
        editor
          .chain()
          .command(({ tr }) => {
            tr.delete(range.from, range.to);
            tr.setSelection(TextSelection.create(tr.doc, range.from));
            tr.setMeta(dictationPluginKey, { anchor: range.from, lastRange: null } satisfies DictationMeta);
            return true;
          })
          .run();
        break;
      }
      case "undo":
        editor.chain().undo().command(resync).run();
        break;
      case "stop":
        stop = true;
        break;
    }
  }
  return stop;
}
