import { IoClose, IoDesktop, IoScanOutline, IoApps, IoReload } from "react-icons/io5";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { useEffect, useState } from "react";
import { FiMonitor } from "react-icons/fi";

export type WindowInfo = {
    title: string;
    image_path?: string;
    hwnd: number;
};

export type MonitorInfo = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    is_primary: boolean;
};

interface ScreenOptionsProps {
    isOpen: boolean;
    onClose: () => void;
    onStartRecording: (config: RecordingConfig) => void;
}

export type RecordingConfig = {
    type: 'fullscreen' | 'monitor' | 'window' | 'region';
    monitorId?: string;
    windowHwnd?: number;
    windowTitle?: string;
    overlayPosition: string;
    overlayShape: string;
    overlaySize: string;
};

type SelectionMode = 'main' | 'monitors' | 'windows';

const ImprovedScreenSelector = ({ isOpen, onClose, onStartRecording }: ScreenOptionsProps) => {
    const [mode, setMode] = useState<SelectionMode>('main');
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [selectedMonitor, setSelectedMonitor] = useState<string>('');
    const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    
    // Overlay settings
    const [overlayShape, setOverlayShape] = useState('rounded');
    const [overlayPosition, setOverlayPosition] = useState('bottom_right');
    const [overlaySize, setOverlaySize] = useState('small');

    useEffect(() => {
        if (isOpen && mode === 'monitors' && monitors.length === 0) {
            loadMonitors();
        }
    }, [isOpen, mode]);

    useEffect(() => {
        if (isOpen && mode === 'windows') {
            loadWindows();
        }
    }, [isOpen, mode]);

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
        try {
            setIsLoading(true);
            const result = await invoke<WindowInfo[]>('capture_window_screenshots_by_title_command', {
                appHandle: null
            });
            
            const windowsWithUrls = result.map(window => ({
                ...window,
                imageUrl: window.image_path ? convertFileSrc(window.image_path) : undefined
            }));
            
            setWindows(windowsWithUrls as any);
        } catch (error) {
            console.error('Failed to load windows:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleStartRecording = () => {
        let config: RecordingConfig = {
            type: 'fullscreen',
            overlayPosition,
            overlayShape,
            overlaySize
        };

        if (selectedMonitor) {
            config = { ...config, type: 'monitor', monitorId: selectedMonitor };
        } else if (selectedWindow !== null) {
            const window = windows.find(w => w.hwnd === selectedWindow);
            config = { 
                ...config, 
                type: 'window', 
                windowHwnd: selectedWindow,
                windowTitle: window?.title 
            };
        }

        onStartRecording(config);
        onClose();
    };

    const renderMainOptions = () => (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 p-8">
            <button
                onClick={() => {
                    setSelectedMonitor('');
                    setSelectedWindow(null);
                }}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-gray-200 hover:border-green-400 hover:bg-green-50 transition-all"
            >
                <IoScanOutline className="text-6xl text-gray-700" />
                <span className="text-sm font-medium">Full Screen</span>
                <span className="text-xs text-gray-500">All displays</span>
            </button>

            <button
                onClick={() => setMode('monitors')}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-gray-200 hover:border-green-400 hover:bg-green-50 transition-all"
            >
                <FiMonitor className="text-6xl text-gray-700" />
                <span className="text-sm font-medium">Monitor</span>
                <span className="text-xs text-gray-500">Select display</span>
            </button>

            <button
                onClick={() => setMode('windows')}
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-gray-200 hover:border-green-400 hover:bg-green-50 transition-all"
            >
                <IoApps className="text-6xl text-gray-700" />
                <span className="text-sm font-medium">Window</span>
                <span className="text-xs text-gray-500">Select app</span>
            </button>

            <button
                className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 border-gray-200 hover:border-green-400 hover:bg-green-50 transition-all opacity-50 cursor-not-allowed"
                disabled
            >
                <IoDesktop className="text-6xl text-gray-700" />
                <span className="text-sm font-medium">Region</span>
                <span className="text-xs text-gray-500">Coming soon</span>
            </button>
        </div>
    );

    const renderMonitors = () => (
        <div className="p-8">
            <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold">Select Monitor</h3>
                <button
                    onClick={() => setMode('main')}
                    className="text-sm text-gray-600 hover:text-gray-800"
                >
                    ← Back
                </button>
            </div>

            {isLoading ? (
                <div className="text-center py-12">Loading monitors...</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {monitors.map((monitor) => (
                        <button
                            key={monitor.id}
                            onClick={() => setSelectedMonitor(monitor.id)}
                            className={`p-6 rounded-lg border-2 transition-all text-left ${
                                selectedMonitor === monitor.id
                                    ? 'border-green-500 bg-green-50'
                                    : 'border-gray-200 hover:border-green-400'
                            }`}
                        >
                            <div className="flex items-start justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <FiMonitor className="text-3xl text-gray-700" />
                                    <span className="font-medium">{monitor.name}</span>
                                </div>
                                {monitor.is_primary && (
                                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                                        Primary
                                    </span>
                                )}
                            </div>
                            <div className="text-sm text-gray-600 space-y-1">
                                <p>Resolution: {monitor.width} × {monitor.height}</p>
                                <p>Position: ({monitor.x}, {monitor.y})</p>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderWindows = () => (
        <div className="p-8">
            <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-semibold">Select Window</h3>
                <div className="flex gap-2">
                    <button
                        onClick={loadWindows}
                        className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                        title="Refresh"
                    >
                        <IoReload className="text-xl" />
                    </button>
                    <button
                        onClick={() => setMode('main')}
                        className="text-sm text-gray-600 hover:text-gray-800"
                    >
                        ← Back
                    </button>
                </div>
            </div>

            {isLoading ? (
                <div className="text-center py-12">Loading windows...</div>
            ) : windows.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                    No windows found. Try refreshing.
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-96 overflow-y-auto">
                    {windows.map((window: any) => (
                        <button
                            key={window.hwnd}
                            onClick={() => setSelectedWindow(window.hwnd)}
                            className={`rounded-lg border-2 overflow-hidden transition-all text-left ${
                                selectedWindow === window.hwnd
                                    ? 'border-green-500 ring-2 ring-green-200'
                                    : 'border-gray-200 hover:border-green-400'
                            }`}
                        >
                            <div className="h-32 bg-gray-100 flex items-center justify-center overflow-hidden">
                                {window.imageUrl ? (
                                    <img
                                        src={window.imageUrl}
                                        alt={window.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).src = '';
                                            (e.target as HTMLImageElement).style.display = 'none';
                                        }}
                                    />
                                ) : (
                                    <IoApps className="text-4xl text-gray-400" />
                                )}
                            </div>
                            <div className="p-3">
                                <p className="text-sm font-medium truncate" title={window.title}>
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
        <div className="border-t p-6 bg-gray-50 space-y-6">
            <div>
                <label className="block text-sm font-medium mb-3">Camera Overlay Shape</label>
                <div className="flex gap-4">
                    {['rounded', 'circle', 'square'].map((shape) => (
                        <button
                            key={shape}
                            onClick={() => setOverlayShape(shape)}
                            className={`w-16 h-16 border-2 transition-all ${
                                overlayShape === shape
                                    ? 'border-green-500 bg-green-100'
                                    : 'border-gray-300 bg-white hover:border-green-400'
                            } ${
                                shape === 'circle' ? 'rounded-full' : shape === 'rounded' ? 'rounded-lg' : ''
                            }`}
                        />
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium mb-3">Camera Position</label>
                <div className="grid grid-cols-3 gap-3">
                    {[
                        { value: 'top_left', label: 'Top Left' },
                        { value: 'top_center', label: 'Top Center' },
                        { value: 'top_right', label: 'Top Right' },
                        { value: 'bottom_left', label: 'Bottom Left' },
                        { value: 'bottom_center', label: 'Bottom Center' },
                        { value: 'bottom_right', label: 'Bottom Right' },
                    ].map((pos) => (
                        <button
                            key={pos.value}
                            onClick={() => setOverlayPosition(pos.value)}
                            className={`px-4 py-2 text-sm rounded border-2 transition-all ${
                                overlayPosition === pos.value
                                    ? 'border-green-500 bg-green-100 text-green-700'
                                    : 'border-gray-300 bg-white hover:border-green-400'
                            }`}
                        >
                            {pos.label}
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-sm font-medium mb-3">Camera Size</label>
                <div className="flex gap-3">
                    {[
                        { value: 'small', label: 'Small', desc: '340×240' },
                        { value: 'medium', label: 'Medium', desc: '720×540' },
                        { value: 'large', label: 'Large', desc: '1080×810' },
                    ].map((size) => (
                        <button
                            key={size.value}
                            onClick={() => setOverlaySize(size.value)}
                            className={`flex-1 px-4 py-3 rounded border-2 transition-all ${
                                overlaySize === size.value
                                    ? 'border-green-500 bg-green-100'
                                    : 'border-gray-300 bg-white hover:border-green-400'
                            }`}
                        >
                            <div className="font-medium text-sm">{size.label}</div>
                            <div className="text-xs text-gray-600">{size.desc}</div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black bg-opacity-50"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b">
                    <div className="flex items-center gap-3">
                        <IoDesktop className="text-2xl text-gray-700" />
                        <h2 className="text-xl font-semibold">Screen Recording Options</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
                    >
                        <IoClose className="text-2xl text-gray-600" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto">
                    {mode === 'main' && renderMainOptions()}
                    {mode === 'monitors' && renderMonitors()}
                    {mode === 'windows' && renderWindows()}
                    
                    {/* Always show overlay settings */}
                    {renderOverlaySettings()}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between p-6 border-t bg-white">
                    <div className="text-sm text-gray-600">
                        {selectedMonitor && (
                            <span className="bg-green-100 text-green-700 px-3 py-1 rounded">
                                Monitor selected: {monitors.find(m => m.id === selectedMonitor)?.name}
                            </span>
                        )}
                        {selectedWindow !== null && (
                            <span className="bg-green-100 text-green-700 px-3 py-1 rounded">
                                Window selected: {windows.find(w => w.hwnd === selectedWindow)?.title}
                            </span>
                        )}
                        {!selectedMonitor && selectedWindow === null && (
                            <span>Full screen recording</span>
                        )}
                    </div>
                    <button
                        onClick={handleStartRecording}
                        className="bg-black text-white px-6 py-3 rounded-lg hover:bg-gray-800 transition-colors font-medium"
                    >
                        Start Recording
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ImprovedScreenSelector;