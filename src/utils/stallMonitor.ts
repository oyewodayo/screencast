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
