// utils/previewHead.ts
//
// Playing lines on audio tracks, and who gets to play.
//
// A playing line marks where in a track something other than the timeline is playing it - the audio
// panel's own preview (AudioOverlayPopover), or the mixer playing the selected pieces on their own
// (audition.ts). One per track, by the track's id; read every frame by the line on its chip
// (PreviewHeadLine in VideoTimelineDocker), so following playback never re-renders the timeline.
//
// Three things can play the edit's sound - the timeline, the mixer's audition, a panel's preview -
// and only one at a time makes sense: each registers how to stop it, and claims playback when it
// starts, which stops the others.

export interface PreviewHead {
  at: number; // seconds into the track's source file
  playing: boolean;
  // The panel's "Show playing line" switch (always on for the mixer's audition).
  visible: boolean;
  // Drives the timeline's scroll to keep it in view - one line per player, so several don't fight.
  leads: boolean;
  // Lets the line seek its player (a drag, or a click on the track).
  seek: (sourceTime: number) => void;
}

const heads = new Map<string, PreviewHead>();

export const setPreviewHead = (trackId: string, head: PreviewHead | null) => {
  if (head) heads.set(trackId, head);
  else heads.delete(trackId);
};
export const readPreviewHead = (trackId: string): PreviewHead | null => heads.get(trackId) ?? null;

export type PlaybackOwner = "timeline" | "audition" | "panel";
const stoppers = new Map<PlaybackOwner, () => void>();

// How to stop this player when another starts. Returns the unregister.
export function registerPlayback(owner: PlaybackOwner, stop: () => void): () => void {
  stoppers.set(owner, stop);
  return () => {
    if (stoppers.get(owner) === stop) stoppers.delete(owner);
  };
}

// This player is starting - every other one stops.
export function claimPlayback(owner: PlaybackOwner) {
  stoppers.forEach((stop, other) => other !== owner && stop());
}

const SHOW_KEY = "briefcast.audioPanel.showPlayingLine";
export const readShowPlayingLine = (): boolean => {
  try {
    return localStorage.getItem(SHOW_KEY) !== "0";
  } catch {
    return true;
  }
};
export const saveShowPlayingLine = (on: boolean) => {
  try {
    localStorage.setItem(SHOW_KEY, on ? "1" : "0");
  } catch {
    // A convenience only.
  }
};
