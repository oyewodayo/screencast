import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize, availableMonitors } from "@tauri-apps/api/window";
import type { SettingsInitialTarget } from "../components/Modals/SettingsModal";
import { AppSettings, loadSettings, SETTINGS_CHANGED_DOM_EVENT, updateSettings } from "../utils/appSettings";
import { fadeTotalMs } from "../utils/annotationStyles";
import { isPrivacyShieldActiveNow, syncScreenBlurConfig } from "../utils/privacyShield";

// How long to keep the overlay window shown (but click-through) after draw mode turns off, so a
// stroke that's still fading gets to finish instead of vanishing instantly - the longest fade the
// current Settings > Annotation fade can produce, plus margin.
const annotationFadeGraceMs = (): number => {
  const { annotationFade } = loadSettings();
  return Math.max(fadeTotalMs("pen", annotationFade), fadeTotalMs("laser", annotationFade)) + 400;
};

interface UseAnnotationControllerOptions {
  isRecording: boolean;
  showSettings: boolean;
  onOpenSettings: (section?: SettingsInitialTarget) => void;
}

export function useAnnotationController({
  isRecording,
  showSettings,
  onOpenSettings,
}: UseAnnotationControllerOptions) {
  const [annotationEnabled, setAnnotationEnabled] = useState<boolean>(() => loadSettings().enableAnnotationTool);
  const annotationDrawModeRef = useRef<boolean>(false);
  const [annotationDrawMode, setAnnotationDrawMode] = useState<boolean>(false);
  const annotationToolRef = useRef<"ink" | "blur">("ink");
  const [activeBlurCount, setActiveBlurCount] = useState<number>(0);
  const [privacyShieldActiveNow, setPrivacyShieldActiveNow] = useState<boolean>(() =>
    isPrivacyShieldActiveNow(loadSettings(), false)
  );
  const annotationHideTimeoutRef = useRef<number | null>(null);
  const onOpenSettingsRef = useRef(onOpenSettings);
  onOpenSettingsRef.current = onOpenSettings;

  // Shows/hides the system-wide annotation overlay and flips its click-through state, emitting
  // global state updates so both the overlay pill and floating recording pill stay in sync.
  const toggleAnnotationDrawMode = useCallback(async (forceOff = false, requestedTool?: "ink" | "blur") => {
    const overlay = await WebviewWindow.getByLabel("annotation-overlay");
    if (!overlay) return;

    // Already drawing and asked for the other tool (e.g. clicking Privacy Shield on the floating
    // recording pill while Draw is open): switch tools in place instead of closing.
    if (!forceOff && annotationDrawModeRef.current && requestedTool && annotationToolRef.current !== requestedTool) {
      annotationToolRef.current = requestedTool;
      try {
        await overlay.setFocus();
        await emit("annotation-mode-changed", { active: true, tool: requestedTool });
      } catch (err) {
        console.error("Failed to switch annotation tool:", err);
      }
      return;
    }

    const next = forceOff ? false : !annotationDrawModeRef.current;
    annotationDrawModeRef.current = next;
    setAnnotationDrawMode(next);
    annotationToolRef.current = next ? (requestedTool ?? "ink") : "ink";

    if (annotationHideTimeoutRef.current !== null) {
      window.clearTimeout(annotationHideTimeoutRef.current);
      annotationHideTimeoutRef.current = null;
    }

    try {
      if (next) {
        const monitors = await availableMonitors();
        if (monitors.length > 0) {
          const left = Math.min(...monitors.map((m) => m.position.x));
          const top = Math.min(...monitors.map((m) => m.position.y));
          const right = Math.max(...monitors.map((m) => m.position.x + m.size.width));
          const bottom = Math.max(...monitors.map((m) => m.position.y + m.size.height));
          await overlay.setPosition(new PhysicalPosition(left, top));
          await overlay.setSize(new PhysicalSize(right - left, bottom - top));
        }
        await overlay.show();
        await overlay.setIgnoreCursorEvents(false);
        await overlay.setFocus();
        await emit("annotation-mode-changed", { active: true, tool: annotationToolRef.current });
      } else {
        await emit("annotation-mode-changed", { active: false });
        await overlay.setIgnoreCursorEvents(true);
        annotationHideTimeoutRef.current = window.setTimeout(() => {
          annotationHideTimeoutRef.current = null;
          if (!annotationDrawModeRef.current) void overlay.hide();
        }, annotationFadeGraceMs());
      }
    } catch (err) {
      console.error("Failed to toggle annotation draw mode:", err);
    }
  }, []);

  // Clicking an explicit Annotate / Privacy Shield button in the dock, Home onboarding, or
  // recording pill always works even if the global hotkey toggle was switched off in Settings.
  const handleToggleAnnotationFromUI = useCallback(
    async (requestedTool?: "ink" | "blur") => {
      if (!loadSettings().enableAnnotationTool) {
        updateSettings({ enableAnnotationTool: true });
        setAnnotationEnabled(true);
      }
      await toggleAnnotationDrawMode(false, requestedTool);
    },
    [toggleAnnotationDrawMode]
  );

  // Turning the annotation tool off ends draw mode and hides its overlay.
  useEffect(() => {
    if (annotationEnabled) return;
    void (async () => {
      if (annotationDrawModeRef.current) {
        await toggleAnnotationDrawMode(true);
      }
      const overlay = await WebviewWindow.getByLabel("annotation-overlay");
      if (overlay) await overlay.hide();
    })();
  }, [annotationEnabled, toggleAnnotationDrawMode]);

  // Privacy Shield strength and auto-blur rules (services/screen_blur.rs). Re-sent when recording
  // starts/stops, whenever Settings closes, and whenever any window updates settings live.
  useEffect(() => {
    if (showSettings) return;
    const applyFrom = (st: AppSettings) => {
      setAnnotationEnabled(st.enableAnnotationTool);
      setPrivacyShieldActiveNow(isPrivacyShieldActiveNow(st, isRecording));
      void syncScreenBlurConfig(st, isRecording);
    };
    applyFrom(loadSettings());
    const onSettings = (e: Event) => {
      const detail = (e as CustomEvent<AppSettings>).detail;
      applyFrom(detail ?? loadSettings());
    };
    window.addEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
    return () => window.removeEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
  }, [isRecording, showSettings]);

  // Track live blur region count so the dock indicator reflects active Privacy Shield regions.
  useEffect(() => {
    const unlisten = listen<unknown[]>("screen-blur-changed", (e) => {
      setActiveBlurCount(Array.isArray(e.payload) ? e.payload.length : 0);
    });
    invoke<unknown[]>("screen_blur_list")
      .then((list) => setActiveBlurCount(list.length))
      .catch(() => {});
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Cross-window annotation & settings requests (overlay Esc/close, recording pill buttons,
  // overlay Options popover "All settings...").
  useEffect(() => {
    const unlistenTurnOff = listen("annotation-turn-off-request", () => {
      if (annotationDrawModeRef.current) {
        void toggleAnnotationDrawMode(true);
      }
    });
    const unlistenToggle = listen<{ tool?: "ink" | "blur" }>("annotation-toggle-request", (e) => {
      void handleToggleAnnotationFromUI(e.payload?.tool);
    });
    const unlistenTool = listen<{ tool: "ink" | "blur" }>("annotation-tool-changed", (e) => {
      annotationToolRef.current = e.payload.tool;
    });
    const unlistenOpenSettings = listen<{ section?: SettingsInitialTarget }>("open-settings-request", (e) => {
      void (async () => {
        if (annotationDrawModeRef.current) {
          await toggleAnnotationDrawMode(true);
        }
        const mainWin = getCurrentWebviewWindow();
        await mainWin.show().catch(() => {});
        await mainWin.unminimize().catch(() => {});
        await mainWin.setFocus().catch(() => {});
        onOpenSettingsRef.current(e.payload?.section ?? "annotation");
      })();
    });
    return () => {
      unlistenTurnOff.then((fn) => fn());
      unlistenToggle.then((fn) => fn());
      unlistenTool.then((fn) => fn());
      unlistenOpenSettings.then((fn) => fn());
    };
  }, [toggleAnnotationDrawMode, handleToggleAnnotationFromUI]);

  return {
    annotationEnabled,
    setAnnotationEnabled,
    annotationDrawMode,
    hasActiveBlur: activeBlurCount > 0 || privacyShieldActiveNow,
    toggleAnnotationDrawMode,
    handleToggleAnnotationFromUI,
  };
}
