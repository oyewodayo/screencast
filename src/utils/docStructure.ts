// utils/docStructure.ts
//
// Everything in a document that is numbered or derived from other parts of it: figure and table
// captions ("Figure 3"), display equations ("(2)"), cross-references to them, citations ("[4]",
// "(Scholl et al., 2021)"), the reference list, and the headings an outline or table of contents
// is built from. None of those numbers are stored - they're recomputed from document order on
// every change, so moving a figure renumbers it and every reference to it at once.
//
// One builder computes the structure from either a live ProseMirror doc (the plugin below, which
// turns it into decorations the node views render) or editor.getJSON() (the exporters), so the
// editor, print/PDF, .docx, .html and Markdown always agree on every number.
import { Extension } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { BibliographySource, BibEntry, CitationStyleId } from "./docBibliography";
import { DEFAULT_CITATION_STYLE } from "./docBibliography";
import {
  citationSpaceBefore,
  buildCitationContext,
  formatBibliography,
  formatCitation,
  type CitationContext,
  type FormattedReference,
  type InTextCitation,
} from "./docCitationStyles";

export type CaptionKind = "figure" | "table";
export type TargetKind = CaptionKind | "equation";

export const CAPTION_NAMES: Record<CaptionKind, string> = { figure: "Figure", table: "Table" };

export interface StructureTarget {
  id: string;
  kind: TargetKind;
  number: number;
  // How a cross-reference reads: "Figure 3", "Table 1", "Eq. (2)".
  label: string;
  // Caption text, or the equation's LaTeX - what the cross-reference picker shows.
  text: string;
  pos: number;
}

export interface HeadingEntry {
  level: number;
  text: string;
  pos: number;
}

export interface CitationOccurrence {
  refIds: string[];
  locator: string | null;
  pos: number;
}

export interface DocStructure {
  targets: Map<string, StructureTarget>;
  targetList: StructureTarget[];
  // Display equation number by node position (live doc only - exporters number as they walk).
  equationAt: Map<number, number>;
  captionAt: Map<number, StructureTarget>;
  headings: HeadingEntry[];
  citations: CitationOccurrence[];
  citationAt: Map<number, InTextCitation>;
  citedIds: string[];
  context: CitationContext;
  bibliography: FormattedReference[];
  style: CitationStyleId;
  lookup: (id: string) => BibEntry | undefined;
}

export function crossRefLabel(kind: TargetKind, number: number): string {
  return kind === "equation" ? `Eq. (${number})` : `${CAPTION_NAMES[kind]} ${number}`;
}

const isNumberedEquation = (attrs: Record<string, unknown>) => attrs.numbered !== false && String(attrs.latex ?? "").trim() !== "";

class StructureBuilder {
  private counts: Record<TargetKind, number> = { figure: 0, table: 0, equation: 0 };
  targetList: StructureTarget[] = [];
  equationAt = new Map<number, number>();
  captionAt = new Map<number, StructureTarget>();
  headings: HeadingEntry[] = [];
  citations: CitationOccurrence[] = [];

  visit(type: string, attrs: Record<string, unknown>, text: () => string, pos: number): void {
    switch (type) {
      case "caption": {
        const kind: CaptionKind = attrs.kind === "table" ? "table" : "figure";
        const number = ++this.counts[kind];
        const target: StructureTarget = { id: String(attrs.id ?? ""), kind, number, label: crossRefLabel(kind, number), text: text(), pos };
        this.captionAt.set(pos, target);
        if (target.id) this.targetList.push(target);
        break;
      }
      case "mathBlock":
        if (isNumberedEquation(attrs)) {
          const number = ++this.counts.equation;
          this.equationAt.set(pos, number);
          if (attrs.id) this.targetList.push({ id: String(attrs.id), kind: "equation", number, label: crossRefLabel("equation", number), text: String(attrs.latex ?? ""), pos });
        }
        break;
      case "heading":
        this.headings.push({ level: Number(attrs.level ?? 1), text: text().trim(), pos });
        break;
      case "citation":
        this.citations.push({ refIds: Array.isArray(attrs.refIds) ? (attrs.refIds as string[]) : [], locator: (attrs.locator as string | null) ?? null, pos });
        break;
    }
  }

