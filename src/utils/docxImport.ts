// utils/docxImport.ts
//
// Converts a picked .docx file into a real Docs document: mammoth.js turns the .docx bytes into
// HTML (running entirely in the webview, no Node runtime needed), that HTML is parsed into a
// ProseMirror Node using the exact same schema DocsEditor.tsx's live editor builds (see
// docSchemaExtensions.ts), and y-prosemirror's prosemirrorToYDoc - the same tree-walking machinery
// ySyncPlugin itself uses - builds a Y.Doc from that Node headlessly, with no live Editor/
// useEditor mount required for the import step itself. The result is handed to the same
// create_doc/save_doc Rust commands every other doc already goes through, so an imported doc is
// completely indistinguishable from a hand-created one the moment it lands in DocsHome's list.
import * as mammoth from "mammoth";
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import {
  DOMParser as ProseMirrorDOMParser,
  Fragment,
  Mark,
  type MarkType,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { EXTENSION_BY_MIME } from "./docImagePaste";
import {
  type DocxDocumentMetadata,
  type DocxTableMeta,
  type ParagraphStyle,
  type RunStyle,
  resolveDocxMetadata,
} from "./docxStyleResolver";
import { writeLayout } from "./docLayout";

export interface ImportedDoc {
  id: string;
  title: string;
}

const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 80);

export function prepareConvertedDom(
  body: HTMLElement,
  imageSizes: Array<{ width: number; height: number } | null>,
  tablesMeta: DocxTableMeta[]
): void {
  // 1. Strip empty bookmark anchors (<a id="..."></a>) that mammoth emits for <w:bookmarkStart/>;
  // unwrap non-empty anchor bookmarks without href so they don't confuse ProseMirror mark parsing.
  body.querySelectorAll("a:not([href])").forEach((a) => {
    if ((a.textContent ?? "").length === 0 && a.children.length === 0) {
      a.remove();
    } else {
      a.replaceWith(...Array.from(a.childNodes));
    }
  });

  // 2. Apply <wp:extent> pixel dimensions to embedded <img> elements in document order.
  const imgs = Array.from(body.querySelectorAll("img"));
  imgs.forEach((img, idx) => {
    const sz = imageSizes[idx];
    if (sz) {
      img.setAttribute("width", String(sz.width));
      img.setAttribute("height", String(sz.height));
    }
  });

  // 3. Apply table metadata (or unwrap single-column borderless wrapper tables so their blocks
  // sit at the top level of the document and paginate across pages).
  const tables = Array.from(body.querySelectorAll("table"));
  tables.forEach((table, idx) => {
    const meta = tablesMeta[idx];
    if (!meta) return;

    if (meta.isSingleColumnLayoutWrapper) {
      const extractedChildren: Node[] = [];
      table.querySelectorAll("tr").forEach((tr) => {
        Array.from(tr.children).forEach((cell) => {
          const hasText = (cell.textContent ?? "").trim().length > 0;
          const hasMedia = cell.querySelector("img, table, hr") !== null;
          if (hasText || hasMedia) {
            extractedChildren.push(...Array.from(cell.childNodes));
          }
        });
      });
      if (extractedChildren.length > 0) {
        table.replaceWith(...extractedChildren);
        return;
      }
    }

    if (meta.rules) {
      table.setAttribute("data-rules", meta.rules);
    }
    const rows = Array.from(table.querySelectorAll("tr"));
    rows.forEach((tr, rIdx) => {
      const rowMeta = meta.cells[rIdx];
      if (!rowMeta) return;
      const cells = Array.from(tr.children).filter((c) => c.tagName === "TD" || c.tagName === "TH");
      cells.forEach((cell, cIdx) => {
        const cm = rowMeta[cIdx];
        if (!cm) return;
        if (cm.background) cell.setAttribute("data-background", cm.background);
        if (cm.colwidth) cell.setAttribute("colwidth", String(cm.colwidth));
      });
    });
  });

  // 4. Remove any empty <p> or <h1..h6> that might remain (e.g. if a paragraph contained only a
  // bookmark anchor), keeping 1 <p> inside an otherwise empty table cell or list item.
  body.querySelectorAll("p, h1, h2, h3, h4, h5, h6").forEach((el) => {
    const hasText = (el.textContent ?? "").trim().length > 0;
    const hasInline = el.querySelector("img, br, hr, input") !== null;
    if (hasText || hasInline) return;
    const parent = el.parentElement;
    if (parent && (parent.tagName === "TD" || parent.tagName === "TH" || parent.tagName === "LI")) {
      const siblingBlocks = Array.from(parent.children).filter((c) => c !== el);
      if (siblingBlocks.length === 0) return;
    }
    el.remove();
  });

  // 5. Preserve multi-space runs (xml:space="preserve", e.g. "   |   " or aligned columns) and
  // tabs (\t) so ProseMirrorDOMParser's HTML whitespace collapsing doesn't squash them.
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const val = textNode.nodeValue;
    if (val) {
      let nextVal = val;
      if (nextVal.includes("\t")) {
        nextVal = nextVal.replace(/\t/g, "\u00a0");
      }
      if (nextVal.includes("  ")) {
        nextVal = nextVal.replace(/ {2,}/g, (m) => " " + "\u00a0".repeat(m.length - 1));
      }
      if (nextVal !== val) {
        textNode.nodeValue = nextVal;
      }
    }
    textNode = walker.nextNode() as Text | null;
  }
}

