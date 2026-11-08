// utils/projectPrep.ts
//
// Progress for the "Making your video" screen (components/video/ProjectPrepOverlay.tsx), kept out of
// React state on purpose: it changes once per photo, and pushing that through Dashboard's state would
// re-render the whole Dashboard dozens of times while a project is being made. Here only the
// overlay, which subscribes, redraws.
//
// Two pieces:
//   - the making itself (song, beat, photo fills, the project file) - set by Dashboard as it runs
//     the dialog's prepare step;
//   - how many of the open timeline's photos are ready to play (their preview proxies) - set by
//     Dashboard's preparation effect for any open timeline, which is what "ready" waits for.

export interface PrepState {
  // Identifies one run, so a late update from an abandoned run can't touch a newer one.
  id: string;
  name: string;
  // The picked photos' thumbnails, in order (null where none was ready).
  thumbs: (string | null)[];
  step: string;
  done: number;
  total: number;
  // Set once the project is open: the timeline whose photos must be ready before it shows.
  primaryPath: string | null;
  // How many distinct photos that timeline will have - ready means at least this many prepared.
  expectedPhotos: number;
}

export interface WarmProgress {
  primaryPath: string;
  done: number;
  total: number;
}

type Listener = () => void;

let prep: PrepState | null = null;
let warm: WarmProgress | null = null;
const listeners = new Set<Listener>();

const notify = () => listeners.forEach((fn) => fn());

export const getPrep = (): PrepState | null => prep;
export const getWarm = (): WarmProgress | null => warm;

export function startPrep(init: Omit<PrepState, "step" | "done" | "total" | "primaryPath" | "expectedPhotos">): void {
  prep = { ...init, step: "Getting started…", done: 0, total: 0, primaryPath: null, expectedPhotos: 0 };
  notify();
}

/** Updates the run `id` - ignored if that run has ended or been replaced. */
export function updatePrep(id: string, patch: Partial<Omit<PrepState, "id">>): void {
  if (!prep || prep.id !== id) return;
  prep = { ...prep, ...patch };
  notify();
}

export function endPrep(id: string): void {
  if (!prep || prep.id !== id) return;
  prep = null;
  notify();
}

export function setWarm(progress: WarmProgress): void {
  warm = progress;
  notify();
}

export function subscribePrep(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether every photo of the run's timeline is ready to play. */
export function isPrepReady(p: PrepState, w: WarmProgress | null): boolean {
  if (!p.primaryPath) return false;
  if (p.expectedPhotos === 0) return true;
  return !!w && w.primaryPath === p.primaryPath && w.total >= p.expectedPhotos && w.done >= w.total;
}
