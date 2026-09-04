// utils/docFindReplace.ts
//
// Ctrl+F find/replace within a doc - interaction-only (contributes no schema), so like Placeholder
// and docSlashCommand.tsx it's added directly in DocsEditor.tsx's extensions array, not
// docSchemaExtensions.ts. No official Tiptap search extension exists for v2 (this project is pinned
// to 2.27.2, see docFontSizeExtension.ts's own header comment on why this codebase writes its own
// small extensions rather than reaching for a version that doesn't fit), so this is a plain
// ProseMirror plugin: a single source of truth (the plugin's own state, read directly via
// DocFindReplacePluginKey.getState(editor.state)) rather than mirroring it into React state, since
// DocsEditor.tsx's useEditor already re-renders on every transaction.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface SearchMatch {
  from: number;
  to: number;
}

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  matches: SearchMatch[];
  activeIndex: number; // -1 when there are no matches
}

export const DocFindReplacePluginKey = new PluginKey<SearchState>("docFindReplace");

// Flattens the doc's text into one string with a position-offset table (offsets[i] is the
// ProseMirror position of flattened character i), then regex-free substring searches that string -
// not a per-text-node search, which is what lets a match span a mark boundary (e.g. "lo wo" across
// a bold/plain split, where "hello world" is really two adjacent text nodes). A block boundary
// inserts a single space into the flattened string (and records the new block's start position for
// it) so two paragraphs' text doesn't silently glue into one unbroken word.
function findMatches(doc: ProseMirrorNode, query: string, caseSensitive: boolean): SearchMatch[] {
  if (!query) return [];

  let text = "";
  const offsets: number[] = [];
  let sawBlockBreak = true; // true at the very start too, so a leading block doesn't add a stray space

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) offsets.push(pos + i);
      text += node.text;
      sawBlockBreak = false;
      return true;
    }
    if (node.isBlock && !sawBlockBreak) {
      offsets.push(pos);
      text += " ";
      sawBlockBreak = true;
    }
    return true;
  });

  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle.length === 0) return [];

  const matches: SearchMatch[] = [];
  let searchFrom = 0;
  while (searchFrom <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) break;
    matches.push({ from: offsets[index], to: offsets[index + needle.length - 1] + 1 });
    searchFrom = index + needle.length;
  }
  return matches;
}

function wrapIndex(index: number, length: number): number {
  if (length === 0) return -1;
  return ((index % length) + length) % length;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    docFindReplace: {
      setSearchQuery: (query: string, caseSensitive?: boolean) => ReturnType;
      findNext: () => ReturnType;
      findPrevious: () => ReturnType;
      replaceActive: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}

const DocFindReplace = Extension.create({
  name: "docFindReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: DocFindReplacePluginKey,
        state: {
          init: (): SearchState => ({ query: "", caseSensitive: false, matches: [], activeIndex: -1 }),
          apply(tr, prev): SearchState {
            const meta = tr.getMeta(DocFindReplacePluginKey) as Partial<SearchState> | undefined;
            const query = meta?.query ?? prev.query;
            const caseSensitive = meta?.caseSensitive ?? prev.caseSensitive;

            // Only re-walk the doc when it actually could have changed the match set - an edit
            // elsewhere, or the query/case-sensitivity itself changing. A plain activeIndex nudge
            // (findNext/findPrevious) reuses the existing match list.
            const needsRecompute = tr.docChanged || meta?.query !== undefined || meta?.caseSensitive !== undefined;
            const matches = needsRecompute ? findMatches(tr.doc, query, caseSensitive) : prev.matches;

            let activeIndex = prev.activeIndex;
            if (needsRecompute) {
              // Prefer keeping the same match selected across a recompute (e.g. typing elsewhere
              // while the bar is open) rather than always snapping back to the first result.
              const prevMatch = prev.matches[prev.activeIndex];
              const stillThere = prevMatch ? matches.findIndex((m) => m.from === prevMatch.from && m.to === prevMatch.to) : -1;
              activeIndex = stillThere !== -1 ? stillThere : matches.length ? 0 : -1;
            }
            if (typeof meta?.activeIndex === "number") {
              activeIndex = wrapIndex(meta.activeIndex, matches.length);
            }

            if (query === prev.query && caseSensitive === prev.caseSensitive && matches === prev.matches && activeIndex === prev.activeIndex) {
              return prev;
            }
            return { query, caseSensitive, matches, activeIndex };
          },
        },
        props: {
          decorations(state) {
            const pluginState = DocFindReplacePluginKey.getState(state);
            if (!pluginState || pluginState.matches.length === 0) return DecorationSet.empty;
            const decorations = pluginState.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === pluginState.activeIndex ? "doc-search-match doc-search-match-active" : "doc-search-match",
              })
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearchQuery:
        (query: string, caseSensitive = false) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(DocFindReplacePluginKey, { query, caseSensitive }));
          return true;
        },
      findNext:
        () =>
        ({ state, tr, dispatch }) => {
          const pluginState = DocFindReplacePluginKey.getState(state);
          if (!pluginState || pluginState.matches.length === 0) return false;
          if (dispatch) dispatch(tr.setMeta(DocFindReplacePluginKey, { activeIndex: pluginState.activeIndex + 1 }));
          return true;
        },
      findPrevious:
        () =>
        ({ state, tr, dispatch }) => {
          const pluginState = DocFindReplacePluginKey.getState(state);
          if (!pluginState || pluginState.matches.length === 0) return false;
          if (dispatch) dispatch(tr.setMeta(DocFindReplacePluginKey, { activeIndex: pluginState.activeIndex - 1 }));
          return true;
        },
      replaceActive:
        (replacement: string) =>
        ({ state, tr, dispatch }) => {
          const pluginState = DocFindReplacePluginKey.getState(state);
          const match = pluginState && pluginState.activeIndex >= 0 ? pluginState.matches[pluginState.activeIndex] : undefined;
          if (!match) return false;
          if (dispatch) dispatch(tr.insertText(replacement, match.from, match.to));
          return true;
        },
      replaceAll:
        (replacement: string) =>
        ({ state, tr, dispatch }) => {
          const pluginState = DocFindReplacePluginKey.getState(state);
          if (!pluginState || pluginState.matches.length === 0) return false;
          if (dispatch) {
            // Back-to-front so an earlier replacement's length change never invalidates a
            // not-yet-applied match's position.
            [...pluginState.matches].reverse().forEach((m) => tr.insertText(replacement, m.from, m.to));
            dispatch(tr);
          }
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(DocFindReplacePluginKey, { query: "", caseSensitive: false, activeIndex: -1 }));
          return true;
        },
    };
  },
});

export default DocFindReplace;
