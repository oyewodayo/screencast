import { IoClose, IoScanOutline, IoApps, IoReload, IoArrowBack, IoVideocam, IoMic, IoDesktopOutline, IoSwapHorizontal, IoPencil, IoPhonePortraitOutline, IoVolumeHigh, IoHandLeftOutline, IoTvOutline, IoSearch, IoNavigateOutline, IoBrowsersOutline, IoShieldCheckmarkOutline, IoInformationCircleOutline, IoSparklesOutline, IoKeypadOutline } from "react-icons/io5";
import { PHONE_CAMERA_DEVICE, PHONE_CAMERA_LABEL } from "../services/phoneCamera";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { startTransition, useEffect, useRef, useState } from "react";
import { FiMonitor } from "react-icons/fi";
import { WindowInfo, MonitorInfo, CaptureCapabilities } from "../Types";
import CameraOverlayPreview from "./CameraOverlayPreview";
import LiveMicMeter from "./LiveMicMeter";
import { RECORD_TYPE_LABELS } from "./ActiveRecordingState";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_CHANGED_DOM_EVENT, type AppSettings, type CameraBackgroundPref } from "../utils/appSettings";
import { isPrivacyShieldArmed, privacyShieldSummary } from "../utils/privacyShield";
import { backgroundRemovalStatus, downloadBackgroundEngine } from "../utils/backgroundRemoval";
import { BACKGROUND_SWATCHES } from "../utils/cutoutBackground";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { PresentationPanel, startOrStopPresentation, usePresentation } from "./PresentationControls";
import { getPresentationState } from "../services/presentation";
import ColorInput from "./common/ColorInput";

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
    // Opens Settings directly on Annotate & Privacy Shield without discarding the setup modal.
    onOpenAnnotationSettings?: () => void;
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

// A segmented control - one subtle track, the active option raised cleanly on it.
const Segmented = <T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: React.ReactNode; title?: string }[];
    onChange: (v: T) => void;
}) => (
    <div className="flex p-0.5 gap-0.5 rounded-lg bg-neutral-200/70 dark:bg-neutral-800/90 ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
        {options.map((o) => (
            <button
                key={o.value}
                type="button"
                title={o.title}
                onClick={() => onChange(o.value)}
                className={`flex-1 px-2 py-1.5 rounded-[7px] text-xs font-medium transition-colors duration-100 ${
                    value === o.value
                        ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                }`}
            >
                {o.label}
            </button>
        ))}
    </div>
);

// Crisp tactile pill switch used across capture/studio options (replaces heavy checkbox cards).
const ToggleSwitch = ({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) => (
    <span
        aria-hidden="true"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 ${
            disabled
                ? "bg-neutral-200 dark:bg-neutral-800"
                : checked
                ? "bg-emerald-600 dark:bg-emerald-500"
                : "bg-neutral-300/90 dark:bg-neutral-700"
        }`}
    >
        <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-150 ${
                checked && !disabled ? "translate-x-[18px]" : "translate-x-[3px]"
            }`}
        />
    </span>
);

