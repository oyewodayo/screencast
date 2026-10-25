// utils/docTemplates.ts
//
// The template registry behind DocsHome's "Start a new document" row and template gallery, and
// the one place a template becomes a document. Templates themselves live in utils/templates/ -
// HTML in the editor's own vocabulary plus optional document settings (body style, columns,
// reference library, citation style, page setup).
//
// A template is turned into a Y.Doc through exactly the path docxImport.ts uses (DOMParser ->
// ProseMirror Node -> prosemirrorToYDoc), so a doc made from one is an ordinary doc the moment it
// exists: its TOC, numbered equations, captions, citations, checklists and shaded tables are the
// live nodes, not lookalikes.
import * as Y from "yjs";
import { getHTMLFromFragment, getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { invoke } from "@tauri-apps/api/core";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { normalizePageColor, pageFormat } from "./docPageGeometry";
import { docSettingsMap, writeLayout, type DocLayout, DEFAULT_COLUMN_GAP_IN } from "./docLayout";
import { DEFAULT_CITATION_STYLE, type BibEntry } from "./docBibliography";
import type { DocPreviewData } from "./docPreview";
import { RESEARCH_TEMPLATES } from "./templates/researchTemplates";
import { WORK_TEMPLATES } from "./templates/workTemplates";
import { PERSONAL_TEMPLATES } from "./templates/personalTemplates";
import { templateBody, type DocTemplate, type DocTemplateCategory } from "./templates/types";

export type { DocTemplate, DocTemplateCategory } from "./templates/types";
export { RESUME_GROUPS } from "./templates/resumeTemplates";

export const DOC_TEMPLATES: DocTemplate[] = [...RESEARCH_TEMPLATES, ...WORK_TEMPLATES, ...PERSONAL_TEMPLATES];

export const DOC_TEMPLATE_CATEGORIES: DocTemplateCategory[] = ["Research", "Work", "Personal"];

let cachedSchema: Schema | null = null;
export function docContentSchema(): Schema {
  cachedSchema ??= getSchema(getDocContentExtensions());
  return cachedSchema;
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function parseTemplate(template: DocTemplate, today: string): ProseMirrorNode {
  const schema = docContentSchema();
  const dom = new DOMParser().parseFromString(template.html(today), "text/html");
  return ProseMirrorDOMParser.fromSchema(schema).parse(dom.body);
}

// The layout a template gives its document - also what DocPagePreview needs to typeset the card.
export function templateLayout(template: DocTemplate): DocLayout {
  return { columns: template.layout?.columns ?? 1, columnGap: DEFAULT_COLUMN_GAP_IN, body: templateBody(template.layout) };
}


// The template as the editor would serialize it - parsed through the schema and back, so the
// card shows exactly what the new document will contain (shading attributes, normalized marks)
// rather than the template's hand-written source.
const previewCache = new Map<string, DocPreviewData>();
// The preview only if it's already been built - for rendering a card without paying for the parse.
export function cachedTemplatePreview(template: DocTemplate): DocPreviewData | null {
  return previewCache.get(template.id) ?? null;
}
export function templatePreview(template: DocTemplate): DocPreviewData {
  const cached = previewCache.get(template.id);
  if (cached) return cached;
  let html = "";
  try {
    html = getHTMLFromFragment(parseTemplate(template, todayLabel()).content, docContentSchema());
  } catch (err) {
    console.error(`Failed to render preview for template ${template.id}:`, err);
  }
  const preview: DocPreviewData = {
    html,
    layout: templateLayout(template),
    references: template.references ?? [],
    citationStyle: template.citationStyle ?? DEFAULT_CITATION_STYLE,
    page: pageFormat(template.pageSetup?.pageSize, template.pageSetup?.orientation),
    pageColor: normalizePageColor(template.pageSetup?.pageColor),
  };
  previewCache.set(template.id, preview);
  return preview;
}

export async function createDocFromTemplate(template: DocTemplate, folderId: string | null): Promise<string> {
  const today = todayLabel();
  // "default" - the fragment @tiptap/extension-collaboration reads (see docxImport.ts).
  const ydoc = prosemirrorToYDoc(parseTemplate(template, today), "default");
  ydoc.transact(() => {
    const layout = templateLayout(template);
    if (layout.columns === 2 || layout.body) writeLayout(ydoc, layout);
    if (template.references?.length) {
      const library = ydoc.getMap<BibEntry>("bibliography");
      // addedAt keeps the library in the template's order (BibliographyStore sorts by it).
      const now = Date.now();
      template.references.forEach((ref, i) => library.set(ref.id, { ...ref, addedAt: now + i }));
    }
    if (template.citationStyle) docSettingsMap(ydoc).set("citationStyle", template.citationStyle);
  });

  const id = crypto.randomUUID();
  const title = template.docTitle(today);
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), folderId });
  if (template.pageSetup) {
    const { pageSize = null, orientation = null, pageColor = null, margins = null, headerText = null, footerText = null } = template.pageSetup;
    await invoke("set_doc_page_setup", { id, pageSize, orientation: orientation === "landscape" ? "landscape" : null, pageColor, headerText, footerText, margins });
  }
  return id;
}
