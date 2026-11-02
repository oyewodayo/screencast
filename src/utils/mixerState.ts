// utils/mixerState.ts
//
// The mixer's session-only state, shared by the player (the video's own sound), the timeline (the
// audio tracks' elements) and the picture-in-picture layer: whether the Mixer panel is open (its
// meters need every channel routed through Web Audio) and which channels are soloed. Solo is a
// listening aid - nothing about it is saved or exported.
import { useSyncExternalStore } from "react";

export const VIDEO_CHANNEL = "video";
export const pipChannelKey = (pipId: string) => `pip:${pipId}`;

interface MixerSession {
  open: boolean;
  solo: ReadonlySet<string>;
  // The latest "open the mixer at this channel" ask from outside the timeline (a picture-in-
  // picture's panel) - the timeline opens it; a fresh object each time, so a repeat still counts.
  request?: { key: string };
}

let session: MixerSession = { open: false, solo: new Set() };
const listeners = new Set<() => void>();

function set(next: MixerSession) {
  session = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useMixerSession = (): MixerSession => useSyncExternalStore(subscribe, () => session);
export const getMixerSession = (): MixerSession => session;

export function setMixerOpen(open: boolean) {
  if (open !== session.open) set({ ...session, open, solo: open ? session.solo : new Set() });
}

export function toggleSolo(channel: string) {
  const solo = new Set(session.solo);
  if (solo.has(channel)) solo.delete(channel);
  else solo.add(channel);
  set({ ...session, solo });
}

export function requestMixer(channel: string) {
  set({ ...session, request: { key: channel } });
}

// Whether solo on other channels silences this one (in the preview only).
export const silencedBySolo = (s: MixerSession, channel: string): boolean => s.solo.size > 0 && !s.solo.has(channel);
