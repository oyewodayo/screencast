// utils/sessionRestore.ts
//
// Where the user was, kept for the life of the app window so a page reload lands back there
// instead of on the home screen. Reloads happen without the user asking: waking the laptop from
// sleep (`tauri dev`'s Vite client reloads once it reconnects to the dev server; in a release
// build, webview_recovery.rs reloads a WebView whose renderer process died while suspended), plus
// a manual Ctrl+R. Everything else about the work already survives a reload on disk - video edits,
// docs, boards autosave - so only the "which screen, which file" part was being lost.
//
// sessionStorage, deliberately: it survives reloads of the same window but not quitting the app,
// so a fresh launch still opens on the home screen as it always has.
import type { BoardScreen } from "../components/board/BoardWorkspace";
import type { DocsScreen } from "../components/docs/DocsWorkspace";
import type { MindmapScreen } from "../components/mindmap/MindmapWorkspace";
import type { WhiteboardScreen } from "../components/whiteboard/WhiteboardWorkspace";

const SESSION_KEY = "briefcast.workspace.v1";

export interface SavedWorkspace {
  // The file open in the main pane, by its real path (asset URLs are re-resolved on restore).
  file: { path: string; name: string } | null;
  videoEditor: { mode: "home" } | { mode: "editing" } | null;
  docs: DocsScreen | null;
  whiteboard: WhiteboardScreen | null;
  mindmap: MindmapScreen | null;
  board: BoardScreen | null;
  dockerMode: "record" | "file-tools";
}

export function saveWorkspace(workspace: SavedWorkspace): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(workspace));
  } catch {
    // Storage unavailable - a reload just falls back to the home screen, as before.
  }
}

export function loadWorkspace(): SavedWorkspace | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedWorkspace>;
    if (!parsed || typeof parsed !== "object") return null;
    const file =
      parsed.file && typeof parsed.file.path === "string" && typeof parsed.file.name === "string" ? { path: parsed.file.path, name: parsed.file.name } : null;
    return {
      file,
      videoEditor: parsed.videoEditor ?? null,
      docs: parsed.docs ?? null,
      whiteboard: parsed.whiteboard ?? null,
      mindmap: parsed.mindmap ?? null,
      board: parsed.board ?? null,
      dockerMode: parsed.dockerMode === "file-tools" ? "file-tools" : "record",
    };
  } catch {
    return null;
  }
}
