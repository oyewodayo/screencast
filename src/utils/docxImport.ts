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
import { DOMParser as ProseMirrorDOMParser, Fragment, type Node as ProseMirrorNode, type MarkType } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { EXTENSION_BY_MIME } from "./docImagePaste";
import { resolveDocxParagraphStyles, type ParagraphStyle } from "./docxStyleResolver";

export interface ImportedDoc {
  id: string;
  title: string;
}

// Overlays docxStyleResolver's per-paragraph color/font/size (recovered by reading the .docx's raw
// OOXML directly - see that module's own header comment for why mammoth's HTML output alone can't
// carry this) onto mammoth's own structural ProseMirror output. Correlated purely by encounter
// order: both this walk and the resolver's own XML walk visit every paragraph/heading in a
// recursive depth-first, document-order traversal (top-level, inside a list item, inside a table
// cell - wherever it is), so the Nth paragraph/heading node this recursion reaches is assumed to
// be the Nth entry the resolver produced. True for the common case; an unusual paragraph type
// mammoth drops or restructures differently than a literal walk could misalign the two lists -
// best-effort fidelity improvement over having no styling at all, not a correctness guarantee.
function applyParagraphStyles(doc: ProseMirrorNode, markType: MarkType | undefined, paragraphStyles: ParagraphStyle[]): ProseMirrorNode {
  if (!markType || paragraphStyles.length === 0) return doc;
  const definiteMarkType = markType;
  let index = 0;

  function walk(node: ProseMirrorNode): ProseMirrorNode {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      const style = paragraphStyles[index];
      index++;
      return style ? applyStyleToTextRuns(node, definiteMarkType, style) : node;
    }
    if (node.content.childCount === 0) return node;
    const children: ProseMirrorNode[] = [];
    node.forEach((child) => children.push(walk(child)));
    return node.copy(Fragment.fromArray(children));
  }

  return walk(doc);
}

function applyStyleToTextRuns(node: ProseMirrorNode, markType: MarkType, style: ParagraphStyle): ProseMirrorNode {
  const attrs: Record<string, unknown> = {};
  if (style.color) attrs.color = style.color;
  if (style.fontFamily) attrs.fontFamily = style.fontFamily;
  if (style.fontSizePt) attrs.fontSize = style.fontSizePt;
  if (Object.keys(attrs).length === 0) return node;
  const mark = markType.create(attrs);

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    // Only text runs get the style - other inline content (e.g. an inline image) passes through
    // untouched, since "paragraph color/font" has no meaning for it.
    if (child.isText) {
      const otherMarks = child.marks.filter((m) => m.type !== markType);
      children.push(child.mark([...otherMarks, mark]));
    } else {
      children.push(child);
    }
  });
  return node.copy(Fragment.fromArray(children));
}

// mammoth's own Image descriptor exposes contentType (a MIME string) and several read methods -
// readAsArrayBuffer() is the browser-safe one (readAsBuffer()/read() return a Node Buffer, which
// doesn't exist in the webview).
async function saveEmbeddedImage(docId: string, image: { contentType: string; readAsArrayBuffer: () => Promise<ArrayBuffer> }): Promise<{ src: string }> {
  const extension = EXTENSION_BY_MIME[image.contentType];
  if (!extension) {
    // Same "don't silently drop it" reasoning as docImagePaste.ts - an image mammoth extracted
    // but this app doesn't have a whitelisted extension for becomes a visible warning in the
    // returned mammoth `messages` array (surfaced by the caller) rather than vanishing outright.
    throw new Error(`Unsupported embedded image type: "${image.contentType || "unknown"}"`);
  }
  const arrayBuffer = await image.readAsArrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  const path = await invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension, bytes });
  return { src: convertFileSrc(path) };
}

export async function importDocxFile(path: string, fileName: string): Promise<ImportedDoc> {
  const id = crypto.randomUUID();
  const title = fileName.replace(/\.docx$/i, "");

  // Reserve the doc's folder first (as an empty placeholder) - save_doc_image below needs
  // Docs/<id>/assets/ to already make sense as "this doc's folder", and create_doc's own
  // "must not already exist" guard means it has to run before anything else touches that path.
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(new Y.Doc())) });

  try {
    const fileBytes = await invoke<number[]>("read_file_bytes", { path });
    const arrayBuffer = new Uint8Array(fileBytes).buffer;

    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      { convertImage: mammoth.images.imgElement((image) => saveEmbeddedImage(id, image)) }
    );
    if (result.messages.some((m) => m.type === "error")) {
      console.error("mammoth reported errors converting .docx:", result.messages);
    }

    const schema = getSchema(getDocContentExtensions());
    const dom = new DOMParser().parseFromString(result.value, "text/html");
    const parsedNode = ProseMirrorDOMParser.fromSchema(schema).parse(dom.body);

    // Recovers color/font/size mammoth's own HTML conversion can't (see docxStyleResolver.ts) by
    // reading the .docx's raw OOXML directly, then overlaying it onto mammoth's structural output.
    const paragraphStyles = await resolveDocxParagraphStyles(new Uint8Array(fileBytes));
    const node = applyParagraphStyles(parsedNode, schema.marks.textStyle, paragraphStyles);

    // "default" matches @tiptap/extension-collaboration's own default field name (DocsEditor.tsx
    // never overrides it) - getting this wrong would silently put the imported content in a
    // fragment the live editor's Collaboration extension never looks at.
    const ydoc = prosemirrorToYDoc(node, "default");
    await invoke("save_doc", { id, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), title });

    return { id, title };
  } catch (err) {
    // A failed import shouldn't leave a phantom empty doc sitting in the main list - soft-delete
    // (the same mechanism DocsHome's own delete button uses) rather than adding a separate hard-
    // delete path just for this one edge case. Best-effort: a cleanup failure shouldn't mask the
    // real error from the caller.
    try {
      await invoke("delete_doc", { id });
    } catch (cleanupErr) {
      console.error("Failed to clean up placeholder doc after a failed import:", cleanupErr);
    }
    throw err;
  }
}
