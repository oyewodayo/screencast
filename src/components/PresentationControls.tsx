// PresentationControls.tsx
//
// The operator's side of the live display (services/presentation.ts): the Screen Options
// modal's "Present" body - a preview of exactly what the room sees, plus cameras, layout and
// display controls - and the compact bar that stays on screen while the display is live, so
// cameras can be cut without reopening the modal.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
    IoAppsOutline,
    IoEye,
    IoEyeOffOutline,
    IoGridOutline,
    IoSquareOutline,
    IoStop,
    IoTvOutline,
} from "react-icons/io5";
import PresentationStage from "./PresentationStage";
import { useCameraStreams } from "../hooks/useCameraStreams";
import { PHONE_CAMERA_DEVICE, subscribePhoneCamera } from "../services/phoneCamera";
import {
    PresentationLayout,
    PresentationState,
    applyPresentationAction,
    cameraDisplayName,
    getPresentationState,
    goLive,
    liveCamera,
    presentationActionForKey,
    startPresentation,
    stopPresentation,
    subscribePresentation,
    toggleCameraHidden,
    updatePresentation,
    visibleCameras,
} from "../services/presentation";

interface MonitorInfo {
    id: string;
    name: string;
    width: number;
    height: number;
    is_primary: boolean;
}

export const usePresentation = () => {
    const [state, setState] = useState<PresentationState>(getPresentationState);
    useEffect(() => subscribePresentation(setState), []);
    return state;
};

// Whether a PresentationPanel is on screen - the floating bar steps aside for it, so the two
// never both react to the same key (a doubled Shift+N toggle would cancel itself out).
let panelsOpen = 0;
const panelListeners = new Set<(open: boolean) => void>();
const setPanelOpen = (delta: number) => {
    panelsOpen += delta;
    panelListeners.forEach((l) => l(panelsOpen > 0));
};
const usePanelOpen = () => {
    const [open, setOpen] = useState(panelsOpen > 0);
    useEffect(() => {
        panelListeners.add(setOpen);
        return () => {
            panelListeners.delete(setOpen);
        };
    }, []);
    return open;
};

