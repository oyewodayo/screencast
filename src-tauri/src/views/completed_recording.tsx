// src/modal.js
import React from 'react';
import ReactDOM from "react-dom/client";
import FileModal, { type RecordingModalStatus } from "../../../src/components/Modals/FileModal";
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
const params = new URLSearchParams(window.location.search);
const filePath = params.get('path') ?? '';
// "processing" while the backend is still finishing the file, then the window is reloaded as
// "done" or "failed" (with `error`) - see stop_recording in commands/recording.rs.
const status = (params.get('status') as RecordingModalStatus | null) ?? 'done';
const error = params.get('error') ?? undefined;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <FileModal filePath={filePath} status={status} error={error} />
    </React.StrictMode>,
  );
