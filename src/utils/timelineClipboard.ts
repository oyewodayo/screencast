// utils/timelineClipboard.ts
//
// Copy and paste on the video timeline. Ctrl+C keeps copies of the selected clips or overlay here
// (with every setting) and puts a marker on the system clipboard; Ctrl+V pastes them at the
// playhead - as long as the system clipboard still holds that marker. If something else has been
// copied since (files in Explorer, a screenshot, a picture from a browser), Ctrl+V adds that to
// the video instead - see VideoTimelineDocker's paste handler.

import type { AdjustmentLayer, AudioOverlay, BlurOverlay, Clip, ImageOverlay, PipOverlay, TextOverlay } from "./videoEditTypes";

export interface TimelineClipboardItems {
  clips: Clip[];
  textOverlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  blurOverlays: BlurOverlay[];
  pipOverlays: PipOverlay[];
  audioOverlays: AudioOverlay[];
  adjustmentLayers: AdjustmentLayer[];
}

export const emptyClipboardItems = (): TimelineClipboardItems => ({
  clips: [],
  textOverlays: [],
  imageOverlays: [],
  blurOverlays: [],
  pipOverlays: [],
  audioOverlays: [],
  adjustmentLayers: [],
});

let held: { marker: string; items: TimelineClipboardItems } | null = null;

const MARKER_PREFIX = "briefcast-timeline-copy:";

// Keeps the items and marks the system clipboard as holding them. Returns how many were copied.
export async function copyItems(items: TimelineClipboardItems): Promise<number> {
  const count = Object.values(items).reduce((n, list) => n + list.length, 0);
  if (count === 0) return 0;
  const marker = `${MARKER_PREFIX}${crypto.randomUUID()}`;
  held = { marker, items: structuredClone(items) };
  try {
    await navigator.clipboard.writeText(marker);
  } catch {
    // Without the system clipboard, paste still works from what's held here.
  }
  return count;
}

// What Ctrl+V should paste from the timeline, given the system clipboard's text: the held items
// if that text is still the marker (or the system clipboard couldn't be read at all).
export function heldItemsFor(clipboardText: string | null): TimelineClipboardItems | null {
  if (!held) return null;
  if (clipboardText === null || clipboardText === held.marker) return structuredClone(held.items);
  return null;
}

export const isTimelineMarker = (text: string) => text.startsWith(MARKER_PREFIX);