function buildMarksForSlice(
  baseMarks: readonly Mark[],
  run: RunStyle | null,
  para: ParagraphStyle,
  isHeading: boolean,
  schema: Schema
): readonly Mark[] {
  let marks = [...baseMarks];
  const isLink = marks.some((m) => m.type.name === "link");

  // Update link underlineOff if the run inside the hyperlink explicitly disables underline.
  const effectiveUnderline = run?.underline !== null && run?.underline !== undefined ? run.underline : para.underline;
  if (isLink && effectiveUnderline === false && schema.marks.link) {
    marks = marks.map((m) => (m.type.name === "link" ? schema.marks.link.create({ ...m.attrs, underlineOff: true }) : m));
  } else if (!isLink && effectiveUnderline === true && schema.marks.underline && !marks.some((m) => m.type.name === "underline")) {
    marks.push(schema.marks.underline.create());
  }

  // Bold handling:
  // - In headings, CSS makes text bold by default. If the .docx heading style or run has bold === false
  //   (e.g. Google Docs' Heading 2 / Heading 3 with <w:b w:val="0"/>), strip any bold mark and emit
  //   fontWeight: "normal" on textStyle.
  // - In paragraphs, if the style or run has bold === true (e.g. a Title paragraph style where bold
  //   lives on the style definition rather than the run), add the bold mark.
  const effectiveBold = run?.bold !== null && run?.bold !== undefined ? run.bold : para.bold;
  if (isHeading) {
    if (effectiveBold === false) {
      marks = marks.filter((m) => m.type.name !== "bold");
    }
  } else {
    if (effectiveBold === true && schema.marks.bold && !marks.some((m) => m.type.name === "bold")) {
      marks.push(schema.marks.bold.create());
    } else if (effectiveBold === false) {
      marks = marks.filter((m) => m.type.name !== "bold");
    }
  }

  // Italic handling:
  const effectiveItalic = run?.italic !== null && run?.italic !== undefined ? run.italic : para.italic;
  if (effectiveItalic === true && schema.marks.italic && !marks.some((m) => m.type.name === "italic")) {
    marks.push(schema.marks.italic.create());
  } else if (effectiveItalic === false) {
    marks = marks.filter((m) => m.type.name !== "italic");
  }

  // Build textStyle mark attributes. Note: fontSize is stored as a point number (e.g. 11, 16) per
  // docFontSizeExtension.ts, which renders `font-size: ${attributes.fontSize}pt`.
  const fontFamily = run?.fontFamily ?? para.fontFamily ?? null;
  const fontSize = run?.fontSizePt ?? para.fontSizePt ?? null;
  const color = run?.color ?? para.color ?? null;
  const fontWeight: "normal" | null =
    isHeading && effectiveBold === false ? "normal" : (run?.fontWeight ?? null);
  const fontStyle: "normal" | null = run?.fontStyle ?? null;
  const tabAlign: "right" | null = run?.tabAlign ?? null;

  if ((fontFamily || fontSize || color || fontWeight || fontStyle || tabAlign) && schema.marks.textStyle) {
    const existingTs = marks.find((m) => m.type.name === "textStyle");
    marks = marks.filter((m) => m.type.name !== "textStyle");
    marks.push(
      schema.marks.textStyle.create({
        ...(existingTs?.attrs ?? {}),
        fontFamily: fontFamily ?? existingTs?.attrs?.fontFamily ?? null,
        fontSize: fontSize ?? existingTs?.attrs?.fontSize ?? null,
        color: color ?? existingTs?.attrs?.color ?? null,
        fontWeight: fontWeight ?? existingTs?.attrs?.fontWeight ?? null,
        fontStyle: fontStyle ?? existingTs?.attrs?.fontStyle ?? null,
        tabAlign: tabAlign ?? existingTs?.attrs?.tabAlign ?? null,
      })
    );
  }

  return marks;
}

