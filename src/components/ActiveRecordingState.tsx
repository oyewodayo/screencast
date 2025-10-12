import React, { MouseEventHandler, useEffect, useState } from 'react'
import { IoIosArrowDown, IoIosArrowUp, IoIosPlayCircle } from 'react-icons/io';
import { IoAirplane, IoArrowDown, IoClose, IoMicCircle, IoOpenSharp, IoPause, IoPlay, IoPlayForward, IoScanSharp, IoSettingsSharp, IoSparklesOutline, IoStopSharp, IoVideocam, IoVideocamSharp, IoFolder, IoFolderOpen } from 'react-icons/io5'

interface Props {
    recordType: string;
    isRecording:boolean;
    res_message:string;
    error:string;
    openModalSettings:()=>void;
    handleFolderSettings:()=>void;
    handleVideoOverlayAction: ()=>void;
    handleStopRecording: () => void;
    showDocker:boolean;
    setShowDocker:React.Dispatch<React.SetStateAction<boolean>>;
    showFileList?: boolean;
}
const ActiveRecordingState = (
    {
        recordType,isRecording,res_message,error,openModalSettings,handleFolderSettings, handleVideoOverlayAction,handleStopRecording,showDocker,setShowDocker,showFileList

    }:Props) => {
    const [elapsedTime, setElapsedTime] = useState<number>(0);
    const [showFolderOpen, setShowFolderOpen] = useState(false);
const [isFolderOpen, setIsFolderOpen] = useState(false);

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
    useEffect(() => {
        let interval: number | undefined;
        if (isRecording) {
        interval = window.setInterval(() => {
            setElapsedTime((prevTime) => prevTime + 1);
        }, 1000);
        } else {
        setElapsedTime(0);
        }
        return () => clearInterval(interval);
    }, [isRecording]);


    return (
        <>
            <div className='mx-2'>
                {res_message && <p className="message text-right">{res_message}</p>}
                {error && <p className="error text-right">{error}</p>}
            </div>
            <div className='flex justify-between pl-2 pb-2 items-center align-middle'>
                <div className="flex">
                   {showFileList ? (
                        <IoFolderOpen
                        className="cursor-pointer mr-4"
                        onClick={() => handleFolderSettings()}
                        />
                    ) : (
                        <IoFolder
                        className="cursor-pointer mr-4"
                        onClick={() => handleFolderSettings()}
                        />
                    )}


                    <IoSettingsSharp
                        onClick={()=>openModalSettings()}
                        className="cursor-pointer"
                    />
                </div>
                <div className='flex items-center'>

                    {/* { !showDocker && <button className='bg-black rounded p-0.5'><IoPlay title='Start recording' className='text-white' /></button>} */}

                    {isRecording? (
                    <div className="bg-black rounded text-[#F5F7FA] text-ms py-2 px-3 flex justify-between align-middle">              
                        <div className="flex ">
                            <div>
                                {isRecording?
                                    (<button className="flex"><IoPause className="rounded-md text-2xl cursor-pointer"/> Pause &nbsp;&nbsp;</button>):
                                    (<button className="flex"><IoPlay className="rounded-md text-2xl cursor-pointer"/> Play &nbsp;&nbsp;</button>) }
                            </div>
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
                                <IoScanSharp 
                                    
                                className={
                                    isRecording ? `text-green-500 cursor-pointer ` : ``
                                }
                                />
                                <IoVideocam  
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
                                <IoMicCircle className={isRecording ? `text-green` : ``} />
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
                        </div>
                    )}

                    <div className='flex justify-end pl-2'>
                    { showDocker ?
                    (<button onClick={closeDocker}><IoIosArrowDown/></button>):
                    (<button onClick={openDocker}><IoIosArrowUp/></button>)
                    }
                    </div>
                </div>
            </div>
        </>
    )
}

export default ActiveRecordingState