import { useState } from "react";
import { IoClose, IoDesktop, IoScanOutline } from "react-icons/io5";

interface AddModalProps{
    overlayPosition:string,
    overlayShape:string,
    overlaySize:string,
    setOverlayPosition:React.Dispatch<React.SetStateAction<string>>;
    setOverlayShape:React.Dispatch<React.SetStateAction<string>>;
    setOverlaySize:React.Dispatch<React.SetStateAction<string>>;
    isOpenScreen:boolean,
    onCloseScreen:()=>void,
    onStartRecording:()=>void,
    setOpen:React.Dispatch<React.SetStateAction<boolean>>,
}



const ScreenOptions = ({overlayPosition, overlayShape, overlaySize,setOverlayPosition, setOverlayShape, setOverlaySize, isOpenScreen, onCloseScreen,onStartRecording, setOpen}:AddModalProps) => {
  
    const closeModal =()=>{
        setOpen(false);
        onCloseScreen()
    }
    interface CustomChangeEvent {
        target: {
            value: string; // or number, or whatever type you expect
        };
    }

    const onChangeOverlayShape = ({target:{value}}:CustomChangeEvent)=>{
        setOverlayShape(value)
        console.log(value)
    }
    const onChangeOverlayPosition = ({target:{value}}:CustomChangeEvent)=>{
        setOverlayPosition(value)
        console.log(value)
    }
    const onChangeOverlaySize = ({target:{value}}:CustomChangeEvent)=>{
        setOverlaySize(value)
        console.log(value)
    }

    const isCheckedPosition = (value:string)=>value===overlayPosition;
    const isCheckedSize = (value:string)=>value===overlaySize;
    const isCheckedShape = (value:string)=>value===overlayShape;
    
    return (
        <div key={"screen-options"} className={`w-screen h-screen mb-10 place-items-center fixed -top-20 left-0 z-50 ${isOpenScreen?'grid':'hidden'}`}>
            <div className={`w-full h-full bg-white opacity-70 absolute left-0 z-20`}
            onClick={closeModal}
            > </div>
            <div className="md:w-[50vw] h-[50%] bg-white rounded-b-lg border shadow-md z-50 flex flex-col gap-3 mb-28">
                    
                    <div className="w-full flex justify-between  items-center">
                        <div className="flex">
                            <div className=" px-2 py-1 text-sm border-b-2 border-b-black flex items-center">
                                <IoDesktop/> &nbsp; Screen options

                            </div>
                        
                            <select name="" id="">
                                <option value="">Full screen</option>
                            </select>
                        </div>
                        <button onClick={closeModal}><IoClose className="hover:bg-red-600 p-1 hover:text-white text-3xl"/></button>
                    </div>
                    <div className="w-full overflow-y-auto">
                        <div className="font-semibold px-5">Screen</div> 
                        <div className="grid lg:grid-cols-4 md:grid-cols-3 sm:grid-cols-2 grid-cols-2 items-center align-middle my-5 px-5 gap-10 ">
                            <button className="text-center flex flex-col items-center text-green-400 hover:text-green-300">
                                <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl "/>
                                Fullscreen
                            </button>
                            <button className="text-center flex flex-col items-center hover:text-green-300">
                                <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl "/>
                                Custom
                            </button>
                            <button className="text-center flex flex-col items-center hover:text-green-300">
                                <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl "/>
                                <div> Last screen</div>
                            </button>
                            <button className="text-center flex flex-col items-center hover:text-green-300">
                                <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl"/>
                                <span className=""> Select screen</span>                           
                            </button>                    
                        
                        </div>
                        <hr />
                        <div className="px-10 py-5 mb-10">
                            <div className="font-semibold">Video overlay</div> 
                            <div className="">Overlay shape</div>
                            <div className="grid grid-cols-3 items-center align-middle gap-3 py-5">
                                   
                                    <input type="radio" checked={isCheckedShape("rounded")} name="overlay_shape" value="rounded" onChange={onChangeOverlayShape}  hidden id="overlay_rounded" />
                                    <label htmlFor="overlay_rounded" className={`${overlayShape==="rounded"?"bg-green-400 active:bg-green-400":"bg-slate-200"}  rounded h-[100px] w-[100px] cursor-pointer  hover:bg-green-300 checked:bg-green-400`}> </label>
                               
                               
                                    <input type="radio" checked={isCheckedShape("circle")} name="overlay_shape" value="circle" onChange={onChangeOverlayShape} hidden id="overlay_circle" />
                                    <label htmlFor="overlay_circle" className={`${overlayShape==="circle"?"bg-green-400 active:bg-green-400":"bg-slate-200"} rounded-full h-[100px] w-[100px] cursor-pointer  hover:bg-green-300 checked:bg-green-400`}> </label>
                              
                               
                                    <input type="radio" checked={isCheckedShape("square")} name="overlay_shape" value="square" onChange={onChangeOverlayShape} hidden id="overlay_square" />
                                    <label htmlFor="overlay_square" className={`${overlayShape==="square"?"bg-green-400 active:bg-green-400":"bg-slate-200"} h-[100px] w-[100px] cursor-pointer  hover:bg-green-300 checked:bg-green-400`}> </label>
                                
                            </div>
                            <div className="pt-5">Overlay position</div>
                            <div className="gap-3 align-middle grid grid-cols-3 items-center py-5">
                                <div >
                                    <label htmlFor="bottom_left" className="cursor-pointer hover:text-green-300"> Bottom Left </label>
                                    <input id="bottom_left" type="radio" checked={isCheckedPosition("bottom_left")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_left" className="align-middle cursor-pointer "/> 
                                </div>
                                <div>
                                    <label htmlFor="bottom_middle" className="cursor-pointer hover:text-green-300"> Bottom Middle </label>
                                    <input id="bottom_middle" type="radio" checked={isCheckedPosition("bottom_middle")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_middle" className="align-middle cursor-pointer"/> 
                                </div>
                                <div className="items-center align-middle">
                                    <label htmlFor="bottom_right" className="cursor-pointer align-middle hover:text-green-300"> Bottom Right  </label>
                                    <input id="bottom_right" type="radio" checked={isCheckedPosition("bottom_right")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_right" className="align-middle cursor-pointer"/> 
                                </div>
                            </div>
                            <div className="pt-5">Overlay size</div>
                            <div className="gap-3 align-middle grid grid-cols-2 md:grid-cols-2 items-center py-5">
                                <div className="" >
                                    <label htmlFor="small" className="cursor-pointer hover:text-green-300"> Small(340x240) </label>
                                    <input id="small" name="overlay_size" type="radio" checked={isCheckedSize("small")} onChange={onChangeOverlaySize}  value="small" className="align-middle cursor-pointer text-green-400 checked:text-green-300"/> 
                                </div>
                                <div className="flex">
                                    <label htmlFor="medium" className="cursor-pointer hover:text-green-300">  Medium(720x540) &nbsp; </label>
                                    <input id="medium" name="overlay_size" type="radio" checked={isCheckedSize("medium")} onChange={onChangeOverlaySize}  value="medium" className="align-middle cursor-pointer"/> 
                                </div>
                               
                            </div>
                        </div>
                    </div>

                    <div className="bottom-0 flex justify-end items-end text-right">
                        <button className="bg-black py-2 px-5 text-white rounded-br-md" onClick={onStartRecording} >Start now</button>
                    </div>
               
            </div>
        </div>
  )
}

export default ScreenOptions