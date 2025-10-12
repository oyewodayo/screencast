import { IoClose } from "react-icons/io5";

interface AddModalProps{
    isOpenSettings:boolean,
    onCloseSettings:()=>void,
    setOpen:React.Dispatch<React.SetStateAction<boolean>>;
}


const SettingsModal = ({isOpenSettings, onCloseSettings, setOpen}:AddModalProps) => {
    
    const closeModal =()=>{
        setOpen(false);
        onCloseSettings()
    }

    return (
        <div key={"settings-option"} className={`w-screen h-screen place-items-center fixed top-0 left-0 ${isOpenSettings?'grid':'hidden'}`}>
            <div className={`w-full h-full bg-white opacity-70 absolute left-0 z-20`}
            onClick={closeModal}
            > </div>
            <div className="md:w-[30vw] h-[60%] bg-white rounded-lg border shadow-md z-50 flex flex-col items-center gap-3 mb-28">
                
                <div className="w-full flex justify-between items-center">
                    <div className=" px-2 py-1 text-sm border-b-2 border-b-black">Settings</div>
                    <button onClick={closeModal}><IoClose className="bg-red-600 p-1 text-white text-3xl"/></button>
                </div>
                <div className="w-full h-full flex flex-col justify-center items-center gap-3">
                    <div className="w-11/12 h-16 border rounded flex flex-col justify-center px-3">
                        <div className="text-sm font-semibold">Audio Notification</div>
                        <div className="text-xs text-gray-500">Play sound on start and stop recording</div>
                    </div>
                    <div className="w-11/12 h-16 border rounded flex flex-col justify-center px-3">
                        <div className="text-sm font-semibold">Recording Format</div>
                        <div className="text-xs text-gray-500">Select the format for your recordings (e.g., MP4, AVI)</div>
                    </div>
                    <div className="w-11/12 h-16 border rounded flex flex-col justify-center px-3">
                        <div className="text-sm font-semibold">Video Quality</div>
                        <div className="text-xs text-gray-500">Choose the quality of the recorded video (e.g., 720p, 1080p)</div>
                    </div>
                    <div className="w-11/12 h-16 border rounded flex flex-col justify-center px-3">
                        <div className="text-sm font-semibold">Save Location</div>
                        <div className="text-xs text-gray-500">Set the default folder where recordings will be saved</div>
                    </div>
                    <div className="w-11/12 h-16 border rounded flex flex-col justify-center px-3">
                        <div className="text-sm font-semibold">Hotkeys</div>
                        <div className="text-xs text-gray-500">Configure keyboard shortcuts for starting and stopping recordings</div>
                    </div>
                </div>
                    
              
            </div>
        </div>
  )
}

export default SettingsModal