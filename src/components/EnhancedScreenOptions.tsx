import { IoClose, IoScanOutline, IoApps, IoReload, IoArrowBack, IoVideocam, IoMic, IoDesktopOutline, IoSwapHorizontal, IoPencil, IoPhonePortraitOutline, IoVolumeHigh, IoHandLeftOutline } from "react-icons/io5";
import { PHONE_CAMERA_DEVICE, PHONE_CAMERA_LABEL } from "../services/phoneCamera";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { WindowInfo, MonitorInfo } from "../Types";
import CameraOverlayPreview from "./CameraOverlayPreview";
import { RECORD_TYPE_LABELS } from "./ActiveRecordingState";
import { loadSettings, saveSettings } from "../utils/appSettings";

interface ScreenOptionsProps {
    recordType: string;
    videoDevices: string[];
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
    // Records the webcam as its own file, which is what makes switching the main view between
    // screen and camera possible while recording (Alt+Shift+V) - see FormData.separate_webcam_capture.
    separateWebcamCapture: boolean;
    setSeparateWebcamCapture: React.Dispatch<React.SetStateAction<boolean>>;
    // Every other recording setting the bottom panel (RecordingDocker) has - the same state, so a
    // change in either place shows in both.
    fileName: string;
    onFileNameChange: (name: string) => void;
    fileExt: string;
    onFileExtChange: (ext: string) => void;
    audioDevice: string;
    onAudioDeviceChange: (device: string) => void;
    connectedAudioDevices: string[] | null;
    connectedCameraDevices: string[] | null;
    onToggleVideoDevice: (device: string) => void;
    onRefreshDevices: () => void;
    onOpenPhoneCamera: () => void;
    isPhoneCameraConnected: boolean;
    includeSystemAudio: boolean;
    onToggleIncludeSystemAudio: () => void;
    trackClicks: boolean;
    onToggleTrackClicks: () => void;
    isClickTrackingSupported: boolean;
    resolutionWidth: number | null;
    onResolutionWidthChange: (width: number | null) => void;
    framerate: number | null;
    onFramerateChange: (fps: number | null) => void;
    isOpenScreen: boolean;
    onCloseScreen: () => void;
    // Accepts the resolved capture target directly rather than relying on the caller to have
    // already re-rendered with the setScreenSize/setSelectedScreen calls made just before it -
    // those are async state updates, so reading them back synchronously in the same tick (as
    // clicking a window thumbnail below needs to) would still see the *previous* selection.
    onStartRecording: (target?: SelectionTarget) => void;
    setOpen: React.Dispatch<React.SetStateAction<boolean>>;
    // Lets the header switch what's being recorded without closing the modal.
    onRecordTypeChange: (recordType: string) => void;
    error?: string;
}

// The record types the header offers, in order. "c" (Screenshot) is a separate flow the caller
// switches into on its own, so it isn't one of them.
const RECORD_TYPE_OPTIONS: { value: string; icons: React.ReactNode[] }[] = [
    { value: "sva", icons: [<IoDesktopOutline key="s" />, <IoVideocam key="v" />, <IoMic key="a" />] },
    { value: "sa", icons: [<IoDesktopOutline key="s" />, <IoMic key="a" />] },
    { value: "s", icons: [<IoDesktopOutline key="s" />] },
    { value: "va", icons: [<IoVideocam key="v" />, <IoMic key="a" />] },
    { value: "v", icons: [<IoVideocam key="v" />] },
    { value: "a", icons: [<IoMic key="a" />] },
];

// Record types that capture a camera and no screen - the screen target is never read for these.
const CAMERA_ONLY_TYPES = ["va", "v"];
const AUDIO_ONLY_TYPES = ["a"];

const SHAPES = [
    { value: "rounded", label: "Rounded", className: "rounded-xl" },
    { value: "circle", label: "Circle", className: "rounded-full" },
    { value: "square", label: "Rectangle", className: "rounded-sm aspect-[4/3] !h-auto" },
];

// Bubble width as a share of the video's - mirrors bubble_fraction in recording.rs.
const SIZES = [
    { value: "xs", label: "XS", hint: "10%" },
    { value: "small", label: "S", hint: "14%" },
    { value: "medium", label: "M", hint: "18%" },
    { value: "large", label: "L", hint: "24%" },
    { value: "xl", label: "XL", hint: "30%" },
];

