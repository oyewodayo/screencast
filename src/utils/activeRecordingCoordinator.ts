// utils/activeRecordingCoordinator.ts
//
// Single shared frontend source of truth for Briefcast's active native Rust recording session.
// Both the main BottomDocker recorder (Dashboard.tsx) and scoped presentation recorders
// (Whiteboard Presentation Mode, and future Live Multi-Camera Display recording) register here so:
//   - Starting a Whiteboard recording immediately reflects on the main bottom bar (turning Record
//     into Stop + live timer + Pause/Resume) and delegates main-bar Stop/Pause/Hotkey cleanly.
//   - Starting a Main recording prevents Whiteboard Presentation from double-invoking start_recording.
import { useSyncExternalStore } from "react";

export type RecordingOwner = "main" | "whiteboard" | "presentation";

export interface ActiveRecordingSession {
  owner: RecordingOwner;
  startedAt: number;
  isPaused: boolean;
  pauseStartedAt: number | null;
  pausedAccumulatedMs: number;
  stop: () => Promise<void>;
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
}

let currentSession: ActiveRecordingSession | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getActiveRecordingSession(): ActiveRecordingSession | null {
  return currentSession;
}

export function setActiveRecordingSession(session: ActiveRecordingSession | null): void {
  currentSession = session;
  emit();
}

export function updateActiveRecordingSession(
  owner: RecordingOwner,
  patch: Partial<Omit<ActiveRecordingSession, "owner">>
): void {
  if (!currentSession || currentSession.owner !== owner) return;
  currentSession = { ...currentSession, ...patch };
  emit();
}

export function clearActiveRecordingSession(owner: RecordingOwner): void {
  if (!currentSession || currentSession.owner !== owner) return;
  currentSession = null;
  emit();
}

export function subscribeActiveRecordingSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActiveRecordingSession(): ActiveRecordingSession | null {
  return useSyncExternalStore(
    subscribeActiveRecordingSession,
    getActiveRecordingSession,
    getActiveRecordingSession
  );
}
