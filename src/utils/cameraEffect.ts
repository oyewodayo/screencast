// utils/cameraEffect.ts
//
// The live camera background (blur, a colour or a picture behind you while you record - see
// src-tauri/src/commands/camera_effects.rs) from the UI's side: what a recording is told
// (cameraEffectSpec) and the settings preview's live feed (useCameraEffectFeed), which streams
// directly over a zero-IPC localhost HTTP MJPEG push URL (`<img src="http://127.0.0.1:PORT/stream">`)
// so frames land on screen at native camera rate with zero Blob/ObjectURL churn.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CameraBackgroundPref } from "./appSettings";

export interface CameraEffectSpec {
  kind: "blur" | "color" | "image";
  amount: number;
  color: string | null;
  imagePath: string | null;
}

export function cameraEffectSpec(pref: CameraBackgroundPref | undefined): CameraEffectSpec | null {
  if (!pref || pref.kind === "off") return null;
  if (pref.kind === "image" && !pref.imagePath) return null;
  return { kind: pref.kind, amount: pref.amount, color: pref.color, imagePath: pref.imagePath };
}

interface BackendFeedStatus {
  engine: string;
  fps: number;
  width: number;
  height: number;
  previewUrl?: string | null;
}

export interface FeedState {
  // "off", "needs-engine" (download first), "starting", "running", or "error".
  phase: "off" | "needs-engine" | "starting" | "running" | "error";
  frameUrl: string | null;
  engine?: string;
  fps?: number;
  message?: string;
}

// Runs the feed for `device` while `pref` is on (and the component is mounted), returning the
// localhost HTTP MJPEG push stream URL directly (zero IPC per frame, zero Blob GC). Changing
// backdrop settings (blur amount, colour, picture) retunes the running feed in place with zero
// stream reconnect flicker.
export function useCameraEffectFeed(
  device: string | null,
  shape: string,
  size: string,
  pref: CameraBackgroundPref | undefined,
  engineGeneration = 0
): FeedState {
  const spec = cameraEffectSpec(pref);
  const specKey = JSON.stringify(spec);
  const [state, setState] = useState<FeedState>({ phase: "off", frameUrl: null });
  const baseStreamUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!device || !spec) {
      baseStreamUrlRef.current = null;
      setState({ phase: "off", frameUrl: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, phase: s.phase === "running" ? "running" : "starting" }));
    invoke<BackendFeedStatus>("camera_effect_start", { device, shape, size, effect: spec })
      .then((status) => {
        if (!live) return;
        const rawUrl = status?.previewUrl ?? null;
        // Only change the <img> src URL when a brand-new feed/port started so retuning blur/color
        // keeps the existing MJPEG stream open with zero flicker.
        let frameUrl: string | null = null;
        if (rawUrl) {
          if (baseStreamUrlRef.current !== rawUrl) {
            baseStreamUrlRef.current = rawUrl;
            frameUrl = `${rawUrl}?t=${Date.now()}`;
          }
        }
        setState((s) => ({
          phase: status?.engine?.startsWith("error") ? "error" : "running",
          frameUrl: frameUrl ?? s.frameUrl,
          engine: status?.engine ?? s.engine,
          fps: status?.fps ?? s.fps,
          message: status?.engine?.startsWith("error") ? status.engine.slice(7) : undefined,
        }));
      })
      .catch((err) => {
        if (!live) return;
        const message = String(err);
        baseStreamUrlRef.current = null;
        setState({
          phase: message.includes("ENGINE_MISSING") ? "needs-engine" : "error",
          frameUrl: null,
          message,
        });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, shape, size, specKey, engineGeneration]);

  // Lightweight 1 Hz status refresh for the FPS/engine badge only (the video frames themselves flow
  // over the native HTTP MJPEG push stream directly into <img>, with zero IPC per frame).
  const on = !!device && !!spec;
  useEffect(() => {
    if (!on) return;
    let live = true;
    const pollStatus = async () => {
      if (!live || document.hidden) return;
      try {
        const status = await invoke<BackendFeedStatus | null>("camera_effect_status");
        if (!live || !status) return;
        if (status.engine.startsWith("error")) {
          setState({ phase: "error", frameUrl: null, message: status.engine.slice(7) });
        } else {
          setState((s) => ({
            ...s,
            phase: s.phase === "needs-engine" || s.phase === "error" ? s.phase : "running",
            engine: status.engine,
            fps: status.fps,
          }));
        }
      } catch {
        // Feed not up yet.
      }
    };
    const interval = window.setInterval(() => {
      void pollStatus();
    }, 1000);
    return () => {
      live = false;
      window.clearInterval(interval);
    };
  }, [on]);

  // Switched off with the preview still open: the feed hands the camera straight back, so the
  // plain preview (and nothing else waiting on the camera) isn't left on "In use elsewhere".
  // Closing the preview (below) keeps the grace period, for Start to reuse the warm feed.
  const wasOn = useRef(false);
  useEffect(() => {
    if (on) {
      wasOn.current = true;
      return;
    }
    void invoke("camera_effect_stop", { immediate: wasOn.current }).catch(() => {});
    wasOn.current = false;
  }, [on]);

  useEffect(() => {
    return () => {
      if (wasOn.current) void invoke("camera_effect_stop").catch(() => {});
    };
  }, []);

  return state;
}
