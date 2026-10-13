// utils/playerCaptionSettings.ts
//
// How the PLAYER shows viewing captions (a loaded .vtt/.srt or captions generated in the player) -
// the same style presets/emphasis/position/size the editor's burned-in captions use (captions.ts),
// but purely a viewer preference: global (not per video), kept in localStorage, never written into
// any file. Storage can be unavailable (private window, blocked) - defaults are used then.
import { CaptionSettings } from "./videoEditTypes";
import { CAPTION_PRESETS, defaultCaptionSettings } from "./captions";

const KEY = "briefcast.player.captionSettings";

// Sits a little higher than the editor's default, clear of the player's own control bar.
const PLAYER_DEFAULTS: CaptionSettings = { ...defaultCaptionSettings("highlight"), emphasis: false, offset: 0.12 };

export function loadPlayerCaptionSettings(): CaptionSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return PLAYER_DEFAULTS;
    const parsed = { ...PLAYER_DEFAULTS, ...JSON.parse(raw) } as CaptionSettings;
    // A preset removed in a later version falls back rather than breaking the renderer.
    return CAPTION_PRESETS[parsed.preset] ? parsed : PLAYER_DEFAULTS;
  } catch {
    return PLAYER_DEFAULTS;
  }
}

export function savePlayerCaptionSettings(settings: CaptionSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* not persisted */
  }
}
