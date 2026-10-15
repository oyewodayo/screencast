// services/snip.ts - starts the screenshot picker (commands/snip.rs, SnipOverlay.tsx).

import { invoke } from "@tauri-apps/api/core";

// System-wide, so a screenshot can be taken from any app. Alt+Shift like the app's other global
// shortcuts; Win+Shift+S stays Windows' own Snipping Tool.
export const SNIP_SHORTCUT = "Alt+Shift+S";

export interface SnipResult {
    path: string;
    copied: boolean;
}

// Hides Briefcast, freezes the screen and opens the picker. Resolves false where the picker isn't
// available (macOS/Linux), so the caller can fall back to the older screenshot flow.
export const startSnip = async (delayMs = 0): Promise<boolean> => {
    try {
        await invoke("snip_begin", { delayMs });
        return true;
    } catch (err) {
        if (String(err) === "unsupported") return false;
        throw err;
    }
};