const POSITIONS = [
    "top_left", "top_center", "top_right",
    "center_left", "center", "center_right",
    "bottom_left", "bottom_center", "bottom_right",
];
const POSITION_LABELS: Record<string, string> = {
    top_left: "Top left", top_center: "Top center", top_right: "Top right",
    center_left: "Center left", center: "Center", center_right: "Center right",
    bottom_left: "Bottom left", bottom_center: "Bottom center", bottom_right: "Bottom right",
};

// "Native" is a width beyond any real display - see FormData.resolution_width (recording.rs).
const NATIVE_RESOLUTION_WIDTH = 7680;

const BORDERS = [
    { value: "none", label: "None" },
    { value: "thin", label: "Thin" },
    { value: "medium", label: "Medium" },
    { value: "thick", label: "Thick" },
];

const BORDER_COLORS = ["#ffffff", "#111827", "#3b82f6", "#22c55e", "#ef4444", "#f59e0b", "#a855f7", "#ec4899"];

type SelectionMode = "main" | "monitors" | "windows";

interface SelectionTarget {
    screenSize: string;
    selectedScreen: string;
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

// A segmented control - one rounded track, the selected option raised on it.
const Segmented = <T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: React.ReactNode; title?: string }[];
    onChange: (v: T) => void;
}) => (
    <div className="flex p-1 gap-1 rounded-xl bg-neutral-100 dark:bg-neutral-800/80">
        {options.map((o) => (
            <button
                key={o.value}
                type="button"
                title={o.title}
                onClick={() => onChange(o.value)}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    value === o.value
                        ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                }`}
            >
                {o.label}
            </button>
        ))}
    </div>
);

const SectionLabel = ({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) => (
    <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{children}</span>
        {hint && <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{hint}</span>}
    </div>
);

const Kbd = ({ children }: { children: React.ReactNode }) => (
    <kbd className="px-1.5 py-0.5 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-[10px] font-mono text-neutral-600 dark:text-neutral-300 shadow-[0_1px_0_rgba(0,0,0,0.08)]">
        {children}
    </kbd>
);

const EnhancedScreenOptions = ({
    recordType,
    videoDevices,
    selectScreen,
    setScreen,
    unSetScreen,
    screenSize: _screenSize,
    setScreenSize,
    windowTitles,
    overlayPosition,
    overlayShape,
    overlaySize,
    setOverlayPosition,
    setOverlayShape,
    setOverlaySize,
    separateWebcamCapture,
    setSeparateWebcamCapture,
    fileName,
    onFileNameChange,
    fileExt,
    onFileExtChange,
    audioDevice,
    onAudioDeviceChange,
    connectedAudioDevices,
    connectedCameraDevices,
    onToggleVideoDevice,
    onRefreshDevices,
    onOpenPhoneCamera,
    isPhoneCameraConnected,
    includeSystemAudio,
    onToggleIncludeSystemAudio,
    trackClicks,
    onToggleTrackClicks,
    isClickTrackingSupported,
    resolutionWidth,
    onResolutionWidthChange,
    framerate,
    onFramerateChange,
    isOpenScreen,
    onCloseScreen,
    onStartRecording,
    setOpen,
    setSelectedScreen,
    onRecordTypeChange,
    error,
}: ScreenOptionsProps) => {
    const [mode, setMode] = useState<SelectionMode>("main");
    // The header title doubles as the recording's file name - click it to rename.
    const [editingName, setEditingName] = useState(false);
    const isCameraOnly = CAMERA_ONLY_TYPES.includes(recordType);
    const isAudioOnly = AUDIO_ONLY_TYPES.includes(recordType);
    const hasCameraBubble = recordType === "sva";
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [selectedMonitor, setSelectedMonitor] = useState<string>("");
    const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    // Bubble border, remembered between recordings (appSettings) and sent with every recording
    // by Dashboard's handleStartRecording.
    const [border, setBorder] = useState(() => loadSettings().cameraBorder);
    const [borderColor, setBorderColor] = useState(() => loadSettings().cameraBorderColor);
    const updateBorder = (next: { cameraBorder?: string; cameraBorderColor?: string }) => {
        const settings = loadSettings();
        saveSettings({ ...settings, ...next });
        if (next.cameraBorder !== undefined) setBorder(next.cameraBorder);
        if (next.cameraBorderColor !== undefined) setBorderColor(next.cameraBorderColor);
    };

    // Snapshot of `error` taken when a window-load starts, so the fallback below only reacts
    // to a *new* error firing during this load - not a stale, unrelated error already sitting
    // in Dashboard's error state from something else entirely.
    const loadErrorBaselineRef = useRef<string | undefined>(undefined);

    // Load windows when entering windows mode. isLoading is cleared regardless of whether any
    // windows came back, so a successful-but-empty capture can't leave this stuck loading.
    useEffect(() => {
        if (!selectScreen) return;
        const windowsWithUrls = windowTitles.map((window) => ({
            ...window,
            imageUrl: window.image_path ? convertFileSrc(window.image_path) : undefined,
        }));
        setWindows(windowsWithUrls as any);
        setMode("windows");
        setIsLoading(false);
    }, [selectScreen, windowTitles]);

    useEffect(() => {
        if (mode === "monitors" && monitors.length === 0) {
            loadMonitors();
        }
    }, [mode]);

    // If the parent's window-capture invoke rejects outright, selectScreen never flips true and
    // the effect above never runs - clear isLoading on an error that's new since this load began.
    useEffect(() => {
        if (mode === "windows" && isLoading && error && error !== loadErrorBaselineRef.current) {
            setIsLoading(false);
        }
    }, [mode, isLoading, error]);

    useEffect(() => {
        return () => {
            const tempFilePaths = windows.map((w) => w.image_path).filter((path) => path && path.includes("briefcast_window_"));
            if (tempFilePaths.length > 0) {
                invoke("cleanup_screenshot_files", { filePaths: tempFilePaths }).catch((err) =>
                    console.error("Failed to cleanup files:", err)
                );
            }
        };
    }, [windows]);

    const loadMonitors = async () => {
        try {
            setIsLoading(true);
            setMonitors(await invoke<MonitorInfo[]>("get_monitors"));
        } catch (error) {
            console.error("Failed to load monitors:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const loadWindows = async () => {
        setIsLoading(true);
        loadErrorBaselineRef.current = error;
        setScreen();
    };

    const handleBack = () => {
        if (mode === "windows") unSetScreen();
        setMode("main");
    };

    const closeModal = () => {
        setOpen(false);
        onCloseScreen();
        setMode("main");
    };

    const resolveCurrentTarget = (): SelectionTarget => {
        if (selectedMonitor) {
            const monitor = monitors.find((m) => m.id === selectedMonitor);
            return { screenSize: `monitor:${selectedMonitor}`, selectedScreen: monitor?.name || selectedMonitor };
        }
        if (selectedWindow !== null) {
            const window = windows.find((w) => w.hwnd === selectedWindow);
            return { screenSize: `window:${selectedWindow}`, selectedScreen: window?.title || "" };
        }
        return { screenSize: "fullscreen", selectedScreen: "" };
    };

    // Also updates screenSize/selectedScreen for code that still reads them ambiently - but the
    // capture itself is driven by `target`, so it's correct immediately.
    const confirmAndStart = (target: SelectionTarget) => {
        setScreenSize(target.screenSize);
        setSelectedScreen(target.selectedScreen);
        onStartRecording(target);
        closeModal();
    };

    // Screenshotting a window is a single click: picking it *is* confirming the target. Video
    // recording keeps select-then-confirm, since a recording has room to be corrected.
    const handleWindowClick = async (window: WindowInfo & { hwnd: number }) => {
        setSelectedWindow(window.hwnd);
        setSelectedMonitor("");
        if (recordType === "c") {
            try {
                await invoke("activate_and_open_window", { title: window.title });
            } catch (err) {
                console.error("Failed to activate window:", err);
            }
            confirmAndStart({ screenSize: `window:${window.hwnd}`, selectedScreen: window.title || "" });
        }
    };

    // Enter starts, Escape closes - the two things a keyboard user reaches for in a dialog.
    useEffect(() => {
        if (!isOpenScreen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeModal();
            if (e.key === "Enter" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) confirmAndStart(resolveCurrentTarget());
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const fullscreenSelected = !selectedMonitor && selectedWindow === null;
    const sourceCard = (
        active: boolean,
        icon: React.ReactNode,
        title: string,
        subtitle: string,
        onClick: () => void
    ) => (
        <button
            type="button"
            onClick={onClick}
            className={`group flex items-center gap-3 p-4 rounded-2xl border text-left transition-all ${
                active
                    ? "border-emerald-500 bg-emerald-50/80 dark:bg-emerald-500/10 ring-4 ring-emerald-500/10"
                    : "border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-900 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm"
            }`}
        >
            <span
                className={`flex items-center justify-center w-11 h-11 rounded-xl text-2xl transition-colors ${
                    active
                        ? "bg-emerald-500 text-white"
                        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 group-hover:bg-neutral-200 dark:group-hover:bg-neutral-700"
                }`}
            >
                {icon}
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400 truncate">{subtitle}</span>
            </span>
        </button>
    );

    const selectedMonitorInfo = monitors.find((m) => m.id === selectedMonitor);
    const selectedWindowInfo = windows.find((w) => w.hwnd === selectedWindow);

    const renderSources = () => (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {sourceCard(fullscreenSelected, <IoScanOutline />, "Full screen", "Your whole display", () => {
                setSelectedMonitor("");
                setSelectedWindow(null);
                setScreenSize("fullscreen");
                setMode("main");
            })}
            {sourceCard(
                !!selectedMonitor || mode === "monitors",
                <FiMonitor />,
                "Monitor",
                selectedMonitorInfo ? selectedMonitorInfo.name : "Pick one display",
                () => setMode("monitors")
            )}
            {sourceCard(
                selectedWindow !== null || mode === "windows",
                <IoApps />,
                "Window",
                selectedWindowInfo ? selectedWindowInfo.title : "Record one app",
                () => {
                    setMode("windows");
                    loadWindows();
                }
            )}
        </div>
    );

    const pickerHeader = (title: string, onRefresh?: () => void) => (
        <div className="flex items-center justify-between mb-3">
            <button
                type="button"
                onClick={handleBack}
                className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
            >
                <IoArrowBack /> {title}
            </button>
            {onRefresh && (
                <button
                    type="button"
                    onClick={onRefresh}
                    className="p-2 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    title="Refresh"
                >
                    <IoReload />
                </button>
            )}
        </div>
    );

    const renderMonitors = () => (
        <div>
            {pickerHeader("Choose a monitor")}
            {isLoading ? (
                <div className="py-10 text-center text-sm text-neutral-500">Looking for displays…</div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {monitors.map((monitor) => (
                        <button
                            key={monitor.id}
                            type="button"
                            onClick={() => {
                                setSelectedMonitor(monitor.id);
                                setSelectedWindow(null);
                            }}
                            className={`p-4 rounded-2xl border text-left transition-all ${
                                selectedMonitor === monitor.id
                                    ? "border-emerald-500 bg-emerald-50/80 dark:bg-emerald-500/10 ring-4 ring-emerald-500/10"
                                    : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600"
                            }`}
                        >
                            <div
                                className="w-full rounded-lg bg-gradient-to-br from-slate-200 to-slate-300 dark:from-neutral-800 dark:to-neutral-700 mb-3 flex items-center justify-center text-neutral-400"
                                style={{ aspectRatio: `${monitor.width} / ${monitor.height}` }}
                            >
                                <FiMonitor className="text-3xl" />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold">{monitor.name}</span>
                                {monitor.is_primary && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300">
                                        Primary
                                    </span>
                                )}
                            </div>
                            <div className="text-xs text-neutral-500 dark:text-neutral-400">
                                {monitor.width} × {monitor.height}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderWindows = () => (
        <div>
            {pickerHeader("Choose a window", loadWindows)}
            {isLoading ? (
                <div className="py-10 text-center text-sm text-neutral-500">Finding open windows…</div>
            ) : windows.length === 0 ? (
                <div className="py-10 text-center text-sm text-neutral-500">No windows found. Try refreshing.</div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                    {windows.map((window: any) => (
                        <button
                            key={window.hwnd}
                            type="button"
                            onClick={() => handleWindowClick(window)}
                            className={`rounded-2xl border overflow-hidden text-left transition-all ${
                                selectedWindow === window.hwnd
                                    ? "border-emerald-500 ring-4 ring-emerald-500/15"
                                    : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm"
                            }`}
                        >
                            <div className="aspect-video bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
                                {window.imageUrl ? (
                                    <img
                                        src={window.imageUrl}
                                        alt={window.title}
                                        className="w-full h-full object-cover"
                                        onError={(e) => {
                                            (e.target as HTMLImageElement).style.display = "none";
                                        }}
                                    />
                                ) : (
                                    <IoApps className="text-3xl text-neutral-300 dark:text-neutral-600" />
                                )}
                            </div>
                            <div className="p-2.5">
                                <p className="text-xs font-medium truncate" title={window.title}>
                                    {window.title}
                                </p>
                                {/* Titles alone can be ambiguous, and thumbnails aren't always available. */}
                                {window.exe_path && (
                                    <p className="text-[10px] text-neutral-500 truncate" title={window.exe_path}>
                                        {window.exe_path.split(/[\\/]/).pop()}
                                    </p>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderCameraPanel = () => (
        <div className="space-y-6">
            <div>
                <SectionLabel>Shape</SectionLabel>
                <div className="grid grid-cols-3 gap-2">
                    {SHAPES.map((shape) => (
                        <button
                            key={shape.value}
                            type="button"
                            onClick={() => setOverlayShape(shape.value)}
                            className={`flex flex-col items-center gap-2 py-3 rounded-xl border transition-all ${
                                overlayShape === shape.value
                                    ? "border-emerald-500 bg-emerald-50/80 dark:bg-emerald-500/10"
                                    : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600"
                            }`}
                        >
                            <span
                                className={`w-9 h-9 bg-gradient-to-br from-neutral-300 to-neutral-400 dark:from-neutral-600 dark:to-neutral-500 ${shape.className}`}
                                style={border !== "none" ? { boxShadow: `0 0 0 ${border === "thick" ? 3 : border === "medium" ? 2 : 1}px ${borderColor}` } : undefined}
                            />
                            <span className="text-xs font-medium">{shape.label}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <SectionLabel hint="of the video's width">Size</SectionLabel>
                <Segmented
                    value={overlaySize}
                    onChange={setOverlaySize}
                    options={SIZES.map((s) => ({ value: s.value, label: s.label, title: `${s.hint} of the video's width` }))}
                />
            </div>

            <div>
                <SectionLabel>Position</SectionLabel>
                <div className="relative aspect-video rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50 p-2 grid grid-cols-3 grid-rows-3 gap-1.5">
                    {POSITIONS.map((pos) => (
                        <button
                            key={pos}
                            type="button"
                            title={POSITION_LABELS[pos]}
                            onClick={() => setOverlayPosition(pos)}
                            className={`flex ${pos.startsWith("top") ? "items-start" : pos.startsWith("bottom") ? "items-end" : "items-center"} ${
                                pos.endsWith("left") ? "justify-start" : pos.endsWith("right") ? "justify-end" : "justify-center"
                            } p-1.5 rounded-lg transition-colors ${
                                overlayPosition === pos ? "bg-emerald-500/10" : "hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60"
                            }`}
                        >
                            <span
                                className={`w-5 h-4 transition-all ${
                                    overlayShape === "circle" ? "rounded-full w-4" : overlayShape === "rounded" ? "rounded-md" : "rounded-sm"
                                } ${overlayPosition === pos ? "bg-emerald-500 shadow" : "bg-neutral-300 dark:bg-neutral-600"}`}
                            />
                        </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[11px] text-neutral-500">
                    {POSITION_LABELS[overlayPosition] ?? "Bottom right"}
                    {videoDevices.length > 1 ? " - several cameras line up in a row from here" : ""}
                </p>
            </div>

            <div>
                <SectionLabel>Border</SectionLabel>
                <Segmented
                    value={border}
                    onChange={(v) => updateBorder({ cameraBorder: v })}
                    options={BORDERS.map((b) => ({ value: b.value, label: b.label }))}
                />
                {border !== "none" && (
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                        {BORDER_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                title={c}
                                onClick={() => updateBorder({ cameraBorderColor: c })}
                                className={`w-7 h-7 rounded-full border border-black/10 dark:border-white/20 transition-transform hover:scale-110 ${
                                    borderColor.toLowerCase() === c ? "ring-2 ring-offset-2 ring-emerald-500 dark:ring-offset-neutral-900" : ""
                                }`}
                                style={{ background: c }}
                            />
                        ))}
                        <label
                            className="relative w-7 h-7 rounded-full border border-dashed border-neutral-400 dark:border-neutral-500 flex items-center justify-center cursor-pointer overflow-hidden"
                            title="Custom colour"
                            style={!BORDER_COLORS.includes(borderColor.toLowerCase()) ? { background: borderColor, borderStyle: "solid" } : undefined}
                        >
                            {BORDER_COLORS.includes(borderColor.toLowerCase()) && <span className="text-xs text-neutral-500">+</span>}
                            <input
                                type="color"
                                value={borderColor}
                                onChange={(e) => updateBorder({ cameraBorderColor: e.target.value })}
                                className="absolute inset-0 opacity-0 cursor-pointer"
                            />
                        </label>
                    </div>
                )}
            </div>

            {videoDevices.length === 1 && (
                <label className="flex items-start gap-3 p-3 rounded-xl border border-neutral-200 dark:border-neutral-700 cursor-pointer hover:border-neutral-300 dark:hover:border-neutral-600">
                    <input
                        type="checkbox"
                        checked={separateWebcamCapture}
                        onChange={() => setSeparateWebcamCapture((v) => !v)}
                        className="mt-0.5 w-4 h-4 accent-emerald-500"
                    />
                    <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                            <IoSwapHorizontal className="text-emerald-500" /> Record webcam separately
                        </span>
                        <span className="block mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                            Keeps the camera as its own layer: move, resize and restyle it later in the editor, and while
                            recording cut between your screen and a full-frame camera with <Kbd>{isMac ? "⌥" : "Alt"}</Kbd> <Kbd>Shift</Kbd> <Kbd>V</Kbd> or the Screen/Camera
                            buttons.
                        </span>
                    </span>
                </label>
            )}
        </div>
    );


    const isScreenType = recordType === "sva" || recordType === "sa" || recordType === "s";
    const hasMic = ["sva", "sa", "va", "a"].includes(recordType);
    const hasCamera = ["sva", "va", "v"].includes(recordType);
    const selectClass =
        "w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 focus:outline-none focus:ring-2 focus:ring-emerald-500/40";
    const toggleRow = (
        checked: boolean,
        onChange: () => void,
        icon: React.ReactNode,
        title: string,
        hint: string,
        disabled = false
    ) => (
        <label
            className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                disabled
                    ? "border-neutral-200 dark:border-neutral-800 opacity-50 cursor-not-allowed"
                    : checked
                    ? "border-emerald-500/60 bg-emerald-50/60 dark:bg-emerald-500/10 cursor-pointer"
                    : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 cursor-pointer"
            }`}
        >
            <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={onChange} className="mt-0.5 w-4 h-4 accent-emerald-500" />
            <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">{icon}{title}</span>
                <span className="block mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{hint}</span>
            </span>
        </label>
    );

    const renderOptions = () => (
        <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {hasMic && (
                    <div>
                        <SectionLabel>Microphone</SectionLabel>
                        <select className={selectClass} value={audioDevice} onChange={(e) => onAudioDeviceChange(e.target.value)}>
                            {connectedAudioDevices && connectedAudioDevices.length > 0 ? (
                                connectedAudioDevices.map((d) => (
                                    <option key={d} value={d}>{d}</option>
                                ))
                            ) : (
                                <option value="">No microphone detected</option>
                            )}
                        </select>
                    </div>
                )}
                <div>
                    <SectionLabel>File format</SectionLabel>
                    <select className={selectClass} value={fileExt.toLowerCase()} onChange={(e) => onFileExtChange(e.target.value)}>
                        {recordType === "c" ? (
                            <>
                                <option value="png">PNG</option>
                                <option value="jpeg">JPEG</option>
                                <option value="webp">WebP</option>
                            </>
                        ) : recordType === "a" ? (
                            <>
                                <option value="mp3">MP3</option>
                                <option value="wav">WAV</option>
                                <option value="aac">AAC</option>
                                <option value="wma">WMA</option>
                            </>
                        ) : (
                            <>
                                <option value="mp4">MP4 (recommended)</option>
                                <option value="mkv">MKV</option>
                                <option value="mov">MOV</option>
                                <option value="webm">WebM</option>
                                <option value="avi">AVI</option>
                            </>
                        )}
                    </select>
                </div>
                {isScreenType && (
                    <>
                        <div>
                            <SectionLabel>Resolution</SectionLabel>
                            <select
                                className={selectClass}
                                value={resolutionWidth ?? ""}
                                onChange={(e) => onResolutionWidthChange(e.target.value ? Number(e.target.value) : null)}
                            >
                                <option value="">Auto - full resolution on supported GPUs</option>
                                <option value="1280">720p</option>
                                <option value="1920">1080p</option>
                                <option value="2560">1440p</option>
                                <option value={NATIVE_RESOLUTION_WIDTH}>Native</option>
                            </select>
                        </div>
                        <div>
                            <SectionLabel>Frame rate</SectionLabel>
                            <select
                                className={selectClass}
                                value={framerate ?? ""}
                                onChange={(e) => onFramerateChange(e.target.value ? Number(e.target.value) : null)}
                            >
                                <option value="">Auto - 60 fps on supported GPUs</option>
                                <option value="24">24 fps</option>
                                <option value="30">30 fps</option>
                                <option value="60">60 fps</option>
                            </select>
                        </div>
                    </>
                )}
            </div>

            {hasCamera && (
                <div>
                    <SectionLabel
                        hint={
                            <button type="button" onClick={onRefreshDevices} className="flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200">
                                <IoReload /> Refresh
                            </button>
                        }
                    >
                        Cameras
                    </SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {connectedCameraDevices && connectedCameraDevices.length > 0 ? (
                            connectedCameraDevices.map((device) => {
                                const isPhone = device === PHONE_CAMERA_DEVICE;
                                const on = videoDevices.includes(device);
                                return (
                                    <button
                                        key={device}
                                        type="button"
                                        onClick={() => (isPhone && !isPhoneCameraConnected ? onOpenPhoneCamera() : onToggleVideoDevice(device))}
                                        className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors ${
                                            on
                                                ? "border-emerald-500 bg-emerald-50/80 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                                                : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600"
                                        }`}
                                    >
                                        {isPhone ? <IoPhonePortraitOutline /> : <IoVideocam />}
                                        <span className="truncate max-w-[14rem]">{isPhone ? PHONE_CAMERA_LABEL : device}</span>
                                        {isPhone && (
                                            <span
                                                className={`text-[10px] px-1.5 py-px rounded-full ${
                                                    isPhoneCameraConnected
                                                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                                        : "bg-neutral-100 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400"
                                                }`}
                                            >
                                                {isPhoneCameraConnected ? "Connected" : "Set up"}
                                            </span>
                                        )}
                                    </button>
                                );
                            })
                        ) : (
                            <span className="text-sm text-neutral-500">No cameras detected</span>
                        )}
                    </div>
                </div>
            )}

            {isScreenType && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {toggleRow(
                        includeSystemAudio,
                        onToggleIncludeSystemAudio,
                        <IoVolumeHigh className="text-emerald-500" />,
                        "System audio",
                        "Also record what's playing through your speakers."
                    )}
                    {toggleRow(
                        trackClicks,
                        onToggleTrackClicks,
                        <IoHandLeftOutline className="text-emerald-500" />,
                        "Track clicks",
                        isClickTrackingSupported
                            ? "Remember where you click, so the editor can zoom in on each one."
                            : "Windows-only for now.",
                        !isClickTrackingSupported
                    )}
                </div>
            )}
        </div>
    );

    if (!isOpenScreen) return null;

    const summary =
        selectedMonitorInfo
            ? `Monitor · ${selectedMonitorInfo.name}`
            : selectedWindowInfo
            ? `Window · ${selectedWindowInfo.title}`
            : "Full screen";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5">
            <div className="absolute inset-0 bg-neutral-950/60 backdrop-blur-sm" onClick={closeModal} />

            <div className="relative w-full max-w-[1600px] h-full max-h-[1000px] flex flex-col rounded-3xl bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 shadow-2xl ring-1 ring-black/5 dark:ring-white/10 overflow-hidden">
                {/* Header */}
                <div className="flex items-center gap-4 px-6 py-4 border-b border-neutral-200/80 dark:border-neutral-800">
                    <div className="min-w-0">
                        {editingName ? (
                            <input
                                autoFocus
                                value={fileName}
                                onChange={(e) => onFileNameChange(e.target.value)}
                                onBlur={() => setEditingName(false)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === "Escape") {
                                        e.stopPropagation();
                                        setEditingName(false);
                                    }
                                }}
                                placeholder={recordType === "c" ? "Screenshot name" : "Recording name"}
                                className="text-lg font-semibold leading-tight bg-transparent border-b-2 border-emerald-500 outline-none w-72 max-w-full"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => setEditingName(true)}
                                title="Rename"
                                className="group flex items-center gap-2 text-lg font-semibold leading-tight text-left max-w-[28rem]"
                            >
                                <span className="truncate">
                                    {fileName.trim() || (recordType === "c" ? "Take a screenshot" : "New recording")}
                                </span>
                                <IoPencil className="text-sm text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                            </button>
                        )}
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                            {RECORD_TYPE_LABELS[recordType] ?? recordType}
                        </p>
                    </div>
                    {/* Screenshot is a separate flow the caller manages - switching type mid-way would fight it. */}
                    {recordType !== "c" && (
                        <div className="hidden md:flex mx-auto p-1 gap-1 rounded-2xl bg-neutral-100 dark:bg-neutral-800/80">
                            {RECORD_TYPE_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    title={RECORD_TYPE_LABELS[opt.value]}
                                    onClick={() => opt.value !== recordType && onRecordTypeChange(opt.value)}
                                    className={`flex items-center gap-1 px-3 py-1.5 rounded-xl text-sm transition-all ${
                                        opt.value === recordType
                                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                                            : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                                    }`}
                                >
                                    {opt.icons}
                                </button>
                            ))}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={closeModal}
                        className="ml-auto p-2 rounded-xl text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-white"
                        title="Close (Esc)"
                    >
                        <IoClose className="text-2xl" />
                    </button>
                </div>

                {/* Body */}
                <div className={`flex-1 min-h-0 grid ${hasCameraBubble ? "lg:grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1"}`}>
                    <div className="min-h-0 overflow-y-auto p-6 space-y-6">
                        {!isCameraOnly && !isAudioOnly && (
                            <>
                                <div>
                                    <SectionLabel>What to record</SectionLabel>
                                    {renderSources()}
                                </div>
                                {mode === "monitors" && renderMonitors()}
                                {mode === "windows" && renderWindows()}
                                {mode === "main" && hasCameraBubble && (
                                    <div>
                                        <SectionLabel hint="live">Preview</SectionLabel>
                                        <CameraOverlayPreview
                                            videoDevices={videoDevices}
                                            overlayShape={overlayShape}
                                            overlayPosition={overlayPosition}
                                            overlaySize={overlaySize}
                                            overlayBorder={border}
                                            overlayBorderColor={borderColor}
                                            showLabel={false}
                                        />
                                    </div>
                                )}
                            </>
                        )}
                        {isCameraOnly && (
                            <div className="max-w-4xl mx-auto space-y-3">
                                <SectionLabel hint="live">Camera</SectionLabel>
                                <CameraOverlayPreview
                                    videoDevices={videoDevices}
                                    overlayShape={overlayShape}
                                    overlayPosition={overlayPosition}
                                    overlaySize={overlaySize}
                                    variant="full"
                                    showLabel={false}
                                />
                                <p className="text-sm text-neutral-500 dark:text-neutral-400">
                                    {videoDevices.length === 0
                                        ? "Pick a camera in the recording bar's Video device(s) list to record."
                                        : "Only the camera is recorded - nothing on your screen is captured."}
                                </p>
                            </div>
                        )}
                        {isAudioOnly && (
                            <div className="flex flex-col items-center justify-center text-center gap-3 py-10">
                                <span className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center text-3xl">
                                    <IoMic />
                                </span>
                                <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-sm">
                                    Recording audio only - no screen or camera is captured. Press Start when you're ready.
                                </p>
                            </div>
                        )}
                        {recordType !== "c" && (
                            <div className="pt-2 border-t border-neutral-200/80 dark:border-neutral-800">
                                <div className="pt-4">
                                    <SectionLabel>Options</SectionLabel>
                                </div>
                                {renderOptions()}
                            </div>
                        )}
                    </div>

                    {hasCameraBubble && (
                        <aside className="min-h-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-900/60 p-6">
                            <div className="flex items-center gap-2 mb-5">
                                <IoVideocam className="text-emerald-500" />
                                <h3 className="text-sm font-semibold">Camera</h3>
                                {videoDevices.length === 0 && (
                                    <span className="ml-auto text-[11px] text-amber-600 dark:text-amber-400">No camera selected</span>
                                )}
                            </div>
                            {mode !== "main" && (
                                <div className="mb-6">
                                    <CameraOverlayPreview
                                        videoDevices={videoDevices}
                                        overlayShape={overlayShape}
                                        overlayPosition={overlayPosition}
                                        overlaySize={overlaySize}
                                        overlayBorder={border}
                                        overlayBorderColor={borderColor}
                                        showLabel={false}
                                    />
                                </div>
                            )}
                            {renderCameraPanel()}
                        </aside>
                    )}
                </div>

                {/* Footer */}
                <div className="flex items-center gap-4 px-6 py-4 border-t border-neutral-200/80 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/80">
                    <div className="min-w-0 flex items-center gap-2 text-sm">
                        {!isCameraOnly && !isAudioOnly && (
                            <span className="truncate px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs font-medium">
                                {summary}
                            </span>
                        )}
                        <span className="hidden lg:flex items-center gap-1 text-xs text-neutral-400">
                            <Kbd>{MOD}</Kbd>
                            <Kbd>Shift</Kbd>
                            <Kbd>R</Kbd>
                            <span className="ml-1">starts and stops a recording anytime</span>
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => confirmAndStart(resolveCurrentTarget())}
                        className="ml-auto flex items-center gap-2 px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white text-sm font-semibold shadow-sm shadow-emerald-600/30 transition-all"
                    >
                        <span className="w-2.5 h-2.5 rounded-full bg-white/90" />
                        {recordType === "c" ? "Take Screenshot" : "Start Recording"}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default EnhancedScreenOptions;
