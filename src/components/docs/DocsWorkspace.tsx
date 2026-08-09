// components/docs/DocsWorkspace.tsx
//
// Entry point for the Docs feature, mirroring BoardWorkspace's role for Board: Dashboard.tsx
// renders this one component and hands it a single screen/onScreenChange pair.
import React from "react";
import DocsHome from "./DocsHome";
import DocsEditor from "./DocsEditor";
import { LibraryFileEntry } from "../../utils/docTypes";

export type DocsScreen = { mode: "home" } | { mode: "editor"; docId: string };

interface DocsWorkspaceProps {
  screen: DocsScreen;
  onScreenChange: (screen: DocsScreen) => void;
  // Passed straight through to DocsEditor's "Link to recording" picker - Dashboard.tsx already
  // owns the flattened file list as its `files` state, so it's threaded down rather than giving
  // Docs its own second file-listing code path.
  libraryFiles: LibraryFileEntry[];
  onOpenLinkedFile?: (path: string, name: string) => void;
}

const DocsWorkspace: React.FC<DocsWorkspaceProps> = ({ screen, onScreenChange, libraryFiles, onOpenLinkedFile }) =>
  screen.mode === "editor" ? (
    <DocsEditor
      docId={screen.docId}
      onBack={() => onScreenChange({ mode: "home" })}
      libraryFiles={libraryFiles}
      onOpenLinkedFile={onOpenLinkedFile}
    />
  ) : (
    <DocsHome onOpenDoc={(id) => onScreenChange({ mode: "editor", docId: id })} />
  );

export default DocsWorkspace;
