// utils/videoTracks.ts
//
// Video tracks above the main one - V2, V3, ... - holding picture-in-picture and B-roll layers
// (PipOverlay). A layer's `track` decides what covers what: higher tracks draw over lower ones, and
// within a track later layers over earlier ones. Every video track sits on the main video, beneath
// blur regions, pictures, text and captions - so a title stays readable over B-roll and a blur
// region hides what's under it on every track. Preview (PipOverlayLayer's DOM order) and export
// (export_trimmed_video's PiP pass, in stackOrder) composite in the same order.
import type { PipOverlay } from "./videoEditTypes";

export const pipTrack = (o: Pick<PipOverlay, "track">): number => Math.max(1, Math.round(o.track ?? 1));

// "V2" for track 1 - the main video is V1.
export const videoTrackLabel = (track: number): string => `V${track + 1}`;

// Bottom-most first: the order to composite in.
export function stackOrder<T extends Pick<PipOverlay, "track">>(layers: T[]): T[] {
  return layers.map((o, i) => ({ o, i })).sort((a, b) => pipTrack(a.o) - pipTrack(b.o) || a.i - b.i).map(({ o }) => o);
}

// Tracks with something on them, lowest first.
export function tracksInUse(layers: Pick<PipOverlay, "track">[]): number[] {
  return Array.from(new Set(layers.map(pipTrack))).sort((a, b) => a - b);
}

const overlaps = (a: { startTime: number; endTime: number }, start: number, end: number) => a.startTime < end - 1e-6 && a.endTime > start + 1e-6;

// The lowest track (from `minTrack` up) with nothing on it during [start, end) - a new track above
// the rest when every one is busy then.
export function freeTrack(layers: Pick<PipOverlay, "track" | "startTime" | "endTime" | "id">[], start: number, end: number, minTrack = 1, ignoreId?: string): number {
  for (let t = minTrack; ; t++) {
    if (!layers.some((o) => o.id !== ignoreId && pipTrack(o) === t && overlaps(o, start, end))) return t;
  }
}

// How opaque a layer is at output time `t`: its opacity times its fade in/out ramps - linear, as
// export's `fade` filter ramps the alpha. Each fade is capped at half the layer's length.
export function layerOpacityAt(o: Pick<PipOverlay, "opacity" | "fadeIn" | "fadeOut" | "startTime" | "endTime">, t: number): number {
  const base = Math.max(0, Math.min(1, o.opacity ?? 1));
  const half = Math.max(0, (o.endTime - o.startTime) / 2);
  const fadeIn = Math.min(half, Math.max(0, o.fadeIn ?? 0));
  const fadeOut = Math.min(half, Math.max(0, o.fadeOut ?? 0));
  let k = 1;
  if (fadeIn > 0) k = Math.min(k, (t - o.startTime) / fadeIn);
  if (fadeOut > 0) k = Math.min(k, (o.endTime - t) / fadeOut);
  return base * Math.max(0, Math.min(1, k));
}

// Fades as export takes them: seconds, already capped at half the layer.
export function exportFades(o: Pick<PipOverlay, "fadeIn" | "fadeOut" | "startTime" | "endTime">): { fadeIn: number; fadeOut: number } {
  const half = Math.max(0, (o.endTime - o.startTime) / 2);
  return { fadeIn: Math.min(half, Math.max(0, o.fadeIn ?? 0)), fadeOut: Math.min(half, Math.max(0, o.fadeOut ?? 0)) };
}

export const isTrackHidden = (hidden: number[] | undefined, track: number): boolean => !!hidden?.includes(track);

// Renumbers the tracks in use to 1, 2, 3... in the same order (a track emptied by a move or a
// delete leaves no gap), carrying the hidden flags along. Unchanged inputs come back as they were.
export function compactTracks<T extends Pick<PipOverlay, "track">>(layers: T[], hidden: number[] | undefined): { layers: T[]; hidden: number[] | undefined } {
  const used = tracksInUse(layers);
  if (used.every((t, i) => t === i + 1)) return { layers, hidden };
  const renumber = new Map(used.map((t, i) => [t, i + 1]));
  const nextHidden = (hidden ?? []).flatMap((t) => (renumber.has(t) ? [renumber.get(t)!] : []));
  return {
    layers: layers.map((o) => (renumber.get(pipTrack(o)) === pipTrack(o) ? o : { ...o, track: renumber.get(pipTrack(o)) })),
    hidden: nextHidden.length > 0 ? nextHidden : undefined,
  };
}
