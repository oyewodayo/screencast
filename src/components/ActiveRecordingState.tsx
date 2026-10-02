import React, { useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp} from 'react-icons/io';
import { IoCameraOutline, IoMicCircle, IoPauseCircle, IoPlayCircle, IoRadioButtonOn, IoScanSharp, IoVideocam, IoFolder, IoFolderOpen, IoHomeOutline, IoSettingsOutline, IoDocumentAttachOutline, IoImagesOutline, IoDocumentTextOutline, IoGitNetworkOutline, IoMapOutline, IoCutOutline } from 'react-icons/io5'

export type RecordSource = "screen" | "video" | "audio";

// Which of the three capture sources each backend-supported record_type is made of (see
// start_recording's match on form_data.record_type in src-tauri/src/commands/recording.rs -
// "sva"/"sa"/"va"/"s"/"v"/"a" are the only values it actually handles). Shared with
// BottomDocker.tsx so the shortcut-icon toggles below and the docker's own toggle logic agree
// on the same mapping.
export const SOURCE_FLAGS: Record<string, { screen: boolean; video: boolean; audio: boolean }> = {
    sva: { screen: true, video: true, audio: true },
    sa: { screen: true, video: false, audio: true },
    va: { screen: false, video: true, audio: true },
    s: { screen: true, video: false, audio: false },
    v: { screen: false, video: true, audio: false },
    a: { screen: false, video: false, audio: true },
};

// Human-readable label for each record_type, including "c" (screenshot) which SOURCE_FLAGS
// doesn't cover since it isn't a screen/webcam/mic combination. Used anywhere the currently
// selected recording option needs to be shown back to the user (e.g. EnhancedScreenOptions'
// "Screen Options" modal, opened from the shortcut icons below with no other indication of
// which sources were armed).
export const RECORD_TYPE_LABELS: Record<string, string> = {
    sva: "Screen + Video + Audio",
    sa: "Screen + Audio",
    va: "Video + Audio",
    s: "Screen only",
    v: "Video only",
    a: "Audio only",
    c: "Screenshot",
};

