// TEMPORARY test harness - not part of the app, used only to reproduce a bug in isolation without
// needing the full Tauri backend. Safe to delete; not imported by anything else.
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ThemeProvider } from "./contexts/ThemeContext";
import ImageEditor from "./components/ImageEditor";
import useImageEditStore from "./hooks/useImageEditStore";

const TEST_IMAGE_SRC =
  "data:image/svg+xml," +
  encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
      <rect width="1920" height="1080" fill="#2b2f36"/>
      <rect x="40" y="40" width="1840" height="1000" fill="none" stroke="#5865f2" stroke-width="4"/>
      <text x="960" y="540" font-size="64" fill="#e5e7eb" text-anchor="middle" font-family="sans-serif">TEST IMAGE 1920x1080</text>
    </svg>
  `);

function Harness() {
  const [isToolsPanelOpen, setIsToolsPanelOpen] = React.useState(true);
  const store = useImageEditStore("C:/fake/test-harness.png", TEST_IMAGE_SRC);

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ImageEditor
        sourcePath="C:/fake/test-harness.png"
        title="test-harness.png"
        onSaved={() => {}}
        store={store}
        isToolsPanelOpen={isToolsPanelOpen}
        onToolsPanelOpenChange={setIsToolsPanelOpen}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <Harness />
    </ThemeProvider>
  </React.StrictMode>
);
