// utils/docFileImport.ts
//
// Opening a document file (.docx, .md, .txt) in Briefcast Docs - "Open a file", a click on one in
// the library, or Docs home's Import - instead of handing it to another app. Like Google Docs'
// "Open with Google Docs", the file is converted into a Briefcast document (the original file is
// never touched; Export writes it back out as .docx/.md/.txt/PDF).
//
// Opening the same file again reopens the document made from it rather than importing a second
// copy - unless the file has changed since (edited in Word, say), when it's imported afresh so
// those changes aren't hidden behind an older copy. "Changed" is a fingerprint of the file's bytes,
// remembered per path in localStorage.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { EXTENSION_BY_MIME } from "./docImagePaste";
import { importDocxFile } from "./docxImport";
import type { DocSummary } from "./docTypes";

export const OPENABLE_DOC_EXTENSIONS = ["docx", "md", "markdown", "txt"];

export function isOpenableDocument(fileName: string): boolean {
  return OPENABLE_DOC_EXTENSIONS.includes(fileName.split(".").pop()?.toLowerCase() ?? "");
}

const OPENED_KEY = "briefcast.openedDocumentFiles.v1";

interface OpenedRecord {
  docId: string;
  fingerprint: string;
}

function readOpened(): Record<string, OpenedRecord> {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPENED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rememberOpened(path: string, record: OpenedRecord) {
  try {
    localStorage.setItem(OPENED_KEY, JSON.stringify({ ...readOpened(), [path.toLowerCase()]: record }));
  } catch {
    /* storage unavailable - the file is simply imported again next time */
  }
}

// FNV-1a over the bytes plus the length - cheap, and only has to tell "same file" from "changed".
export function fingerprintBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${bytes.length}:${(h >>> 0).toString(16)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// Plain text: a blank line separates paragraphs, a single line break stays a line break.
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function markdownToHtml(markdown: string): string {
  // Front matter (--- yaml ---) is metadata, not content.
  const body = markdown.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
}

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : "";
}

const EXT_BY_NAME: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpeg", gif: "gif", webp: "webp" };

// A Markdown file's pictures are usually files next to it ("![](images/plot.png)") - copied into
// the document's own assets so it doesn't depend on that folder staying put. Web images stay
// links; anything unreadable is dropped from the import rather than left as a broken picture.
async function adoptImages(docId: string, dom: Document, sourcePath: string): Promise<void> {
  const base = dirOf(sourcePath);
  for (const img of Array.from(dom.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (/^https?:/i.test(src)) continue;
    try {
      let bytes: Uint8Array;
      let extension: string | undefined;
      const data = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(src);
      if (data) {
        extension = EXTENSION_BY_MIME[data[1].toLowerCase()];
        bytes = Uint8Array.from(atob(data[2]), (c) => c.charCodeAt(0));
      } else {
        const rel = decodeURIComponent(src.replace(/^file:\/\/\/?/i, ""));
        const abs = /^([a-z]:[\\/]|[\\/])/i.test(rel) ? rel : `${base}\\${rel.replace(/\//g, "\\")}`;
        extension = EXT_BY_NAME[abs.split(".").pop()?.toLowerCase() ?? ""];
        if (!extension) throw new Error("unsupported image");
        bytes = new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path: abs }));
      }
      if (!extension) throw new Error("unsupported image");
      const saved = await invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension, bytes: Array.from(bytes) });
      img.setAttribute("src", convertFileSrc(saved));
    } catch (err) {
      console.warn(`Skipping image "${src}" while importing:`, err);
      img.remove();
    }
  }
}

// A new Briefcast document from HTML - the same create_doc/save_doc path every document takes.
async function createDocFromHtml(title: string, html: string, sourcePath: string): Promise<string> {
  const id = crypto.randomUUID();
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(new Y.Doc())) });
  try {
    const dom = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    await adoptImages(id, dom, sourcePath);
    const schema = getSchema(getDocContentExtensions());
    const node = ProseMirrorDOMParser.fromSchema(schema).parse(dom.body);
    const ydoc = prosemirrorToYDoc(node, "default");
    await invoke("save_doc", { id, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), title });
    return id;
  } catch (err) {
    try {
      await invoke("delete_doc", { id });
    } catch (cleanupErr) {
      console.error("Failed to clean up placeholder doc after a failed import:", cleanupErr);
    }
    throw err;
  }
}

export interface OpenedDocument {
  docId: string;
  // false = an existing document made from this same, unchanged file was reopened.
  imported: boolean;
}

// Opens `path` as a Briefcast document: the one already made from it if the file is unchanged,
// else a fresh import.
export async function openDocumentFile(path: string, fileName: string): Promise<OpenedDocument> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!OPENABLE_DOC_EXTENSIONS.includes(ext)) throw new Error(`"${fileName}" can't be opened as a document`);
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  const bytes = new Uint8Array(buffer);
  const fingerprint = fingerprintBytes(bytes);

  const previous = readOpened()[path.toLowerCase()];
  if (previous && previous.fingerprint === fingerprint) {
    const docs = await invoke<DocSummary[]>("list_docs").catch(() => [] as DocSummary[]);
    if (docs.some((d) => d.id === previous.docId && !d.deleted_at)) return { docId: previous.docId, imported: false };
  }

  const title = fileName.replace(/\.[^.]+$/, "") || "Untitled document";
  let docId: string;
  if (ext === "docx") {
    docId = (await importDocxFile(path, fileName, buffer)).id;
  } else {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    docId = await createDocFromHtml(title, ext === "txt" ? textToHtml(text) : markdownToHtml(text), path);
  }
  rememberOpened(path, { docId, fingerprint });
  return { docId, imported: true };
}
