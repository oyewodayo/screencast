// Manages the home screen's creation indexes (docs, whiteboards, mind maps, boards),
// pinned/recent/external files, phone/USB arrivals, and derived home/history item lists.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BoardScreen } from "../components/board/BoardWorkspace";
import type { DocsScreen } from "../components/docs/DocsWorkspace";
import type { MindmapScreen } from "../components/mindmap/MindmapWorkspace";
import type { WhiteboardScreen } from "../components/whiteboard/WhiteboardWorkspace";
import { onPhoneFileArrived } from "../services/phoneTransfer";
import { onUsbImported } from "../services/usbPhone";
import type { BoardSummary } from "../utils/boardTypes";
import type { DocSummary } from "../utils/docTypes";
import { buildHomeItems, homeItemKey } from "../utils/homeLibraryItems";
import {
  getArrivals,
  getExternalFiles,
  getOpenedAt,
  getPinnedPaths,
  getRecentPaths,
  recordFileArrived,
  recordItemOpened,
  togglePin,
  type ExternalFileMetadata,
} from "../utils/homeScreenFiles";
import type { FileEntry } from "../utils/libraryEntries";
import type { MindmapSummary } from "../utils/mindmapTypes";
import type { WhiteboardSummary } from "../utils/whiteboardTypes";

export interface UseHomeCreationIndexesParams {
  allLibraryFiles: FileEntry[];
  hasSelectedFile: boolean;
  isVideoEditorHome: boolean;
  boardScreen: BoardScreen | null;
  docsScreen: DocsScreen | null;
  whiteboardScreen: WhiteboardScreen | null;
  mindmapScreen: MindmapScreen | null;
}

