import React, { useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp} from 'react-icons/io';
import { IoClose, IoMicCircle, IoOpenSharp, IoScanSharp, IoStopSharp, IoVideocam, IoVideocamSharp, IoFolder, IoFolderOpen, IoHomeOutline, IoSettingsOutline, IoDocumentAttachOutline } from 'react-icons/io5'

interface Props {
    recordType: string;
    isRecording:boolean;
    recordingStartTime: number | null;
    handleFolderSettings:()=>void;
    handleGoHome:()=>void;
    handleOpenSettings:()=>void;
    handleOpenExternalFile:()=>void;
    handleVideoOverlayAction: ()=>void;
    handleStopRecording: () => void;
    showDocker:boolean;
    setShowDocker:React.Dispatch<React.SetStateAction<boolean>>;
    showFileList?: boolean;
}
const ActiveRecordingState = (
    {
        recordType,isRecording,recordingStartTime,handleFolderSettings,handleGoHome,handleOpenSettings,handleOpenExternalFile, handleVideoOverlayAction,handleStopRecording,showDocker,setShowDocker,showFileList

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
        <div className="bg-gradient-to-t from-black/30 via-black/20 to-transparent pt-5">
            <div className='mx-2 h-4' data-tauri-drag-region />
            <div className='flex justify-between pl-2 pb-2 items-center align-middle'>
                <div className="flex items-center">
                   {showFileList ? (
                        <IoFolderOpen
                        className="cursor-pointer mr-4 text-white text-xl"
                        onClick={() => handleFolderSettings()}
                        title="Toggle file list"
                        />
                    ) : (
                        <IoFolder
                        className="cursor-pointer mr-4 text-white text-xl"
                        onClick={() => handleFolderSettings()}
                        title="Toggle file list"
                        />
                    )}
                    <IoDocumentAttachOutline
                    className="cursor-pointer mr-4 text-white text-xl"
                    onClick={() => handleOpenExternalFile()}
                    title="Open file from anywhere"
                    />
                    <IoHomeOutline
                    className="cursor-pointer mr-4 text-white text-xl"
                    onClick={() => handleGoHome()}
                    title="Home"
                    />
                    <IoSettingsOutline
                    className="cursor-pointer mr-4 text-white text-xl"
                    onClick={() => handleOpenSettings()}
                    title="Settings"
                    />
                </div>
                <div className='flex items-center'>

                    {/* { !showDocker && <button className='bg-black rounded p-0.5'><IoPlay title='Start recording' className='text-white' /></button>} */}

                    {isRecording? (
                    <div className="bg-black rounded text-[#F5F7FA] text-ms py-2 px-3 flex justify-between align-middle">
                        <div className="flex ">
                            <button className="flex" onClick={handleStopRecording}><IoStopSharp className="rounded-md text-2xl cursor-pointer" /> Stop &nbsp;&nbsp; </button>
                            <div className='mr-3'> {formatTime(elapsedTime)}</div>
                        </div>

                        <div className='flex align-middle items-center pl-4'>
                         
                            {recordType == "sva" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp                                         
                                className={
                                    isRecording ? `text-green-500 cursor-pointer ` : ``
                                }
                                />
                                <IoVideocam
                                onClick={handleVideoOverlayAction}    
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                                <IoMicCircle className={isRecording ? `text-green-500 cursor-pointer` : ``} />
                            </div>
                            )}
                            {recordType == "sa" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                                <IoMicCircle className={isRecording ? `text-green` : ``} />
                            </div>
                            )}
                            {recordType == "va" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoVideocamSharp
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                                <IoMicCircle className={isRecording ? `text-green-500` : ``} />
                            </div>
                            )}
                            {recordType == "s" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                            </div>
                            )}
                            {recordType == "v" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoVideocamSharp
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                            </div>
                            )}
                            {recordType == "a" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoMicCircle
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                            </div>
                            )}
                            {recordType == "c" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp
                                className={
                                    isRecording ? `text-green-500 cursor-pointer` : ``
                                }
                                />
                            </div>
                            )}
                         
                            {isRecording ?<IoOpenSharp className=" text-2xl"/>:<IoClose className=" text-2xl"/>}
                        </div>
                    </div>
                    ):(
                        <div className="px-4 ">
                            {recordType == "sva" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp className="text-white" />
                                <IoVideocam className="text-white" />
                                <IoMicCircle className="text-white" />
                            </div>
                            )}
                            {recordType == "sa" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp className="text-white" />
                                <IoMicCircle className="text-white" />
                            </div>
                            )}
                            {recordType == "va" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoVideocamSharp className="text-white" />
                                <IoMicCircle className="text-white" />
                            </div>
                            )}
                            {recordType == "s" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp className="text-white" />
                            </div>
                            )}
                            {recordType == "v" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoVideocamSharp className="text-white" />
                            </div>
                            )}
                            {recordType == "a" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoMicCircle className="text-white" />
                            </div>
                            )}
                            {recordType == "c" && (
                            <div className="w-full flex flex-row gap-3 text-right">
                                <IoScanSharp className="text-white" />
                            </div>
                            )}
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