// utils/docDocx.ts
//
// Converts a Tiptap document (editor.getJSON()) into real .docx bytes for DocsEditor's export
// feature - the reverse of docxImport.ts. mammoth.js (used for import) is one-directional
// (docx->HTML only), so this walks editor.getJSON() directly and builds `docx` library objects,
// mirroring docMarkdown.ts's own hand-rolled walker (the doc schema is fully bounded - see
// docSchemaExtensions.ts - so a direct walk is simpler and more predictable than round-tripping
// through HTML/a converter library). Async (unlike docMarkdown.ts) because embedded images need to
// invoke("read_file_bytes", ...) per image.
import type { JSONContent } from "@tiptap/core";
import {
  AlignmentType,
  BorderStyle,
  CommentReference,
  CommentRangeEnd,
  CommentRangeStart,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  IBordersOptions,
  type ICommentOptions,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ParagraphChild,
  type PositiveUniversalMeasure,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from "docx";
import { invoke } from "@tauri-apps/api/tauri";
import type { DocComment, DocPageSize } from "./docTypes";
import { PAGE_DIMENSIONS_IN, PAGE_MARGIN_IN } from "./docPageGeometry";

const ALIGNMENT_BY_TEXT_ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function alignmentFor(node: JSONContent) {
  const align = node.attrs?.textAlign as string | undefined;
  return align ? ALIGNMENT_BY_TEXT_ALIGN[align] : undefined;
}

// docx's ImageRun only accepts these four raster types (confirmed from the library's own
// RegularImageOptions type) - notably NOT "jpeg" or "webp", unlike the MIME-derived extensions
// docImagePaste.ts/docxImport.ts can produce. A webp image saved earlier via paste/import simply
// can't be embedded here; skipped with a console.error rather than mistyped or aborting the export.
const DOCX_IMAGE_TYPE_BY_EXTENSION: Record<string, "jpg" | "png" | "gif" | "bmp"> = {
  jpg: "jpg",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  bmp: "bmp",
};

// Tauri v1's convertFileSrc is just `${protocol}://localhost/${encodeURIComponent(path)}` - both
// the classic asset:// scheme and the https://asset.localhost/ scheme (used when the custom
// protocol isn't registered as secure) are stripped to recover the original absolute path.
const ASSET_URL_PREFIXES = ["https://asset.localhost/", "asset://localhost/"];

function resolveImagePath(src: string): string | null {
  const prefix = ASSET_URL_PREFIXES.find((p) => src.startsWith(p));
  if (!prefix) return null;
  try {
    return decodeURIComponent(src.slice(prefix.length));
  } catch {
    return null;
  }
}

// Fallback for images with no explicit width/height (DocImageView.tsx's resize handles, added
// after this default was introduced, now set node.attrs.width/height for any image the user has
// resized - this stays the fallback for images that were never resized, e.g. from before that
// feature shipped, or freshly cropped/inserted).
const DEFAULT_IMAGE_WIDTH = 400;
const DEFAULT_IMAGE_HEIGHT = 300;

async function buildImageRun(src: string, width?: number | null, height?: number | null): Promise<ImageRun | null> {
  const path = resolveImagePath(src);
  if (!path) return null;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const type = DOCX_IMAGE_TYPE_BY_EXTENSION[extension];
  if (!type) {
    console.error(`Skipping image with unsupported docx export type: ".${extension}"`);
    return null;
  }
  try {
    const bytes = await invoke<number[]>("read_file_bytes", { path });
    return new ImageRun({
      type,
      data: new Uint8Array(bytes),
      transformation: { width: width ?? DEFAULT_IMAGE_WIDTH, height: height ?? DEFAULT_IMAGE_HEIGHT },
    });
  } catch (err) {
    console.error("Failed to embed image in docx export:", err);
    return null;
  }
}

// Flat TextRun properties, unlike docMarkdown.ts's string-wrapping - a docx run's formatting is a
// property bag, not markup, so there's no nesting/precedence concern here. forceBold is used by
// table-header cells (docx has no distinct header-cell type, unlike tableHeader in the schema).
function runOptionsFromMarks(marks: JSONContent["marks"], forceBold: boolean) {
  const has = (type: string) => marks?.some((m) => m.type === type) ?? false;
  const textStyle = marks?.find((m) => m.type === "textStyle");
  const color = textStyle?.attrs?.color as string | undefined;
  const fontFamily = textStyle?.attrs?.fontFamily as string | undefined;
  const fontSizePt = textStyle?.attrs?.fontSize as number | undefined;
  // A separate mark, not a textStyle attribute (see @tiptap/extension-highlight's own source -
  // it's its own Mark rendering <mark>, unlike Color/FontFamily/FontSize which all bolt onto
  // textStyle) - docx has no first-class "highlight" concept either, approximated the same way
  // table-cell/code shading already is: a background fill on the run.
  const highlightColor = marks?.find((m) => m.type === "highlight")?.attrs?.color as string | undefined;
  return {
    bold: has("bold") || forceBold || undefined,
    italics: has("italic") || undefined,
    strike: has("strike") || undefined,
    ...(has("underline") ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(color ? { color: color.replace("#", "") } : {}),
    ...(fontFamily ? { font: fontFamily } : {}),
    // docx's own run size is in half-points (OOXML convention), not points.
    ...(fontSizePt ? { size: fontSizePt * 2 } : {}),
    ...(highlightColor ? { shading: { fill: highlightColor.replace("#", "") } } : {}),
    // No first-class inline-code concept in docx - approximated as monospace + light shading.
    // Placed last so it wins over any fontFamily/highlight above - code's own monospace+shading
    // look would win regardless of what the paragraph's own font/highlight is set to.
    ...(has("code") ? { font: "Consolas", shading: { fill: "F0F0F0" } } : {}),
  };
}

// commentIdFor maps a comment mark's UUID commentId to the small sequential integer id real .docx
// comments need (Word's own CommentRangeStart/End/Reference/Comment XML all key off a plain
// number, not a UUID) - passed in from DocxBuilder rather than looked up globally, since the
// mapping (and which comments actually got referenced, for the final Comments list) is per-export
// state, not something this standalone function should own itself.
async function renderInline(content: JSONContent[] | undefined, commentIdFor: (uuid: string) => number, forceBold = false): Promise<ParagraphChild[]> {
  if (!content) return [];
  const runs: ParagraphChild[] = [];
  // A comment mark wraps a *range* of text, which can span several runs (e.g. commented text that's
  // also partly bold) - tracked here as "the comment range currently open", closed either when the
  // next node's commentId differs or at the end of this content array. Only handles ranges within a
  // single call to renderInline (i.e. within one paragraph/list-item/etc's own content) - a comment
  // spanning across separate top-level blocks is a rarer case this doesn't attempt to reconstruct.
  let activeCommentId: string | null = null;
  const closeComment = () => {
    if (!activeCommentId) return;
    const numericId = commentIdFor(activeCommentId);
    runs.push(new CommentRangeEnd(numericId));
    runs.push(new CommentReference(numericId));
    activeCommentId = null;
  };
  for (const node of content) {
    const commentId = (node.marks?.find((m) => m.type === "comment")?.attrs?.commentId as string | undefined) ?? null;
    if (commentId !== activeCommentId) {
      closeComment();
      if (commentId) {
        runs.push(new CommentRangeStart(commentIdFor(commentId)));
        activeCommentId = commentId;
      }
    }
    if (node.type === "text") {
      const options = { text: node.text ?? "", ...runOptionsFromMarks(node.marks, forceBold) };
      const link = node.marks?.find((m) => m.type === "link");
      if (link?.attrs?.href) {
        runs.push(
          new ExternalHyperlink({
            children: [new TextRun({ ...options, style: "Hyperlink" })],
            link: link.attrs.href as string,
          })
        );
      } else {
        runs.push(new TextRun(options));
      }
    } else if (node.type === "hardBreak") {
      runs.push(new TextRun({ text: "", break: 1 }));
    } else if (node.type === "image") {
      const src = (node.attrs?.src as string) ?? "";
      const image = await buildImageRun(src, node.attrs?.width, node.attrs?.height);
      if (image) runs.push(image);
    }
  }
  closeComment();
  return runs;
}

// Tiptap's Heading schema allows levels 1-6 by default (docSchemaExtensions.ts doesn't restrict
// it) even though DocsEditor.tsx's toolbar only exposes buttons for H1-H3 - a .docx imported via
// docxImport.ts can still contain deeper heading levels straight from Word's own Heading 4-6
// styles. Leaving levels 4-6 out of this map meant `heading` resolved to undefined and the whole
// paragraph silently lost all styling on export (confirmed empirically: exported XML for an H4
// paragraph came back as bare <w:p><w:r><w:t>...</w:t></w:r></w:p>, no pStyle, no formatting at
// all) - so all 6 levels the schema actually allows are mapped here.
const HEADING_BY_LEVEL: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

// Ordered lists in docx need a numbering "reference" pre-registered on the Document (inline
// per-paragraph numbering isn't supported) - this walker accumulates one { reference, levels[] }
// entry per distinct *top-level* orderedList encountered, sharing the same reference across a
// list's own nested sub-lists (level incremented) so numbering doesn't restart mid-list, while
// separate top-level lists each get a fresh, independent reference/counter.
interface NumberingLevel {
  level: number;
  format: (typeof LevelFormat)[keyof typeof LevelFormat];
  text: string;
  alignment: (typeof AlignmentType)[keyof typeof AlignmentType];
  start: number;
}

class DocxBuilder {
  private numberingConfigs: { reference: string; levels: NumberingLevel[] }[] = [];
  private nextListId = 0;
  // Populated by build() before any rendering starts - the DocComment records available to look up
  // each referenced commentId's actual text/date when the final Comments list is assembled.
  private comments: DocComment[] = [];
  private commentNumericIds = new Map<string, number>();
  private nextCommentNumericId = 0;

  // An arrow class field (auto-bound), not a plain method, so it can be passed directly as
  // renderInline's commentIdFor callback without a separate .bind(this) at every call site.
  private commentIdFor = (uuid: string): number => {
    let id = this.commentNumericIds.get(uuid);
    if (id === undefined) {
      id = this.nextCommentNumericId++;
      this.commentNumericIds.set(uuid, id);
    }
    return id;
  };

  private registerNumberingLevel(reference: string, level: number, start: number): void {
    let config = this.numberingConfigs.find((c) => c.reference === reference);
    if (!config) {
      config = { reference, levels: [] };
      this.numberingConfigs.push(config);
    }
    if (!config.levels.some((l) => l.level === level)) {
      config.levels.push({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        start,
      });
    }
  }

  private async renderBulletList(node: JSONContent, level: number): Promise<Paragraph[]> {
    const out: Paragraph[] = [];
    for (const item of node.content ?? []) {
      for (const child of item.content ?? []) {
        if (child.type === "paragraph") {
          out.push(
            new Paragraph({
              children: await renderInline(child.content, this.commentIdFor),
              bullet: { level },
              alignment: alignmentFor(child),
            })
          );
        } else if (child.type === "bulletList") {
          out.push(...(await this.renderBulletList(child, level + 1)));
        } else if (child.type === "orderedList") {
          out.push(...(await this.renderOrderedList(child, level + 1)));
        }
      }
    }
    return out;
  }

  private async renderOrderedList(node: JSONContent, level: number, reference?: string): Promise<Paragraph[]> {
    const ref = reference ?? `ordered-${this.nextListId++}`;
    const start = (node.attrs?.start as number) ?? 1;
    this.registerNumberingLevel(ref, level, start);

    const out: Paragraph[] = [];
    for (const item of node.content ?? []) {
      for (const child of item.content ?? []) {
        if (child.type === "paragraph") {
          out.push(
            new Paragraph({
              children: await renderInline(child.content, this.commentIdFor),
              numbering: { reference: ref, level },
              alignment: alignmentFor(child),
            })
          );
        } else if (child.type === "bulletList") {
          out.push(...(await this.renderBulletList(child, level + 1)));
        } else if (child.type === "orderedList") {
          // Nested ordered list within the same top-level list - reuse the reference so
          // numbering continues as one logical list, just at a deeper level.
          out.push(...(await this.renderOrderedList(child, level + 1, ref)));
        }
      }
    }
    return out;
  }

  private async renderTableCell(cell: JSONContent): Promise<TableCell> {
    const isHeader = cell.type === "tableHeader";
    const children: (Paragraph | Table)[] = [];
    for (const block of cell.content ?? []) {
      // docx has no distinct header-cell type - force bold on header cells' text runs, mirroring
      // docMarkdown.ts's own firstRowIsHeader handling for the same schema-level gap.
      const rendered = await this.renderBlock(block, { forceBold: isHeader });
      children.push(...rendered);
    }
    if (children.length === 0) children.push(new Paragraph({}));
    return new TableCell({ children, width: { size: 100 / (cell.attrs?.colspan ?? 1), type: WidthType.PERCENTAGE } });
  }

  private async renderTable(node: JSONContent): Promise<Table | null> {
    const rows = node.content ?? [];
    if (rows.length === 0) return null;
    const tableRows: TableRow[] = [];
    for (const row of rows) {
      const cells: TableCell[] = [];
      for (const cell of row.content ?? []) cells.push(await this.renderTableCell(cell));
      tableRows.push(new TableRow({ children: cells }));
    }
    return new Table({
      rows: tableRows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      // Matches the live editor's own table style (Tailwind Typography's default: no outer/vertical
      // borders, only a thin line between rows - see @tailwindcss/typography's styles.js, `thead`/
      // `tbody tr` get border-bottom only) - docx's own Table default is a full black grid, which
      // doesn't reflect what the table actually looks like in Docs, so it's overridden explicitly
      // rather than left at that default.
      borders: {
        top: { style: BorderStyle.NONE, size: 0, color: "auto" },
        bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
        left: { style: BorderStyle.NONE, size: 0, color: "auto" },
        right: { style: BorderStyle.NONE, size: 0, color: "auto" },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      },
    });
  }

  // extraParagraphProps carries context a container passes down into any Paragraph it produces -
  // forceBold for table-header cells, indent/border for blockquote (docx Paragraphs are opaque
  // once constructed, so there's no way to apply this after the fact; it has to be baked in at
  // construction time instead). Only paragraph/heading/codeBlock lines actually consume it -
  // nested lists/tables inside a blockquote keep their own styling, a known approximation.
  private async renderBlock(
    node: JSONContent,
    extraParagraphProps: { forceBold?: boolean; indent?: { left: number }; border?: IBordersOptions } = {}
  ): Promise<(Paragraph | Table)[]> {
    const { forceBold = false, indent, border } = extraParagraphProps;
    switch (node.type) {
      case "paragraph":
        return [
          new Paragraph({
            children: await renderInline(node.content, this.commentIdFor, forceBold),
            alignment: alignmentFor(node),
            indent,
            border,
          }),
        ];
      case "heading": {
        const level = (node.attrs?.level as number) ?? 1;
        return [
          new Paragraph({
            children: await renderInline(node.content, this.commentIdFor, forceBold),
            heading: HEADING_BY_LEVEL[level],
            alignment: alignmentFor(node),
            indent,
            border,
          }),
        ];
      }
      case "bulletList":
        return this.renderBulletList(node, 0);
      case "orderedList":
        return this.renderOrderedList(node, 0);
      case "blockquote": {
        // docx has no first-class blockquote - approximated with an indent + left border, passed
        // down into whatever paragraphs its contained blocks produce.
        const quoteProps = {
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 8 } },
        };
        const out: (Paragraph | Table)[] = [];
        for (const child of node.content ?? []) out.push(...(await this.renderBlock(child, quoteProps)));
        return out;
      }
      case "codeBlock": {
        const language = (node.attrs?.language as string) ?? "";
        void language; // docx has no syntax-highlighting concept - monospace + shading only.
        const text = (node.content ?? []).map((c) => c.text ?? "").join("");
        return text.split("\n").map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: line, font: "Consolas", shading: { fill: "F0F0F0" } })],
              indent,
              border,
            })
        );
      }
      case "image": {
        const src = (node.attrs?.src as string) ?? "";
        const image = await buildImageRun(src, node.attrs?.width, node.attrs?.height);
        return image ? [new Paragraph({ children: [image] })] : [];
      }
      case "table": {
        const table = await this.renderTable(node);
        return table ? [table] : [];
      }
      // docx's own PageBreak is a Run (extends Run - see its own import), the standard idiom for
      // forcing one is a Paragraph containing nothing but it.
      case "pageBreak":
        return [new Paragraph({ children: [new PageBreak()] })];
      default:
        return [new Paragraph({ children: await renderInline(node.content, this.commentIdFor, forceBold) })];
    }
  }

  private async renderBlocks(nodes: JSONContent[]): Promise<(Paragraph | Table)[]> {
    const out: (Paragraph | Table)[] = [];
    for (const node of nodes) out.push(...(await this.renderBlock(node)));
    return out;
  }

  async build(json: JSONContent, title: string, options: DocxExportOptions = {}): Promise<Uint8Array> {
    this.comments = options.comments ?? [];
    const children = await this.renderBlocks(json.content ?? []);

    // Only comments whose mark actually appears somewhere in the rendered content end up here -
    // commentNumericIds is populated exclusively by renderInline's commentIdFor calls during the
    // renderBlocks() pass just above, so a resolved-but-still-anchored comment still exports (this
    // format has no "resolved" concept to preserve), while a comment whose mark was already
    // removed from the doc doesn't produce a dangling, unreferenced Comment entry.
    // Document's own `comments` option wants plain ICommentOptions data, not Comment class
    // instances (those are what docx builds internally *from* this data) - confirmed by the type
    // error passing `new Comment(...)` here originally produced.
    const commentChildren: ICommentOptions[] = [...this.commentNumericIds.entries()].map(([uuid, id]) => {
      const comment = this.comments.find((c) => c.mark_id === uuid);
      return {
        id,
        author: "Briefcast",
        initials: "BC",
        date: comment?.created_at ? new Date(comment.created_at) : new Date(),
        children: [new Paragraph({ children: [new TextRun(comment?.text ?? "")] })],
      };
    });

    // Matches the live editor/print output exactly - same page dimensions (docPageGeometry.ts) and
    // the same real 1in margin on every side, not docx's own unrelated defaults.
    const dims = PAGE_DIMENSIONS_IN[options.pageSize ?? "letter"];
    const width = `${dims.width}in` as PositiveUniversalMeasure;
    const height = `${dims.height}in` as PositiveUniversalMeasure;
    const margin = `${PAGE_MARGIN_IN}in` as PositiveUniversalMeasure;

    const doc = new Document({
      title,
      numbering: { config: this.numberingConfigs },
      comments: commentChildren.length > 0 ? { children: commentChildren } : undefined,
      sections: [
        {
          properties: {
            page: {
              size: { width, height },
              margin: { top: margin, bottom: margin, left: margin, right: margin },
            },
          },
          // Repeats on every page in real Word, unlike the CSS position:fixed trick the live
          // print/PDF path needs (see DocsEditor.tsx's own comment on that) - .docx's header/footer
          // model is native page-chrome, no workaround required here.
          headers: options.headerText
            ? { default: new Header({ children: [new Paragraph({ children: [new TextRun(options.headerText)] })] }) }
            : undefined,
          footers: options.footerText
            ? { default: new Footer({ children: [new Paragraph({ children: [new TextRun(options.footerText)] })] }) }
            : undefined,
          children,
        },
      ],
    });
    // Packer.toBuffer() hardcodes JSZip's "nodebuffer" output type internally, which requires
    // Node's global Buffer and throws ("nodebuffer is not supported by this platform") in a
    // webview - toBlob() uses JSZip's "blob" type instead, which browsers/webviews do support.
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
  }
}

export interface DocxExportOptions {
  comments?: DocComment[];
  pageSize?: DocPageSize | null;
  headerText?: string | null;
  footerText?: string | null;
}

export async function buildDocxBytes(json: JSONContent, title: string, options?: DocxExportOptions): Promise<Uint8Array> {
  return new DocxBuilder().build(json, title, options);
}