const SectionLabel = ({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) => (
    <div className="flex items-baseline justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-400">{children}</span>
        {hint && <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{hint}</span>}
    </div>
);

const Kbd = ({ children }: { children: React.ReactNode }) => (
    <kbd className="px-1.5 py-0.5 rounded-[5px] border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[10px] font-mono text-neutral-500 dark:text-neutral-300 shadow-[0_1px_0_rgba(0,0,0,0.06)]">
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
    setOpen: _setOpen,
    setSelectedScreen,
    onRecordTypeChange,
    onOpenAnnotationSettings,
    error,
}: ScreenOptionsProps) => {
    const [mode, setMode] = useState<SelectionMode>("main");
    // Optimistic local mirrors for props owned by the large parent Dashboard.tsx: clicking shape,
    // size, position, or record-type buttons paints in <16 ms while parent reconciliation runs
    // non-blockingly inside startTransition.
    const [localShape, setLocalShape] = useState(overlayShape);
    const [localSize, setLocalSize] = useState(overlaySize);
    const [localPosition, setLocalPosition] = useState(overlayPosition);
    const [localRecordType, setLocalRecordType] = useState(recordType);
    const [localSeparateCam, setLocalSeparateCam] = useState(separateWebcamCapture);
    const [localSystemAudio, setLocalSystemAudio] = useState(includeSystemAudio);
    const [localTrackClicks, setLocalTrackClicks] = useState(trackClicks);
    useEffect(() => setLocalShape(overlayShape), [overlayShape]);
    useEffect(() => setLocalSize(overlaySize), [overlaySize]);
    useEffect(() => setLocalPosition(overlayPosition), [overlayPosition]);
    useEffect(() => setLocalRecordType(recordType), [recordType]);
    useEffect(() => setLocalSeparateCam(separateWebcamCapture), [separateWebcamCapture]);
    useEffect(() => setLocalSystemAudio(includeSystemAudio), [includeSystemAudio]);
    useEffect(() => setLocalTrackClicks(trackClicks), [trackClicks]);

    const pickShape = (v: string) => {
        setLocalShape(v);
        startTransition(() => setOverlayShape(v));
    };
    const pickSize = (v: string) => {
        setLocalSize(v);
        startTransition(() => setOverlaySize(v));
    };
    const pickPosition = (v: string) => {
        setLocalPosition(v);
        startTransition(() => setOverlayPosition(v));
    };
    const pickRecordType = (v: string) => {
        if (v === localRecordType) return;
        setLocalRecordType(v);
        startTransition(() => onRecordTypeChange(v));
    };
    const toggleSeparateCam = () => {
        setLocalSeparateCam((v) => !v);
        startTransition(() => setSeparateWebcamCapture((v) => !v));
    };
    const toggleSystemAudio = () => {
        setLocalSystemAudio((v) => !v);
        startTransition(() => onToggleIncludeSystemAudio());
    };
    const toggleTrackClicks = () => {
        setLocalTrackClicks((v) => !v);
        startTransition(() => onToggleTrackClicks());
    };
    // "Present": the live camera display (PresentationControls.tsx) instead of a recording setup.
    // Opens straight into it while the display is live, so reopening the modal finds the controls.
    const [presentMode, setPresentMode] = useState(() => getPresentationState().active);
    const presentation = usePresentation();
    const [presentError, setPresentError] = useState<string | null>(null);
    const togglePresentation = async () => {
        setPresentError(null);
        try {
            await startOrStopPresentation(presentation.active);
        } catch (err) {
            setPresentError(String(err));
        }
    };
    // The header title doubles as the recording's file name - click it to rename.
    const [editingName, setEditingName] = useState(false);
    const isCameraOnly = CAMERA_ONLY_TYPES.includes(localRecordType);
    const isAudioOnly = AUDIO_ONLY_TYPES.includes(localRecordType);
    const hasCameraBubble = localRecordType === "sva";
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [windows, setWindows] = useState<WindowInfo[]>([]);
    const [selectedMonitor, setSelectedMonitor] = useState<string>("");
    const [selectedWindow, setSelectedWindow] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    // Narrows the window grid by title or app name - with a dozen windows open, typing "chr" beats
    // scanning thumbnails.
    const [windowQuery, setWindowQuery] = useState("");
    // Small live pictures of each monitor (temp PNGs), keyed by monitor id.
    const [monitorPreviews, setMonitorPreviews] = useState<Record<string, string>>({});
    // Whether a picked window is recorded on its own - decides what the picker promises.
    const [caps, setCaps] = useState<CaptureCapabilities | null>(null);
    useEffect(() => {
        invoke<CaptureCapabilities>("get_capture_capabilities")
            .then(setCaps)
            .catch(() => setCaps({ window_isolated: false }));
    }, []);
    // Proactive macOS privacy permission checks (Screen Recording + Accessibility) so users get
    // one-click onboarding instead of an opaque ffmpeg failure or blank capture.
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const [macPerms, setMacPerms] = useState<{ screen_recording: boolean; accessibility: boolean } | null>(null);
    useEffect(() => {
        if (!isMac || !isOpenScreen) return;
        let active = true;
        const refresh = () => {
            invoke<{ screen_recording: boolean; accessibility: boolean }>("check_macos_permissions")
                .then((st) => {
                    if (active) setMacPerms(st);
                })
                .catch(() => {});
        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
            active = false;
            window.removeEventListener("focus", refresh);
        };
    }, [isMac, isOpenScreen]);
    // Remembered between recordings (appSettings) and sent with every capture by Dashboard.
    const [captureCursor, setCaptureCursor] = useState(() => loadSettings().captureCursor);
    const [windowTitleBar, setWindowTitleBar] = useState(() => loadSettings().windowTitleBar);
    const [editablePointer, setEditablePointer] = useState(() => loadSettings().editablePointer);
    const [recordShortcuts, setRecordShortcuts] = useState(() => loadSettings().recordShortcuts);
    const [shieldSettings, setShieldSettings] = useState<AppSettings>(() => loadSettings());
    useEffect(() => {
        const onSettings = (e: Event) => {
            const detail = (e as CustomEvent<AppSettings>).detail;
            setShieldSettings(detail ?? loadSettings());
        };
        window.addEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
        return () => window.removeEventListener(SETTINGS_CHANGED_DOM_EVENT, onSettings);
    }, []);
    const updateShieldPrefs = (patch: Partial<AppSettings>) => {
        const next = { ...loadSettings(), ...patch };
        saveSettings(next);
        setShieldSettings(next);
    };
    const updateCapturePrefs = (next: { captureCursor?: boolean; windowTitleBar?: boolean; editablePointer?: boolean; recordShortcuts?: boolean }) => {
        saveSettings({ ...loadSettings(), ...next });
        if (next.captureCursor !== undefined) setCaptureCursor(next.captureCursor);
        if (next.windowTitleBar !== undefined) setWindowTitleBar(next.windowTitleBar);
        if (next.editablePointer !== undefined) setEditablePointer(next.editablePointer);
        if (next.recordShortcuts !== undefined) setRecordShortcuts(next.recordShortcuts);
    };
    // Pointer and shortcut recording is implemented on Windows (Win32 hooks), macOS (CoreGraphics),
    // and Linux (X11 via x11rb) in services/input_tracker.rs.
    const inputTrackingSupported = true;
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
    // Live background behind you in the bubble (cameraEffect.ts), remembered between recordings.
    // The engine downloads once, the first time it's wanted; the preview then shows the real effect.
    const [cameraBg, setCameraBg] = useState<CameraBackgroundPref>(() => loadSettings().cameraBackground ?? DEFAULT_SETTINGS.cameraBackground);
    const [blurDraft, setBlurDraft] = useState<number>(() => (loadSettings().cameraBackground ?? DEFAULT_SETTINGS.cameraBackground).amount);
    const blurCommitTimerRef = useRef<number | null>(null);
    const updateCameraBg = (patch: Partial<CameraBackgroundPref>) => {
        setCameraBg((prev) => {
            const next = { ...prev, ...patch };
            saveSettings({ ...loadSettings(), cameraBackground: next });
            return next;
        });
    };
    const handleBlurSliderChange = (value: number) => {
        setBlurDraft(value);
        if (blurCommitTimerRef.current !== null) window.clearTimeout(blurCommitTimerRef.current);
        blurCommitTimerRef.current = window.setTimeout(() => {
            blurCommitTimerRef.current = null;
            updateCameraBg({ amount: value });
        }, 60);
    };
    const flushBlurSlider = () => {
        if (blurCommitTimerRef.current !== null) {
            window.clearTimeout(blurCommitTimerRef.current);
            blurCommitTimerRef.current = null;
            updateCameraBg({ amount: blurDraft });
        }
    };
    useEffect(() => {
        return () => {
            if (blurCommitTimerRef.current !== null) window.clearTimeout(blurCommitTimerRef.current);
        };
    }, []);
    const [engine, setEngine] = useState<{ state: "unknown" | "ready" | "needs-download" | "unsupported" | "downloading" | "failed"; progress?: number; mb?: number }>({ state: "unknown" });
    const [engineGeneration, setEngineGeneration] = useState(0);
    useEffect(() => {
        backgroundRemovalStatus()
            .then((st) => setEngine({ state: st.state, mb: st.downloadMb }))
            .catch(() => setEngine({ state: "unsupported" }));
    }, []);
    const getEngine = () => {
        setEngine((e) => ({ ...e, state: "downloading", progress: 0 }));
        downloadBackgroundEngine((progress) => setEngine((e) => ({ ...e, state: "downloading", progress })))
            .then(() => {
                setEngine({ state: "ready" });
                setEngineGeneration((g) => g + 1);
            })
            .catch(() => setEngine((e) => ({ ...e, state: "failed" })));
    };
    // What the preview (and so the feed) is given: nothing until the engine is there.
    const previewBg = engine.state === "ready" ? cameraBg : undefined;
    const pickBgPicture = async () => {
        const selected = await openFileDialog({ multiple: false, filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }] });
        if (typeof selected === "string") updateCameraBg({ kind: "image", imagePath: selected });
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
            iconUrl: window.icon_path ? convertFileSrc(window.icon_path) : undefined,
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

    // Preload a lightweight monitor snapshot for the main preview when opening in a screen+camera
    // mode so the user sees their actual display behind the camera bubble instead of a blank box.
    useEffect(() => {
        if (!isOpenScreen || !hasCameraBubble || Object.keys(monitorPreviewsRef.current).length > 0) return;
        loadMonitorPreviews();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpenScreen, hasCameraBubble]);

    // If the parent's window-capture invoke rejects outright, selectScreen never flips true and
    // the effect above never runs - clear isLoading on an error that's new since this load began.
    useEffect(() => {
        if (mode === "windows" && isLoading && error && error !== loadErrorBaselineRef.current) {
            setIsLoading(false);
        }
    }, [mode, isLoading, error]);

    useEffect(() => {
        return () => {
            const tempFilePaths = windows
                .flatMap((w) => [w.image_path, w.icon_path])
                .filter((path): path is string => !!path && path.includes("briefcast_window_"));
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
        // The pictures come after the list - a moment later, never holding it up.
        loadMonitorPreviews();
    };

    const loadMonitorPreviews = () => {
        invoke<Record<string, string>>("get_monitor_previews")
            .then((paths) => {
                setMonitorPreviews((old) => {
                    const stale = Object.values(old);
                    if (stale.length > 0) invoke("cleanup_screenshot_files", { filePaths: stale }).catch(() => {});
                    return paths;
                });
            })
            .catch((err) => console.error("Failed to load monitor previews:", err));
    };

    // Monitor previews are temp files too - gone with the dialog.
    const monitorPreviewsRef = useRef(monitorPreviews);
    monitorPreviewsRef.current = monitorPreviews;
    useEffect(() => {
        return () => {
            const paths = Object.values(monitorPreviewsRef.current);
            if (paths.length > 0) invoke("cleanup_screenshot_files", { filePaths: paths }).catch(() => {});
        };
    }, []);

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
        // Single state update to unmount cleanly — avoids double-triggering setOpen + setMode
        // while the component is already unmounting.
        onCloseScreen();
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

    // Close the modal FIRST so browser preview tracks (useCameraStreams / LiveMicMeter) unmount
    // and release DirectShow/WASAPI handles before ffmpeg tries to open the camera/mic.
    const confirmAndStart = (target: SelectionTarget) => {
        setScreenSize(target.screenSize);
        setSelectedScreen(target.selectedScreen);
        closeModal();
        window.setTimeout(() => {
            onStartRecording(target);
        }, 120);
    };

    // Screenshotting a window is a single click: picking it *is* confirming the target. Video
    // recording keeps select-then-confirm, since a recording has room to be corrected. A window
    // captured on its own is taken where it is; otherwise it's brought forward first.
    const handleWindowClick = async (window: WindowInfo & { hwnd: number }) => {
        setSelectedWindow(window.hwnd);
        setSelectedMonitor("");
        if (recordType === "c") {
            if (!caps?.window_isolated) {
                try {
                    await invoke("activate_and_open_window", { title: window.title, hwnd: window.hwnd });
                } catch (err) {
                    console.error("Failed to activate window:", err);
                }
            }
            confirmAndStart({ screenSize: `window:${window.hwnd}`, selectedScreen: window.title || "" });
        }
    };

    // Enter starts, Escape closes - the two things a keyboard user reaches for in a dialog.
    // Keep the latest handler in a ref so the window listener binds once while open rather than
    // tearing down and re-attaching on every re-render.
    const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
    keyHandlerRef.current = (e: KeyboardEvent) => {
        if (e.key === "Escape") closeModal();
        if (e.key === "Enter" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLButtonElement)) {
            if (presentMode) {
                if (!presentation.active) void togglePresentation();
            } else confirmAndStart(resolveCurrentTarget());
        }
    };
    useEffect(() => {
        if (!isOpenScreen) return;
        const onKey = (e: KeyboardEvent) => keyHandlerRef.current(e);
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isOpenScreen]);

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
            className={`group flex items-center gap-3 px-3.5 py-3 rounded-xl border text-left transition-colors duration-100 ${
                active
                    ? "border-emerald-600/80 dark:border-emerald-500/80 bg-emerald-50/50 dark:bg-emerald-500/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
                    : "border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-neutral-900/60 hover:border-neutral-300 dark:hover:border-neutral-700 hover:bg-neutral-50/70 dark:hover:bg-neutral-800/50"
            }`}
        >
            <span
                className={`flex items-center justify-center w-9 h-9 rounded-lg text-lg shrink-0 transition-colors duration-100 ${
                    active
                        ? "bg-emerald-600 text-white shadow-sm"
                        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 group-hover:bg-neutral-200/80 dark:group-hover:bg-neutral-700"
                }`}
            >
                {icon}
            </span>
            <span className="min-w-0">
                <span className="block text-[13px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">{title}</span>
                <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 truncate">{subtitle}</span>
            </span>
        </button>
    );

    const selectedMonitorInfo = monitors.find((m) => m.id === selectedMonitor);
    const selectedWindowInfo = windows.find((w) => w.hwnd === selectedWindow);

    const renderSources = () => (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Not lit while a monitor or window is being picked - only one source looks chosen. */}
            {sourceCard(fullscreenSelected && mode === "main", <IoScanOutline />, "Full screen", "Your whole display", () => {
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
                selectedWindowInfo
                    ? selectedWindowInfo.title
                    : caps?.window_isolated
                    ? "Just one app - even behind others"
                    : "Record one app",
                () => {
                    setMode("windows");
                    loadWindows();
                }
            )}
        </div>
    );

    const pickerHeader = (title: string, onRefresh?: () => void, extra?: React.ReactNode) => (
        <div className="flex items-center gap-3 mb-3">
            <button
                type="button"
                onClick={handleBack}
                className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-white shrink-0"
            >
                <IoArrowBack /> {title}
            </button>
            <div className="flex-1 min-w-0 flex justify-end">{extra}</div>
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
            {pickerHeader("Choose a monitor", loadMonitors)}
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
                                className="w-full rounded-lg overflow-hidden bg-gradient-to-br from-slate-200 to-slate-300 dark:from-neutral-800 dark:to-neutral-700 mb-3 flex items-center justify-center text-neutral-400 ring-1 ring-black/5 dark:ring-white/10"
                                style={{ aspectRatio: `${monitor.width} / ${monitor.height}` }}
                            >
                                {monitorPreviews[monitor.id] ? (
                                    <img src={convertFileSrc(monitorPreviews[monitor.id])} alt={monitor.name} className="w-full h-full object-cover" />
                                ) : (
                                    <FiMonitor className="text-3xl" />
                                )}
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

    const query = windowQuery.trim().toLowerCase();
    const shownWindows = query
        ? windows.filter((w) => `${w.title} ${w.app_name ?? ""} ${w.exe_path?.split(/[\\/]/).pop() ?? ""}`.toLowerCase().includes(query))
        : windows;

    const renderWindows = () => (
        <div>
            {pickerHeader(
                "Choose a window",
                loadWindows,
                windows.length > 6 && (
                    <label className="relative w-full max-w-xs">
                        <IoSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                        <input
                            value={windowQuery}
                            onChange={(e) => setWindowQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape" && windowQuery) {
                                    e.stopPropagation();
                                    setWindowQuery("");
                                }
                            }}
                            placeholder="Find a window or app"
                            className="w-full pl-9 pr-3 py-1.5 rounded-xl text-sm bg-neutral-100 dark:bg-neutral-800 border border-transparent focus:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                        />
                    </label>
                )
            )}
            {caps && (
                <div
                    className={`mb-3 flex items-start gap-2 px-3 py-2 rounded-xl text-xs ${
                        caps.window_isolated
                            ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                            : "bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-200"
                    }`}
                >
                    {caps.window_isolated ? <IoShieldCheckmarkOutline className="mt-px shrink-0 text-sm" /> : <IoInformationCircleOutline className="mt-px shrink-0 text-sm" />}
                    <span>
                        {caps.window_isolated
                            ? recordType === "c"
                                ? "Captures just this window, exactly as it is - even if other windows cover it. Nothing is brought to the front."
                                : "Records just this window - other windows on top of it and the apps you switch to stay out of the video. It follows the window if you move it."
                            : "This window is recorded as the part of the screen it covers - keep it in front while recording."}
                    </span>
                </div>
            )}
            {isLoading ? (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3" aria-label="Finding open windows">
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="rounded-2xl border border-neutral-200 dark:border-neutral-800 overflow-hidden animate-pulse">
                            <div className="aspect-video bg-neutral-100 dark:bg-neutral-800" />
                            <div className="p-2.5 space-y-1.5">
                                <div className="h-3 rounded bg-neutral-100 dark:bg-neutral-800 w-3/4" />
                                <div className="h-2.5 rounded bg-neutral-100 dark:bg-neutral-800 w-1/3" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : windows.length === 0 ? (
                <div className="py-10 text-center text-sm text-neutral-500">No windows found. Try refreshing.</div>
            ) : shownWindows.length === 0 ? (
                <div className="py-10 text-center text-sm text-neutral-500">No window matches "{windowQuery}".</div>
            ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                    {shownWindows.map((window: any) => {
                        const exeName = window.exe_path ? window.exe_path.split(/[\\/]/).pop() : "";
                        const appLabel = window.app_name || exeName;
                        return (
                            <button
                                key={window.hwnd}
                                type="button"
                                onClick={() => handleWindowClick(window)}
                                title={window.exe_path || window.title}
                                className={`group rounded-2xl border overflow-hidden text-left transition-all ${
                                    selectedWindow === window.hwnd
                                        ? "border-emerald-500 ring-4 ring-emerald-500/15"
                                        : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 hover:shadow-sm"
                                }`}
                            >
                                <div className="relative aspect-video bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center overflow-hidden">
                                    {window.imageUrl ? (
                                        <img
                                            src={window.imageUrl}
                                            alt={window.title}
                                            className="w-full h-full object-cover object-top"
                                            onError={(e) => {
                                                (e.target as HTMLImageElement).style.display = "none";
                                            }}
                                        />
                                    ) : window.iconUrl ? (
                                        <img src={window.iconUrl} alt="" className="w-12 h-12 opacity-90" />
                                    ) : (
                                        <IoBrowsersOutline className="text-3xl text-neutral-300 dark:text-neutral-600" />
                                    )}
                                    <span className="absolute top-2 left-2 flex gap-1">
                                        {window.is_own && (
                                            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-600 text-white shadow-sm">Briefcast</span>
                                        )}
                                        {window.is_minimized && (
                                            <span
                                                className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-neutral-900/70 text-white backdrop-blur-sm"
                                                title="Minimized - it's restored for the capture without taking focus"
                                            >
                                                Minimized
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="p-2.5 flex items-start gap-2">
                                    {window.iconUrl ? (
                                        <img src={window.iconUrl} alt="" className="w-4 h-4 mt-px shrink-0" />
                                    ) : (
                                        <IoApps className="w-4 h-4 mt-px shrink-0 text-neutral-400" />
                                    )}
                                    <span className="min-w-0">
                                        <span className="block text-xs font-medium truncate">{window.title}</span>
                                        <span className="block text-[10px] text-neutral-500 truncate">
                                            {appLabel}
                                            {window.width && window.height ? ` · ${window.width} × ${window.height}` : ""}
                                        </span>
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const renderCameraPanel = () => (
        <div className="space-y-5">
            <div>
                <SectionLabel>Shape</SectionLabel>
                <div className="grid grid-cols-3 gap-2">
                    {SHAPES.map((shape) => (
                        <button
                            key={shape.value}
                            type="button"
                            onClick={() => pickShape(shape.value)}
                            className={`flex flex-col items-center gap-2 py-2.5 rounded-xl border transition-colors duration-100 ${
                                localShape === shape.value
                                    ? "border-emerald-600/80 dark:border-emerald-500/80 bg-white dark:bg-neutral-800/90 shadow-sm"
                                    : "border-neutral-200/80 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/40 hover:border-neutral-300 dark:hover:border-neutral-700"
                            }`}
                        >
                            <span
                                className={`w-8 h-8 bg-gradient-to-br from-neutral-300 to-neutral-400 dark:from-neutral-600 dark:to-neutral-500 ${shape.className}`}
                                style={border !== "none" ? { boxShadow: `0 0 0 ${border === "thick" ? 3 : border === "medium" ? 2 : 1}px ${borderColor}` } : undefined}
                            />
                            <span className={`text-[11px] font-medium ${localShape === shape.value ? "text-neutral-900 dark:text-white" : "text-neutral-600 dark:text-neutral-400"}`}>
                                {shape.label}
                            </span>
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <SectionLabel hint="of frame width">Size</SectionLabel>
                <Segmented
                    value={localSize}
                    onChange={pickSize}
                    options={SIZES.map((s) => ({ value: s.value, label: s.label, title: `${s.hint} of the video's width` }))}
                />
            </div>

            <div>
                <SectionLabel hint={POSITION_LABELS[localPosition] ?? "Bottom right"}>Position</SectionLabel>
                <div className="relative aspect-video rounded-xl border border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-neutral-900/70 p-2 grid grid-cols-3 grid-rows-3 gap-1">
                    {POSITIONS.map((pos) => (
                        <button
                            key={pos}
                            type="button"
                            title={POSITION_LABELS[pos]}
                            onClick={() => pickPosition(pos)}
                            className={`flex ${pos.startsWith("top") ? "items-start" : pos.startsWith("bottom") ? "items-end" : "items-center"} ${
                                pos.endsWith("left") ? "justify-start" : pos.endsWith("right") ? "justify-end" : "justify-center"
                            } p-1.5 rounded-lg transition-colors duration-100 ${
                                localPosition === pos
                                    ? "bg-emerald-500/12 dark:bg-emerald-500/15"
                                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800/80"
                            }`}
                        >
                            <span
                                className={`h-3.5 transition-colors duration-100 ${
                                    localShape === "circle"
                                        ? "rounded-full w-3.5"
                                        : localShape === "rounded"
                                        ? "rounded-[4px] w-4.5"
                                        : "rounded-[2px] w-4.5"
                                } ${localPosition === pos ? "bg-emerald-600 dark:bg-emerald-500 shadow-sm" : "bg-neutral-300 dark:bg-neutral-700"}`}
                            />
                        </button>
                    ))}
                </div>
                {videoDevices.length > 1 && (
                    <p className="mt-1.5 text-[11px] text-neutral-500">
                        Multiple cameras line up horizontally from this anchor.
                    </p>
                )}
            </div>

            <div>
                <SectionLabel>Border</SectionLabel>
                <Segmented
                    value={border}
                    onChange={(v) => updateBorder({ cameraBorder: v })}
                    options={BORDERS.map((b) => ({ value: b.value, label: b.label }))}
                />
                {border !== "none" && (
                    <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                        {BORDER_COLORS.map((c) => (
                            <button
                                key={c}
                                type="button"
                                title={c}
                                onClick={() => updateBorder({ cameraBorderColor: c })}
                                className={`w-6 h-6 rounded-full border border-black/10 dark:border-white/20 transition-transform duration-100 hover:scale-110 ${
                                    borderColor.toLowerCase() === c ? "ring-2 ring-offset-2 ring-emerald-600 dark:ring-offset-[#151619]" : ""
                                }`}
                                style={{ background: c }}
                            />
                        ))}
                        <label
                            className="relative w-6 h-6 rounded-full border border-dashed border-neutral-400 dark:border-neutral-600 flex items-center justify-center cursor-pointer overflow-hidden hover:border-neutral-500"
                            title="Custom colour"
                            style={!BORDER_COLORS.includes(borderColor.toLowerCase()) ? { background: borderColor, borderStyle: "solid" } : undefined}
                        >
                            {BORDER_COLORS.includes(borderColor.toLowerCase()) && <span className="text-[11px] text-neutral-500">+</span>}
                            <ColorInput
                                value={borderColor}
                                onChange={(e) => updateBorder({ cameraBorderColor: e.target.value })}
                                className="absolute inset-0 opacity-0 cursor-pointer"
                            />
                        </label>
                    </div>
                )}
            </div>

            {engine.state !== "unsupported" && !(localSeparateCam && videoDevices.length === 1) && (
                <div>
                    <SectionLabel hint="real-time">Background</SectionLabel>
                    <div className="grid grid-cols-4 gap-1.5">
                        {([
                            ["off", "Off", "No effect - your camera as it is"],
                            ["blur", "Blur", "Your own room, softly blurred"],
                            ["color", "Colour", "A solid colour behind you"],
                            ["image", "Picture", "A picture of your own behind you"],
                        ] as const).map(([kind, label, hint]) => (
                            <button
                                key={kind}
                                type="button"
                                title={hint}
                                onClick={() => (kind === "image" && !cameraBg.imagePath ? void pickBgPicture() : updateCameraBg({ kind }))}
                                className={`flex flex-col items-center gap-1.5 py-2 rounded-xl border transition-colors duration-100 ${
                                    cameraBg.kind === kind
                                        ? "border-emerald-600/80 dark:border-emerald-500/80 bg-white dark:bg-neutral-800/90 shadow-sm"
                                        : "border-neutral-200/80 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/40 hover:border-neutral-300 dark:hover:border-neutral-700"
                                }`}
                            >
                                <span className="relative w-8 h-8 rounded-full overflow-hidden ring-1 ring-black/10 dark:ring-white/10">
                                    {kind === "off" && <span className="absolute inset-0 bg-gradient-to-br from-stone-300 to-stone-500" />}
                                    {kind === "blur" && <span className="absolute inset-0 bg-gradient-to-br from-amber-200 via-sky-400 to-indigo-600 blur-[2px] scale-125" />}
                                    {kind === "color" && <span className="absolute inset-0" style={{ background: cameraBg.color }} />}
                                    {kind === "image" &&
                                        (cameraBg.imagePath ? (
                                            <img src={convertFileSrc(cameraBg.imagePath)} alt="" className="absolute inset-0 w-full h-full object-cover" />
                                        ) : (
                                            <span className="absolute inset-0 bg-gradient-to-br from-emerald-300 to-teal-600" />
                                        ))}
                                    <span className="absolute left-1/2 top-[22%] -translate-x-1/2 w-2 h-2 rounded-full bg-white/90" />
                                    <span className="absolute left-1/2 bottom-0 -translate-x-1/2 w-4.5 h-2.5 rounded-t-full bg-white/90" />
                                </span>
                                <span className={`text-[11px] font-medium ${cameraBg.kind === kind ? "text-neutral-900 dark:text-white" : "text-neutral-600 dark:text-neutral-400"}`}>
                                    {label}
                                </span>
                            </button>
                        ))}
                    </div>
                    {cameraBg.kind === "blur" && (
                        <label className="mt-2.5 flex items-center gap-3 text-xs">
                            <span className="w-14 text-neutral-500">Strength</span>
                            <input
                                type="range"
                                min={0.15}
                                max={1}
                                step={0.01}
                                value={blurDraft}
                                onChange={(e) => handleBlurSliderChange(Number(e.target.value))}
                                onPointerUp={flushBlurSlider}
                                onBlur={flushBlurSlider}
                                className="flex-1 accent-emerald-600 cursor-pointer"
                            />
                            <span className="w-8 text-right font-mono text-[11px] tabular-nums text-neutral-500">
                                {Math.round(blurDraft * 100)}%
                            </span>
                        </label>
                    )}
                    {cameraBg.kind === "color" && (
                        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                            {BACKGROUND_SWATCHES.map((c) => (
                                <button
                                    key={c}
                                    type="button"
                                    title={c}
                                    onClick={() => updateCameraBg({ color: c })}
                                    className={`w-6 h-6 rounded-full border border-black/10 dark:border-white/20 transition-transform duration-100 hover:scale-110 ${
                                        cameraBg.color.toLowerCase() === c ? "ring-2 ring-offset-2 ring-emerald-600 dark:ring-offset-[#151619]" : ""
                                    }`}
                                    style={{ background: c }}
                                />
                            ))}
                            <label className="relative w-6 h-6 rounded-full border border-dashed border-neutral-400 dark:border-neutral-600 flex items-center justify-center cursor-pointer overflow-hidden" title="Any colour">
                                <span className="text-[11px] text-neutral-500">+</span>
                                <ColorInput value={cameraBg.color} onChange={(e) => updateCameraBg({ color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                            </label>
                        </div>
                    )}
                    {cameraBg.kind === "image" && (
                        <button type="button" onClick={() => void pickBgPicture()} className="mt-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:underline">
                            Choose another picture…
                        </button>
                    )}
                    {cameraBg.kind !== "off" && (engine.state === "needs-download" || engine.state === "downloading" || engine.state === "failed") && (
                        <div className="mt-3 p-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-500/10 border border-emerald-500/30 text-xs">
                            {engine.state === "downloading" ? (
                                <>
                                    <div className="flex justify-between mb-1.5 text-neutral-600 dark:text-neutral-300">
                                        <span>Getting the background engine…</span>
                                        <span className="tabular-nums">{Math.round((engine.progress ?? 0) * 100)}%</span>
                                    </div>
                                    <div className="h-1.5 rounded-full bg-emerald-500/20 overflow-hidden">
                                        <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${Math.round((engine.progress ?? 0) * 100)}%` }} />
                                    </div>
                                </>
                            ) : (
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-neutral-600 dark:text-neutral-300">
                                        {engine.state === "failed" ? "The download didn't finish." : `A one-time ${engine.mb ?? 40} MB download makes this work.`}
                                    </span>
                                    <button type="button" onClick={getEngine} className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
                                        {engine.state === "failed" ? "Try again" : "Get it"}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    {cameraBg.kind !== "off" && engine.state === "ready" && (
                        <p className="mt-2 text-[11px] text-neutral-400 dark:text-neutral-500">Processed locally on your GPU — stays private and works offline.</p>
                    )}
                </div>
            )}

            {videoDevices.length === 1 && (
                <button
                    type="button"
                    role="switch"
                    aria-checked={localSeparateCam}
                    onClick={toggleSeparateCam}
                    className="w-full flex items-start justify-between gap-3 p-3 rounded-xl border border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-neutral-900/60 hover:border-neutral-300 dark:hover:border-neutral-700 text-left transition-colors duration-100"
                >
                    <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-900 dark:text-neutral-100">
                            <IoSwapHorizontal className="text-emerald-600 dark:text-emerald-400 shrink-0" /> Record webcam separately
                        </span>
                        <span className="block mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 leading-relaxed">
                            Saves camera as its own editable layer and unlocks live Screen/Camera cuts (<Kbd>{isMac ? "⌥" : "Alt"}</Kbd> <Kbd>Shift</Kbd> <Kbd>V</Kbd>).
                        </span>
                    </span>
                    <ToggleSwitch checked={localSeparateCam} />
                </button>
            )}
        </div>
    );


    const isScreenType = localRecordType === "sva" || localRecordType === "sa" || localRecordType === "s";
    const hasMic = ["sva", "sa", "va", "a"].includes(localRecordType);
    const hasCamera = ["sva", "va", "v"].includes(localRecordType);
    const selectClass =
        "w-full px-3 py-2 rounded-lg text-[13px] bg-white dark:bg-neutral-900 border border-neutral-200/90 dark:border-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 transition-colors duration-100";
    const toggleRow = (
        checked: boolean,
        onChange: () => void,
        icon: React.ReactNode,
        title: string,
        hint: string,
        disabled = false
    ) => (
        <button
            type="button"
            role="switch"
            aria-checked={checked && !disabled}
            disabled={disabled}
            onClick={() => !disabled && onChange()}
            className={`w-full flex items-center justify-between gap-4 px-3.5 py-2.5 text-left transition-colors duration-100 ${
                disabled
                    ? "opacity-45 cursor-not-allowed"
                    : "hover:bg-neutral-50/90 dark:hover:bg-neutral-800/40 cursor-pointer"
            }`}
        >
            <span className="min-w-0 flex items-start gap-2.5">
                <span className="mt-0.5 text-neutral-500 dark:text-neutral-400 shrink-0">{icon}</span>
                <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-neutral-900 dark:text-neutral-100 leading-snug">{title}</span>
                    <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 leading-snug">{hint}</span>
                </span>
            </span>
            <ToggleSwitch checked={checked} disabled={disabled} />
        </button>
    );

    const capturesScreen = isScreenType || localRecordType === "c";
    const windowPicked = selectedWindow !== null;
    const renderCaptureToggles = () => (
        <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900/50 divide-y divide-neutral-200/70 dark:divide-neutral-800/80 overflow-hidden">
            {toggleRow(
                captureCursor || (isScreenType && editablePointer && inputTrackingSupported),
                () => updateCapturePrefs({ captureCursor: !captureCursor }),
                <IoNavigateOutline className="-scale-x-100" />,
                "Show cursor",
                localRecordType === "c"
                    ? "Include the mouse pointer in the screenshot."
                    : isScreenType && editablePointer && inputTrackingSupported
                    ? "Managed by Editable pointer for smooth playback."
                    : "Include the mouse pointer in the video.",
                isScreenType && editablePointer && inputTrackingSupported
            )}
            {isScreenType &&
                toggleRow(
                    editablePointer && inputTrackingSupported,
                    () => updateCapturePrefs({ editablePointer: !editablePointer }),
                    <IoSparklesOutline />,
                    "Editable pointer",
                    "Records cursor path separately for smoothing, enlargement, and click ripples in the editor.",
                    !inputTrackingSupported
                )}
            {isScreenType &&
                toggleRow(
                    recordShortcuts && inputTrackingSupported,
                    () => updateCapturePrefs({ recordShortcuts: !recordShortcuts }),
                    <IoKeypadOutline />,
                    "Record shortcuts",
                    "Captures modifier combos and action keys (never ordinary typing) for editor keycaps.",
                    !inputTrackingSupported
                )}
            {isScreenType &&
                toggleRow(
                    localSystemAudio,
                    toggleSystemAudio,
                    <IoVolumeHigh />,
                    "System audio",
                    "Record audio playing through your speakers or headphones."
                )}
            {isScreenType &&
                toggleRow(
                    localTrackClicks,
                    toggleTrackClicks,
                    <IoHandLeftOutline />,
                    "Track clicks",
                    isClickTrackingSupported
                        ? "Log click positions so the editor can auto-zoom on interactions."
                        : "Unavailable on this platform.",
                    !isClickTrackingSupported
                )}
            {windowPicked &&
                toggleRow(
                    windowTitleBar,
                    () => updateCapturePrefs({ windowTitleBar: !windowTitleBar }),
                    <IoBrowsersOutline />,
                    "Include title bar",
                    "Keep the window's title bar and frame; off captures content only."
                )}
        </div>
    );

    const renderOptions = () => (
        <div className="space-y-4">
            <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/40 p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {hasMic && (
                        <div>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500 dark:text-neutral-400">Microphone</span>
                                <LiveMicMeter audioDevice={audioDevice} />
                            </div>
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
                            {localRecordType === "c" ? (
                                <>
                                    <option value="png">PNG</option>
                                    <option value="jpeg">JPEG</option>
                                    <option value="webp">WebP</option>
                                </>
                            ) : localRecordType === "a" ? (
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
                                    <option value="">Auto (full GPU resolution)</option>
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
                                    <option value="">Auto (up to 60 fps)</option>
                                    <option value="24">24 fps</option>
                                    <option value="30">30 fps</option>
                                    <option value="60">60 fps</option>
                                </select>
                            </div>
                        </>
                    )}
                </div>

                {hasCamera && (
                    <div className="pt-3 border-t border-neutral-200/70 dark:border-neutral-800/80">
                        <SectionLabel
                            hint={
                                <button type="button" onClick={onRefreshDevices} className="flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
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
                                            onClick={() => (isPhone && !isPhoneCameraConnected ? onOpenPhoneCamera() : startTransition(() => onToggleVideoDevice(device)))}
                                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors duration-100 ${
                                                on
                                                    ? "border-emerald-600/80 dark:border-emerald-500/80 bg-emerald-50/60 dark:bg-emerald-500/12 text-emerald-800 dark:text-emerald-200"
                                                    : "border-neutral-200/90 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-neutral-300 dark:hover:border-neutral-700"
                                            }`}
                                        >
                                            {isPhone ? <IoPhonePortraitOutline /> : <IoVideocam />}
                                            <span className="truncate max-w-[14rem]">{isPhone ? PHONE_CAMERA_LABEL : device}</span>
                                            {isPhone && (
                                                <span
                                                    className={`text-[10px] px-1.5 py-px rounded-full ${
                                                        isPhoneCameraConnected
                                                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                                            : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                                                    }`}
                                                >
                                                    {isPhoneCameraConnected ? "Connected" : "Pair"}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })
                            ) : (
                                <span className="text-xs text-neutral-500">No cameras detected</span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {capturesScreen && renderCaptureToggles()}

            {capturesScreen && (() => {
                const shieldOn = isPrivacyShieldArmed(shieldSettings);
                const whatsappOn = shieldSettings.annotationAutoBlurWhatsApp !== "off";
                const textOn = shieldSettings.annotationAutoBlurText !== "off";
                const toggleShieldMaster = () => {
                    if (shieldOn) {
                        updateShieldPrefs({
                            annotationAutoBlurWhatsApp: "off",
                            annotationAutoBlurText: "off",
                        });
                    } else {
                        updateShieldPrefs({
                            annotationAutoBlurWhatsApp: "recording",
                            annotationAutoBlurText: "recording",
                        });
                    }
                };
                return (
                    <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900/50 divide-y divide-neutral-200/70 dark:divide-neutral-800/80 overflow-hidden">
                        <div className="px-3.5 py-2.5 space-y-2">
                            <div className="flex items-center justify-between gap-4">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={shieldOn}
                                    onClick={toggleShieldMaster}
                                    className="min-w-0 flex-1 flex items-start gap-2.5 text-left cursor-pointer"
                                >
                                    <span className={`mt-0.5 shrink-0 ${shieldOn ? "text-emerald-600 dark:text-emerald-400" : "text-neutral-500 dark:text-neutral-400"}`}>
                                        <IoShieldCheckmarkOutline />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-2 flex-wrap">
                                            <span className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100 leading-snug">
                                                Privacy Shield
                                            </span>
                                            <span
                                                className={`text-[10px] font-medium px-1.5 py-px rounded-full ${
                                                    shieldOn
                                                        ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                                                        : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400"
                                                }`}
                                            >
                                                {privacyShieldSummary(shieldSettings)}
                                            </span>
                                        </span>
                                        <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 leading-snug">
                                            Auto-blurs WhatsApp chats, passwords, API keys &amp; cards live during capture.
                                        </span>
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={shieldOn}
                                    aria-label="Toggle Privacy Shield"
                                    onClick={toggleShieldMaster}
                                    className="cursor-pointer shrink-0"
                                >
                                    <ToggleSwitch checked={shieldOn} />
                                </button>
                            </div>
                            <div className="pl-6 flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            updateShieldPrefs({
                                                annotationAutoBlurWhatsApp: whatsappOn ? "off" : "recording",
                                            })
                                        }
                                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${
                                            whatsappOn
                                                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                                : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                                        }`}
                                    >
                                        WhatsApp {shieldSettings.annotationAutoBlurWhatsApp === "always" ? "(Always)" : whatsappOn ? "(Rec)" : ""}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            updateShieldPrefs({
                                                annotationAutoBlurText: textOn ? "off" : "recording",
                                            })
                                        }
                                        className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors ${
                                            textOn
                                                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                                : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                                        }`}
                                    >
                                        Sensitive text {shieldSettings.annotationAutoBlurText === "always" ? "(Always)" : textOn ? "(Rec)" : ""}
                                    </button>
                                </div>
                                {onOpenAnnotationSettings && (
                                    <button
                                        type="button"
                                        onClick={onOpenAnnotationSettings}
                                        className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                                    >
                                        Customize…
                                    </button>
                                )}
                            </div>
                        </div>
                        {isScreenType && (
                            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5 hover:bg-neutral-50/90 dark:hover:bg-neutral-800/40 transition-colors duration-100">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={shieldSettings.enableAnnotationTool}
                                    onClick={() => updateShieldPrefs({ enableAnnotationTool: !shieldSettings.enableAnnotationTool })}
                                    className="min-w-0 flex-1 flex items-start gap-2.5 text-left cursor-pointer"
                                >
                                    <span className={`mt-0.5 shrink-0 ${shieldSettings.enableAnnotationTool ? "text-blue-600 dark:text-blue-400" : "text-neutral-500 dark:text-neutral-400"}`}>
                                        <IoPencil />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100 leading-snug">
                                                Screen annotation
                                            </span>
                                            <Kbd>{MOD}</Kbd>
                                            <Kbd>Shift</Kbd>
                                            <Kbd>D</Kbd>
                                        </span>
                                        <span className="block text-[11px] text-neutral-500 dark:text-neutral-400 leading-snug">
                                            Draw over any app, point with the presenter hand, or drag Privacy Blur (B) live.
                                        </span>
                                    </span>
                                </button>
                                <div className="flex items-center gap-3 shrink-0">
                                    {onOpenAnnotationSettings && (
                                        <button
                                            type="button"
                                            onClick={onOpenAnnotationSettings}
                                            className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                                        >
                                            Style…
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={shieldSettings.enableAnnotationTool}
                                        aria-label="Toggle screen annotation"
                                        onClick={() => updateShieldPrefs({ enableAnnotationTool: !shieldSettings.enableAnnotationTool })}
                                        className="cursor-pointer"
                                    >
                                        <ToggleSwitch checked={shieldSettings.enableAnnotationTool} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })()}
        </div>
    );

    if (!isOpenScreen) return null;

    const activeScreenPreviewUrl = (() => {
        if (selectedWindowInfo && (selectedWindowInfo as any).imageUrl) {
            return (selectedWindowInfo as any).imageUrl as string;
        }
        if (selectedMonitor && monitorPreviews[selectedMonitor]) {
            return convertFileSrc(monitorPreviews[selectedMonitor]);
        }
        const firstMonitorPath = monitorPreviews["monitor_0"] ?? Object.values(monitorPreviews)[0];
        return firstMonitorPath ? convertFileSrc(firstMonitorPath) : undefined;
    })();

    const summary =
        selectedMonitorInfo
            ? `Monitor · ${selectedMonitorInfo.name}`
            : selectedWindowInfo
            ? `Window · ${selectedWindowInfo.app_name ? `${selectedWindowInfo.app_name} - ` : ""}${selectedWindowInfo.title}`
            : "Full screen";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5">
            {/* Solid translucent scrim (no full-viewport backdrop-blur) keeps GPU compositor 60 fps on integrated GPUs. */}
            <div className="absolute inset-0 bg-neutral-950/65" onClick={closeModal} />

            <div className="relative w-full max-w-[1220px] h-[min(90vh,860px)] flex flex-col rounded-2xl bg-white dark:bg-[#111214] text-neutral-900 dark:text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] dark:ring-white/[0.08] overflow-hidden [contain:layout_style_paint]">
                {/* Header */}
                <div className="flex items-center gap-4 px-6 py-3.5 border-b border-neutral-200/80 dark:border-neutral-800/90 bg-white dark:bg-[#111214]">
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
                                placeholder={localRecordType === "c" ? "Screenshot name" : "Recording name"}
                                className="text-[15px] font-semibold tracking-tight leading-tight bg-transparent border-b-2 border-emerald-600 outline-none w-72 max-w-full"
                            />
                        ) : (
                            <button
                                type="button"
                                onClick={() => setEditingName(true)}
                                title="Click to rename"
                                className="group flex items-center gap-1.5 text-[15px] font-semibold tracking-tight leading-tight text-left max-w-[24rem]"
                            >
                                <span className="truncate">
                                    {fileName.trim() || (localRecordType === "c" ? "Take a screenshot" : "New recording")}
                                </span>
                                <IoPencil className="text-xs text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                            </button>
                        )}
                        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                            {presentMode ? "Live camera display" : RECORD_TYPE_LABELS[localRecordType] ?? localRecordType}
                        </p>
                    </div>
                    {/* Screenshot is a separate flow the caller manages - switching type mid-way would fight it. */}
                    {localRecordType !== "c" && !presentMode && (
                        <div className="hidden md:flex mx-auto p-1 gap-0.5 rounded-xl bg-neutral-100 dark:bg-neutral-800/90 ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
                            {RECORD_TYPE_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    title={RECORD_TYPE_LABELS[opt.value]}
                                    onClick={() => pickRecordType(opt.value)}
                                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors duration-100 ${
                                        opt.value === localRecordType
                                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                                            : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
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
                        className="ml-auto w-8 h-8 flex items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-white transition-colors duration-100"
                        title="Close (Esc)"
                        aria-label="Close"
                    >
                        <IoClose className="text-xl" />
                    </button>
                </div>

                {/* Body */}
                {presentMode ? (
                    <div className="flex-1 min-h-0 overflow-y-auto p-6">
                        <PresentationPanel connectedCameraDevices={connectedCameraDevices} />
                    </div>
                ) : (
                <div className={`flex-1 min-h-0 grid ${hasCameraBubble ? "lg:grid-cols-[minmax(0,1fr)_356px]" : "grid-cols-1"}`}>
                    <div className="min-h-0 overflow-y-auto p-6 space-y-5">
                        {!isCameraOnly && !isAudioOnly && (
                            <>
                                {isMac && macPerms && (!macPerms.screen_recording || !macPerms.accessibility) && (
                                    <div className="rounded-xl border border-amber-300/80 dark:border-amber-700/60 bg-amber-50/90 dark:bg-amber-950/40 px-4 py-3 text-xs text-amber-950 dark:text-amber-100 space-y-2">
                                        <div className="flex items-start gap-2">
                                            <IoShieldCheckmarkOutline className="mt-0.5 shrink-0 text-base text-amber-600 dark:text-amber-400" />
                                            <div className="min-w-0 flex-1 space-y-1">
                                                <p className="font-semibold">macOS permissions needed for screen recording</p>
                                                <p className="text-amber-900/80 dark:text-amber-200/80">
                                                    {!macPerms.screen_recording
                                                        ? "Grant Screen Recording access so Briefcast can capture your display instead of a blank screen."
                                                        : "Grant Accessibility access to pick individual windows and record click/shortcut telemetry."}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2 pl-6">
                                            {!macPerms.screen_recording && (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            invoke<boolean>("request_macos_screen_recording_permission")
                                                                .then((granted) =>
                                                                    setMacPerms((prev) =>
                                                                        prev ? { ...prev, screen_recording: granted } : prev
                                                                    )
                                                                )
                                                                .catch(() => {});
                                                        }}
                                                        className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium transition-colors"
                                                    >
                                                        Allow Screen Recording
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            invoke("open_macos_permission_settings", { pane: "screen_recording" }).catch(() => {})
                                                        }
                                                        className="px-2.5 py-1 rounded-lg border border-amber-400/70 dark:border-amber-600/70 hover:bg-amber-100 dark:hover:bg-amber-900/50 font-medium transition-colors"
                                                    >
                                                        Open Screen Recording Settings
                                                    </button>
                                                </>
                                            )}
                                            {!macPerms.accessibility && (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        invoke("open_macos_permission_settings", { pane: "accessibility" }).catch(() => {})
                                                    }
                                                    className="px-2.5 py-1 rounded-lg border border-amber-400/70 dark:border-amber-600/70 hover:bg-amber-100 dark:hover:bg-amber-900/50 font-medium transition-colors"
                                                >
                                                    Open Accessibility Settings
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                                <div>
                                    <SectionLabel>Source</SectionLabel>
                                    {renderSources()}
                                </div>
                                {mode === "monitors" && renderMonitors()}
                                {mode === "windows" && renderWindows()}
                                {mode === "main" && hasCameraBubble && (
                                    <div>
                                        <SectionLabel
                                            hint={
                                                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                                    Live preview
                                                </span>
                                            }
                                        >
                                            Stage
                                        </SectionLabel>
                                        <div className="rounded-2xl bg-neutral-100/80 dark:bg-black/35 p-2.5 ring-1 ring-black/[0.05] dark:ring-white/[0.06]">
                                            <CameraOverlayPreview
                                                videoDevices={videoDevices}
                                                overlayShape={localShape}
                                                overlayPosition={localPosition}
                                                overlaySize={localSize}
                                                overlayBorder={border}
                                                overlayBorderColor={borderColor}
                                                showLabel={false}
                                                cameraBackground={previewBg}
                                                engineGeneration={engineGeneration}
                                                screenPreviewUrl={activeScreenPreviewUrl}
                                            />
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                        {isCameraOnly && (
                            <div className="max-w-4xl mx-auto space-y-3">
                                <SectionLabel hint="live">Camera</SectionLabel>
                                <div className="rounded-2xl bg-neutral-100/80 dark:bg-black/35 p-2.5 ring-1 ring-black/[0.05] dark:ring-white/[0.06]">
                                    <CameraOverlayPreview
                                        videoDevices={videoDevices}
                                        overlayShape={localShape}
                                        overlayPosition={localPosition}
                                        overlaySize={localSize}
                                        variant="full"
                                        showLabel={false}
                                    />
                                </div>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                                    {videoDevices.length === 0
                                        ? "Pick a camera below to record."
                                        : "Only the camera is recorded — nothing on your screen is captured."}
                                </p>
                            </div>
                        )}
                        {isAudioOnly && (
                            <div className="flex flex-col items-center justify-center text-center gap-3 py-10">
                                <span className="w-14 h-14 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-2xl ring-1 ring-emerald-500/20">
                                    <IoMic />
                                </span>
                                <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm">
                                    Recording audio only — no screen or camera is captured. Press Start when ready.
                                </p>
                            </div>
                        )}
                        {!isAudioOnly && (
                            <div className="pt-1">
                                <SectionLabel>Recording setup</SectionLabel>
                                {renderOptions()}
                            </div>
                        )}
                    </div>

                    {hasCameraBubble && (
                        <aside className="min-h-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-neutral-200/80 dark:border-neutral-800/90 bg-neutral-50/90 dark:bg-[#151619] p-5">
                            <div className="flex items-center gap-2 mb-4">
                                <IoVideocam className="text-emerald-600 dark:text-emerald-400 text-sm" />
                                <h3 className="text-[13px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">Camera</h3>
                                {videoDevices.length === 0 && (
                                    <span className="ml-auto text-[11px] text-amber-600 dark:text-amber-400">No camera selected</span>
                                )}
                            </div>
                            {mode !== "main" && (
                                <div className="mb-5">
                                    <CameraOverlayPreview
                                        videoDevices={videoDevices}
                                        overlayShape={localShape}
                                        overlayPosition={localPosition}
                                        overlaySize={localSize}
                                        overlayBorder={border}
                                        overlayBorderColor={borderColor}
                                        showLabel={false}
                                        cameraBackground={previewBg}
                                        engineGeneration={engineGeneration}
                                        screenPreviewUrl={activeScreenPreviewUrl}
                                    />
                                </div>
                            )}
                            {renderCameraPanel()}
                        </aside>
                    )}
                </div>
                )}

                {/* Footer */}
                <div className="flex items-center gap-3 px-6 py-3.5 border-t border-neutral-200/80 dark:border-neutral-800/90 bg-white dark:bg-[#111214]">
                    <div className="min-w-0 flex items-center gap-3 text-sm">
                        {localRecordType !== "c" && (
                            <div className="flex p-0.5 gap-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800/90 ring-1 ring-black/[0.04] dark:ring-white/[0.06]" role="tablist" aria-label="Mode">
                                {([
                                    ["record", "Record", <IoVideocam key="r" />],
                                    ["present", "Present", <IoTvOutline key="p" />],
                                ] as const).map(([value, label, icon]) => {
                                    const active = (value === "present") === presentMode;
                                    return (
                                        <button
                                            key={value}
                                            type="button"
                                            role="tab"
                                            aria-selected={active}
                                            onClick={() => setPresentMode(value === "present")}
                                            title={value === "present" ? "Show cameras live, full screen on a TV or projector" : "Set up a recording"}
                                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-[7px] text-xs font-medium transition-colors duration-100 ${
                                                active
                                                    ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                                                    : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200"
                                            }`}
                                        >
                                            {icon}
                                            {label}
                                            {value === "present" && presentation.active && (
                                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {presentMode ? (
                            presentError && <span className="text-xs text-red-500 truncate">{presentError}</span>
                        ) : (
                        <>
                        {!isCameraOnly && !isAudioOnly && (
                            <span className="truncate px-2.5 py-1 rounded-md bg-neutral-100 dark:bg-neutral-800/90 text-neutral-700 dark:text-neutral-300 text-xs font-medium ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
                                {summary}
                            </span>
                        )}
                        <span className="hidden lg:flex items-center gap-1 text-[11px] text-neutral-400">
                            <Kbd>{MOD}</Kbd>
                            <Kbd>Shift</Kbd>
                            <Kbd>R</Kbd>
                            <span className="ml-1">toggle recording</span>
                        </span>
                        </>
                        )}
                    </div>
                    {presentMode ? (
                    <button
                        type="button"
                        onClick={() => void togglePresentation()}
                        disabled={!presentation.active && presentation.cameras.length === 0}
                        className={`ml-auto flex items-center gap-2 px-5 py-2 rounded-xl text-white text-[13px] font-semibold shadow-sm active:scale-[0.98] transition-colors duration-100 disabled:opacity-50 disabled:cursor-not-allowed ${
                            presentation.active
                                ? "bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-100"
                                : "bg-red-600 hover:bg-red-500"
                        }`}
                    >
                        <IoTvOutline className="text-base" />
                        {presentation.active ? "Stop display" : "Go live"}
                    </button>
                    ) : (
                    <button
                        type="button"
                        onClick={() => confirmAndStart(resolveCurrentTarget())}
                        className="ml-auto flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white text-[13px] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.15)] transition-colors duration-100"
                    >
                        <span className="w-2 h-2 rounded-full bg-white" />
                        {localRecordType === "c" ? "Take Screenshot" : "Start Recording"}
                    </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default EnhancedScreenOptions;
