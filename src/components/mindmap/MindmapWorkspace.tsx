// components/mindmap/MindmapWorkspace.tsx
//
// Thin "home" | "editor" switch for the Mindmap feature, so Dashboard.tsx only has to render one
// component and pass one mindmapScreen/setMindmapScreen pair - same convention
// whiteboard/WhiteboardWorkspace.tsx and board/BoardWorkspace.tsx use for their own features.
import MindmapEditor from "./MindmapEditor";
import MindmapHome from "./MindmapHome";

export type MindmapScreen = { mode: "home" } | { mode: "editor"; mindmapId: string };

interface MindmapWorkspaceProps {
  screen: MindmapScreen;
  onScreenChange: (screen: MindmapScreen) => void;
}

const MindmapWorkspace: React.FC<MindmapWorkspaceProps> = ({ screen, onScreenChange }) =>
  screen.mode === "editor" ? (
    <MindmapEditor mindmapId={screen.mindmapId} onBack={() => onScreenChange({ mode: "home" })} />
  ) : (
    <MindmapHome onOpenMindmap={(id) => onScreenChange({ mode: "editor", mindmapId: id })} />
  );

export default MindmapWorkspace;