  finish(bib: BibliographySource | null): DocStructure {
    const lookup = (id: string) => bib?.get(id);
    const style = bib?.style() ?? DEFAULT_CITATION_STYLE;
    const citedIds: string[] = [];
    const seen = new Set<string>();
    for (const c of this.citations) {
      for (const id of c.refIds) {
        if (!seen.has(id) && lookup(id)) {
          seen.add(id);
          citedIds.push(id);
        }
      }
    }
    const context = buildCitationContext(citedIds, lookup, style);
    const citationAt = new Map<number, InTextCitation>();
    for (const c of this.citations) citationAt.set(c.pos, formatCitation(c.refIds, c.locator, lookup, context));
    const targets = new Map<string, StructureTarget>();
    for (const t of this.targetList) if (!targets.has(t.id)) targets.set(t.id, t);
    return {
      targets,
      targetList: this.targetList,
      equationAt: this.equationAt,
      captionAt: this.captionAt,
      headings: this.headings,
      citations: this.citations,
      citationAt,
      citedIds,
      context,
      bibliography: formatBibliography(context),
      style,
      lookup,
    };
  }
}

export function computeStructure(doc: PmNode, bib: BibliographySource | null): DocStructure {
  const builder = new StructureBuilder();
  doc.descendants((node, pos) => {
    builder.visit(node.type.name, node.attrs, () => node.textContent, pos);
    // Nothing numbered lives inside these.
    return node.type.name !== "codeBlock" && !node.isAtom;
  });
  return builder.finish(bib);
}

function jsonText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(jsonText).join("");
}

export function computeStructureFromJson(json: JSONContent, bib: BibliographySource | null): DocStructure {
  const builder = new StructureBuilder();
  const walk = (node: JSONContent) => {
    if (node.type && node.type !== "doc") builder.visit(node.type, node.attrs ?? {}, () => jsonText(node), -1);
    if (node.type === "codeBlock") return;
    for (const child of node.content ?? []) walk(child);
  };
  walk(json);
  return builder.finish(bib);
}

// ----------------------------------------------------------------------------------------------
// Live plugin

interface PluginState {
  structure: DocStructure;
  decorations: DecorationSet;
  // A block briefly highlighted after "Go to" (outline, table of contents, cross-reference). A
  // decoration, not a class set on the DOM directly: ProseMirror owns its nodes' DOM and reverts
  // foreign attribute changes when it redraws them.
  reveal: { pos: number; flip: boolean } | null;
}

const REVEAL = "docStructureReveal";

export const DocStructurePluginKey = new PluginKey<PluginState>("docStructure");

export function getDocStructure(state: EditorState): DocStructure | null {
  return DocStructurePluginKey.getState(state)?.structure ?? null;
}

// A short fingerprint of a derived block's content, so its decoration (and so its NodeView) only
// changes - and re-renders - when what it shows actually changes, not on every keystroke.
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function buildDecorations(doc: PmNode, s: DocStructure): DecorationSet {
  const decos: Decoration[] = [];
  const bibRevision = hash(s.style + JSON.stringify(s.bibliography));
  const tocRevision = hash(s.headings.map((h) => `${h.level}${h.text}`).join("\u0000"));
  doc.descendants((node, pos, parent, index) => {
    const end = pos + node.nodeSize;
    switch (node.type.name) {
      case "caption": {
        const target = s.captionAt.get(pos);
        if (target) {
          decos.push(
            Decoration.node(pos, end, {
              "data-caption-label": target.label,
              class: node.content.size === 0 ? "doc-caption-empty" : "",
            })
          );
        }
        return true; // citations and cross-references inside the caption text
      }
      case "crossRef": {
        const target = s.targets.get(String(node.attrs.targetId ?? ""));
        const label = target ? target.label : "??";
        decos.push(Decoration.node(pos, end, { "data-label": label, "data-missing": target ? "false" : "true" }, { label, missing: !target, kind: target?.kind }));
        return false;
      }
      case "citation": {
        const cite = s.citationAt.get(pos);
        if (cite) {
          const before = parent && index > 0 ? parent.child(index - 1) : null;
          const previousChar = before ? (before.isText ? (before.text ?? "").slice(-1) : before.type.name === "hardBreak" ? "\n" : "x") : "";
          const space = citationSpaceBefore(previousChar, cite.superscript);
          decos.push(Decoration.node(pos, end, { "data-label": space + cite.text, "data-missing": String(cite.missing), "data-sup": String(cite.superscript) }, { cite, space }));
        }
        return false;
      }
      case "mathBlock": {
        const number = s.equationAt.get(pos);
        decos.push(Decoration.node(pos, end, { "data-eq-number": number ? String(number) : "" }, { eqNumber: number ?? null }));
        return false;
      }
      case "bibliography":
        decos.push(Decoration.node(pos, end, { "data-rev": bibRevision }));
        return false;
      case "tableOfContents":
        decos.push(Decoration.node(pos, end, { "data-rev": tocRevision }));
        return false;
    }
    return node.type.name !== "codeBlock";
  });
  return DecorationSet.create(doc, decos);
}