function applyRunsToInlineChildren(
  node: ProseMirrorNode,
  para: ParagraphStyle,
  isHeading: boolean,
  schema: Schema
): Fragment {
  const runs = para.runs ?? [];
  let runIdx = 0;
  let runOffset = 0;

  const nextRunSlice = (maxLen: number): { run: RunStyle | null; len: number } => {
    while (runIdx < runs.length && runOffset >= runs[runIdx].text.length) {
      runIdx++;
      runOffset = 0;
    }
    if (runIdx >= runs.length) {
      return { run: null, len: maxLen };
    }
    const curRun = runs[runIdx];
    const avail = curRun.text.length - runOffset;
    const take = Math.min(maxLen, avail);
    runOffset += take;
    return { run: curRun, len: take };
  };

  const outChildren: ProseMirrorNode[] = [];
  node.content.forEach((child) => {
    if (!child.isText || !child.text) {
      outChildren.push(child);
      return;
    }
    const text = child.text;
    let pos = 0;
    while (pos < text.length) {
      const { run, len } = nextRunSlice(text.length - pos);
      const sliceLen = Math.max(1, len);
      const sliceText = text.slice(pos, pos + sliceLen);
      pos += sliceLen;
      const marks = buildMarksForSlice(child.marks, run, para, isHeading, schema);
      outChildren.push(schema.text(sliceText, marks));
    }
  });

  return Fragment.from(outChildren);
}

