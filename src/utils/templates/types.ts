// utils/templates/types.ts
import type { BibEntry, CitationStyleId } from "../docBibliography";
import type { DocBodyStyle } from "../docLayout";
import type { DocMargins, DocPageSize } from "../docTypes";

export type DocTemplateCategory = "Research" | "Work" | "Personal";

export interface DocTemplateLayout {
  columns?: 1 | 2;
  // The document's own body style (docLayout.ts) - its font, size, leading, paragraph rhythm.
  body?: Partial<DocBodyStyle>;
}

export interface DocTemplate {
  id: string;
  name: string;
  // Short secondary line under the name on the template card.
  description: string;
  category: DocTemplateCategory;
  // Groups a variant inside its parent's style picker ("Technology", "Healthcare", ...).
  group?: string;
  // Title the new doc is created with; `today` is the formatted creation date.
  docTitle: (today: string) => string;
  html: (today: string) => string;
  layout?: DocTemplateLayout;
  pageSetup?: { pageSize?: DocPageSize; margins?: DocMargins; headerText?: string; footerText?: string };
  // Seeds the document's reference library, so citations in the template resolve on first open.
  references?: BibEntry[];
  citationStyle?: CitationStyleId;
  // A template that is really a family of styles (Resume): picking it opens a style picker
  // instead of creating a document straight away.
  variants?: DocTemplate[];
}

const DEFAULT_BODY: DocBodyStyle = {
  fontFamily: null,
  fontSize: null,
  lineHeight: null,
  blockSpacing: null,
  paragraphIndent: null,
  color: null,
  justify: false,
  hyphenate: false,
};

export function templateBody(layout: DocTemplateLayout | undefined): DocBodyStyle | null {
  return layout?.body ? { ...DEFAULT_BODY, ...layout.body } : null;
}
