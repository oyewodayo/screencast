// utils/recordingStatus.ts
//
// The backend's view of the recording in progress (get_recording_status, commands/recording.rs),
// for a window whose page was reloaded mid-recording to pick it back up. Times are Date.now()
// milliseconds, the same model as the live timer's startTime/pauseStartedAt/pausedAccumulatedMs.

export interface RecordingClock {
  recordType: string;
  startedAt: number;
  pauseStartedAt: number | null;
  pausedAccumulatedMs: number;
}

export interface RecordingStatus {
  recording: boolean;
  clock: RecordingClock | null;
}
