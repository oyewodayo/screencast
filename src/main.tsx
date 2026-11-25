import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import './index.css'
import { ThemeProvider } from "./contexts/ThemeContext";
import { startCanvasLossMonitor, startStallMonitor } from "./utils/stallMonitor";
import { installGlobalErrorReporting } from "./utils/telemetry";
import { initSettings } from "./utils/appSettings";
// import "./App.css";

startStallMonitor();
startCanvasLossMonitor();
installGlobalErrorReporting();

// Tauri enables WebView2's `IsPinchZoomEnabled` via `zoomHotkeysEnabled: true` so Windows
// Precision Touchpad pinch gestures actually reach the DOM as `wheel` events with `ctrlKey: true`.
// Cancel default browser page-zoom globally on bubble phase so pinching or Ctrl+wheel outside an
// interactive canvas never zooms the app chrome, while canvas listeners (Whiteboard, PDF, Image)
// still receive and handle every pinch gesture cleanly.
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  },
  { passive: false }
);
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) {
    e.preventDefault();
  }
});

// Settings live in a file owned by Rust; every component reads them synchronously from a cache,
// so the cache has to be filled before anything renders. initSettings never rejects.
void initSettings().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
});