// Walks the parsed ProseMirror document in document order alongside the resolved ParagraphStyle
// list, applying block-level spacing/alignment/indents/borders to each paragraph/heading/list and
// run-level font/size/color/weight marks to each text segment.
export function applyParagraphStyles(
  doc: ProseMirrorNode,
  markTypeOrStyles: MarkType | ParagraphStyle[] | undefined,
  maybeStyles?: ParagraphStyle[],
): ProseMirrorNode {
  const paragraphStyles = Array.isArray(markTypeOrStyles) ? markTypeOrStyles : (maybeStyles ?? []);
  if (paragraphStyles.length === 0) return doc;
  const schema = doc.type.schema;
  let index = 0;

  const matchNextStyle = (node: ProseMirrorNode): ParagraphStyle | undefined => {
    if (index >= paragraphStyles.length) return undefined;
    const nodePreview = normalizeText(node.textContent);
    const currentPreview = paragraphStyles[index].textPreview;
    if (nodePreview === currentPreview) {
      return paragraphStyles[index++];
    }
    // Look ahead up to 6 entries in case an empty block or wrapper differed: resync immediately.
    if (nodePreview.length > 0) {
      const maxLookahead = Math.min(paragraphStyles.length, index + 6);
      for (let k = index + 1; k < maxLookahead; k++) {
        if (paragraphStyles[k].textPreview === nodePreview) {
          index = k + 1;
          return paragraphStyles[k];
        }
      }
    }
    return paragraphStyles[index++];
  };

  const walk = (node: ProseMirrorNode): ProseMirrorNode => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      const s = matchNextStyle(node);
      if (!s) return node;
      const isHeading = node.type.name === "heading";
      const attrs: Record<string, unknown> = {
        ...node.attrs,
        lineSpacing: s.lineSpacing ?? node.attrs.lineSpacing,
        spaceBefore: s.spaceBeforePt !== null ? s.spaceBeforePt : node.attrs.spaceBefore,
        spaceAfter: s.spaceAfterPt !== null ? s.spaceAfterPt : node.attrs.spaceAfter,
        textAlign: s.textAlign ?? node.attrs.textAlign,
        indentLeft: s.indentLeftIn ?? node.attrs.indentLeft,
        indentRight: s.indentRightIn ?? node.attrs.indentRight,
        indentFirst: s.indentFirstIn ?? node.attrs.indentFirst,
        borderBottom: s.borderBottom ?? node.attrs.borderBottom,
      };
      const content = applyRunsToInlineChildren(node, s, isHeading, schema);
      return node.type.create(attrs, content, node.marks);
    }

    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      const startIndex = index;
      const children: ProseMirrorNode[] = [];
      node.forEach((child) => children.push(walk(child)));
      const endIndex = index;

      const firstItemStyle = startIndex < endIndex ? paragraphStyles[startIndex] : undefined;
      const lastItemStyle = endIndex > startIndex ? paragraphStyles[endIndex - 1] : undefined;

      // Transfer the first list item's spaceBefore (including any folded blank paragraph space
      // above the list) and the last list item's spaceAfter onto the list block itself so the
      // top-level list container has exact margins instead of ProseMirror's default 1rem (mt-4).
      const listAttrs: Record<string, unknown> = {
        ...node.attrs,
        spaceBefore:
          firstItemStyle?.spaceBeforePt !== undefined && firstItemStyle.spaceBeforePt !== null
            ? firstItemStyle.spaceBeforePt
            : node.attrs.spaceBefore,
        spaceAfter:
          lastItemStyle?.spaceAfterPt !== undefined && lastItemStyle.spaceAfterPt !== null
            ? lastItemStyle.spaceAfterPt
            : node.attrs.spaceAfter,
      };
      if (node.type.name === "bulletList" && firstItemStyle?.bulletMarker) {
        listAttrs.bulletMarker = firstItemStyle.bulletMarker;
      }
      if (firstItemStyle?.listIndentLeftIn) {
        listAttrs.indentLeft = firstItemStyle.listIndentLeftIn;
      }

      // Zero out the first list item's inner paragraph spaceBefore so it isn't applied twice.
      if (children.length > 0 && firstItemStyle?.spaceBeforePt) {
        const firstLi = children[0];
        if (firstLi.childCount > 0 && firstLi.firstChild?.type.name === "paragraph") {
          const firstP = firstLi.firstChild;
          const restLiChildren: ProseMirrorNode[] = [
            firstP.type.create({ ...firstP.attrs, spaceBefore: 0 }, firstP.content, firstP.marks),
          ];
          for (let i = 1; i < firstLi.childCount; i++) restLiChildren.push(firstLi.child(i));
          children[0] = firstLi.type.create(firstLi.attrs, Fragment.from(restLiChildren), firstLi.marks);
        }
      }

      return node.type.create(listAttrs, Fragment.from(children), node.marks);
    }

    if (node.content.childCount === 0) return node;
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(walk(child)));
    return node.copy(Fragment.fromArray(children));
  };

  return walk(doc);
}

