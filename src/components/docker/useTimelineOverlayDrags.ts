// components/docker/useTimelineOverlayDrags.ts
//
// Owns live drag (move) and edge-resize (retime/trim) state, split-group live following,
// and quick-add helpers for every overlay lane in VideoTimelineDocker:
// TextOverlay, ImageOverlay, BlurOverlay, AdjustmentLayer, StageScene, and PipOverlay (B-roll).
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { UseVideoEditStoreResult } from "../../hooks/useVideoEditStore";
import { resizePipOverlayTime as resizePipOverlayTimeHandler } from "../../handlers/videoEditHandlers";
import {
  AdjustmentLayer,
  BlurOverlay,
  ImageOverlay,
  PipOverlay,
  TextOverlay,
} from "../../utils/videoEditTypes";
import { MEDIA_VIDEO_EXTENSIONS } from "../../utils/fileCategory";
import type { StageScene } from "../../utils/stage/stageTypes";
import { sceneDuration, setBeatHold, setSceneDuration } from "../../utils/stage/stageEditing";
import { pipTrack, tracksInUse } from "../../utils/videoTracks";
import { MIN_OVERLAY_DURATION, snapToTargets } from "./timelineHelpers";

const CLICK_DRAG_THRESHOLD_PX = 4;

export interface UseTimelineOverlayDragsParams {
  filePath: string;
  isProject: boolean;
  editStore: UseVideoEditStoreResult;
  pxPerSec: number;
  totalOutputDuration: number;
  getCurrentOutputTime: () => number;
  getOverlaySnapTargets: () => number[];
  isPlaying: boolean;
  toolMode: "select" | "razor";
  videoPixelSize: { width: number; height: number } | null;
  rootRef: React.RefObject<HTMLDivElement | null>;
  outputTimeFromClientX: (clientX: number) => number;
  seekToOutputTime: (outputTime: number) => void;
  setSelectedClipId: (id: string | null) => void;
  onSelectOverlay?: (id: string | null) => void;
  onSelectImageOverlay?: (id: string | null) => void;
  onSelectBlurOverlay?: (id: string | null) => void;
  onSelectAdjustment?: (id: string | null) => void;
  onSelectScene?: (id: string | null) => void;
  onSelectPipOverlay?: (id: string | null) => void;
}

