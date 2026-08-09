// components/board/BoardWorkspace.tsx
//
// Thin "home" | "editor" switch for the Board feature, so Dashboard.tsx only has to render one
// component and pass one boardScreen/setBoardScreen pair, the same way it hands off to a single
// PdfAnnotator/ImageEditor/VideoPlayer for the other file categories.
import React from "react";
import BoardHome from "./BoardHome";
import BoardEditor from "./BoardEditor";

export type BoardScreen = { mode: "home" } | { mode: "editor"; boardId: string };

interface BoardWorkspaceProps {
  screen: BoardScreen;
  onScreenChange: (screen: BoardScreen) => void;
}

const BoardWorkspace: React.FC<BoardWorkspaceProps> = ({ screen, onScreenChange }) =>
  screen.mode === "editor" ? (
    <BoardEditor boardId={screen.boardId} onBack={() => onScreenChange({ mode: "home" })} />
  ) : (
    <BoardHome onOpenBoard={(id) => onScreenChange({ mode: "editor", boardId: id })} />
  );

export default BoardWorkspace;
