// RecordingOverlayWindow.tsx - This should be a separate component/page
import { useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp} from 'react-icons/io';
import { IoMicCircle, IoScanSharp, IoStopSharp, IoVideocam } from 'react-icons/io5'
import { appWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/tauri';

const RecordingOverlayWindow = () => {
    const [elapsedTime, setElapsedTime] = useState<number>(0);
    const [isMinimized, setIsMinimized] = useState<boolean>(false);
    const [recordType, setRecordType] = useState<string>("sva");
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [startTime, setStartTime] = useState<number | null>(null);

    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    };

    const toggleMinimize = () => {
        setIsMinimized(!isMinimized);
    };

    const handleStopRecording = async () => {
        try {
            await invoke("stop_recording");
            
            // Emit event to main window to update its state
            const { emit } = await import('@tauri-apps/api/event');
            await emit('recording-stopped');
            
            // Hide this overlay window after stopping
            await appWindow.hide();
        } catch (error) {
            console.error("Error stopping recording:", error);
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
            }>('recording-state-update', (event) => {
                setIsRecording(event.payload.isRecording);
                setRecordType(event.payload.recordType);
                setStartTime(event.payload.startTime);
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
    // ActiveRecordingState.tsx) so this window's timer can't drift apart from the main window's.
    useEffect(() => {
        let interval: number | undefined;
        if (isRecording && startTime) {
            const tick = () => setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
            tick();
            interval = window.setInterval(tick, 1000);
        } else {
            setElapsedTime(0);
        }
        return () => clearInterval(interval);
    }, [isRecording, startTime]);

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
                        
                        <span className="text-xs font-mono">{formatTime(elapsedTime)}</span>
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
        <div className="w-full h-full flex flex-col bg-white/95 backdrop-blur-sm rounded-lg">
            {/* Draggable header */}
            <div 
                data-tauri-drag-region
                className="bg-gray-800 rounded-t-lg px-3 py-2 cursor-move flex justify-between items-center"
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
                        <div className="flex gap-2">
                            <button
                                className="flex items-center gap-1 hover:text-gray-300" 
                                onClick={handleStopRecording}
                                title="Stop recording"
                            >
                                <IoStopSharp className="text-lg" /> 
                            </button>
                            <div className='font-mono text-sm ml-2'>{formatTime(elapsedTime)}</div>
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