interface Props {
    recordType: string;
    isRecording:boolean;
    recordingStartTime: number | null;
    handleFolderSettings:()=>void;
    handleGoHome:()=>void;
    isHome:boolean;
    handleOpenBoard:()=>void;
    isBoard:boolean;
    handleOpenDocs:()=>void;
    isDocs:boolean;
    handleOpenWhiteboard:()=>void;
    isWhiteboard:boolean;
    handleOpenMindmap:()=>void;
    isMindmap:boolean;
    handleOpenVideoEditor:()=>void;
    isVideoEditor:boolean;
    handleOpenSettings:()=>void;
    handleOpenExternalFile:()=>void;
    handleStopRecording: () => void;
    // Pause/resume timing model - see Dashboard.tsx's own doc comment on these three fields for
    // the elapsed-time formula they feed into below.
    isPaused: boolean;
    pauseStartedAt: number | null;
    pausedAccumulatedMs: number;
    handlePauseRecording: () => void;
    handleResumeRecording: () => void;
    showDocker:boolean;
    setShowDocker:React.Dispatch<React.SetStateAction<boolean>>;
    showFileList?: boolean;
    // Lets the scan/videocam/mic icons act as shortcuts even when the full recording panel
    // (RecordingDocker) is hidden via Settings - toggling which capture sources are armed, and
    // kicking off the same start-recording flow its "Start Recording" button used to be the only
    // way to reach.
    onToggleRecordSource?: (source: RecordSource) => void;
    onStartRecordingClick?: () => void;
    // Same idea as onStartRecordingClick, but for RecordingDocker's other button - a screenshot
    // is a standalone one-shot action, not part of the screen/webcam/mic toggle combo above.
    onScreenshotClick?: () => void;
    // Hides the screenshot/screen-webcam-mic/record-button cluster entirely (Ctrl+Shift+B, see
    // Dashboard.tsx's PANEL_BUTTONS_TOGGLE_SHORTCUT) - for hiding Briefcast's own controls right
    // before presenting/recording a screen that includes this window, so they don't end up baked
    // into the video.
    showRecordingPanelButtons: boolean;
    // Live Screen <-> Camera cutting while recording (Alt+Shift+V) - see Dashboard's switchView.
    canSwitchView?: boolean;
    viewMode?: 'screen' | 'camera';
    onSwitchView?: (mode: 'screen' | 'camera') => void;
}
const ActiveRecordingState = (
    {
        recordType,isRecording,recordingStartTime,handleFolderSettings,handleGoHome,isHome,handleOpenBoard,isBoard,handleOpenDocs,isDocs,handleOpenWhiteboard,isWhiteboard,handleOpenMindmap,isMindmap,handleOpenVideoEditor,isVideoEditor,handleOpenSettings,handleOpenExternalFile,handleStopRecording,isPaused,pauseStartedAt,pausedAccumulatedMs,handlePauseRecording,handleResumeRecording,showDocker,setShowDocker,showFileList,onToggleRecordSource,onStartRecordingClick,onScreenshotClick,showRecordingPanelButtons,canSwitchView,viewMode,onSwitchView

    }:Props) => {
    const [elapsedTime, setElapsedTime] = useState<number>(0);


    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    };

    const closeDocker =()=>{
       setShowDocker(false)
    }

    const openDocker =()=>{
        setShowDocker(true)
     }
    // Derive elapsed time from the shared start timestamp (rather than accumulating +1 per
    // tick) so this window's timer can't drift apart from the recording-overlay window's. While
    // paused, "now" is pinned to the moment the pause began (pauseStartedAt) instead of the real
    // clock, and pausedAccumulatedMs subtracts out every millisecond already spent paused before
    // that - together these freeze the display during a pause and pick up again, uninterrupted,
    // wherever it left off on resume, rather than counting the paused span as part of the video.
    useEffect(() => {
        let interval: number | undefined;
        if (isRecording && recordingStartTime) {
        const tick = () => {
            const effectiveNow = isPaused && pauseStartedAt ? pauseStartedAt : Date.now();
            setElapsedTime(Math.floor((effectiveNow - recordingStartTime - pausedAccumulatedMs) / 1000));
        };
        tick();
        if (!isPaused) {
            interval = window.setInterval(tick, 1000);
        }
        } else {
        setElapsedTime(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, recordingStartTime, isPaused, pauseStartedAt, pausedAccumulatedMs]);


    // Shared look for every icon button in the bar - compact padded hit-area, neutral icon that
    // darkens on hover, and a tinted "you are here" state for the active view.
    const iconButtonClass = (active = false) =>
        `cursor-pointer p-1.5 rounded-md text-base transition-all duration-150 active:scale-90 outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 ${
            active
                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25"
                : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        }`;

    return (
        // This bar floats over whatever the video player is showing (a `fixed bottom-0`
        // overlay), so it can't rely on the page's own background for contrast. It used to use a
        // gradient scrim with white icons for that; it now has a flat, near-opaque background
        // matching the footer below it, with neutral icons, so it's legible over a bright or
        // dark video frame alike without any shadow above it.
        <div className="bg-neutral-50/95 dark:bg-neutral-900/95 backdrop-blur-sm border-t border-neutral-200 dark:border-neutral-800">
            <div className='flex justify-between px-2 py-1 items-center align-middle' data-tauri-drag-region>
                <div className="flex items-center gap-0.5">
                    <button
                    type="button"
                    className={iconButtonClass()}
                    onClick={() => handleFolderSettings()}
                    title="Toggle file list"
                    >
                      {showFileList ? <IoFolderOpen /> : <IoFolder />}
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass()}
                    onClick={() => handleOpenExternalFile()}
                    title="Open file from anywhere"
                    >
                      <IoDocumentAttachOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isBoard)}
                    onClick={() => handleOpenBoard()}
                    title="Board"
                    >
                      <IoImagesOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isDocs)}
                    onClick={() => handleOpenDocs()}
                    title="Docs"
                    >
                      <IoDocumentTextOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isWhiteboard)}
                    onClick={() => handleOpenWhiteboard()}
                    title="Whiteboard"
                    >
                      <IoGitNetworkOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isMindmap)}
                    onClick={() => handleOpenMindmap()}
                    title="Mindmap"
                    >
                      <IoMapOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isVideoEditor)}
                    onClick={() => handleOpenVideoEditor()}
                    title="Video editor"
                    >
                      <IoCutOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass()}
                    onClick={() => handleOpenSettings()}
                    title="Settings"
                    >
                      <IoSettingsOutline />
                    </button>
                    <button
                    type="button"
                    className={iconButtonClass(isHome)}
                    onClick={() => handleGoHome()}
                    title="Home"
                    >
                      <IoHomeOutline />
                    </button>
                </div>
                <div className='flex items-center'>

                    {/* The recording-in-progress case used to swap this whole panel out for a
                        separate "Stop / elapsed time / active-source icons" panel - now redundant
                        with the draggable overlay window (RecordingOverlayWindow.tsx), which
                        already shows the timer and a Stop button. So this panel stays exactly as
                        it is during recording (sources shown but not toggleable, since recordType
                        can't change mid-recording) and only the record button itself changes: red
                        "start" -> pulsing green "recording, click to stop". Hideable on its own
                        (Ctrl+Shift+B) for presenting/recording a screen that includes this
                        window - see appSettings.ts's showRecordingPanelButtons doc comment. */}
                    {showRecordingPanelButtons && (
                    <div className="px-2 flex items-center gap-0.5">
                        <button
                            type="button"
                            title="Take a screenshot"
                            onClick={() => onScreenshotClick?.()}
                            disabled={isRecording}
                            className={
                                isRecording
                                    ? "p-1.5 rounded-md text-base outline-none text-neutral-300 dark:text-neutral-600 cursor-not-allowed"
                                    : iconButtonClass()
                            }
                        >
                            <IoCameraOutline />
                        </button>
                        <div className="w-px h-4 mx-1 bg-neutral-300 dark:bg-white/20" />
                        {(() => {
                            const flags = SOURCE_FLAGS[recordType] ?? { screen: false, video: false, audio: false };
                            const sourceButtonClass = (active: boolean) =>
                                `p-1.5 rounded-md text-base transition-all duration-150 outline-none ${
                                    isRecording ? "cursor-default" : "cursor-pointer active:scale-90"
                                } ${
                                    active
                                        ? "text-green-600 dark:text-green-400 bg-green-500/10 hover:bg-green-500/20"
                                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white hover:bg-neutral-200 dark:hover:bg-white/10"
                                }`;
                            return (
                                <>
                                    <button
                                        type="button"
                                        title="Toggle screen capture"
                                        onClick={() => !isRecording && onToggleRecordSource?.("screen")}
                                        className={sourceButtonClass(flags.screen)}
                                    >
                                        <IoScanSharp />
                                    </button>
                                    <button
                                        type="button"
                                        title="Toggle webcam"
                                        onClick={() => !isRecording && onToggleRecordSource?.("video")}
                                        className={sourceButtonClass(flags.video)}
                                    >
                                        <IoVideocam />
                                    </button>
                                    <button
                                        type="button"
                                        title="Toggle microphone"
                                        onClick={() => !isRecording && onToggleRecordSource?.("audio")}
                                        className={sourceButtonClass(flags.audio)}
                                    >
                                        <IoMicCircle />
                                    </button>
                                </>
                            );
                        })()}
                        {isRecording && canSwitchView && (
                            // Which view is live as the main picture right now - a cut is logged
                            // at this moment and applied by the editor and export.
                            <div
                                className="ml-2 flex p-0.5 gap-0.5 rounded-lg bg-neutral-200/70 dark:bg-white/10"
                                title="Switch the main view (Alt+Shift+V)"
                            >
                                {(['screen', 'camera'] as const).map((m) => (
                                    <button
                                        key={m}
                                        type="button"
                                        onClick={() => onSwitchView?.(m)}
                                        className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all ${
                                            viewMode === m
                                                ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                                                : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-white"
                                        }`}
                                    >
                                        {m === 'screen' ? <IoScanSharp /> : <IoVideocam />}
                                        {m === 'screen' ? 'Screen' : 'Camera'}
                                    </button>
                                ))}
                            </div>
                        )}
                        {isRecording && (
                            <div className={`ml-1 text-xs font-mono ${isPaused ? "text-amber-500" : "text-neutral-700 dark:text-white"}`}>
                                {formatTime(elapsedTime)}{isPaused ? " (paused)" : ""}
                            </div>
                        )}
                        {isRecording && (
                            <button
                                type="button"
                                title={isPaused ? "Resume recording" : "Pause recording"}
                                onClick={isPaused ? handleResumeRecording : handlePauseRecording}
                                className={`ml-1 ${iconButtonClass()}`}
                            >
                                {isPaused ? <IoPlayCircle /> : <IoPauseCircle />}
                            </button>
                        )}
                        <button
                            type="button"
                            title={isRecording ? "Stop recording" : "Start recording"}
                            onClick={isRecording ? handleStopRecording : onStartRecordingClick}
                            className={`cursor-pointer ml-1 p-1.5 rounded-full text-sm text-white active:scale-90 transition-all duration-150 outline-none ${
                                !isRecording
                                    ? "bg-red-500 hover:bg-red-400"
                                    : isPaused
                                    ? "bg-amber-500 hover:bg-amber-400"
                                    : "bg-green-500 hover:bg-green-400 animate-pulse"
                            }`}
                        >
                            <IoRadioButtonOn />
                        </button>
                    </div>
                    )}

                    <div className='flex justify-end pl-1'>
                    <button
                        type="button"
                        onClick={showDocker ? closeDocker : openDocker}
                        title={showDocker ? "Hide panel" : "Show panel"}
                        className={iconButtonClass()}
                    >
                        {showDocker ? <IoIosArrowDown /> : <IoIosArrowUp />}
                    </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default ActiveRecordingState
