// RecordingOverlayWindow.tsx - This should be a separate component/page
import { useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp} from 'react-icons/io';
import { IoMicCircle, IoPauseCircle, IoPlayCircle, IoScanSharp, IoStopSharp, IoVideocam } from 'react-icons/io5'
import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';
import { message } from '@tauri-apps/api/dialog';

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

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    const toggleMinimize = () => {
        setIsMinimized(!isMinimized);
    };

    const handleStopRecording = async () => {
        // ffmpeg has already been asked to stop and torn down on the backend by the time
        // stop_recording rejects (e.g. the capture device disappeared mid-recording and no
        // output file was produced) - so the main window's state still needs resetting and
        // this overlay still needs to go away even on failure. Only the "tell the user what
        // happened" step differs between the two branches below.
        try {
            await invoke("stop_recording");
        } catch (error) {
            console.error("Error stopping recording:", error);
            await message(String(error), { title: 'Recording failed', type: 'error' });
        }

        const { emit } = await import('@tauri-apps/api/event');
        await emit('recording-stopped');
        await appWindow.hide();
    };

    const handlePauseRecording = async () => {
        try {
            await invoke("pause_recording");
            const now = Date.now();
            setIsPaused(true);
            setPauseStartedAt(now);
            const { emit } = await import('@tauri-apps/api/event');
            await emit('recording-pause-changed', { isPaused: true, pauseStartedAt: now, pausedAccumulatedMs });
        } catch (error) {
            console.error("Error pausing recording:", error);
            await message(String(error), { title: 'Failed to pause recording', type: 'error' });
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
            const { emit } = await import('@tauri-apps/api/event');
            await emit('recording-pause-changed', { isPaused: false, pauseStartedAt: null, pausedAccumulatedMs: newAccumulatedMs });
        } catch (error) {
            console.error("Error resuming recording:", error);
            await message(String(error), { title: 'Failed to resume recording', type: 'error' });
        }
    };

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
            }>('recording-state-update', (event) => {
                setIsRecording(event.payload.isRecording);
                setRecordType(event.payload.recordType);
                setStartTime(event.payload.startTime);
                setIsPaused(event.payload.isPaused ?? false);
                setPauseStartedAt(event.payload.pauseStartedAt ?? null);
                setPausedAccumulatedMs(event.payload.pausedAccumulatedMs ?? 0);
            });

            return () => {
                unlistenRecordingState();
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

    // Render minimized version
    if (isMinimized) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-black/90 rounded-lg">
                <div className="flex items-center gap-3 p-2">
                    <div className="flex items-center gap-2 text-white">
                        {recordType === "sva" && (
                            <>
                                <IoScanSharp className="text-green-500 text-base" />
                                <IoVideocam className="text-green-500 text-base" />
                                <IoMicCircle className="text-green-500 text-base" />
                            </>
                        )}
                        {recordType === "sa" && (
                            <>
                                <IoScanSharp className="text-green-500 text-base" />
                                <IoMicCircle className="text-green-500 text-base" />
                            </>
                        )}
                        {recordType === "va" && (
                            <>
                                <IoVideocam className="text-green-500 text-base" />
                                <IoMicCircle className="text-green-500 text-base" />
                            </>
                        )}
                        {recordType === "s" && <IoScanSharp className="text-green-500 text-base" />}
                        {recordType === "v" && <IoVideocam className="text-green-500 text-base" />}
                        {recordType === "a" && <IoMicCircle className="text-green-500 text-base" />}
                        {recordType === "c" && <IoScanSharp className="text-green-500 text-base" />}
                        
                        <span className={`text-xs font-mono ${isPaused ? "text-amber-400" : ""}`}>{formatTime(elapsedTime)}</span>
                    </div>
                    <button 
                        onClick={toggleMinimize}
                        className="text-white hover:text-gray-300"
                    >
                        <IoIosArrowUp className="text-lg" />
                    </button>
                </div>
            </div>
        );
    }

    // Render full overlay
    return (
        <div className="w-full h-full flex flex-col bg-white/95 dark:bg-neutral-900/95 backdrop-blur-sm rounded-lg">
            {/* Draggable header */}
            <div
                data-tauri-drag-region
                className="bg-gray-800 dark:bg-neutral-950 rounded-t-lg px-3 py-2 cursor-move flex justify-between items-center"
            >
                <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500"></div>
                    <span className="ml-2 text-xs font-medium text-white">Recording</span>
                </div>
                <button 
                    onClick={toggleMinimize}
                    className="text-white hover:text-gray-300"
                >
                    <IoIosArrowDown className="text-lg" />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 p-3 flex flex-col justify-center">
                {isRecording && (
                    <div className="bg-black rounded-lg text-white text-xs py-2 px-3 flex items-center justify-between gap-2">              
                        <div className="flex gap-2 items-center">
                            <button
                                className="flex items-center gap-1 hover:text-gray-300"
                                onClick={handleStopRecording}
                                title="Stop recording"
                            >
                                <IoStopSharp className="text-lg" />
                            </button>
                            <button
                                className="flex items-center gap-1 hover:text-gray-300"
                                onClick={isPaused ? handleResumeRecording : handlePauseRecording}
                                title={isPaused ? "Resume recording" : "Pause recording"}
                            >
                                {isPaused ? <IoPlayCircle className="text-lg" /> : <IoPauseCircle className="text-lg" />}
                            </button>
                            <div className={`font-mono text-sm ml-1 ${isPaused ? "text-amber-400" : ""}`}>
                                {formatTime(elapsedTime)}{isPaused ? " (paused)" : ""}
                            </div>
                        </div>

                        <div className='flex items-center gap-2 pl-2 border-l border-gray-600'>
                            {recordType === "sva" && (
                                <div className="flex gap-2">
                                    <IoScanSharp className="text-green-500 text-base" />
                                    <IoVideocam className="text-green-500 text-base" />
                                    <IoMicCircle className="text-green-500 text-base" />
                                </div>
                            )}
                            {recordType === "sa" && (
                                <div className="flex gap-2">
                                    <IoScanSharp className="text-green-500 text-base" />
                                    <IoMicCircle className="text-green-500 text-base" />
                                </div>
                            )}
                            {recordType === "va" && (
                                <div className="flex gap-2">
                                    <IoVideocam className="text-green-500 text-base" />
                                    <IoMicCircle className="text-green-500 text-base" />
                                </div>
                            )}
                            {recordType === "s" && <IoScanSharp className="text-green-500 text-base" />}
                            {recordType === "v" && <IoVideocam className="text-green-500 text-base" />}
                            {recordType === "a" && <IoMicCircle className="text-green-500 text-base" />}
                            {recordType === "c" && <IoScanSharp className="text-green-500 text-base" />}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default RecordingOverlayWindow;