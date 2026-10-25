// utils/cameraEffect.ts
//
// The live camera background (blur, a colour or a picture behind you while you record - see
// src-tauri/src/commands/camera_effects.rs) from the UI's side: what a recording is told
// (cameraEffectForRecording) and the settings preview's live feed (useCameraEffectFeed), which also
// warms the model up so recording starts with the effect already running.
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

export interface FeedState {
  // "off", "needs-engine" (download first), "starting", "running", or "error".
  phase: "off" | "needs-engine" | "starting" | "running" | "error";
  frameUrl: string | null;
  engine?: string;
  fps?: number;
  message?: string;
}

// Runs the feed for `device` while `pref` is on (and the component is mounted), giving the newest
// previewed frame as an object URL ~15 times a second. Changing the background just retunes it.
export function useCameraEffectFeed(device: string | null, shape: string, size: string, pref: CameraBackgroundPref | undefined, engineGeneration = 0): FeedState {
  const spec = cameraEffectSpec(pref);
  const specKey = JSON.stringify(spec);
  const [state, setState] = useState<FeedState>({ phase: "off", frameUrl: null });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!device || !spec) {
      setState({ phase: "off", frameUrl: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, phase: s.phase === "running" ? "running" : "starting" }));
    invoke("camera_effect_start", { device, shape, size, effect: spec }).catch((err) => {
      if (!live) return;
      const message = String(err);
      setState({ phase: message.includes("ENGINE_MISSING") ? "needs-engine" : "error", frameUrl: null, message });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, shape, size, specKey, engineGeneration]);

  // Frames and status while it runs.
  const on = !!device && !!spec;
  useEffect(() => {
    if (!on) return;
    let live = true;
    let timer = 0;
    let tick = 0;
    const poll = async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("camera_effect_preview");
        if (!live) return;
        if (bytes.byteLength > 0) {
          const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setState((s) => (s.phase === "needs-engine" || s.phase === "error" ? s : { ...s, phase: "running", frameUrl: url }));
        }
        if (tick++ % 15 === 0) {
          const status = await invoke<{ engine: string; fps: number } | null>("camera_effect_status");
          if (live && status) {
            if (status.engine.startsWith("error")) setState({ phase: "error", frameUrl: null, message: status.engine.slice(7) });
            else setState((s) => ({ ...s, engine: status.engine, fps: status.fps }));
          }
        }
      } catch {
        // The feed isn't up yet.
      }
      if (live) timer = window.setTimeout(poll, 66);
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
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
  useEffect(
    () => () => {
      void invoke("camera_effect_stop").catch(() => {});
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );
  return state;
}
