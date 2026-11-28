// utils/docDictationExtension.ts
//
// Editor-side state for Docs dictation (useDocDictation.ts drives the microphone/whisper side).
// A ProseMirror plugin, not React state, because the thing it tracks - *where* the next chunk of
// dictated text lands - is a document position, and positions have to be mapped through every
// transaction (the user typing above it, a collaborator's remote edit, an earlier chunk landing)
// to stay correct.
//
// Interim text never touches the document: it's a widget decoration at the anchor (rendered
// word-by-word with a subtle slide-in animation and pulsing status dots while chunks are
// transcribing). Only final text is inserted, one transaction per chunk, so undo/"scratch that"
// step back a phrase at a time.
import { Command, Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, EditorState, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  describeDictationOp,
  DictationOp,
  fitToContext,
  trailingPeriodToDrop,
} from "./dictationText";

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
  lastAction: string | null;
  lastActionId: number;
}

type DictationMeta = Partial<DictationPluginState>;

export const dictationPluginKey = new PluginKey<DictationPluginState>("docDictation");

const IDLE: DictationPluginState = {
  active: false,
  anchor: null,
  lastRange: null,
  preview: "",
  pending: 0,
  lastAction: null,
  lastActionId: 0,
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docDictation: {
      beginDictation: () => ReturnType;
      pauseDictation: () => ReturnType;
      endDictation: () => ReturnType;
      setDictationPreview: (preview: string) => ReturnType;
      setDictationPending: (pending: number) => ReturnType;
      setDictationAction: (lastAction: string | null) => ReturnType;
    };
  }
}

export function getDictationState(state: EditorState): DictationPluginState {
  return dictationPluginKey.getState(state) ?? IDLE;
}

function clampPos(state: EditorState, pos: number): number {
  return Math.max(0, Math.min(pos, state.doc.content.size));
}

let actionClearTimer: ReturnType<typeof setTimeout> | null = null;
let prevRenderedWords: string[] = [];

