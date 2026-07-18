// src/modal.js
import React from 'react';
import ReactDOM from "react-dom/client";
import FileModal from "../../../src/components/Modals/FileModal";
// This window has its own HTML entry point (completed_recording.html), separate from the
// main app's index.html/main.tsx - without importing the compiled Tailwind stylesheet here
// too, every Tailwind class used by FileModal has no matching CSS in this window at all,
// rendering as unstyled raw HTML.
import "../../../src/index.css";
// Same reasoning as the stylesheet import above: this window has no ThemeProvider of its own,
// so it needs to independently apply the persisted light/dark preference (initTheme reads the
// same localStorage settings the main window writes to, since both share the app's webview
// storage) to avoid rendering permanently light regardless of the user's setting.
import { initTheme } from "../../../src/contexts/ThemeContext";

initTheme();

// The path is baked into this window's own URL by create_or_replace_rec_completed_modal
// (Rust side) rather than sent via an event - by the time any event listener registered here
// could fire, the backend has already emitted it, so it would always be missed. Reading it
// synchronously from the URL has no such timing dependency.
const filePath = new URLSearchParams(window.location.search).get('path') ?? '';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <FileModal filePath={filePath} />
    </React.StrictMode>,
  );
