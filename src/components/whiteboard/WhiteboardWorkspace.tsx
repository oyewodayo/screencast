// components/whiteboard/WhiteboardWorkspace.tsx
//
// Thin "home" | "editor" switch for the Whiteboard feature, so Dashboard.tsx only has to render one
// component and pass one whiteboardScreen/setWhiteboardScreen pair - same convention as
// board/BoardWorkspace.tsx and docs/DocsWorkspace.tsx for their own features.
import WhiteboardHome from "./WhiteboardHome";
import WhiteboardEditor from "./WhiteboardEditor";

export type WhiteboardScreen = { mode: "home" } | { mode: "editor"; whiteboardId: string };

interface WhiteboardWorkspaceProps {
  screen: WhiteboardScreen;
  onScreenChange: (screen: WhiteboardScreen) => void;
}

const WhiteboardWorkspace: React.FC<WhiteboardWorkspaceProps> = ({ screen, onScreenChange }) =>
  screen.mode === "editor" ? (
    <WhiteboardEditor whiteboardId={screen.whiteboardId} onBack={() => onScreenChange({ mode: "home" })} />
  ) : (
    <WhiteboardHome onOpenWhiteboard={(id) => onScreenChange({ mode: "editor", whiteboardId: id })} />
  );

export default WhiteboardWorkspace;
