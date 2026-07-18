import { IoClose, IoDesktop, IoScanOutline, IoApps, IoReload } from "react-icons/io5";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { useEffect, useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { MdMonitor } from "react-icons/md";
import { WindowInfo, MonitorInfo } from "../Types";

interface ScreenOptionsProps {
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
    error?: string;
}

type SelectionMode = 'main' | 'monitors' | 'windows';

const EnhancedScreenOptions = ({
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
    setOpen,
    setSelectedScreen,
    error
}: ScreenOptionsProps) => {
    const [mode, setMode] = useState<SelectionMode>('main');
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [selectedMonitor, setSelectedMonitor] = useState<string>('');
    const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    // Snapshot of `error` taken when a window-load starts, so the fallback below only reacts
    // to a *new* error firing during this load - not a stale, unrelated error already sitting
    // in Dashboard's error state from something else entirely.
    const loadErrorBaselineRef = useRef<string | undefined>(undefined);

    // Load windows when entering windows mode. isLoading must be cleared here regardless of
    // whether any windows actually came back - previously it was only cleared when
    // windowTitles was non-empty, so a successful-but-empty capture (or the loading state set
    // by the "Window" button) left this stuck on "Loading windows..." forever.
    useEffect(() => {
        if (!selectScreen) return;
        const windowsWithUrls = windowTitles.map(window => ({
            ...window,
            imageUrl: window.image_path ? convertFileSrc(window.image_path) : undefined
        }));
        setWindows(windowsWithUrls as any);
        setMode('windows');
        setIsLoading(false);
    }, [selectScreen, windowTitles]);

    // Load monitors when entering monitors mode
    useEffect(() => {
        if (mode === 'monitors' && monitors.length === 0) {
            loadMonitors();
        }
    }, [mode]);

    // If the parent's window-capture invoke rejects outright, selectScreen never flips true
    // and the effect above never runs - fall back to clearing isLoading here so the modal
    // doesn't get stuck on "Loading windows..." forever. Only trips on an error that's new
    // since this load started, so a stale unrelated error already in state can't falsely
    // short-circuit a load that's still genuinely in progress.
    useEffect(() => {
        if (mode === 'windows' && isLoading && error && error !== loadErrorBaselineRef.current) {
            setIsLoading(false);
        }
    }, [mode, isLoading, error]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            const tempFilePaths = windows
                .map(w => w.image_path)
                .filter(path => path && path.includes('briefcast_window_'));

            if (tempFilePaths.length > 0) {
                invoke('cleanup_screenshot_files', { filePaths: tempFilePaths })
                    .catch(err => console.error('Failed to cleanup files:', err));
            }
        };
    }, [windows]);

    const loadMonitors = async () => {
        try {
            setIsLoading(true);
            const result = await invoke<MonitorInfo[]>('get_monitors');
            setMonitors(result);
        } catch (error) {
            console.error('Failed to load monitors:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const loadWindows = async () => {
        setIsLoading(true);
        loadErrorBaselineRef.current = error;
        setScreen(); // Call the parent's setScreen function
    };

    const handleBack = () => {
        if (mode === 'windows') {
            unSetScreen();
        }
        setMode('main');
    };

    const closeModal = () => {
        setOpen(false);
        onCloseScreen();
        setMode('main');
    };

    const handleStartRecording = () => {
        // Store selection info in screenSize for parent component compatibility
        if (selectedMonitor) {
            setScreenSize(`monitor:${selectedMonitor}`);
            setSelectedScreen(selectedMonitor);
        } else if (selectedWindow !== null) {
            const window = windows.find(w => w.hwnd === selectedWindow);
            setScreenSize(`window:${selectedWindow}`);
            setSelectedScreen(window?.title || '');
        } else {
            setScreenSize('fullscreen');
        }

        onStartRecording();
        closeModal();
    };

    const renderMainOptions = () => (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6">
            <button
                onClick={() => {
                    setSelectedMonitor('');
                    setSelectedWindow(null);
                    setScreenSize('fullscreen');
                }}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all ${
                    screenSize === 'fullscreen' && !selectedMonitor && selectedWindow === null
                        ? 'border-green-500 bg-green-50 dark:bg-green-500/10'
                        : 'border-gray-200 dark:border-neutral-700 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-500/10'
                }`}
            >
                <IoScanOutline className="text-5xl text-gray-700 dark:text-neutral-300" />
                <span className="text-sm font-medium">Full Screen</span>
            </button>

            <button
                onClick={() => setMode('monitors')}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-gray-200 dark:border-neutral-700 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-500/10 transition-all"
            >
                <FiMonitor className="text-5xl text-gray-700 dark:text-neutral-300" />
                <span className="text-sm font-medium">Monitor</span>
            </button>

            <button
                onClick={() => {
                    setMode('windows');
                    loadWindows();
                }}
                className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-gray-200 dark:border-neutral-700 hover:border-green-400 hover:bg-green-50 dark:hover:bg-green-500/10 transition-all"
            >
                <IoApps className="text-5xl text-gray-700 dark:text-neutral-300" />
                <span className="text-sm font-medium">Window</span>
            </button>

            <button
                className="flex flex-col items-center gap-2 p-4 rounded-lg border-2 border-gray-200 dark:border-neutral-700 opacity-50 cursor-not-allowed"
                disabled
            >
                <IoDesktop className="text-5xl text-gray-700 dark:text-neutral-300" />
                <span className="text-sm font-medium">Region</span>
                <span className="text-xs text-gray-500 dark:text-neutral-400">Coming soon</span>
            </button>
        </div>
    );

    const renderMonitors = () => (
        <div className="p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Select Monitor</h3>
                <button
                    onClick={handleBack}
                    className="text-sm text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
                >
                    ← Back
                </button>
            </div>

            {isLoading ? (
                <div className="text-center py-8">Loading monitors...</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {monitors.map((monitor) => (
                        <button
                            key={monitor.id}
                            onClick={() => setSelectedMonitor(monitor.id)}
                            className={`p-4 rounded-lg border-2 transition-all text-left ${
                                selectedMonitor === monitor.id
                                    ? 'border-green-500 bg-green-50 dark:bg-green-500/10'
                                    : 'border-gray-200 dark:border-neutral-700 hover:border-green-400'
                            }`}
                        >
                            <div className="flex items-center gap-2 mb-2">
                                <MdMonitor className="text-2xl" />
                                <span className="font-medium">{monitor.name}</span>
                                {monitor.is_primary && (
                                    <span className="text-xs bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded">
                                        Primary
                                    </span>
                                )}
                            </div>
                            <div className="text-sm text-gray-600 dark:text-neutral-400">
                                {monitor.width} × {monitor.height}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderWindows = () => (
        <div className="p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Select Window</h3>
                <div className="flex gap-2">
                    <button
                        onClick={loadWindows}
                        className="p-2 text-gray-600 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded"
                        title="Refresh"
                    >
                        <IoReload className="text-lg" />
                    </button>
                    <button
                        onClick={handleBack}
                        className="text-sm text-gray-600 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200"
                    >
                        ← Back
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="text-center py-8">Loading windows...</div>
            ) : windows.length === 0 ? (
                <div className="text-center py-8 text-gray-500 dark:text-neutral-400">
                    No windows found. Try refreshing.
                </div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-80 overflow-y-auto">
                    {windows.map((window: any) => (
                        <button
                            key={window.hwnd}
                            onClick={() => setSelectedWindow(window.hwnd)}
                            className={`rounded-lg border-2 overflow-hidden transition-all text-left ${
                                selectedWindow === window.hwnd
                                    ? 'border-green-500 ring-2 ring-green-200 dark:ring-green-500/30'
                                    : 'border-gray-200 dark:border-neutral-700 hover:border-green-400'
                            }`}
                        >
                            <div className="h-24 bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                                {window.imageUrl ? (
                                    <img
                                        src={window.imageUrl}
                                        alt={window.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                    />
                                ) : (
                                    <IoApps className="text-3xl text-gray-400 dark:text-neutral-500" />
                                )}
                            </div>
                            <div className="p-2">
                                <p className="text-xs truncate" title={window.title}>
                                    {window.title}
                                </p>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderOverlaySettings = () => (
        <div className="border-t dark:border-neutral-700 p-6 bg-gray-50 dark:bg-neutral-800/60 space-y-4">
            <div>
                <label className="block text-sm font-medium mb-2">Camera Shape</label>
                <div className="flex gap-3">
                    {[
                        { value: 'rounded', label: 'Rounded' },
                        { value: 'circle', label: 'Circle' },
                        { value: 'square', label: 'Square' }
                    ].map((shape) => (
                        <button
                            key={shape.value}
                            onClick={() => setOverlayShape(shape.value)}
                            className={`w-16 h-16 border-2 transition-all ${
                                overlayShape === shape.value
                                    ? 'border-green-500 bg-green-100 dark:bg-green-500/20'
                                    : 'border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 hover:border-green-400'
                            } ${
                                shape.value === 'circle' ? 'rounded-full' :
                                shape.value === 'rounded' ? 'rounded-lg' : ''
                            }`}
                        />
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium mb-2">Camera Position</label>
                <div className="grid grid-cols-3 gap-2">
                    {[
                        'top_left', 'top_center', 'top_right',
                        'bottom_left', 'bottom_center', 'bottom_right'
                    ].map((pos) => (
                        <button
                            key={pos}
                            onClick={() => setOverlayPosition(pos)}
                            className={`px-3 py-2 text-xs rounded border-2 transition-all ${
                                overlayPosition === pos
                                    ? 'border-green-500 bg-green-100 dark:bg-green-500/20'
                                    : 'border-gray-300 dark:border-neutral-600 hover:border-green-400'
                            }`}
                        >
                            {pos.replace('_', ' ')}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium mb-2">Camera Size</label>
                <div className="flex gap-2">
                    {[
                        { value: 'small', label: 'Small', desc: '340×240' },
                        { value: 'medium', label: 'Medium', desc: '720×540' }
                    ].map((size) => (
                        <button
                            key={size.value}
                            onClick={() => setOverlaySize(size.value)}
                            className={`flex-1 px-3 py-2 rounded border-2 transition-all ${
                                overlaySize === size.value
                                    ? 'border-green-500 bg-green-100 dark:bg-green-500/20'
                                    : 'border-gray-300 dark:border-neutral-600 hover:border-green-400'
                            }`}
                        >
                            <div className="text-sm font-medium">{size.label}</div>
                            <div className="text-xs text-gray-600 dark:text-neutral-400">{size.desc}</div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );

    if (!isOpenScreen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black bg-opacity-50" onClick={closeModal} />
            
            <div className="relative bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col m-4">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b dark:border-neutral-700">
                    <div className="flex items-center gap-2">
                        <IoDesktop className="text-xl" />
                        <h2 className="text-lg font-semibold">Screen Options</h2>
                    </div>
                    <button onClick={closeModal} className="p-1 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded">
                        <IoClose className="text-2xl" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {mode === 'main' && renderMainOptions()}
                    {mode === 'monitors' && renderMonitors()}
                    {mode === 'windows' && renderWindows()}
                    {renderOverlaySettings()}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between p-4 border-t dark:border-neutral-700">
                    <div className="text-sm text-gray-600 dark:text-neutral-400">
                        {selectedMonitor && (
                            <span className="bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300 px-2 py-1 rounded text-xs">
                                Monitor: {monitors.find(m => m.id === selectedMonitor)?.name}
                            </span>
                        )}
                        {selectedWindow !== null && (
                            <span className="bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300 px-2 py-1 rounded text-xs">
                                Window: {windows.find(w => w.hwnd === selectedWindow)?.title}
                            </span>
                        )}
                        {!selectedMonitor && selectedWindow === null && (
                            <span className="text-xs">Full screen</span>
                        )}
                    </div>
                    <button
                        onClick={handleStartRecording}
                        className="bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 px-6 py-2 rounded hover:bg-gray-800 dark:hover:bg-white text-sm font-medium"
                    >
                        Start Recording
                    </button>
                </div>
            </div>
        </div>
    );
};

export default EnhancedScreenOptions;