// Number keys etc. while this window has focus - see presentationActionForKey.
const usePresentationKeys = (enabled: boolean) => {
    useEffect(() => {
        if (!enabled) return;
        const onKey = (e: KeyboardEvent) => {
            const action = presentationActionForKey(e);
            if (action) {
                e.preventDefault();
                applyPresentationAction(action);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [enabled]);
};

const LAYOUTS: { value: PresentationLayout; label: string; icon: React.ReactNode; key: string }[] = [
    { value: "grid", label: "Grid", icon: <IoGridOutline />, key: "G" },
    { value: "spotlight", label: "Spotlight", icon: <IoAppsOutline />, key: "S" },
    { value: "single", label: "One camera", icon: <IoSquareOutline />, key: "O" },
];

const Kbd = ({ children }: { children: React.ReactNode }) => (
    <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-[10px] font-mono text-neutral-600 dark:text-neutral-300">
        {children}
    </kbd>
);

const Segmented = <T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { value: T; label: string; icon?: React.ReactNode; title?: string }[];
    onChange: (v: T) => void;
}) => (
    <div className="flex p-1 gap-1 rounded-xl bg-neutral-100 dark:bg-neutral-800">
        {options.map((o) => (
            <button
                key={o.value}
                type="button"
                title={o.title}
                onClick={() => onChange(o.value)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    o.value === value
                        ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                        : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                }`}
            >
                {o.icon}
                {o.label}
            </button>
        ))}
    </div>
);

const Section = ({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) => (
    <div>
        <div className="flex items-center justify-between mb-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{title}</h4>
            {hint}
        </div>
        {children}
    </div>
);

// The modal body in Present mode.
export const PresentationPanel = ({ connectedCameraDevices }: { connectedCameraDevices: string[] | null }) => {
    const state = usePresentation();
    const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
    const [error, setError] = useState<string | null>(null);

    // Every camera this PC can see can go on the display - not just the ones ticked for
    // recording - including the phone, relayed to the display window (see presentation.ts).
    const cameraKey = (connectedCameraDevices ?? []).join("|");
    useEffect(() => {
        const cameras = connectedCameraDevices ?? [];
        if (cameras.join("|") !== getPresentationState().cameras.join("|")) updatePresentation({ cameras });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cameraKey]);

    useEffect(() => {
        invoke<MonitorInfo[]>("get_monitors")
            .then(setMonitors)
            .catch((err) => console.error("Failed to load monitors:", err));
    }, []);

    usePresentationKeys(true);
    useEffect(() => {
        setPanelOpen(1);
        return () => setPanelOpen(-1);
    }, []);

    const shown = visibleCameras(state);
    const live = liveCamera(state);
    // Same constraints as the display window, so the two share one capture per camera at full
    // quality rather than the preview pinning it to a small size.
    const { streams, errors } = useCameraStreams(shown, "hd");
    const [phoneStream, setPhoneStream] = useState<MediaStream | null>(null);
    useEffect(() => subscribePhoneCamera((st) => setPhoneStream(st.stream)), []);
    const allStreams = phoneStream ? { ...streams, [PHONE_CAMERA_DEVICE]: phoneStream } : streams;

    const monitorValue = state.monitorId && monitors.some((m) => m.id === state.monitorId) ? state.monitorId : "";
    const lastMonitor = monitors[monitors.length - 1];

    const pickMonitor = async (id: string) => {
        updatePresentation({ monitorId: id || null });
        if (state.active) {
            try {
                await startPresentation(id || null);
            } catch (err) {
                setError(String(err));
            }
        }
    };

    return (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-3 min-w-0">
                <div className="flex items-center justify-between">
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                        {state.active ? "On the display now" : "What the display will show"}
                    </h4>
                    {state.active && (
                        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400 text-[11px] font-semibold">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                            LIVE
                        </span>
                    )}
                </div>
                <div className="relative w-full aspect-video rounded-2xl overflow-hidden ring-1 ring-black/10 dark:ring-white/10 shadow-lg bg-black">
                    <PresentationStage
                        cameras={shown}
                        live={live}
                        layout={state.layout}
                        fit={state.fit}
                        showNames={state.showNames}
                        streams={allStreams}
                        errors={errors}
                        compact
                        onPick={(c) => goLive(c)}
                    />
                </div>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Click a camera to put it on air. Shows full screen on a TV, projector or second monitor connected to this PC -
                    nothing is recorded unless you also start a recording.
                </p>
                {error && <p className="text-xs text-red-500">{error}</p>}
            </div>

            <div className="space-y-6">
                <Section
                    title="Cameras"
                    hint={
                        state.cameras.length > 1 && (
                            <button
                                type="button"
                                onClick={() => applyPresentationAction({ type: "all" })}
                                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                                title="Every camera, tiled (0)"
                            >
                                Show all
                            </button>
                        )
                    }
                >
                    {state.cameras.length === 0 ? (
                        <p className="text-sm text-neutral-500">No cameras connected. Plug in a webcam or capture card and refresh devices.</p>
                    ) : (
                        <div className="space-y-1.5">
                            {state.cameras.map((camera, i) => {
                                const isShown = shown.includes(camera);
                                const onAir = camera === live && state.layout !== "grid";
                                return (
                                    <div
                                        key={camera}
                                        className={`flex items-center gap-2 p-1.5 pl-2 rounded-xl border transition-colors ${
                                            onAir
                                                ? "border-red-500/50 bg-red-50 dark:bg-red-500/10"
                                                : isShown
                                                ? "border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900"
                                                : "border-dashed border-neutral-200 dark:border-neutral-800 bg-transparent opacity-60"
                                        }`}
                                    >
                                        {i < 9 ? <Kbd>{i + 1}</Kbd> : <span className="w-5" />}
                                        <button
                                            type="button"
                                            onClick={() => applyPresentationAction({ type: "cut", index: i + 1 })}
                                            className="flex-1 min-w-0 text-left text-sm font-medium truncate"
                                            title={`Put ${cameraDisplayName(camera)} on air${i < 9 ? ` (${i + 1})` : ""}`}
                                        >
                                            {cameraDisplayName(camera)}
                                        </button>
                                        {onAir && <span className="text-[10px] font-bold text-red-600 dark:text-red-400 px-1.5">ON AIR</span>}
                                        <button
                                            type="button"
                                            onClick={() => toggleCameraHidden(camera)}
                                            className={`flex items-center justify-center w-8 h-8 rounded-lg ${
                                                isShown
                                                    ? "text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                                    : "text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                                            }`}
                                            title={`${isShown ? "Hide from" : "Show on"} the display${i < 9 ? ` (Shift+${i + 1})` : ""}`}
                                        >
                                            {isShown ? <IoEye size={16} /> : <IoEyeOffOutline size={16} />}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Section>

                <Section title="Layout">
                    <Segmented
                        value={state.layout}
                        options={LAYOUTS.map((l) => ({ value: l.value, label: l.label, icon: l.icon, title: `${l.label} (${l.key})` }))}
                        onChange={(layout) => updatePresentation({ layout })}
                    />
                </Section>

                <Section title="Picture">
                    <div className="space-y-2">
                        <Segmented
                            value={state.fit}
                            options={[
                                { value: "fill", label: "Fill screen", title: "Crop to fill each tile" },
                                { value: "fit", label: "Show whole picture", title: "Letterbox, never crop" },
                            ]}
                            onChange={(fit) => updatePresentation({ fit })}
                        />
                        <label className="flex items-center justify-between gap-2 text-sm cursor-pointer">
                            Show camera names
                            <input
                                type="checkbox"
                                checked={state.showNames}
                                onChange={(e) => updatePresentation({ showNames: e.target.checked })}
                                className="w-4 h-4 accent-blue-500"
                            />
                        </label>
                    </div>
                </Section>

                <Section title="Display on">
                    <select
                        value={monitorValue}
                        onChange={(e) => pickMonitor(e.target.value)}
                        className="w-full p-2.5 rounded-xl text-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700"
                    >
                        <option value="">
                            Automatic{lastMonitor ? ` (${lastMonitor.name}${monitors.length > 1 ? ", usually the TV" : ""})` : ""}
                        </option>
                        {monitors.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name} - {m.width}×{m.height}
                                {m.is_primary ? " (this screen)" : ""}
                            </option>
                        ))}
                    </select>
                    {monitors.length === 1 && (
                        <p className="mt-1.5 text-xs text-neutral-500">
                            Only one display is connected, so the live display will cover this screen. Press Esc on it to stop.
                        </p>
                    )}
                </Section>

                <Section title="Shortcuts">
                    <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                        <span><Kbd>1</Kbd>–<Kbd>9</Kbd></span>
                        <span>Cut to that camera</span>
                        <span><Kbd>Shift</Kbd>+<Kbd>1</Kbd>–<Kbd>9</Kbd></span>
                        <span>Add / remove a camera</span>
                        <span><Kbd>0</Kbd></span>
                        <span>Show all cameras</span>
                        <span><Kbd>G</Kbd> <Kbd>S</Kbd> <Kbd>O</Kbd></span>
                        <span>Grid, spotlight, one camera</span>
                        <span><Kbd>Alt</Kbd>+<Kbd>Shift</Kbd>+…</span>
                        <span>Same cuts from any app while live (1–9, 0, L)</span>
                    </div>
                </Section>
            </div>
        </div>
    );
};

export const startOrStopPresentation = async (active: boolean) => {
    if (active) await stopPresentation();
    else await startPresentation();
};

// Floating bar on the main window while the display is live and the modal is closed: cut,
// show/hide and stop without reopening anything. Holds no cameras open.
export const PresentationLiveBar = () => {
    const state = usePresentation();
    const panelOpen = usePanelOpen();
    usePresentationKeys(state.active && !panelOpen);
    if (!state.active || panelOpen) return null;

    const shown = visibleCameras(state);
    const live = liveCamera(state);

    return (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 max-w-[calc(100vw-32px)] p-1.5 pl-3 rounded-2xl border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 backdrop-blur shadow-xl">
            <span className="flex items-center gap-1.5 pr-2 mr-1 border-r border-neutral-200 dark:border-neutral-700 text-[11px] font-bold text-red-600 dark:text-red-400 whitespace-nowrap">
                <IoTvOutline size={15} />
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                LIVE
            </span>
            <div className="flex items-center gap-1 overflow-x-auto">
                {state.cameras.map((camera, i) => {
                    const isShown = shown.includes(camera);
                    const onAir = camera === live && state.layout !== "grid";
                    return (
                        <button
                            key={camera}
                            type="button"
                            onClick={(e) =>
                                e.shiftKey ? toggleCameraHidden(camera) : applyPresentationAction({ type: "cut", index: i + 1 })
                            }
                            title={`Cut to ${cameraDisplayName(camera)}${i < 9 ? ` (${i + 1})` : ""} - Shift+click to show/hide`}
                            className={`flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium whitespace-nowrap max-w-[160px] transition-colors ${
                                onAir
                                    ? "bg-red-600 text-white"
                                    : isShown
                                    ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                                    : "text-neutral-400 line-through hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            }`}
                        >
                            {i < 9 && <span className="opacity-60 font-mono">{i + 1}</span>}
                            <span className="truncate">{cameraDisplayName(camera)}</span>
                        </button>
                    );
                })}
            </div>
            <span className="w-px h-6 mx-1 bg-neutral-200 dark:bg-neutral-700" />
            {LAYOUTS.map((l) => (
                <button
                    key={l.value}
                    type="button"
                    onClick={() => updatePresentation({ layout: l.value })}
                    title={`${l.label} (${l.key})`}
                    className={`flex items-center justify-center w-8 h-8 rounded-lg ${
                        state.layout === l.value
                            ? "bg-neutral-900 dark:bg-white text-white dark:text-neutral-900"
                            : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                >
                    {l.icon}
                </button>
            ))}
            <button
                type="button"
                onClick={() => applyPresentationAction({ type: "all" })}
                title="Show all cameras (0)"
                className="h-8 px-2.5 rounded-lg text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 whitespace-nowrap"
            >
                All
            </button>
            <button
                type="button"
                onClick={() => void stopPresentation()}
                title="Stop the live display"
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-xs font-semibold whitespace-nowrap"
            >
                <IoStop size={11} />
                Stop
            </button>
        </div>
    );
};