const BIB_CHANGED = "bibliographyChanged";

// Captions always carry an id (cross-references point at it); equations get one the first time
// something references them. Copy-pasting a captioned figure duplicates its id - the copy gets a
// fresh one so references keep pointing at the original's first occurrence.
function ensureUniqueIds(trs: readonly Transaction[], state: EditorState): Transaction | null {
  if (!trs.some((t) => t.docChanged)) return null;
  const seen = new Set<string>();
  let tr: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    const name = node.type.name;
    if (name !== "caption" && name !== "mathBlock") return node.type.name !== "codeBlock";
    const id = node.attrs.id as string | null;
    if ((name === "caption" && !id) || (id && seen.has(id))) {
      const fresh = crypto.randomUUID();
      tr ??= state.tr;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: fresh });
      seen.add(fresh);
    } else if (id) seen.add(id);
    return false;
  });
  if (tr) (tr as Transaction).setMeta("addToHistory", false);
  return tr;
}

export function createDocStructureExtension(bibliography: BibliographySource | null) {
  return Extension.create({
    name: "docStructure",

    addProseMirrorPlugins() {
      const editor = this.editor;
      return [
        new Plugin<PluginState>({
          key: DocStructurePluginKey,
          state: {
            init: (_config, state) => {
              const structure = computeStructure(state.doc, bibliography);
              return { structure, decorations: buildDecorations(state.doc, structure), reveal: null };
            },
            apply(tr, prev, _old, state) {
              const revealMeta = tr.getMeta(REVEAL) as PluginState["reveal"] | undefined;
              let reveal = revealMeta !== undefined ? revealMeta : prev.reveal;
              if (reveal && tr.docChanged) {
                const mapped = tr.mapping.mapResult(reveal.pos);
                reveal = mapped.deleted ? null : { ...reveal, pos: mapped.pos };
              }
              if (!tr.docChanged && !tr.getMeta(BIB_CHANGED)) return reveal === prev.reveal ? prev : { ...prev, reveal };
              const structure = computeStructure(state.doc, bibliography);
              return { structure, decorations: buildDecorations(state.doc, structure), reveal };
            },
          },
          props: {
            decorations: (state) => {
              const st = DocStructurePluginKey.getState(state);
              if (!st) return DecorationSet.empty;
              const node = st.reveal ? state.doc.nodeAt(st.reveal.pos) : null;
              if (!st.reveal || !node) return st.decorations;
              // Two class names, alternated, so revealing the same block twice restarts the flash.
              return st.decorations.add(state.doc, [Decoration.node(st.reveal.pos, st.reveal.pos + node.nodeSize, { class: st.reveal.flip ? "doc-reveal-b" : "doc-reveal" })]);
            },
          },
          appendTransaction: (trs, _old, state) => ensureUniqueIds(trs, state),
          view: () => {
            // Library or style edits (References panel) relabel citations without a doc change.
            const unsubscribe = bibliography?.subscribe(() => {
              if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(BIB_CHANGED, true));
            });
            return { destroy: () => unsubscribe?.() };
          },
        }),
      ];
    },
  });
}

// Scrolls the editor to a node and flashes it - the outline, table of contents and "Go to" on a
// cross-reference all land the same way.
let revealTimer = 0;

export function revealPos(view: import("@tiptap/pm/view").EditorView, pos: number): void {
  const dom = view.nodeDOM(pos);
  const el = dom instanceof HTMLElement ? dom : dom?.parentElement;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const prev = DocStructurePluginKey.getState(view.state)?.reveal;
  view.dispatch(view.state.tr.setMeta(REVEAL, { pos, flip: prev?.pos === pos ? !prev.flip : false }));
  window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(() => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(REVEAL, null));
  }, 1700);
}
