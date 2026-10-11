// utils/docPreview.ts
//
// First-page preview data for DocsHome's document cards: the opening blocks serialized with the
// editor's own schema, plus what DocPagePreview needs to typeset them like the editor does - the
// document's layout (body style, columns) and its reference library and citation style.
//
// Loads run one at a time (load_doc goes through the backend's serialized command lane, and a
// burst of parallel decodes on a big library would stall the UI), and results are cached by
// id + updated_at, so scrolling back or returning to the Docs home doesn't decode again until the
// doc actually changes.
import * as Y from "yjs";
import { getHTMLFromFragment } from "@tiptap/core";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { invoke } from "@tauri-apps/api/core";
import { docContentSchema } from "./docTemplates";
import { readLayout, DEFAULT_LAYOUT, type DocLayout } from "./docLayout";
import { DEFAULT_CITATION_STYLE, isCitationStyle, type BibEntry, type CitationStyleId } from "./docBibliography";
import { DEFAULT_PAGE, normalizePageColor, pageFormat, type PageFormat } from "./docPageGeometry";
import type { DocOrientation, DocPageSize } from "./docTypes";

export interface DocPreviewData {
  html: string;
  layout: DocLayout;
  references: BibEntry[];
  citationStyle: CitationStyleId;
  // Paper size and orientation, and the paper colour (null = white) - from the doc's page setup.
  page: PageFormat;
  pageColor: string | null;
}

export const EMPTY_PREVIEW: DocPreviewData = { html: "", layout: DEFAULT_LAYOUT, references: [], citationStyle: DEFAULT_CITATION_STYLE, page: DEFAULT_PAGE, pageColor: null };

// Enough top-level blocks to fill a page - long docs aren't serialized past what the card shows.
const PREVIEW_BLOCK_LIMIT = 30;
const CACHE_LIMIT = 300;

const cache = new Map<string, DocPreviewData>();
let queue: Promise<unknown> = Promise.resolve();

async function buildPreview(id: string): Promise<DocPreviewData> {
  const result = await invoke<{ bytes: number[]; page_size: DocPageSize | null; orientation: DocOrientation | null; page_color: string | null }>("load_doc", { id });
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, new Uint8Array(result.bytes));
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("default")) as { content?: unknown[] };
    const content = (json.content ?? []).slice(0, PREVIEW_BLOCK_LIMIT);
    const schema = docContentSchema();
    const html = content.length === 0 ? "" : getHTMLFromFragment(schema.nodeFromJSON({ type: "doc", content }).content, schema);
    const references = Object.values(ydoc.getMap<BibEntry>("bibliography").toJSON() as Record<string, BibEntry>).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    const style = ydoc.getMap("docSettings").get("citationStyle");
    return {
      html,
      layout: readLayout(ydoc),
      references,
      citationStyle: isCitationStyle(style) ? style : DEFAULT_CITATION_STYLE,
      page: pageFormat(result.page_size, result.orientation),
      pageColor: normalizePageColor(result.page_color),
    };
  } finally {
    ydoc.destroy();
  }
}

export function loadDocPreview(id: string, updatedAt: string): Promise<DocPreviewData> {
  const key = `${id}:${updatedAt}`;
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const task = queue.then(async () => {
    try {
      const preview = await buildPreview(id);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
      cache.set(key, preview);
      return preview;
    } catch (err) {
      // A doc that fails to decode just gets a blank page on its card - not worth an error banner.
      console.error(`Failed to build preview for document ${id}:`, err);
      return EMPTY_PREVIEW;
    }
  });
  queue = task;
  return task;
}
