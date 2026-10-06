// hooks/useCanvasRestoreTick.ts
import { useEffect, useState } from "react";

// A counter that goes up whenever a canvas on this page gets its rendering context back after
// losing it - a GPU process crash, or the GPU being reset across sleep/resume (see
// src/utils/stallMonitor.ts's canvas monitor and src-tauri/src/services/webview_recovery.rs).
// The browser hands a restored canvas back blank and never redraws it, so every canvas that draws
// from a useEffect adds this to that effect's dependencies, as a pure redraw trigger.
//
// One listener per mounted canvas component, on the document in the capture phase (neither event
// bubbles). A single GPU reset restores every canvas at once; React batches the resulting state
// updates, so that is one redraw per component, not one per canvas.
export default function useCanvasRestoreTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    document.addEventListener("contextrestored", bump, true);
    document.addEventListener("webglcontextrestored", bump, true);
    return () => {
      document.removeEventListener("contextrestored", bump, true);
      document.removeEventListener("webglcontextrestored", bump, true);
    };
  }, []);
  return tick;
}
