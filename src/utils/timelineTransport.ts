// utils/timelineTransport.ts
//
// The video timeline's own clock and seek, in output time, for the player's scrub bar. Both go
// through the timeline (VideoTimelineDocker) because only it knows which clip is playing at the very
// moment of a switch - seeking the <video> directly would leave it tracking the clip it was in before.

export interface TimelineTransport {
  // null while the player can't be read (mid-switch).
  getTime: () => number | null;
  seek: (outputTime: number) => void;
}

let current: TimelineTransport | null = null;

// Returns the unregister.
export function registerTimelineTransport(transport: TimelineTransport): () => void {
  current = transport;
  return () => {
    if (current === transport) current = null;
  };
}

export const timelineTime = (): number | null => current?.getTime() ?? null;
export const seekTimeline = (outputTime: number) => current?.seek(outputTime);