export function useHomeCreationIndexes({
  allLibraryFiles,
  hasSelectedFile,
  isVideoEditorHome,
  boardScreen,
  docsScreen,
  whiteboardScreen,
  mindmapScreen,
}: UseHomeCreationIndexesParams) {
  // Pinned + recently-opened file paths behind the home screen's "From your library" preview —
  // see utils/homeScreenFiles.ts. Mirrored into React state (rather than read fresh from
  // localStorage on every render) so toggling a pin or opening a file re-renders that preview.
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => getPinnedPaths());
  const [recentPaths, setRecentPaths] = useState<string[]>(() => getRecentPaths());
  const [externalFiles, setExternalFiles] = useState<Record<string, ExternalFileMetadata>>(() => getExternalFiles());
  const [homeLibraryView, setHomeLibraryView] = useState<"list" | "grid">(() => {
    try {
      return localStorage.getItem("briefcast.homeLibraryViewMode") === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  const [homeLibrarySearch, setHomeLibrarySearch] = useState("");

  const handleHomeLibraryViewChange = useCallback((mode: "list" | "grid") => {
    setHomeLibraryView(mode);
    try {
      localStorage.setItem("briefcast.homeLibraryViewMode", mode);
    } catch {
      // ignore storage quota / private-mode errors
    }
  }, []);

  const handleTogglePinHomeKey = useCallback((key: string) => {
    setPinnedPaths(togglePin(key));
  }, []);

  // Whiteboards, mind maps, boards and docs for the home screen's "From your library" list,
  // and when each library item was last opened - see utils/homeLibraryItems.ts.
  const [whiteboardIndex, setWhiteboardIndex] = useState<WhiteboardSummary[]>([]);
  const [mindmapIndex, setMindmapIndex] = useState<MindmapSummary[]>([]);
  const [boardIndex, setBoardIndex] = useState<BoardSummary[]>([]);
  const [docsIndex, setDocsIndex] = useState<DocSummary[]>([]);
  const [openedAt, setOpenedAt] = useState<Record<string, number>>(() => getOpenedAt());
  // Files that came in from a phone - tagged on the home screen with where from (homeScreenFiles.ts).
  const [arrivals, setArrivals] = useState(() => getArrivals());

  useEffect(() => {
    const arrive = (paths: string[], from: string, batch: string) => {
      if (!paths.length) return;
      let recent: string[] = [];
      for (const path of paths) ({ recent } = recordFileArrived(path, from, batch));
      setRecentPaths(recent);
      setArrivals(getArrivals());
      setOpenedAt(getOpenedAt());
    };
    const stopWifi = onPhoneFileArrived((file) => arrive(file.path ? [file.path] : [], file.device_name, file.batch ?? file.id));
    const stopUsb = onUsbImported((t) => arrive(t.paths, t.device_name || "Phone", `usb:${t.id}`));
    return () => {
      stopWifi();
      stopUsb();
    };
  }, []);

  // Backs the sidebar's per-file "has linked notes" badge/menu (see linkedDocsByPath below) from
  // one list_docs call rather than a find_docs_linked_to round trip per visible row.
  const refreshDocsIndex = useCallback(async () => {
    try {
      setDocsIndex(await invoke<DocSummary[]>("list_docs"));
    } catch (error) {
      console.error("Failed to load docs index:", error);
    }
  }, []);

  useEffect(() => {
    refreshDocsIndex();
  }, [refreshDocsIndex]);

  // Opening a document, whiteboard or mind map counts as "recent" for the home screen even if
  // nothing in it changes.
  const openedDocId = docsScreen?.mode === "editor" ? docsScreen.docId : null;
  const openedWhiteboardId = whiteboardScreen?.mode === "editor" ? whiteboardScreen.whiteboardId : null;
  const openedMindmapId = mindmapScreen?.mode === "editor" ? mindmapScreen.mindmapId : null;
  const openedBoardId = boardScreen?.mode === "editor" ? boardScreen.boardId : null;

  useEffect(() => {
    if (openedDocId) setOpenedAt(recordItemOpened(homeItemKey("doc", openedDocId)));
  }, [openedDocId]);
  useEffect(() => {
    if (openedWhiteboardId) setOpenedAt(recordItemOpened(homeItemKey("whiteboard", openedWhiteboardId)));
  }, [openedWhiteboardId]);
  useEffect(() => {
    if (openedMindmapId) setOpenedAt(recordItemOpened(homeItemKey("mindmap", openedMindmapId)));
  }, [openedMindmapId]);
  useEffect(() => {
    if (openedBoardId) setOpenedAt(recordItemOpened(homeItemKey("board", openedBoardId)));
  }, [openedBoardId]);

  // The home screen is whatever shows when no tool and no file is open. Its library list is
  // refreshed every time it comes back into view, so a document just written, a design just
  // composed, or a whiteboard just drawn is there straight away.
  const onHomeScreen = !isVideoEditorHome && !mindmapScreen && !whiteboardScreen && !boardScreen && !docsScreen && !hasSelectedFile;
  useEffect(() => {
    if (!onHomeScreen) return;
    let live = true;
    void refreshDocsIndex();
    setOpenedAt(getOpenedAt());
    invoke<WhiteboardSummary[]>("list_whiteboards")
      .then((list) => live && setWhiteboardIndex(list))
      .catch((error) => console.error("Failed to load whiteboards for the home screen:", error));
    invoke<MindmapSummary[]>("list_mindmaps")
      .then((list) => live && setMindmapIndex(list))
      .catch((error) => console.error("Failed to load mind maps for the home screen:", error));
    invoke<BoardSummary[]>("list_boards")
      .then((list) => live && setBoardIndex(list))
      .catch((error) => console.error("Failed to load designs for the home screen:", error));
    return () => {
      live = false;
    };
  }, [onHomeScreen, refreshDocsIndex]);

  // file.path -> every doc linked to it, derived once per docsIndex change rather than filtered
  // per row on every render.
  const linkedDocsByPath = useMemo(() => {
    const map = new Map<string, DocSummary[]>();
    for (const doc of docsIndex) {
      if (!doc.linked_to) continue;
      const existing = map.get(doc.linked_to);
      if (existing) existing.push(doc);
      else map.set(doc.linked_to, [doc]);
    }
    return map;
  }, [docsIndex]);

  // The home screen's items - rebuilt only when the library, pins, history or indexes change,
  // not on every render of the page (playback ticks re-render it several times a second).
  const libraryFilesByPath = useMemo(() => {
    const map = new Map<string, FileEntry>(allLibraryFiles.map((file) => [file.path, file]));
    for (const [path, ext] of Object.entries(externalFiles)) {
      if (!map.has(path)) {
        map.set(path, {
          path: ext.path,
          name: ext.name,
          size: ext.size ?? 0,
          modified: ext.modified,
        });
      }
    }
    return map;
  }, [allLibraryFiles, externalFiles]);

  const boardThumbById = useMemo(
    () => new Map(boardIndex.filter((b) => b.thumbnail_path).map((b) => [b.id, b.thumbnail_path!] as const)),
    [boardIndex]
  );

  const activeDocsForHome = useMemo(
    () => docsIndex.filter((d) => !d.deleted_at).map((d) => ({ id: d.id, name: d.title, updated_at: d.updated_at })),
    [docsIndex]
  );

  const homeItems = useMemo(
    () =>
      buildHomeItems({
        files: allLibraryFiles,
        pinnedPaths,
        recentPaths,
        openedAt,
        docs: activeDocsForHome,
        whiteboards: whiteboardIndex,
        mindmaps: mindmapIndex,
        boards: boardIndex,
        externalFiles,
        query: homeLibrarySearch,
      }),
    [allLibraryFiles, pinnedPaths, recentPaths, openedAt, activeDocsForHome, whiteboardIndex, mindmapIndex, boardIndex, externalFiles, homeLibrarySearch]
  );

  const hasAnyHomeItems =
    allLibraryFiles.length > 0 ||
    pinnedPaths.length > 0 ||
    activeDocsForHome.length > 0 ||
    whiteboardIndex.length > 0 ||
    mindmapIndex.length > 0 ||
    boardIndex.length > 0 ||
    Object.keys(externalFiles).length > 0;

  // Extended history list for the quick-switcher dropup in the dock when navigating outside home
  const historyItems = useMemo(
    () =>
      buildHomeItems({
        files: allLibraryFiles,
        pinnedPaths,
        recentPaths,
        openedAt,
        docs: activeDocsForHome,
        whiteboards: whiteboardIndex,
        mindmaps: mindmapIndex,
        boards: boardIndex,
        externalFiles,
        limit: 30,
      }),
    [allLibraryFiles, pinnedPaths, recentPaths, openedAt, activeDocsForHome, whiteboardIndex, mindmapIndex, boardIndex, externalFiles]
  );

  const homeFiles = useMemo(
    () => homeItems.flatMap((item) => (item.kind === "file" && libraryFilesByPath.has(item.id) ? [libraryFilesByPath.get(item.id)!] : [])),
    [homeItems, libraryFilesByPath]
  );

  return {
    pinnedPaths,
    setPinnedPaths,
    recentPaths,
    setRecentPaths,
    externalFiles,
    setExternalFiles,
    homeLibraryView,
    handleHomeLibraryViewChange,
    homeLibrarySearch,
    setHomeLibrarySearch,
    handleTogglePinHomeKey,
    docsIndex,
    arrivals,
    refreshDocsIndex,
    linkedDocsByPath,
    libraryFilesByPath,
    boardThumbById,
    homeItems,
    hasAnyHomeItems,
    historyItems,
    homeFiles,
  };
}
