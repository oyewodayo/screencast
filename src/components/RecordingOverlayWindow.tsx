// RecordingOverlayWindow.tsx - This should be a separate component/page
import { useEffect, useState } from 'react'
import { IoContractOutline, IoExpandOutline, IoMic, IoPause, IoPlay, IoScanSharp, IoSquare, IoVideocam } from 'react-icons/io5'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import { trackEvent } from "../utils/telemetry";
import type { RecordingStatus } from "../utils/recordingStatus";
const appWindow = getCurrentWebviewWindow()

// The window is sized to the pill it's showing (plus room for the shadow) rather than staying at
// the full bar's size when minimized - a transparent window still takes clicks across its whole
// rectangle, so a small pill in a big window blocked whatever was underneath it.
const FULL_SIZE = new LogicalSize(380, 68);
const MINI_SIZE = new LogicalSize(196, 52);

// Which inputs this recording captures, as small icons - the same set in both sizes of the bar.
function SourceIcons({ recordType }: { recordType: string }) {
    const screen = ["sva", "sa", "s", "c"].includes(recordType);
    const camera = ["sva", "va", "v"].includes(recordType);
    const mic = ["sva", "sa", "va", "a"].includes(recordType);
    return (
        <span className="flex items-center gap-1.5 text-white/60">
            {screen && <IoScanSharp size={14} title="Screen" />}
            {camera && <IoVideocam size={14} title="Camera" />}
            {mic && <IoMic size={14} title="Microphone" />}
        </span>
    );
}

// The live dot + timer. Red and pulsing while capturing, amber and still while paused, so the
// state reads from across the screen without having to look at the buttons.
function RecTimer({ time, paused, compact }: { time: string; paused: boolean; compact?: boolean }) {
    return (
        <span data-tauri-drag-region className="flex items-center gap-2 select-none">
            <span data-tauri-drag-region className="relative flex h-2.5 w-2.5">
                {!paused && <span className="absolute inset-0 rounded-full bg-red-500 opacity-60 animate-ping" />}
                <span className={`relative h-2.5 w-2.5 rounded-full ${paused ? "bg-amber-400" : "bg-red-500"}`} />
            </span>
            <span data-tauri-drag-region className={`font-mono tabular-nums ${compact ? "text-[13px]" : "text-[15px]"} font-semibold tracking-tight ${paused ? "text-amber-300" : "text-white"}`}>
                {time}
            </span>
        </span>
    );
}

const PILL_CLASS =
    "flex items-center rounded-full bg-neutral-900/90 backdrop-blur-xl ring-1 ring-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.35)] text-white cursor-move";
const ICON_BUTTON_CLASS =
    "h-8 w-8 shrink-0 flex items-center justify-center rounded-full transition active:scale-95";

