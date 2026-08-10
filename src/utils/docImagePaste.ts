// utils/docImagePaste.ts
//
// Intercepts a raw pasted/dropped image (a File/Blob from clipboardData/dataTransfer) and uploads
// it into this doc's own assets folder, then inserts an `image` node pointing at the saved file.
// @tiptap/extension-image on its own only handles <img> tags/markdown image syntax/URLs - it does
// NOT handle a raw bitmap paste, so this is a small custom ProseMirror plugin (Tiptap's documented
// mechanism for this) mirroring boards.rs's import_board_image asset-copy convention, adapted for
// in-memory clipboard bytes rather than a source file path already on disk.
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { invoke, convertFileSrc } from "@tauri-apps/api/tauri";

// Kept in sync with docs.rs's save_doc_image ALLOWED whitelist - "image/jpg" is a non-standard
// MIME some tools still emit for a JPEG, mapped alongside the standard "image/jpeg". Exported so
// docxImport.ts's own image-extraction step (docx embeds images the same way clipboard paste
// does - a MIME type + raw bytes) reuses this instead of keeping a second copy.
export const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// save_doc_image's own whitelist (docs.rs) - kept as a separate list rather than reusing
// EXTENSION_BY_MIME's values, since that map's keys are MIME types, not file extensions.
const ALLOWED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

// Shared by every doc-image write path (clipboard paste, drag-drop, toolbar file-insert, and the
// crop tool's re-save-as-new-asset step) - always a fresh crypto.randomUUID() assetId, matching
// this app's "never overwrite, always version as a new file" convention for doc assets.
export async function saveImageBytes(docId: string, bytes: number[], extension: string): Promise<string> {
  if (!ALLOWED_IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported image type: "${extension || "unknown"}"`);
  }
  const path = await invoke<string>("save_doc_image", { id: docId, assetId: crypto.randomUUID(), extension, bytes });
  return convertFileSrc(path);
}

async function uploadImage(docId: string, file: File): Promise<string> {
  const extension = EXTENSION_BY_MIME[file.type];
  // Throwing (rather than returning null) means an unsupported type - e.g. BMP/TIFF/SVG, or any
  // MIME this app's backend doesn't whitelist - surfaces through the existing .catch() logging in
  // handlePaste/handleDrop below instead of the paste silently doing nothing with no diagnostic
  // trail at all.
  if (!extension) throw new Error(`Unsupported image type for paste: "${file.type || "unknown"}"`);
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return saveImageBytes(docId, bytes, extension);
}

// Toolbar-driven "Insert image" counterpart to uploadImage() above - there the source is an
// in-memory File from a paste/drop event; here it's a path already on disk, picked via a native
// file dialog, so the extension comes straight from the filename instead of being derived from a
// MIME type.
export async function uploadImageFromPath(docId: string, path: string): Promise<string> {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const bytes = await invoke<number[]>("read_file_bytes", { path });
  return saveImageBytes(docId, bytes, extension);
}

// Position captured synchronously before the async upload starts, so a cursor move (or further
// typing) while the upload is in flight doesn't insert the image in the wrong place - but the
// document itself can also change size in the meantime (more typing, a deletion, even navigating
// away and the view getting torn down), which would make the raw captured position invalid.
// ProseMirror's `tr.insert` throws a RangeError for an out-of-bounds position, and with no error
// boundary anywhere in the app that would take down the entire render tree - clamp to the current
// doc size and swallow any dispatch failure (e.g. on an already-destroyed view) defensively.
function insertImageAt(view: EditorView, pos: number, src: string): void {
  try {
    const imageType = view.state.schema.nodes.image;
    if (!imageType) return;
    const safePos = Math.min(pos, view.state.doc.content.size);
    view.dispatch(view.state.tr.insert(safePos, imageType.create({ src })));
  } catch (err) {
    console.error("Failed to insert pasted image:", err);
  }
}

export function createDocImagePasteExtension(docId: string) {
  return Extension.create({
    name: "docImagePaste",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste(view, event) {
              const items = event.clipboardData?.items;
              if (!items) return false;
              const file = Array.from(items)
                .find((item) => item.type.startsWith("image/"))
                ?.getAsFile();
              if (!file) return false;
              event.preventDefault();
              const pos = view.state.selection.from;
              uploadImage(docId, file)
                .then((src) => insertImageAt(view, pos, src))
                .catch((err) => console.error("Failed to paste image:", err));
              return true;
            },
            handleDrop(view, event) {
              const files = event.dataTransfer?.files;
              const file = files && Array.from(files).find((f) => f.type.startsWith("image/"));
              if (!file) return false;
              event.preventDefault();
              const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
              const pos = coords?.pos ?? view.state.selection.from;
              uploadImage(docId, file)
                .then((src) => insertImageAt(view, pos, src))
                .catch((err) => console.error("Failed to drop image:", err));
              return true;
            },
          },
        }),
      ];
    },
  });
}
