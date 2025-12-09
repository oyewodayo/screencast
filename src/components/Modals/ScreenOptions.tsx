import { IoClose, IoDesktop, IoScanOutline } from "react-icons/io5";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { useEffect, useState } from "react";
import { WindowInfo } from "../../Types";

interface AddModalProps {
    selectScreen: boolean;
    setScreen: () => void;
    unSetScreen: () => void;
    selectedScreen: string;
    setSelectedScreen: React.Dispatch<React.SetStateAction<string>>;
    screenSize: string;
    setScreenSize: React.Dispatch<React.SetStateAction<string>>;
    windowTitles: WindowInfo[];
    overlayPosition: string;
    overlayShape: string;
    overlaySize: string;
    setOverlayPosition: React.Dispatch<React.SetStateAction<string>>;
    setOverlayShape: React.Dispatch<React.SetStateAction<string>>;
    setOverlaySize: React.Dispatch<React.SetStateAction<string>>;
    isOpenScreen: boolean;
    onCloseScreen: () => void;
    onStartRecording: () => void;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

interface WindowInfoWithUrl extends WindowInfo {
    imageUrl?: string;
}

const ScreenOptions = ({
    selectScreen,
    setScreen,
    unSetScreen,
    screenSize,
    setScreenSize,
    windowTitles,
    overlayPosition,
    overlayShape,
    overlaySize,
    setOverlayPosition,
    setOverlayShape,
    setOverlaySize,
    isOpenScreen,
    onCloseScreen,
    onStartRecording,
    setOpen
}: AddModalProps) => {
    const [windowsWithImages, setWindowsWithImages] = useState<WindowInfoWithUrl[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (windowTitles && windowTitles.length > 0) {
            setIsLoading(true);
            const convertedWindows = windowTitles.map(window => {
                if (window.image_path) {
                    // Convert the file path to a secure URL that Tauri can serve
                    const imageUrl = convertFileSrc(window.image_path);
                    console.log('Original path:', window.image_path);
                    console.log('Converted URL:', imageUrl);
                    return {
                        ...window,
                        imageUrl
                    };
                }
                return window;
            });

            setWindowsWithImages(convertedWindows);
            setIsLoading(false);
        }
    }, [windowTitles]);

    // Cleanup temporary files when component unmounts
    useEffect(() => {
        return () => {
            // Get all the temporary file paths
            const tempFilePaths = windowsWithImages
                .map(window => window.image_path)
                .filter(path => path && path.includes('briefcast_window_'));

            if (tempFilePaths.length > 0) {
                // Call Rust backend to delete the files
                invoke('cleanup_screenshot_files', { filePaths: tempFilePaths })
                    .then(() => console.log('Cleaned up temporary screenshot files'))
                    .catch(err => console.error('Failed to cleanup files:', err));
            }
        };
    }, [windowsWithImages]);

    const closeModal = () => {
        setOpen(false);
        onCloseScreen();
    }

    interface CustomChangeEvent {
        target: {
            value: string;
        };
    }

    const onChangeOverlayShape = ({ target: { value } }: CustomChangeEvent) => {
        setOverlayShape(value);
        console.log(value);
    }

    const onChangeOverlayPosition = ({ target: { value } }: CustomChangeEvent) => {
        setOverlayPosition(value);
        console.log(value);
    }

    const onChangeOverlaySize = ({ target: { value } }: CustomChangeEvent) => {
        setOverlaySize(value);
        console.log(value);
    }

    const onChangeScreenSize = async ({ target: { value } }: CustomChangeEvent) => {
        setScreenSize(value);
        console.log(value);
    }

    const isCheckedScreen = (value: string) => value === screenSize;
    const isCheckedPosition = (value: string) => value === overlayPosition;
    const isCheckedSize = (value: string) => value === overlaySize;
    const isCheckedShape = (value: string) => value === overlayShape;

