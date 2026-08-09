// components/docs/DocsWorkspace.tsx
//
// Entry point for the Docs feature, mirroring BoardWorkspace's role for Board: Dashboard.tsx
// renders this one component and hands it a single screen/onScreenChange pair.
import React from "react";
import DocsHome from "./DocsHome";
import DocsEditor from "./DocsEditor";

export type DocsScreen = { mode: "home" } | { mode: "editor"; docId: string };

interface DocsWorkspaceProps {
  screen: DocsScreen;
  onScreenChange: (screen: DocsScreen) => void;
}

const DocsWorkspace: React.FC<DocsWorkspaceProps> = ({ screen, onScreenChange }) =>
  screen.mode === "editor" ? (
    <DocsEditor docId={screen.docId} onBack={() => onScreenChange({ mode: "home" })} />
  ) : (
    <DocsHome onOpenDoc={(id) => onScreenChange({ mode: "editor", docId: id })} />
  );

export default DocsWorkspace;
