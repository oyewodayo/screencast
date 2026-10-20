// utils/updater.ts
//
// Auto-update against this repo's GitHub Releases (tauri-plugin-updater; endpoint and public key
// are in tauri.conf.json's plugins.updater). Each release's latest.json is produced by the release
// workflow (.github/workflows/release.yml) and every installer it points at is signed with the
// updater key, so a tampered download is rejected before it runs.

import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Resolves to the newer release, or null when up to date / offline / in a dev build (dev builds
// would otherwise offer to "update" themselves into the last published installer).
export async function checkForUpdate(): Promise<Update | null> {
  if (import.meta.env.DEV) return null;
  try {
    return await check();
  } catch (err) {
    // Offline, GitHub unreachable, or no release published yet - never worth bothering the user.
    console.warn("Update check failed:", err);
    return null;
  }
}

// Downloads and runs the installer (Windows: passive NSIS, shows only a progress bar), then
// restarts into the new version. `onProgress` gets 0-100 when the size is known.
export async function installUpdate(update: Update, onProgress?: (percent: number) => void): Promise<void> {
  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      if (total > 0) onProgress?.(Math.min(100, (downloaded / total) * 100));
    }
  });
  await relaunch();
}