const RecordingOverlayWindow = () => {
    const [elapsedTime, setElapsedTime] = useState<number>(0);
    const [isMinimized, setIsMinimized] = useState<boolean>(false);
    const [recordType, setRecordType] = useState<string>("sva");
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [startTime, setStartTime] = useState<number | null>(null);
    // Pause/resume timing model - see Dashboard.tsx's own doc comment on these three fields for
    // the elapsed-time formula they feed into below. Kept in sync with the main window in both
    // directions: 'recording-state-update' carries it here whenever the main window's own pause
    // button changes it, and this window's own pause button below emits 'recording-pause-changed'
    // for the main window to pick back up, mirroring how stop already works both ways.
    const [isPaused, setIsPaused] = useState<boolean>(false);
    const [pauseStartedAt, setPauseStartedAt] = useState<number | null>(null);
    const [pausedAccumulatedMs, setPausedAccumulatedMs] = useState<number>(0);
    // Live capture diagnostics from the backend's ffmpeg `-progress` sidecar (Windows only for
    // now - see services/progress_watch.rs). fps/dropFrames are the two numbers that actually
    // tell a user their capture is struggling in real time, rather than only finding out once
    // they watch the finished file back.
    const [captureFps, setCaptureFps] = useState<number | null>(null);
    const [droppedFrames, setDroppedFrames] = useState<number>(0);
    // The screen capture died and is being restarted ('lost'), or just was ('recovered') - see
    // capture_watchdog.rs. The audio carries on throughout.
    const [captureStatus, setCaptureStatus] = useState<'lost' | 'recovered' | null>(null);
    // Live screen<->camera view switching - only meaningful for "sva" recordings with
    // separate_webcam_capture on (see FormData's own doc comment, recording.rs), which is the one
    // combination that actually produces a second (camera) file to switch to. canSwitchView comes
    // from the main window (Dashboard.tsx) alongside every other recording-state-update field;
    // viewMode is purely local UI state - the backend only cares about the *events* (see
    // handleSwitchView below), not which mode is "current" at any given moment.
    const [canSwitchView, setCanSwitchView] = useState<boolean>(false);
    const [viewMode, setViewMode] = useState<'screen' | 'camera'>('screen');

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    const toggleMinimize = () => {
        setIsMinimized(!isMinimized);
    };

    useEffect(() => {
        appWindow.setSize(isMinimized ? MINI_SIZE : FULL_SIZE).catch((err) => console.error("Couldn't resize the recording bar:", err));
    }, [isMinimized]);

    const handleStopRecording = async () => {
        // ffmpeg has already been asked to stop and torn down on the backend by the time
        // stop_recording rejects (e.g. the capture device disappeared mid-recording and no
        // output file was produced) - so the main window's state still needs resetting and
        // this overlay still needs to go away even on failure. Only the "tell the user what
        // happened" step differs between the two branches below.
        //
        // Hidden and announced first, before stop_recording returns - finishing a long recording
        // takes minutes, and the backend shows the completion window as "finishing" meanwhile.
        setIsRecording(false);
        await appWindow.hide();
        await emit('recording-stopped');
        try {
            await invoke("stop_recording");
            trackEvent("recording_finished", { durationSeconds: elapsedTime, stoppedFrom: "overlay" });
        } catch (error) {
            // Already stopped from the main window and still finishing - nothing to report.
            if (String(error).includes("No recording in progress")) return;
            console.error("Error stopping recording:", error);
            await message(String(error), { title: 'Recording failed', kind: 'error' });
        }
    };

    const handlePauseRecording = async () => {
        try {
            await invoke("pause_recording");
            const now = Date.now();
            setIsPaused(true);
            setPauseStartedAt(now);
            await emit('recording-pause-changed', { isPaused: true, pauseStartedAt: now, pausedAccumulatedMs });
        } catch (error) {
            console.error("Error pausing recording:", error);
            await message(String(error), { title: 'Failed to pause recording', kind: 'error' });
        }
    };

    const handleResumeRecording = async () => {
        try {
            await invoke("resume_recording");
            const addedMs = pauseStartedAt ? Date.now() - pauseStartedAt : 0;
            const newAccumulatedMs = pausedAccumulatedMs + addedMs;
            setIsPaused(false);
            setPauseStartedAt(null);
            setPausedAccumulatedMs(newAccumulatedMs);
            await emit('recording-pause-changed', { isPaused: false, pauseStartedAt: null, pausedAccumulatedMs: newAccumulatedMs });
        } catch (error) {
            console.error("Error resuming recording:", error);
            await message(String(error), { title: 'Failed to resume recording', kind: 'error' });
        }
    };

    // This window's page can be reloaded mid-recording (renderer crash recovery, see
    // services/webview_recovery.rs) - take the timer and controls back from the backend rather
    // than waiting for a 'recording-state-update' that already came and went.
    useEffect(() => {
        invoke<RecordingStatus>("get_recording_status")
            .then(({ recording, clock }) => {
                if (!recording || !clock) return;
                setIsRecording(true);
                setRecordType(clock.recordType);
                setStartTime(clock.startedAt);
                setIsPaused(clock.pauseStartedAt !== null);
                setPauseStartedAt(clock.pauseStartedAt);
                setPausedAccumulatedMs(clock.pausedAccumulatedMs);
            })
            .catch(() => {});
    }, []);

    // Listen for recording updates from main window
    useEffect(() => {
        const setupListeners = async () => {
            // Listen for recording state updates
            const unlistenRecordingState = await listen<{
                isRecording: boolean;
                recordType: string;
                startTime: number;
                isPaused?: boolean;
                pauseStartedAt?: number | null;
                pausedAccumulatedMs?: number;
                canSwitchView?: boolean;
            }>('recording-state-update', (event) => {
                setIsRecording(event.payload.isRecording);
                setRecordType(event.payload.recordType);
                setStartTime(event.payload.startTime);
                setIsPaused(event.payload.isPaused ?? false);
                setPauseStartedAt(event.payload.pauseStartedAt ?? null);
                setPausedAccumulatedMs(event.payload.pausedAccumulatedMs ?? 0);
                setCanSwitchView(event.payload.canSwitchView ?? false);
            });

            const unlistenProgress = await listen<{
                frame?: number;
                fps?: number;
                bitrateKbps?: number;
                outTimeSecs?: number;
                dupFrames?: number;
                dropFrames?: number;
                speed?: number;
            }>('recording-progress', (event) => {
                setCaptureFps(event.payload.fps ?? null);
                setDroppedFrames(event.payload.dropFrames ?? 0);
            });

            const unlistenCapture = await listen<'lost' | 'recovered'>('recording-capture-status', (event) => {
                setCaptureStatus(event.payload);
            });

            return () => {
                unlistenRecordingState();
                unlistenProgress();
                unlistenCapture();
            };
        };

        let cleanup: (() => void) | undefined;
        setupListeners().then(fn => {
            cleanup = fn;
        });

        return () => {
            if (cleanup) cleanup();
        };
    }, []);

    // Clear stale diagnostics from whatever recording just ended, rather than leaving last
    // session's fps/dropped-frame numbers on screen once a new (or no) recording starts.
    useEffect(() => {
        if (!isRecording) {
            setCaptureFps(null);
            setDroppedFrames(0);
            setCaptureStatus(null);
        }
    }, [isRecording]);

    // "recovered" is news for a few seconds, not a lasting state.
    useEffect(() => {
        if (captureStatus !== 'recovered') return;
        const timer = setTimeout(() => setCaptureStatus(null), 6000);
        return () => clearTimeout(timer);
    }, [captureStatus]);

    // Every new recording starts on "screen" by construction (that's what recording_with_output_sva
    // actually captures as the main file's baked-in frame) - reset local UI state so a previous
    // recording's last-picked view doesn't carry over and look wrong from the very first frame.
    // Keyed on startTime (unique per recording) rather than isRecording, which wouldn't change
    // between two recordings started back to back without ever passing through "not recording".
    useEffect(() => {
        setViewMode('screen');
    }, [startTime]);

    // Logs a screen<->camera switch to the backend's own in-memory timeline (written out as a
    // sidecar once the recording stops - see record_view_switch's own doc comment, recording.rs)
    // and flips the local button state immediately for responsive feedback, independent of
    // whether the backend call actually lands. elapsedSecs uses the exact same pause-aware formula
    // the timer above derives from (effectiveNow frozen at pauseStartedAt while paused) so a switch
    // logged mid-pause still lines up with what the displayed timer read at that moment.
    const handleSwitchView = async (mode: 'screen' | 'camera') => {
        if (mode === viewMode) return;
        // The main window owns the view (it also takes the Alt+Shift+V hotkey) and logs the cut;
        // this window just asks, and follows 'view-mode-changed' like every other control.
        setViewMode(mode);
        try {
            await emit('view-switch-requested', { mode });
        } catch (error) {
            console.error('Error requesting view switch:', error);
        }
    };

    useEffect(() => {
        const unlisten = listen<{ mode: 'screen' | 'camera' }>('view-mode-changed', (event) => {
            setViewMode(event.payload.mode);
        });
        return () => {
            unlisten.then((fn) => fn());
        };
    }, []);

    // Derive elapsed time from the shared start timestamp (see Dashboard.tsx /
    // ActiveRecordingState.tsx) so this window's timer can't drift apart from the main window's -
    // same pause-aware formula as ActiveRecordingState.tsx's own copy (see its doc comment).
    useEffect(() => {
        let interval: number | undefined;
        if (isRecording && startTime) {
            const tick = () => {
                const effectiveNow = isPaused && pauseStartedAt ? pauseStartedAt : Date.now();
                setElapsedTime(Math.floor((effectiveNow - startTime - pausedAccumulatedMs) / 1000));
            };
            tick();
            if (!isPaused) {
                interval = window.setInterval(tick, 1000);
            }
        } else {
            setElapsedTime(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, startTime, isPaused, pauseStartedAt, pausedAccumulatedMs]);

    const pauseButton = (
        <button
            type="button"
            className={`${ICON_BUTTON_CLASS} bg-white/10 hover:bg-white/20 text-white`}
            onClick={isPaused ? handleResumeRecording : handlePauseRecording}
            title={isPaused ? "Resume recording" : "Pause recording"}
        >
            {isPaused ? <IoPlay size={15} className="ml-0.5" /> : <IoPause size={15} />}
        </button>
    );
    const stopButton = (
        <button
            type="button"
            className={`${ICON_BUTTON_CLASS} bg-red-500 hover:bg-red-600 text-white shadow-[0_0_0_3px_rgba(239,68,68,0.25)]`}
            onClick={handleStopRecording}
            title="Stop recording"
        >
            <IoSquare size={11} />
        </button>
    );

    // Minimized: just the state, the time, and the one action that matters - stopping.
    if (isMinimized) {
        return (
            <div className="w-full h-full flex items-center justify-center p-1.5">
                <div data-tauri-drag-region className={`${PILL_CLASS} gap-2 h-10 pl-3.5 pr-1`}>
                    <RecTimer time={formatTime(elapsedTime)} paused={isPaused} compact />
                    <div className="flex items-center gap-1">
                        <span className="scale-[0.85] flex">{stopButton}</span>
                        <button type="button" onClick={toggleMinimize} title="Expand" className={`${ICON_BUTTON_CLASS} h-7 w-7 text-white/60 hover:text-white hover:bg-white/10`}>
                            <IoExpandOutline size={14} />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full flex items-center justify-center p-1.5">
            <div data-tauri-drag-region className={`${PILL_CLASS} gap-3 h-[52px] pl-4 pr-1.5`}>
                <div data-tauri-drag-region className="flex flex-col justify-center min-w-[64px]">
                    <RecTimer time={formatTime(elapsedTime)} paused={isPaused} />
                    <span data-tauri-drag-region className="pl-[18px] font-mono text-[10px] leading-tight text-white/45 select-none">
                        {isPaused ? (
                            <span className="text-amber-300/80">paused</span>
                        ) : captureStatus === 'lost' ? (
                            <span className="text-amber-300/90" title="The screen capture stopped and is being restarted - your audio is still recording">
                                reconnecting
                            </span>
                        ) : captureStatus === 'recovered' ? (
                            <span className="text-emerald-300/90" title="The screen capture was restarted - nothing recorded was lost">
                                recovered
                            </span>
                        ) : droppedFrames > 0 ? (
                            <span className="text-amber-300/90" title="Frames dropped during capture - the encoder may be falling behind">
                                {droppedFrames} dropped
                            </span>
                        ) : captureFps !== null ? (
                            `${Math.round(captureFps)} fps`
                        ) : (
                            "recording"
                        )}
                    </span>
                </div>

                <div className="flex items-center gap-1.5">
                    {pauseButton}
                    {stopButton}
                </div>

                <span className="w-px h-6 bg-white/15" />

                {canSwitchView ? (
                    // Interactive - which one is "live" as the main view right now. See
                    // handleSwitchView's own doc comment for what a click here does.
                    <div className="flex items-center p-0.5 rounded-full bg-white/10" title="Switch the main view between screen and camera">
                        {(["screen", "camera"] as const).map((mode) => (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => handleSwitchView(mode)}
                                className={`h-7 w-7 flex items-center justify-center rounded-full transition ${viewMode === mode ? "bg-white text-neutral-900" : "text-white/60 hover:text-white"}`}
                                title={mode === "screen" ? "Show screen as the main view" : "Show camera as the main view"}
                            >
                                {mode === "screen" ? <IoScanSharp size={14} /> : <IoVideocam size={14} />}
                            </button>
                        ))}
                    </div>
                ) : (
                    <SourceIcons recordType={recordType} />
                )}

                <button type="button" onClick={toggleMinimize} title="Minimize" className={`${ICON_BUTTON_CLASS} text-white/60 hover:text-white hover:bg-white/10`}>
                    <IoContractOutline size={15} />
                </button>
            </div>
        </div>
    );
}

export default RecordingOverlayWindow;