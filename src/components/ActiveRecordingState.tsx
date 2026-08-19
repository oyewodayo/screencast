import React, { useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp} from 'react-icons/io';
import { IoCameraOutline, IoMicCircle, IoRadioButtonOn, IoScanSharp, IoVideocam, IoFolder, IoFolderOpen, IoHomeOutline, IoSettingsOutline, IoDocumentAttachOutline, IoImagesOutline, IoDocumentTextOutline } from 'react-icons/io5'

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
    handleOpenSettings:()=>void;
    handleOpenExternalFile:()=>void;
    handleStopRecording: () => void;
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
}
const ActiveRecordingState = (
    {
        recordType,isRecording,recordingStartTime,handleFolderSettings,handleGoHome,isHome,handleOpenBoard,isBoard,handleOpenDocs,isDocs,handleOpenSettings,handleOpenExternalFile,handleStopRecording,showDocker,setShowDocker,showFileList,onToggleRecordSource,onStartRecordingClick,onScreenshotClick,showRecordingPanelButtons

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
    // tick) so this window's timer can't drift apart from the recording-overlay window's.
    useEffect(() => {
        let interval: number | undefined;
        if (isRecording && recordingStartTime) {
        const tick = () => setElapsedTime(Math.floor((Date.now() - recordingStartTime) / 1000));
        tick();
        interval = window.setInterval(tick, 1000);
        } else {
        setElapsedTime(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, recordingStartTime]);


    return (
        // This bar floats over whatever the video player is showing (a `fixed bottom-0`
        // overlay), so it can't rely on the page's own background for contrast - a dark or
        // black video behind it would make unstyled icons/text disappear entirely. The
        // gradient scrim guarantees legibility regardless of what's playing, same technique
        // the video player's own control bar uses (player.css .video-controls-container).
        <div className="bg-gradient-to-t from-black/20 via-black/10 to-transparent pt-3">
            <div className='mx-2 h-4' data-tauri-drag-region />
            <div className='flex justify-between pl-2 pb-2 items-center align-middle'>
                {/* Each icon gets its own padded hit-area that darkens on hover/focus so it
                    reads clearly regardless of what's playing behind this bar (light or dark
                    video frame, or the plain home screen) - a bare white icon with no feedback
                    was easy to miss/misclick against bright content. */}
                <div className="flex items-center">
                   {showFileList ? (
                        <button
                        type="button"
                        className="cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 hover:bg-black/40 active:bg-black/60 active:scale-90 focus-visible:bg-black/40 outline-none"
                        onClick={() => handleFolderSettings()}
                        title="Toggle file list"
                        >
                          <IoFolderOpen />
                        </button>
                    ) : (
                        <button
                        type="button"
                        className="cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 hover:bg-black/40 active:bg-black/60 active:scale-90 focus-visible:bg-black/40 outline-none"
                        onClick={() => handleFolderSettings()}
                        title="Toggle file list"
                        >
                          <IoFolder />
                        </button>
                    )}
                    <button
                    type="button"
                    className="cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 hover:bg-black/40 active:bg-black/60 active:scale-90 focus-visible:bg-black/40 outline-none"
                    onClick={() => handleOpenExternalFile()}
                    title="Open file from anywhere"
                    >
                      <IoDocumentAttachOutline />
                    </button>
                    <button
                    type="button"
                    className={`cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 active:scale-90 focus-visible:bg-black/40 outline-none ${
                      isBoard
                        ? "bg-blue-400/25 hover:bg-blue-400/35 active:bg-blue-400/45"
                        : "hover:bg-black/40 active:bg-black/60"
                    }`}
                    onClick={() => handleOpenBoard()}
                    title="Board"
                    >
                      <IoImagesOutline />
                    </button>
                    <button
                    type="button"
                    className={`cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 active:scale-90 focus-visible:bg-black/40 outline-none ${
                      isDocs
                        ? "bg-blue-400/25 hover:bg-blue-400/35 active:bg-blue-400/45"
                        : "hover:bg-black/40 active:bg-black/60"
                    }`}
                    onClick={() => handleOpenDocs()}
                    title="Docs"
                    >
                      <IoDocumentTextOutline />
                    </button>
                    <button
                    type="button"
                    className={`cursor-pointer mr-1 p-2 rounded-md text-white text-xl transition-all duration-150 active:scale-90 focus-visible:bg-black/40 outline-none ${
                      isHome
                        ? "bg-blue-400/25 hover:bg-blue-400/35 active:bg-blue-400/45"
                        : "hover:bg-black/40 active:bg-black/60"
                    }`}
                    onClick={() => handleGoHome()}
                    title="Home"
                    >
                      <IoHomeOutline />
                    </button>
                    <button
                    type="button"
                    className="cursor-pointer p-2 rounded-md text-white text-xl transition-all duration-150 hover:bg-black/40 active:bg-black/60 active:scale-90 focus-visible:bg-black/40 outline-none"
                    onClick={() => handleOpenSettings()}
                    title="Settings"
                    >
                      <IoSettingsOutline />
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
                    <div className="px-2 flex items-center gap-1">
                        <button
                            type="button"
                            title="Take a screenshot"
                            onClick={() => onScreenshotClick?.()}
                            disabled={isRecording}
                            className={`p-2 rounded-md text-xl transition-all duration-150 active:scale-90 outline-none ${
                                isRecording
                                    ? "text-white/30 cursor-not-allowed"
                                    : "cursor-pointer text-white/70 hover:text-white hover:bg-black/40"
                            }`}
                        >
                            <IoCameraOutline />
                        </button>
                        <div className="w-px self-stretch my-1 bg-white/20" />
                        {(() => {
                            const flags = SOURCE_FLAGS[recordType] ?? { screen: false, video: false, audio: false };
                            const sourceButtonClass = (active: boolean) =>
                                `p-2 rounded-md text-xl transition-all duration-150 outline-none ${
                                    isRecording ? "cursor-default" : "cursor-pointer active:scale-90"
                                } ${
                                    active
                                        ? "text-green-400 bg-green-400/10 hover:bg-green-400/20"
                                        : "text-white/70 hover:text-white hover:bg-black/40"
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
                        {isRecording && (
                            <div className="ml-1 text-white text-xs font-mono">{formatTime(elapsedTime)}</div>
                        )}
                        <button
                            type="button"
                            title={isRecording ? "Stop recording" : "Start recording"}
                            onClick={isRecording ? handleStopRecording : onStartRecordingClick}
                            className={`cursor-pointer ml-1 p-2 rounded-full text-white active:scale-90 transition-all duration-150 outline-none ${
                                isRecording ? "bg-green-500 hover:bg-green-400 animate-pulse" : "bg-red-500 hover:bg-red-400"
                            }`}
                        >
                            <IoRadioButtonOn />
                        </button>
                    </div>
                    )}

                    <div className='flex justify-end pl-2'>
                    { showDocker ?
                    (<button onClick={closeDocker}><IoIosArrowDown className="text-white text-xl" /></button>):
                    (<button onClick={openDocker}><IoIosArrowUp className="text-white text-xl" /></button>)
                    }
                    </div>
                </div>
            </div>
        </div>
    )
}

export default ActiveRecordingState