function buildPreviewWidget(preview: string, pending: number, lastAction: string | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "doc-dictation-preview";
  el.setAttribute("contenteditable", "false");
  el.setAttribute("aria-live", "polite");

  if (lastAction) {
    const badge = document.createElement("span");
    badge.className = "doc-dictation-action-pill";
    badge.textContent = lastAction;
    el.appendChild(badge);
  }

  if (preview) {
    const text = document.createElement("span");
    text.className = "doc-dictation-preview-text";
    const leadingSpace = /^\s/.test(preview) ? " " : "";
    const words = preview.trim().split(/\s+/).filter(Boolean);
    if (leadingSpace) {
      text.appendChild(document.createTextNode(" "));
    }
    words.forEach((w, idx) => {
      if (idx > 0) text.appendChild(document.createTextNode(" "));
      const wordSpan = document.createElement("span");
      const isNewWord = idx >= prevRenderedWords.length || prevRenderedWords[idx] !== w;
      wordSpan.className = isNewWord ? "doc-dictation-word is-new" : "doc-dictation-word";
      wordSpan.textContent = w;
      text.appendChild(wordSpan);
    });
    prevRenderedWords = words;
    el.appendChild(text);
  } else {
    prevRenderedWords = [];
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
          if (dispatch) {
            tr.setMeta(dictationPluginKey, {
              ...IDLE,
              active: true,
              anchor: state.selection.head,
            } satisfies DictationMeta);
          }
          return true;
        },
      // Stops listening but keeps the anchor - chunks still transcribing land where they belong.
      pauseDictation: () => withMeta({ active: false, preview: "", lastAction: null }),
      endDictation: () => withMeta({ ...IDLE }),
      setDictationPreview: (preview: string) => withMeta({ preview }),
      setDictationPending: (pending: number) => withMeta({ pending }),
      setDictationAction: (lastAction: string | null) =>
        withMeta({ lastAction, lastActionId: Date.now() }),
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
          return newState.tr.setMeta(dictationPluginKey, {
            anchor: newState.selection.head,
            lastRange: null,
          } satisfies DictationMeta);
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
              decorations.push(
                Decoration.inline(st.lastRange.from, st.lastRange.to, { class: "doc-dictation-fresh" })
              );
            }
            if (st.anchor !== null && (st.preview || st.pending > 0 || st.active || st.lastAction)) {
              const pos = clampPos(state, st.anchor);
              decorations.push(
                Decoration.widget(pos, () => buildPreviewWidget(st.preview, st.pending, st.lastAction), {
                  side: 1,
                  key: `dictation:${st.preview}:${st.pending > 0}:${st.lastAction ?? ""}:${st.lastActionId}`,
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
export function textBeforeAnchor(state: EditorState, anchor: number): string {
  const $pos = state.doc.resolve(clampPos(state, anchor));
  if (!$pos.parent.isTextblock) return "";
  return $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\n").replace(/^[\s\S]*\n/, "");
}

// Up to `max` characters of document text before the anchor, across blocks - context for whisper.
export function documentTextBeforeDictation(editor: Editor, max = 800): string {
  const { state } = editor;
  const anchor = clampPos(state, getDictationState(state).anchor ?? state.selection.head);
  return state.doc.textBetween(Math.max(0, anchor - max * 2), anchor, "\n", " ").slice(-max);
}

// Finds the range to target for "bold that" / "scratch that" when lastRange is absent or when
// targeting the last word/sentence in the current textblock.
function resolveTargetRange(
  state: EditorState,
  anchor: number,
  lastRange: DictationRange | null,
  fallbackMode: "lastRangeOrWord" | "words" | "sentence",
  wordCount = 1
): DictationRange | null {
  if (fallbackMode === "lastRangeOrWord" && lastRange && lastRange.to > lastRange.from) {
    return {
      from: Math.max(0, clampPos(state, lastRange.from)),
      to: clampPos(state, lastRange.to),
    };
  }
  const $pos = state.doc.resolve(clampPos(state, anchor));
  if (!$pos.parent.isTextblock) return null;
  const blockStart = $pos.start();
  const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\uFFFC");
  if (!before.trim()) return null;

  if (fallbackMode === "sentence") {
    // Delete back to the end of the previous sentence or start of the block.
    const trimmed = before.replace(/\s+$/, "");
    const withoutTrailingMark = trimmed.replace(/[.!?…]+$/, "");
    const prevBoundary = Math.max(
      withoutTrailingMark.lastIndexOf(". "),
      withoutTrailingMark.lastIndexOf("! "),
      withoutTrailingMark.lastIndexOf("? "),
      withoutTrailingMark.lastIndexOf("\n")
    );
    const startOffset = prevBoundary >= 0 ? prevBoundary + 2 : 0;
    return { from: blockStart + startOffset, to: anchor };
  }

  // Match the last `wordCount` words before the anchor.
  const tokens = [...before.matchAll(/\S+/g)];
  if (tokens.length === 0) return null;
  const targetToken = tokens[Math.max(0, tokens.length - wordCount)];
  const startOffset = targetToken.index ?? 0;
  // Include a leading space when deleting words so we don't leave double spaces behind.
  const adjustedStart =
    fallbackMode === "words" && startOffset > 0 && before[startOffset - 1] === " "
      ? startOffset - 1
      : startOffset;
  return { from: blockStart + adjustedStart, to: anchor };
}

function toTitleCase(str: string): string {
  return str.replace(/\b[\p{L}][\p{L}'’]*/gu, (w) => w.charAt(0).toLocaleUpperCase() + w.slice(1).toLocaleLowerCase());
}

function isInsideTable(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(clampPos(state, pos));
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === "table" || name === "tableRow" || name === "tableCell" || name === "tableHeader") {
      return true;
    }
  }
  return false;
}

// Moves to the first cell of the next row in a table, or appends a new row if already on the last row.
function moveOrAddNextTableRow(editor: Editor, anchor: number): void {
  const { state } = editor;
  const $pos = state.doc.resolve(clampPos(state, anchor));
  let tableDepth = -1;
  let rowDepth = -1;
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (rowDepth === -1 && name === "tableRow") rowDepth = d;
    if (name === "table") {
      tableDepth = d;
      break;
    }
  }
  if (tableDepth === -1 || rowDepth === -1) return;

  const tableNode = $pos.node(tableDepth);
  const rowIndex = $pos.index(tableDepth);
  if (rowIndex + 1 < tableNode.childCount) {
    // Move to the first cell of rowIndex + 1
    let rowPos = $pos.start(tableDepth);
    for (let i = 0; i <= rowIndex; i++) {
      rowPos += tableNode.child(i).nodeSize;
    }
    // Inside tableRow (+1), inside first cell (+1), inside its first paragraph (+1)
    const targetPos = clampPos(state, rowPos + 3);
    editor
      .chain()
      .setTextSelection(targetPos)
      .command(({ tr }) => {
        tr.setMeta(dictationPluginKey, { anchor: targetPos, lastRange: null } satisfies DictationMeta);
        return true;
      })
      .run();
  } else {
    // On the last row: add a new row below and jump to its first cell!
    editor
      .chain()
      .setTextSelection(anchor)
      .addRowAfter()
      .goToNextCell()
      .command(({ tr }) => {
        tr.setMeta(dictationPluginKey, { anchor: tr.selection.head, lastRange: null } satisfies DictationMeta);
        return true;
      })
      .run();
  }
}

function flashEditorAction(editor: Editor, label: string | null, onAction?: (label: string) => void): void {
  if (!label) return;
  onAction?.(label);
  if (actionClearTimer) clearTimeout(actionClearTimer);
  editor.commands.setDictationAction(label);
  actionClearTimer = setTimeout(() => {
    if (!editor.isDestroyed) {
      editor.commands.setDictationAction(null);
    }
  }, 2200);
}

// Applies one parsed chunk at the dictation anchor. Returns true when the chunk asked to stop.
export function applyDictationOps(
  editor: Editor,
  ops: DictationOp[],
  onAction?: (label: string) => void
): boolean {
  let stop = false;
  for (const op of ops) {
    const st = getDictationState(editor.state);
    const anchor = clampPos(editor.state, st.anchor ?? editor.state.selection.head);
    const label = describeDictationOp(op);
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
            tr.setMeta(dictationPluginKey, {
              anchor: end,
              lastRange: { from: text.startsWith(" ") ? from + 1 : from, to: end },
            } satisfies DictationMeta);
            return true;
          })
          .run();
        break;
      }
      case "lineBreak":
        editor.chain().setTextSelection(anchor).setHardBreak().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "paragraph":
        editor
          .chain()
          .setTextSelection(anchor)
          .first(({ commands }) => [
            () => commands.splitListItem("taskItem"),
            () => commands.splitListItem("listItem"),
            () => commands.splitBlock(),
          ])
          .command(resync)
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      case "listItem":
        editor
          .chain()
          .setTextSelection(anchor)
          .first(({ commands }) => [
            () => commands.splitListItem("taskItem"),
            () => commands.splitListItem("listItem"),
            () => commands.toggleBulletList(),
          ])
          .command(resync)
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      case "bulletList":
        editor.chain().setTextSelection(anchor).toggleBulletList().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "orderedList":
        editor.chain().setTextSelection(anchor).toggleOrderedList().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "taskList":
        editor.chain().setTextSelection(anchor).toggleTaskList().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "checkItem": {
        editor
          .chain()
          .command(({ tr, state }) => {
            const $pos = state.doc.resolve(anchor);
            for (let d = $pos.depth; d > 0; d--) {
              const node = $pos.node(d);
              if (node.type.name === "taskItem") {
                const pos = $pos.before(d);
                const checked = op.checked ?? !node.attrs.checked;
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
                return true;
              }
            }
            return false;
          })
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "heading":
        editor.chain().setTextSelection(anchor).setHeading({ level: op.level }).command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "normalText":
        editor.chain().setTextSelection(anchor).setParagraph().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "blockquote":
        editor.chain().setTextSelection(anchor).toggleBlockquote().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "horizontalRule":
        editor.chain().setTextSelection(anchor).setHorizontalRule().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "pageBreak":
        editor
          .chain()
          .setTextSelection(anchor)
          .insertContent({ type: "pageBreak" })
          .command(resync)
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      case "insertTable":
        editor
          .chain()
          .setTextSelection(anchor)
          .insertTable({ rows: op.rows, cols: op.cols, withHeaderRow: true })
          .command(resync)
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      case "tableNav": {
        if (!isInsideTable(editor.state, anchor)) break;
        if (op.direction === "next") {
          editor.chain().setTextSelection(anchor).goToNextCell().command(resync).run();
        } else if (op.direction === "prev") {
          editor.chain().setTextSelection(anchor).goToPreviousCell().command(resync).run();
        } else {
          moveOrAddNextTableRow(editor, anchor);
        }
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "formatLast": {
        const range = resolveTargetRange(editor.state, anchor, st.lastRange, "lastRangeOrWord");
        if (!range) break;
        const { from, to } = range;
        const keepAnchor = ({ tr }: { tr: Transaction }) => {
          const end = clampPos(editor.state, to);
          tr.setSelection(TextSelection.create(tr.doc, end));
          tr.setMeta(dictationPluginKey, { anchor: end, lastRange: { from, to: end } } satisfies DictationMeta);
          return true;
        };
        if (op.format === "bold") {
          editor.chain().setTextSelection({ from, to }).toggleBold().command(keepAnchor).run();
        } else if (op.format === "italic") {
          editor.chain().setTextSelection({ from, to }).toggleItalic().command(keepAnchor).run();
        } else if (op.format === "underline") {
          editor.chain().setTextSelection({ from, to }).toggleUnderline().command(keepAnchor).run();
        } else if (op.format === "strike") {
          editor.chain().setTextSelection({ from, to }).toggleStrike().command(keepAnchor).run();
        } else if (op.format === "code") {
          editor.chain().setTextSelection({ from, to }).toggleCode().command(keepAnchor).run();
        } else if (op.format === "highlight") {
          editor
            .chain()
            .setTextSelection({ from, to })
            .toggleHighlight({ color: op.color ?? "#fef08a" })
            .command(keepAnchor)
            .run();
        } else if (op.format === "uppercase" || op.format === "lowercase" || op.format === "titlecase") {
          editor
            .chain()
            .command(({ tr, state }) => {
              const rawText = state.doc.textBetween(from, to);
              if (!rawText) return false;
              const converted =
                op.format === "uppercase"
                  ? rawText.toLocaleUpperCase()
                  : op.format === "lowercase"
                    ? rawText.toLocaleLowerCase()
                    : toTitleCase(rawText);
              tr.insertText(converted, from, to);
              const end = from + converted.length;
              tr.setSelection(TextSelection.create(tr.doc, end));
              tr.setMeta(dictationPluginKey, { anchor: end, lastRange: { from, to: end } } satisfies DictationMeta);
              return true;
            })
            .run();
        }
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "align":
        editor.chain().setTextSelection(anchor).setTextAlign(op.alignment).command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "deleteWord": {
        const range = resolveTargetRange(editor.state, anchor, st.lastRange, "words", op.count ?? 1);
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
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "deleteSentence": {
        const range = resolveTargetRange(editor.state, anchor, st.lastRange, "sentence");
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
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "scratch": {
        const range =
          st.lastRange && st.lastRange.to > st.lastRange.from
            ? st.lastRange
            : resolveTargetRange(editor.state, anchor, null, "sentence");
        if (!range) break;
        editor
          .chain()
          .command(({ tr }) => {
            // Also trim a single leading space before lastRange if deleting it would leave a trailing space.
            const delFrom =
              range.from > 1 && tr.doc.textBetween(range.from - 1, range.from) === " "
                ? range.from - 1
                : range.from;
            tr.delete(delFrom, range.to);
            tr.setSelection(TextSelection.create(tr.doc, delFrom));
            tr.setMeta(dictationPluginKey, { anchor: delFrom, lastRange: null } satisfies DictationMeta);
            return true;
          })
          .run();
        flashEditorAction(editor, label, onAction);
        break;
      }
      case "undo":
        editor.chain().undo().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "redo":
        editor.chain().redo().command(resync).run();
        flashEditorAction(editor, label, onAction);
        break;
      case "stop":
        flashEditorAction(editor, label, onAction);
        stop = true;
        break;
    }
  }
  return stop;
}
