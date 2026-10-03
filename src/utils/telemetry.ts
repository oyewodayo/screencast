// utils/telemetry.ts
//
// Frontend side of src-tauri/src/services/telemetry.rs. Everything here is fire-and-forget and
// no-ops on the Rust side when telemetry is off or the build has no keys, so callers never need
// to check anything first.
//
// Event props must stay non-identifying: enums, counts, durations - never file names, paths or
// text the user typed (see the Rust module's header for the full list of what is and isn't sent).

import { invoke } from "@tauri-apps/api/core";

export type TelemetryProps = Record<string, string | number | boolean>;

export function trackEvent(name: string, props?: TelemetryProps): void {
  invoke("track_event", { name, props: props ?? null }).catch(() => {});
}

export function reportError(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error ? error.stack ?? null : null;
  invoke("report_frontend_error", { message, stack }).catch(() => {});
}

// Uncaught errors and unhandled promise rejections anywhere in the webview.
export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
}
