// components/board/BoardWorkspace.tsx
//
// Thin "home" | "editor" switch for the Board feature, so Dashboard.tsx only has to render one
// component and pass one boardScreen/setBoardScreen pair, the same way it hands off to a single
// PdfAnnotator/ImageEditor/VideoPlayer for the other file categories.
import { forwardRef } from "react";
import BoardHome from "./BoardHome";
import BoardEditor, { BoardEditorHandle } from "./BoardEditor";

export type BoardScreen = { mode: "home" } | { mode: "editor"; boardId: string };

interface BoardWorkspaceProps {
  screen: BoardScreen;
  onScreenChange: (screen: BoardScreen) => void;
  // Forwarded straight through to BoardEditor when it's the active screen - see BoardEditor's own
  // libraryDraggingFiles doc comment. BoardHome has no drop target, so it's simply unused there.
  libraryDraggingFiles?: { name: string; path: string }[] | null;
}

// forwardRef so Dashboard.tsx can reach BoardEditor's imperative addImagesFromPaths (its "Add to
// board" sidebar menu item / bulk action bar) without this thin switch needing to know anything
// about it itself - the ref is simply passed straight through when editor is the active screen.
const BoardWorkspace = forwardRef<BoardEditorHandle, BoardWorkspaceProps>(({ screen, onScreenChange, libraryDraggingFiles }, ref) =>
  screen.mode === "editor" ? (
    <BoardEditor ref={ref} boardId={screen.boardId} onBack={() => onScreenChange({ mode: "home" })} libraryDraggingFiles={libraryDraggingFiles} />
  ) : (
    <BoardHome onOpenBoard={(id) => onScreenChange({ mode: "editor", boardId: id })} />
  )
);

BoardWorkspace.displayName = "BoardWorkspace";

export default BoardWorkspace;