// mammoth's own Image descriptor exposes contentType (a MIME string) and several read methods -
// readAsArrayBuffer() is the browser-safe one (readAsBuffer()/read() return a Node Buffer, which
// doesn't exist in the webview).
async function saveEmbeddedImage(
  docId: string,
  image: { contentType: string; readAsArrayBuffer: () => Promise<ArrayBuffer> }
): Promise<{ src: string }> {
  const extension = EXTENSION_BY_MIME[image.contentType];
  if (!extension) {
    throw new Error(`Unsupported embedded image type: "${image.contentType || "unknown"}"`);
  }
  const arrayBuffer = await image.readAsArrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  const path = await invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension, bytes });
  return { src: convertFileSrc(path) };
}

export async function parseDocxBytesToDoc(
  bytes: Uint8Array,
  options?: {
    docIdForImages?: string;
    schema?: Schema;
  }
): Promise<{ node: ProseMirrorNode; meta: DocxDocumentMetadata }> {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const mammothOpts = options?.docIdForImages
    ? { convertImage: mammoth.images.imgElement((image) => saveEmbeddedImage(options.docIdForImages!, image)) }
    : undefined;

  const [result, meta] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer }, mammothOpts),
    resolveDocxMetadata(bytes),
  ]);
  if (result.messages.some((m) => m.type === "error")) {
    console.error("mammoth reported errors converting .docx:", result.messages);
  }

  const schema = options?.schema ?? getSchema(getDocContentExtensions());
  const dom = new DOMParser().parseFromString(result.value, "text/html");
  prepareConvertedDom(dom.body, meta.imageSizes, meta.tables);

  const parsedNode = ProseMirrorDOMParser.fromSchema(schema).parse(dom.body);
  const node = applyParagraphStyles(parsedNode, schema.marks.textStyle, meta.paragraphs);
  return { node, meta };
}

// `preread` - the file's bytes when the caller already has them (docFileImport.ts reads them to
// fingerprint the file first), so the file isn't read twice.
export async function importDocxFile(path: string, fileName: string, preread?: ArrayBuffer): Promise<ImportedDoc> {
  const id = crypto.randomUUID();
  const title = fileName.replace(/\.docx$/i, "");

  // Reserve the doc's folder first (as an empty placeholder) - save_doc_image below needs
  // Docs/<id>/assets/ to already make sense as "this doc's folder", and create_doc's own
  // "must not already exist" guard means it has to run before anything else touches that path.
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(new Y.Doc())) });

  try {
    const arrayBuffer = preread ?? (await invoke<ArrayBuffer>("read_file_bytes", { path }));
    const { node, meta } = await parseDocxBytesToDoc(new Uint8Array(arrayBuffer), { docIdForImages: id });

    const ydoc = prosemirrorToYDoc(node, "default");
    if (meta.pageSetup && meta.pageSetup.columns === 2) {
      writeLayout(ydoc, {
        body: null,
        columns: 2,
        columnGap: meta.pageSetup.columnGapIn,
      });
    }

    await invoke("save_doc", { id, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), title });

    if (meta.pageSetup) {
      await invoke("set_doc_page_setup", {
        id,
        pageSize: meta.pageSetup.pageSize,
        orientation: meta.pageSetup.orientation,
        margins: meta.pageSetup.margins,
        pageColor: meta.pageSetup.pageColor,
      });
    }

    return { id, title };
  } catch (err) {
    try {
      await invoke("delete_doc", { id });
    } catch (cleanupErr) {
      console.error("Failed to clean up placeholder doc after a failed import:", cleanupErr);
    }
    throw err;
  }
}
