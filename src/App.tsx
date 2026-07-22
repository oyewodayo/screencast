
import { useEffect } from "react";
import RecordingOverlayWindow from "./components/RecordingOverlayWindow";
import ScreenshotOverlayWindow from "./components/ScreenshotOverlayWindow";
import AnnotationOverlayWindow from "./components/AnnotationOverlayWindow";
import Dashboard from "./pages/Dashboard";
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

// WebView2 (like any Chromium-based browser) reloads the whole page on Ctrl+R/Cmd+R/F5 by
// default - completely wiping every bit of in-memory React state (whatever's currently playing,
// the sidebar's loaded file list, undo/redo history, ...) with no warning and no way back. A
// desktop app has no legitimate use for that: there's nothing here a page reload is meant to
// recover from, so it's blocked outright rather than needing every screen to guard against it
// individually. Installed here (App.tsx, the actual top-level component shared by every route)
// so it covers the main window and every overlay window the same way, not just Dashboard.
function useBlockPageReload(): void {
  useEffect(() => {
    const blockReload = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      const isReloadShortcut = key === "f5" || ((e.ctrlKey || e.metaKey) && key === "r");
      if (isReloadShortcut) e.preventDefault();
    };
    // Capture phase: runs before any other keydown handler in the tree gets a chance to
    // stopPropagation() first (the PDF/video/annotation tools all have their own keydown
    // listeners), so this can't accidentally be swallowed before it gets to preventDefault.
    window.addEventListener("keydown", blockReload, { capture: true });
    return () => window.removeEventListener("keydown", blockReload, { capture: true });
  }, []);
}

function App() {
  useBlockPageReload();

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />

        <Route path="/recording-overlay" element={<RecordingOverlayWindow />} />
        <Route path="/screenshot-overlay" element={<ScreenshotOverlayWindow />} />
        <Route path="/annotation-overlay" element={<AnnotationOverlayWindow />} />
        {/* <Route path="/file-modal" element={<FileModal />} /> */}
        {/* <Route path="/settings" element={} /> */}
      </Routes>
    </Router>
  );
}

export default App;