    return (
        <div key={"screen-options"} className={`w-screen h-screen mb-10 place-items-center items-start lg:mt-[5.5em] fixed left-0 z-50 ${isOpenScreen ? 'grid' : 'hidden'}`}>
            <div className={`w-full h-full bg-white opacity-70 absolute left-0 z-20`}
                onClick={closeModal}
            > </div>
            <div className="md:w-[50vw] h-[50%] bg-white rounded-b-lg border shadow-md z-50 flex flex-col gap-3 mb-28">

                <div className="w-full flex justify-between items-center">
                    <div className="flex">
                        <div className="px-2 py-1 text-sm border-b-2 border-b-black flex items-center">
                            <IoDesktop /> &nbsp; Screen options
                        </div>

                        <select name="" id="">
                            <option value="">Full screen</option>
                        </select>
                    </div>
                    <button onClick={closeModal}>
                        <IoClose className="hover:bg-red-600 p-1 hover:text-white text-3xl" />
                    </button>
                </div>

                <div className="w-full overflow-y-auto">
                    <div className="px-10 py-5 mb-10">
                        <div className="font-semibold">Video overlay</div>
                        <div className="">Overlay shape</div>
                        <div className="grid grid-cols-3 items-center align-middle gap-3">

                            <input type="radio" checked={isCheckedShape("rounded")} name="overlay_shape" value="rounded" onChange={onChangeOverlayShape} hidden id="overlay_rounded" />
                            <label htmlFor="overlay_rounded" className={`${overlayShape === "rounded" ? "bg-green-400 active:bg-green-400" : "bg-slate-200"} rounded lg:h-[100px] lg:w-[100px] h-[80px] w-[80px] cursor-pointer hover:bg-green-300 checked:bg-green-400`}> </label>


                            <input type="radio" checked={isCheckedShape("circle")} name="overlay_shape" value="circle" onChange={onChangeOverlayShape} hidden id="overlay_circle" />
                            <label htmlFor="overlay_circle" className={`${overlayShape === "circle" ? "bg-green-400 active:bg-green-400" : "bg-slate-200"} rounded-full lg:h-[100px] lg:w-[100px] h-[80px] w-[80px] cursor-pointer hover:bg-green-300 checked:bg-green-400`}> </label>


                            <input type="radio" checked={isCheckedShape("square")} name="overlay_shape" value="square" onChange={onChangeOverlayShape} hidden id="overlay_square" />
                            <label htmlFor="overlay_square" className={`${overlayShape === "square" ? "bg-green-400 active:bg-green-400" : "bg-slate-200"} lg:h-[100px] lg:w-[100px] h-[80px] w-[80px] cursor-pointer hover:bg-green-300 checked:bg-green-400`}> </label>

                        </div>
                    </div>
                    <hr />
                    <div className="px-10 py-5 mb-10">
                        <div className="pt-5">Overlay position</div>
                        <div className="gap-3 align-middle grid grid-cols-3 items-center py-5">
                            <div>
                                <label htmlFor="bottom_left" className="cursor-pointer hover:text-green-300"> Bottom Left </label>
                                <input id="bottom_left" type="radio" checked={isCheckedPosition("bottom_left")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_left" className="align-middle cursor-pointer" />
                            </div>
                            <div>
                                <label htmlFor="bottom_middle" className="cursor-pointer hover:text-green-300"> Bottom Middle </label>
                                <input id="bottom_middle" type="radio" checked={isCheckedPosition("bottom_middle")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_middle" className="align-middle cursor-pointer" />
                            </div>
                            <div className="items-center align-middle">
                                <label htmlFor="bottom_right" className="cursor-pointer align-middle hover:text-green-300"> Bottom Right </label>
                                <input id="bottom_right" type="radio" checked={isCheckedPosition("bottom_right")} name="overlay_position" onChange={onChangeOverlayPosition} value="bottom_right" className="align-middle cursor-pointer" />
                            </div>
                        </div>
                    </div>
                    <hr />
                    <div className="px-10 py-5 mb-10">
                        <div className="pt-5">Overlay size</div>
                        <div className="gap-3 align-middle grid grid-cols-2 md:grid-cols-2 items-center py-5">
                            <div>
                                <label htmlFor="small" className="cursor-pointer hover:text-green-300"> Small(340x240) </label>
                                <input id="small" name="overlay_size" type="radio" checked={isCheckedSize("small")} onChange={onChangeOverlaySize} value="small" className="align-middle cursor-pointer text-green-400 checked:text-green-300" />
                            </div>
                            <div className="flex">
                                <label htmlFor="medium" className="cursor-pointer hover:text-green-300"> Medium(720x540) &nbsp; </label>
                                <input id="medium" name="overlay_size" type="radio" checked={isCheckedSize("medium")} onChange={onChangeOverlaySize} value="medium" className="align-middle cursor-pointer" />
                            </div>
                        </div>
                    </div>
                    <hr />
                    <div className="font-semibold px-5">Screen</div>
                    <div>
                        {!selectScreen ? (
                            <div className="grid lg:grid-cols-4 md:grid-cols-2 sm:grid-cols-2 grid-cols-2 items-center align-middle my-5 px-5 gap-10">
                                <button className={`${screenSize === "fullscreen" ? "text-green-400" : ""} text-center flex flex-col items-center hover:text-green-300`}>
                                    <input type="radio" checked={isCheckedScreen("fullscreen")} name="screen_size" onChange={onChangeScreenSize} hidden value="fullscreen" id="screen_size" />
                                    <label htmlFor="screen_size">
                                        <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl cursor-pointer" />
                                    </label>
                                    Fullscreen
                                </button>

                                <button className="text-center flex flex-col items-center hover:text-green-300">
                                    <input type="radio" name="screen_size" value="custom_screen" onChange={onChangeScreenSize} hidden id="custom_screen" />
                                    <label htmlFor="custom_screen">
                                        <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl cursor-pointer" />
                                    </label>
                                    Custom
                                </button>

                                <button className="text-center flex flex-col items-center hover:text-green-300">
                                    <input type="radio" name="screen_size" value="lasts_screen" onChange={onChangeScreenSize} hidden id="lasts_screen" />
                                    <label htmlFor="lasts_screen">
                                        <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl cursor-pointer" />
                                    </label>
                                    <div> Last screen</div>
                                </button>

                                <button className="text-center flex flex-col items-center hover:text-green-300" onClick={setScreen}>
                                    <input type="radio" name="screen_size" value="select_screen" onChange={onChangeScreenSize} hidden id="select_screen" />
                                    <label htmlFor="select_screen">
                                        <IoScanOutline className="lg:text-9xl md:text-7xl sm:text-5xl text-5xl cursor-pointer" />
                                    </label>
                                    <span> Select screen</span>
                                </button>
                            </div>
                        ) : (
                            <div className="my-5 px-5">
                                {isLoading ? (
                                    <div className="text-center py-10">Loading windows...</div>
                                ) : windowsWithImages.length === 0 ? (
                                    <div className="text-center py-10">No windows found</div>
                                ) : (
                                    <div className="grid lg:grid-cols-3 md:grid-cols-2 sm:grid-cols-1 gap-4 max-h-96 overflow-y-auto">
                                        {windowsWithImages.map((window, index) => (
                                            <div key={`${window.title}-${index}`} className="border rounded-lg p-3 hover:border-green-400 cursor-pointer">
                                                <div className="text-sm font-semibold mb-2 truncate" title={window.title}>
                                                    {window.title}
                                                </div>
                                                {window.imageUrl ? (
                                                    <img
                                                        src={window.imageUrl}
                                                        alt={window.title}
                                                        className="w-full h-32 object-cover rounded bg-gray-100"
                                                        onError={(e) => {
                                                            console.error('Failed to load image:', window.imageUrl);
                                                            (e.target as HTMLImageElement).style.display = 'none';
                                                        }}
                                                        onLoad={() => {
                                                            console.log('Image loaded successfully:', window.imageUrl);
                                                        }}
                                                    />
                                                ) : (
                                                    <div className="w-full h-32 bg-gray-200 rounded flex items-center justify-center">
                                                        No preview available
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <button
                                    onClick={unSetScreen}
                                    className="mt-4 px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                                >
                                    Back
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                <div className="bottom-0 flex justify-end items-end text-right">
                    <button
                        className="bg-black py-2 px-5 text-white rounded-br-md hover:bg-gray-800"
                        onClick={onStartRecording}
                    >
                        Start now
                    </button>
                </div>

            </div>
        </div>
    );
}

export default ScreenOptions;