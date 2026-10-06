import { invoke } from '@tauri-apps/api/core';

// Logs long webview main-thread tasks to app.log via report_frontend_stall (see
// src-tauri/src/services/responsiveness.rs). A JS task that runs this long freezes the page's
// contents even though Windows never flags the window as "Not responding" - this is how those
// freezes become visible and attributable instead of just "the editor felt stuck".

const REPORT_THRESHOLD_MS = 500;
// Batched so a burst of long tasks produces one log line, not hundreds of IPC calls that would
// themselves add to the load.
const REPORT_INTERVAL_MS = 5000;

let started = false;

export function startStallMonitor(): void {
  if (started || typeof PerformanceObserver === 'undefined') return;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  started = true;

  let pendingCount = 0;
  let pendingWorst = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    flushTimer = null;
    if (pendingCount === 0) return;
    const context = pendingCount > 1 ? `worst of ${pendingCount} long tasks` : undefined;
    invoke('report_frontend_stall', { durationMs: pendingWorst, context }).catch(() => {});
    pendingCount = 0;
    pendingWorst = 0;
  };

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < REPORT_THRESHOLD_MS) continue;
        console.warn(`[stall] webview main thread blocked for ${Math.round(entry.duration)}ms`);
        pendingCount += 1;
        pendingWorst = Math.max(pendingWorst, entry.duration);
      }
      if (pendingCount > 0 && flushTimer === null) {
        flushTimer = setTimeout(flush, REPORT_INTERVAL_MS);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // Monitoring is best-effort - never let it break startup.
  }
}

// Logs when the page's canvases lose their GPU-backed contents (GPU process crash, or the GPU
// device being reset across sleep/resume) and when the browser hands them back - blank. Pairs
// with src-tauri/src/services/webview_recovery.rs, which repaints the window itself: this is what
// tells app.log whether the canvases inside it also need redrawing. Batched, since one GPU reset
// hits every canvas on the page at once.
let canvasMonitorStarted = false;

export function startCanvasLossMonitor(): void {
  if (canvasMonitorStarted) return;
  canvasMonitorStarted = true;

  const counts = { lost: 0, restored: 0 };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    const message = `canvas contexts lost: ${counts.lost}, restored: ${counts.restored} (${location.pathname})`;
    console.warn(`[canvas] ${message}`);
    invoke('report_frontend_event', { message }).catch(() => {});
    counts.lost = 0;
    counts.restored = 0;
  };
  const note = (kind: 'lost' | 'restored') => () => {
    counts[kind] += 1;
    if (flushTimer === null) flushTimer = setTimeout(flush, 2000);
  };
  // Neither event bubbles; capture-phase listeners on the document still see them.
  document.addEventListener('contextlost', note('lost'), true);
  document.addEventListener('contextrestored', note('restored'), true);
  document.addEventListener('webglcontextlost', note('lost'), true);
  document.addEventListener('webglcontextrestored', note('restored'), true);
}