export function useTimelineOverlayDrags({
  filePath,
  isProject,
  editStore,
  pxPerSec,
  totalOutputDuration,
  getCurrentOutputTime,
  getOverlaySnapTargets,
  isPlaying,
  toolMode,
  videoPixelSize,
  rootRef,
  outputTimeFromClientX,
  seekToOutputTime,
  setSelectedClipId,
  onSelectOverlay,
  onSelectImageOverlay,
  onSelectBlurOverlay,
  onSelectAdjustment,
  onSelectScene,
  onSelectPipOverlay,
}: UseTimelineOverlayDragsParams) {
  // ---- Text-overlay lane drag / resize ----------------------------------------------------------
  const [overlayResizeDrag, setOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [overlayDrag, setOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderOverlays: TextOverlay[] = editStore.textOverlays.map((o) => {
    if (overlayResizeDrag && o.id === overlayResizeDrag.id) {
      return overlayResizeDrag.edge === "start" ? { ...o, startTime: overlayResizeDrag.liveValue } : { ...o, endTime: overlayResizeDrag.liveValue };
    }
    if (overlayDrag && o.id === overlayDrag.id) {
      return { ...o, startTime: overlayDrag.liveStartTime, endTime: overlayDrag.liveStartTime + overlayDrag.duration };
    }
    return o;
  });

  const beginOverlayResizeDrag = (overlay: TextOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!overlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - overlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(overlayResizeDrag.startValue + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const clamped =
      overlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, overlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, overlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endOverlayResizeDrag = () => {
    if (!overlayResizeDrag) return;
    const { id, edge, liveValue } = overlayResizeDrag;
    setOverlayResizeDrag(null);
    editStore.resizeTextOverlayTime(id, edge, liveValue);
  };

  const beginOverlayDrag = (overlay: TextOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleOverlayDragMove = (e: React.PointerEvent) => {
    if (!overlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - overlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - overlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(overlayDrag.startTime + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - overlayDrag.duration));
    setOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endOverlayDrag = () => {
    if (!overlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = overlayDrag;
    setOverlayDrag(null);
    if (isDragging) {
      editStore.moveTextOverlayTime(id, liveStartTime);
    }
    onSelectOverlay?.(id);
    const now = getCurrentOutputTime();
    if (now < liveStartTime || now >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- Image & PiP overlay lanes (plus split-screen group following) ----------------------------
  const [imageOverlayResizeDrag, setImageOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [imageOverlayDrag, setImageOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const [pipOverlayResizeDrag, setPipOverlayResizeDrag] = useState<null | { id: string; edge: "start" | "end"; startClientX: number; liveValue: number }>(null);
  const [pipOverlayDrag, setPipOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
    startTrack: number;
    liveTrack: number;
  }>(null);

  // A split screen moves and trims as one (alignSplitTiming does it on drop): while one of its
  // layers is dragged, the rest follow along live.
  const splitFollow = (() => {
    const live: { id: string; start: number; end: number } | null = pipOverlayDrag
      ? { id: pipOverlayDrag.id, start: pipOverlayDrag.liveStartTime, end: pipOverlayDrag.liveStartTime + pipOverlayDrag.duration }
      : imageOverlayDrag
        ? { id: imageOverlayDrag.id, start: imageOverlayDrag.liveStartTime, end: imageOverlayDrag.liveStartTime + imageOverlayDrag.duration }
        : null;
    const edge: { id: string; edge: "start" | "end"; value: number } | null = pipOverlayResizeDrag
      ? { id: pipOverlayResizeDrag.id, edge: pipOverlayResizeDrag.edge, value: pipOverlayResizeDrag.liveValue }
      : imageOverlayResizeDrag
        ? { id: imageOverlayResizeDrag.id, edge: imageOverlayResizeDrag.edge, value: imageOverlayResizeDrag.liveValue }
        : null;
    const id = live?.id ?? edge?.id;
    const dragged = id ? editStore.pipOverlays.find((o) => o.id === id) ?? editStore.imageOverlays.find((o) => o.id === id) : undefined;
    if (!dragged?.split || dragged.split.cell < 0) return null;
    const ds = live ? live.start - dragged.startTime : edge!.edge === "start" ? edge!.value - dragged.startTime : 0;
    const de = live ? live.end - dragged.endTime : edge!.edge === "end" ? edge!.value - dragged.endTime : 0;
    return { group: dragged.split.group, id: dragged.id, ds, de };
  })();
  const followSplit = <T extends { id: string; startTime: number; endTime: number; split?: { group: string } }>(o: T): T =>
    splitFollow && o.id !== splitFollow.id && o.split?.group === splitFollow.group ? { ...o, startTime: o.startTime + splitFollow.ds, endTime: o.endTime + splitFollow.de } : o;

  const renderImageOverlays: ImageOverlay[] = editStore.imageOverlays.map((o) => {
    if (imageOverlayResizeDrag && o.id === imageOverlayResizeDrag.id) {
      return imageOverlayResizeDrag.edge === "start" ? { ...o, startTime: imageOverlayResizeDrag.liveValue } : { ...o, endTime: imageOverlayResizeDrag.liveValue };
    }
    if (imageOverlayDrag && o.id === imageOverlayDrag.id) {
      return { ...o, startTime: imageOverlayDrag.liveStartTime, endTime: imageOverlayDrag.liveStartTime + imageOverlayDrag.duration };
    }
    return followSplit(o);
  });

  const beginImageOverlayResizeDrag = (overlay: ImageOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectImageOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setImageOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleImageOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!imageOverlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - imageOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(imageOverlayResizeDrag.startValue + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const clamped =
      imageOverlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, imageOverlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, imageOverlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setImageOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endImageOverlayResizeDrag = () => {
    if (!imageOverlayResizeDrag) return;
    const { id, edge, liveValue } = imageOverlayResizeDrag;
    setImageOverlayResizeDrag(null);
    editStore.resizeImageOverlayTime(id, edge, liveValue);
  };

  const beginImageOverlayDrag = (overlay: ImageOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setImageOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleImageOverlayDragMove = (e: React.PointerEvent) => {
    if (!imageOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - imageOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - imageOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(imageOverlayDrag.startTime + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - imageOverlayDrag.duration));
    setImageOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endImageOverlayDrag = () => {
    if (!imageOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = imageOverlayDrag;
    setImageOverlayDrag(null);
    if (isDragging) {
      editStore.moveImageOverlayTime(id, liveStartTime);
    }
    onSelectImageOverlay?.(id);
    const now = getCurrentOutputTime();
    if (now < liveStartTime || now >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- Blur-overlay lane drag / resize ----------------------------------------------------------
  const [blurOverlayResizeDrag, setBlurOverlayResizeDrag] = useState<null | {
    id: string;
    edge: "start" | "end";
    startClientX: number;
    startValue: number;
    oppositeBound: number;
    liveValue: number;
  }>(null);
  const [blurOverlayDrag, setBlurOverlayDrag] = useState<null | {
    id: string;
    startClientX: number;
    startTime: number;
    duration: number;
    isDragging: boolean;
    liveStartTime: number;
  }>(null);

  const renderBlurOverlays: BlurOverlay[] = editStore.blurOverlays.map((o) => {
    if (blurOverlayResizeDrag && o.id === blurOverlayResizeDrag.id) {
      return blurOverlayResizeDrag.edge === "start" ? { ...o, startTime: blurOverlayResizeDrag.liveValue } : { ...o, endTime: blurOverlayResizeDrag.liveValue };
    }
    if (blurOverlayDrag && o.id === blurOverlayDrag.id) {
      return { ...o, startTime: blurOverlayDrag.liveStartTime, endTime: blurOverlayDrag.liveStartTime + blurOverlayDrag.duration };
    }
    return o;
  });

  const beginBlurOverlayResizeDrag = (overlay: BlurOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectBlurOverlay?.(overlay.id);
    const startValue = edge === "start" ? overlay.startTime : overlay.endTime;
    const oppositeBound = edge === "start" ? overlay.endTime : overlay.startTime;
    setBlurOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, startValue, oppositeBound, liveValue: startValue });
  };
  const handleBlurOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!blurOverlayResizeDrag) return;
    e.stopPropagation();
    const deltaSec = (e.clientX - blurOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(blurOverlayResizeDrag.startValue + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const clamped =
      blurOverlayResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, blurOverlayResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, blurOverlayResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setBlurOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue: clamped } : prev));
  };
  const endBlurOverlayResizeDrag = () => {
    if (!blurOverlayResizeDrag) return;
    const { id, edge, liveValue } = blurOverlayResizeDrag;
    setBlurOverlayResizeDrag(null);
    editStore.resizeBlurOverlayTime(id, edge, liveValue);
  };

  const beginBlurOverlayDrag = (overlay: BlurOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setBlurOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
    });
  };
  const handleBlurOverlayDragMove = (e: React.PointerEvent) => {
    if (!blurOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - blurOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - blurOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(blurOverlayDrag.startTime + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - blurOverlayDrag.duration));
    setBlurOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endBlurOverlayDrag = () => {
    if (!blurOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration } = blurOverlayDrag;
    setBlurOverlayDrag(null);
    if (isDragging) {
      editStore.moveBlurOverlayTime(id, liveStartTime);
    }
    onSelectBlurOverlay?.(id);
    const now = getCurrentOutputTime();
    if (now < liveStartTime || now >= liveStartTime + duration) {
      seekToOutputTime(liveStartTime);
    }
  };

  // ---- Adjustment-layer lane drag / resize ------------------------------------------------------
  const [adjustResizeDrag, setAdjustResizeDrag] = useState<null | { id: string; edge: "start" | "end"; startClientX: number; startValue: number; oppositeBound: number; liveValue: number }>(null);
  const [adjustDrag, setAdjustDrag] = useState<null | { id: string; startClientX: number; startTime: number; duration: number; isDragging: boolean; liveStartTime: number }>(null);
  const renderAdjustmentLayers: AdjustmentLayer[] = editStore.adjustmentLayers.map((l) => {
    if (adjustResizeDrag && l.id === adjustResizeDrag.id) return adjustResizeDrag.edge === "start" ? { ...l, startTime: adjustResizeDrag.liveValue } : { ...l, endTime: adjustResizeDrag.liveValue };
    if (adjustDrag && l.id === adjustDrag.id) return { ...l, startTime: adjustDrag.liveStartTime, endTime: adjustDrag.liveStartTime + adjustDrag.duration };
    return l;
  });
  const beginAdjustResizeDrag = (layer: AdjustmentLayer, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectAdjustment?.(layer.id);
    const startValue = edge === "start" ? layer.startTime : layer.endTime;
    setAdjustResizeDrag({ id: layer.id, edge, startClientX: e.clientX, startValue, oppositeBound: edge === "start" ? layer.endTime : layer.startTime, liveValue: startValue });
  };
  const handleAdjustResizeDragMove = (e: React.PointerEvent) => {
    if (!adjustResizeDrag) return;
    e.stopPropagation();
    const raw = snapToTargets(adjustResizeDrag.startValue + (e.clientX - adjustResizeDrag.startClientX) / pxPerSec, getOverlaySnapTargets(), pxPerSec);
    const liveValue =
      adjustResizeDrag.edge === "start"
        ? Math.max(0, Math.min(raw, adjustResizeDrag.oppositeBound - MIN_OVERLAY_DURATION))
        : Math.min(totalOutputDuration, Math.max(raw, adjustResizeDrag.oppositeBound + MIN_OVERLAY_DURATION));
    setAdjustResizeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endAdjustResizeDrag = () => {
    if (!adjustResizeDrag) return;
    const { id, edge, liveValue } = adjustResizeDrag;
    setAdjustResizeDrag(null);
    editStore.resizeAdjustmentLayerTime(id, edge, liveValue);
  };
  const beginAdjustDrag = (layer: AdjustmentLayer) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setAdjustDrag({ id: layer.id, startClientX: e.clientX, startTime: layer.startTime, duration: layer.endTime - layer.startTime, isDragging: false, liveStartTime: layer.startTime });
  };
  const handleAdjustDragMove = (e: React.PointerEvent) => {
    if (!adjustDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - adjustDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const raw = snapToTargets(adjustDrag.startTime + (e.clientX - adjustDrag.startClientX) / pxPerSec, getOverlaySnapTargets(), pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - adjustDrag.duration));
    setAdjustDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endAdjustDrag = () => {
    if (!adjustDrag) return;
    const { id, isDragging, liveStartTime, duration } = adjustDrag;
    setAdjustDrag(null);
    if (isDragging) editStore.moveAdjustmentLayerTime(id, liveStartTime);
    onSelectAdjustment?.(id);
    const now = getCurrentOutputTime();
    if (now < liveStartTime || now >= liveStartTime + duration) seekToOutputTime(liveStartTime);
  };

  // ---- Stage scene lane drag / beat-edge resize -------------------------------------------------
  const scenesFree = editStore.clips.length === 0;
  const [sceneDrag, setSceneDrag] = useState<null | { id: string; startClientX: number; startTime: number; duration: number; isDragging: boolean; liveStartTime: number }>(null);
  const [sceneEdgeDrag, setSceneEdgeDrag] = useState<null | { id: string; beat: number | "end"; startClientX: number; startValue: number; liveValue: number }>(null);
  const renderScenes: StageScene[] = editStore.scenes.map((sc) => {
    if (sceneDrag && sc.id === sceneDrag.id) return { ...sc, startTime: sceneDrag.liveStartTime };
    if (sceneEdgeDrag && sc.id === sceneEdgeDrag.id)
      return sceneEdgeDrag.beat === "end" ? setSceneDuration(sc, sceneEdgeDrag.liveValue) : setBeatHold(sc, sceneEdgeDrag.beat, sceneEdgeDrag.liveValue);
    return sc;
  });
  const beginSceneDrag = (sc: StageScene) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSceneDrag({ id: sc.id, startClientX: e.clientX, startTime: sc.startTime, duration: sceneDuration(sc), isDragging: false, liveStartTime: sc.startTime });
  };
  const handleSceneDragMove = (e: React.PointerEvent) => {
    if (!sceneDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - sceneDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const edges = editStore.scenes.filter((x) => x.id !== sceneDrag.id).flatMap((x) => [x.startTime, x.startTime + sceneDuration(x)]);
    const targets = [...getOverlaySnapTargets(), ...edges];
    const free = sceneDrag.startTime + (e.clientX - sceneDrag.startClientX) / pxPerSec;
    const startTo = snapToTargets(free, targets, pxPerSec);
    const endTo = snapToTargets(free + sceneDrag.duration, targets, pxPerSec);
    const startPull = startTo !== free ? Math.abs(startTo - free) : Infinity;
    const endPull = endTo !== free + sceneDrag.duration ? Math.abs(endTo - (free + sceneDrag.duration)) : Infinity;
    const raw = startPull === Infinity && endPull === Infinity ? free : startPull <= endPull ? startTo : endTo - sceneDrag.duration;
    const liveStartTime = Math.max(0, scenesFree ? raw : Math.min(raw, totalOutputDuration - sceneDrag.duration));
    setSceneDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved, liveStartTime } : prev));
  };
  const endSceneDrag = () => {
    if (!sceneDrag) return;
    const { id, isDragging, liveStartTime, duration } = sceneDrag;
    setSceneDrag(null);
    if (isDragging) editStore.moveSceneTime(id, liveStartTime);
    onSelectScene?.(id);
    const now = getCurrentOutputTime();
    if (now < liveStartTime || now >= liveStartTime + duration) seekToOutputTime(liveStartTime + Math.min(duration, 1.5) * 0.9);
  };
  const beginSceneEdgeDrag = (sc: StageScene, beat: number | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectScene?.(sc.id);
    const startValue = beat === "end" ? sceneDuration(sc) : sc.beats[beat].hold;
    setSceneEdgeDrag({ id: sc.id, beat, startClientX: e.clientX, startValue, liveValue: startValue });
  };
  const handleSceneEdgeDragMove = (e: React.PointerEvent) => {
    if (!sceneEdgeDrag) return;
    e.stopPropagation();
    const liveValue = Math.max(0.1, sceneEdgeDrag.startValue + (e.clientX - sceneEdgeDrag.startClientX) / pxPerSec);
    setSceneEdgeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endSceneEdgeDrag = () => {
    if (!sceneEdgeDrag) return;
    const { id, beat, liveValue } = sceneEdgeDrag;
    setSceneEdgeDrag(null);
    editStore.updateScene(id, (sc) => (beat === "end" ? setSceneDuration(sc, liveValue) : setBeatHold(sc, beat, liveValue)));
  };
  const addScene = async () => {
    let frame = videoPixelSize;
    if (!frame && isProject) frame = await invoke<{ width: number; height: number }>("read_video_project", { projectPath: filePath }).catch(() => null);
    const now = getCurrentOutputTime();
    const created = await editStore.addScene(Math.max(0, now), frame ?? { width: 1920, height: 1080 });
    if (!created) return;
    onSelectScene?.(created.id);
    requestAnimationFrame(() => seekToOutputTime(created.startTime + 1.4));
  };
  const addAdjustmentLayer = () => {
    const total = totalOutputDuration;
    if (total <= 0) return;
    const length = Math.min(5, total);
    const startTime = Math.max(0, Math.min(getCurrentOutputTime(), total - length));
    const id = editStore.addAdjustmentLayer(startTime, startTime + length, { look: { preset: "cinematic", intensity: 1 }, vignette: 0.35 });
    onSelectAdjustment?.(id);
  };

  // ---- PiP-overlay / B-roll lane drag & resize --------------------------------------------------
  const renderPipOverlays: PipOverlay[] = editStore.pipOverlays.map((o) => {
    if (pipOverlayResizeDrag && o.id === pipOverlayResizeDrag.id) {
      return pipOverlayResizeDrag.edge === "start" ? { ...o, startTime: pipOverlayResizeDrag.liveValue } : { ...o, endTime: pipOverlayResizeDrag.liveValue };
    }
    if (pipOverlayDrag && o.id === pipOverlayDrag.id) {
      return { ...o, startTime: pipOverlayDrag.liveStartTime, endTime: pipOverlayDrag.liveStartTime + pipOverlayDrag.duration, track: pipOverlayDrag.liveTrack };
    }
    return followSplit(o);
  });
  const videoTrackLanes = tracksInUse(renderPipOverlays).reverse();

  const handleAddBroll = async () => {
    const selected = await openFileDialog({ multiple: true, filters: [{ name: "Video", extensions: [...MEDIA_VIDEO_EXTENSIONS] }] });
    const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    if (paths.length === 0) return;
    const at = getCurrentOutputTime() < totalOutputDuration - 1 ? getCurrentOutputTime() : 0;
    const ids = await editStore.addVideoLayers(paths, at);
    if (ids[0]) onSelectPipOverlay?.(ids[0]);
  };

  const beginPipOverlayResizeDrag = (overlay: PipOverlay, edge: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectPipOverlay?.(overlay.id);
    setPipOverlayResizeDrag({ id: overlay.id, edge, startClientX: e.clientX, liveValue: edge === "start" ? overlay.startTime : overlay.endTime });
  };
  const handlePipOverlayResizeDragMove = (e: React.PointerEvent) => {
    if (!pipOverlayResizeDrag) return;
    e.stopPropagation();
    const overlay = editStore.pipOverlays.find((o) => o.id === pipOverlayResizeDrag.id);
    if (!overlay) return;
    const deltaSec = (e.clientX - pipOverlayResizeDrag.startClientX) / pxPerSec;
    const raw = snapToTargets((pipOverlayResizeDrag.edge === "start" ? overlay.startTime : overlay.endTime) + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const preview = resizePipOverlayTimeHandler([overlay], overlay.id, pipOverlayResizeDrag.edge, totalOutputDuration, raw)[0];
    const liveValue = pipOverlayResizeDrag.edge === "start" ? preview.startTime : preview.endTime;
    setPipOverlayResizeDrag((prev) => (prev ? { ...prev, liveValue } : prev));
  };
  const endPipOverlayResizeDrag = () => {
    if (!pipOverlayResizeDrag) return;
    const { id, edge, liveValue } = pipOverlayResizeDrag;
    setPipOverlayResizeDrag(null);
    editStore.resizePipOverlayTime(id, edge, liveValue);
  };

  const beginPipOverlayDrag = (overlay: PipOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    if (toolMode === "razor") {
      editStore.splitPipOverlay(overlay.id, outputTimeFromClientX(e.clientX));
      onSelectPipOverlay?.(overlay.id);
      setSelectedClipId(null);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setPipOverlayDrag({
      id: overlay.id,
      startClientX: e.clientX,
      startTime: overlay.startTime,
      duration: overlay.endTime - overlay.startTime,
      isDragging: false,
      liveStartTime: overlay.startTime,
      startTrack: pipTrack(overlay),
      liveTrack: pipTrack(overlay),
    });
  };
  const handlePipOverlayDragMove = (e: React.PointerEvent) => {
    if (!pipOverlayDrag) return;
    e.stopPropagation();
    const moved = Math.abs(e.clientX - pipOverlayDrag.startClientX) >= CLICK_DRAG_THRESHOLD_PX;
    const deltaSec = (e.clientX - pipOverlayDrag.startClientX) / pxPerSec;
    const raw = snapToTargets(pipOverlayDrag.startTime + deltaSec, getOverlaySnapTargets(), pxPerSec);
    const liveStartTime = Math.max(0, Math.min(raw, totalOutputDuration - pipOverlayDrag.duration));
    const lanes = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-video-track]") ?? []);
    let overTrack: number | null = null;
    for (const lane of lanes) {
      const r = lane.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom) overTrack = Number(lane.dataset.videoTrack);
    }
    if (overTrack === null && lanes.length > 0 && e.clientY < lanes[0].getBoundingClientRect().top) {
      overTrack = Math.max(0, ...editStore.pipOverlays.filter((o) => o.id !== pipOverlayDrag.id).map(pipTrack)) + 1;
    }
    setPipOverlayDrag((prev) => (prev ? { ...prev, isDragging: prev.isDragging || moved || (overTrack !== null && overTrack !== prev.liveTrack), liveStartTime, liveTrack: overTrack ?? prev.liveTrack } : prev));
  };
  const endPipOverlayDrag = () => {
    if (!pipOverlayDrag) return;
    const { id, isDragging, liveStartTime, duration, startTrack, liveTrack } = pipOverlayDrag;
    setPipOverlayDrag(null);
    if (isDragging) {
      editStore.movePipOverlayTime(id, liveStartTime, liveTrack !== startTrack ? liveTrack : undefined);
    }
    onSelectPipOverlay?.(id);
    setSelectedClipId(null);
    const now = getCurrentOutputTime();
    if (!isPlaying && (now < liveStartTime || now >= liveStartTime + duration)) {
      seekToOutputTime(liveStartTime);
    }
  };

  return {
    overlayResizeDrag,
    overlayDrag,
    renderOverlays,
    beginOverlayResizeDrag,
    handleOverlayResizeDragMove,
    endOverlayResizeDrag,
    beginOverlayDrag,
    handleOverlayDragMove,
    endOverlayDrag,
    imageOverlayResizeDrag,
    imageOverlayDrag,
    renderImageOverlays,
    beginImageOverlayResizeDrag,
    handleImageOverlayResizeDragMove,
    endImageOverlayResizeDrag,
    beginImageOverlayDrag,
    handleImageOverlayDragMove,
    endImageOverlayDrag,
    blurOverlayResizeDrag,
    blurOverlayDrag,
    renderBlurOverlays,
    beginBlurOverlayResizeDrag,
    handleBlurOverlayResizeDragMove,
    endBlurOverlayResizeDrag,
    beginBlurOverlayDrag,
    handleBlurOverlayDragMove,
    endBlurOverlayDrag,
    adjustResizeDrag,
    adjustDrag,
    renderAdjustmentLayers,
    beginAdjustResizeDrag,
    handleAdjustResizeDragMove,
    endAdjustResizeDrag,
    beginAdjustDrag,
    handleAdjustDragMove,
    endAdjustDrag,
    sceneDrag,
    sceneEdgeDrag,
    renderScenes,
    beginSceneDrag,
    handleSceneDragMove,
    endSceneDrag,
    beginSceneEdgeDrag,
    handleSceneEdgeDragMove,
    endSceneEdgeDrag,
    addScene,
    addAdjustmentLayer,
    pipOverlayResizeDrag,
    pipOverlayDrag,
    renderPipOverlays,
    videoTrackLanes,
    handleAddBroll,
    beginPipOverlayResizeDrag,
    handlePipOverlayResizeDragMove,
    endPipOverlayResizeDrag,
    beginPipOverlayDrag,
    handlePipOverlayDragMove,
    endPipOverlayDrag,
  };
}
