import { useEffect, useRef, useState } from "react";
import { IoVideocamOffOutline } from "react-icons/io5";
import { PHONE_CAMERA_DEVICE, subscribePhoneCamera } from "../services/phoneCamera";

interface CameraOverlayPreviewProps {
    videoDevices: string[];
    overlayShape: string;
    overlayPosition: string;
    overlaySize: string;
    // "none" | "thin" | "medium" | "thick", and a "#rrggbb" colour - see OverlayStyle in recording.rs.
    overlayBorder?: string;
    overlayBorderColor?: string;
    // The modal draws its own section heading; standalone uses keep the built-in "Preview" label.
    showLabel?: boolean;
    // "overlay" (default) previews the camera as the bubble it will be composited into a screen
    // recording as - the shape/position/size maths below only mean anything in that arrangement.
    // "full" previews the camera as the whole picture, which is what the camera-only record types
    // ("v", "va") actually produce: there's no screen underneath and no bubble to place.
    variant?: "overlay" | "full";
}

// Every number below mirrors OverlayStyle and friends in src-tauri/src/commands/recording.rs,
// where bubble size, margins and border thickness are all fractions of the recorded frame's
// width - so the preview is the recording, just smaller.
export const BUBBLE_FRACTION: Record<string, number> = {
    xs: 0.10,
    small: 0.14,
    medium: 0.18,
    large: 0.24,
    xl: 0.30,
};
export const BORDER_FRACTION: Record<string, number> = {
    none: 0,
    thin: 0.003,
    medium: 0.006,
    thick: 0.011,
};
const MARGIN_FRACTION = 0.025;
const GAP_FRACTION = 0.012;
// The preview frame is 16:9; widths are fractions of its width, heights of its height.
const ASPECT = 16 / 9;

// Picture size inside one bubble, as fractions of the frame's width: square for circle/rounded,
// 4:3 for the plain rectangle.
const bubblePicture = (shape: string, size: string): [number, number] => {
    const side = BUBBLE_FRACTION[size] ?? BUBBLE_FRACTION.small;
    return shape === "circle" || shape === "rounded" ? [side, side] : [side, (side * 3) / 4];
};

type XBase = "left" | "center" | "right";
const resolveAnchor = (position: string): { xBase: XBase; yBase: "top" | "middle" | "bottom" } => {
    switch (position) {
        case "top_left":
            return { xBase: "left", yBase: "top" };
        case "top_center":
            return { xBase: "center", yBase: "top" };
        case "top_right":
            return { xBase: "right", yBase: "top" };
        case "center_left":
            return { xBase: "left", yBase: "middle" };
        case "center":
            return { xBase: "center", yBase: "middle" };
        case "center_right":
            return { xBase: "right", yBase: "middle" };
        case "bottom_left":
            return { xBase: "left", yBase: "bottom" };
        case "bottom_center":
            return { xBase: "center", yBase: "bottom" };
        default:
            return { xBase: "right", yBase: "bottom" };
    }
};

// Left edge of bubble `index` of `count`, as a fraction of the frame's width.
const bubbleLeft = (xBase: XBase, index: number, count: number, bubbleW: number) => {
    const step = index * (bubbleW + GAP_FRACTION);
    if (xBase === "left") return MARGIN_FRACTION + step;
    if (xBase === "center") {
        const total = count * bubbleW + Math.max(count - 1, 0) * GAP_FRACTION;
        return (1 - total) / 2 + step;
    }
    return 1 - bubbleW - MARGIN_FRACTION - step;
};

// Corner radius of the bubble's outer edge, as a fraction of its own width - recording.rs uses a
// radius of an eighth of the picture's side, plus the border.
const outerRadius = (shape: string, picW: number, border: number, bubbleW: number): string => {
    if (shape === "circle") return "50%";
    if (shape === "rounded") return `${(((picW / 8) + border) / bubbleW) * 100}%`;
    return "0";
};

// Live preview of the webcam overlay(s) exactly as they'll be composited into the recording -
// same anchor/stacking/shape math as the Rust filter_complex builder, just reimplemented in CSS
// percentages instead of ffmpeg expressions. There's no live preview anywhere else in this app
// (the real composite only exists baked into the finished ffmpeg output), so this is the first
// place a user sees their camera arrangement before committing to a recording.
const CameraOverlayPreview = ({
    videoDevices,
    overlayShape,
    overlayPosition,
    overlaySize,
    overlayBorder = "none",
    overlayBorderColor = "#ffffff",
    showLabel = true,
    variant = "overlay",
}: CameraOverlayPreviewProps) => {
    const [streams, setStreams] = useState<Record<string, MediaStream>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const streamsRef = useRef<Record<string, MediaStream>>({});

    // The phone's stream is owned by the phoneCamera service, not acquired here: it arrives over
    // WebRTC rather than from getUserMedia, and the same MediaStream is shared with the pairing
    // panel and the recorder. Tracked separately from streamsRef for that reason - the cleanup
    // paths below stop everything they hold, which must never happen to a stream this component
    // doesn't own.
    const [phoneStream, setPhoneStream] = useState<MediaStream | null>(null);
    useEffect(() => subscribePhoneCamera((st) => setPhoneStream(st.stream)), []);

    useEffect(() => {
        streamsRef.current = streams;
    }, [streams]);

    useEffect(() => {
        let cancelled = false;

        // ffmpeg's dshow device name (what the "Video device(s)" checklist and FormData use)
        // and Chromium's own MediaDeviceInfo.label are usually identical on Windows since both
        // read the same OS-level friendly name, but fall back to a case-insensitive/substring
        // match in case of minor formatting differences between the two enumerations.
        //
        // Entries with a blank label or deviceId are filtered out FIRST, and that is load-bearing,
        // not defensive tidying. Until the page has been granted camera permission, enumerate-
        // Devices() still lists every videoinput but blanks both fields - and the substring
        // fallback below reads `label.includes(d.label)`, which against an empty d.label is
        // `"Integrated Webcam".includes("")`, i.e. true for every device. That made this function
        // return a placeholder whose deviceId was "", which resolveDeviceId then treated as a
        // successful match and returned early from - skipping the very permission prompt that
        // would have populated the labels. The result was a camera that could never preview on a
        // fresh permission state, reported only as the generic "Preview unavailable".
        const findVideoInput = (devices: MediaDeviceInfo[], label: string) => {
            const videoInputs = devices.filter(
                (d) => d.kind === "videoinput" && d.deviceId !== "" && d.label !== ""
            );
            return (
                videoInputs.find((d) => d.label === label) ??
                videoInputs.find((d) => d.label.toLowerCase() === label.toLowerCase()) ??
                videoInputs.find((d) => d.label.includes(label) || label.includes(d.label))
            );
        };

        const resolveDeviceId = async (label: string): Promise<string | null> => {
            let devices = await navigator.mediaDevices.enumerateDevices();
            let match = findVideoInput(devices, label);
            if (match) return match.deviceId;

            // No usable match yet - which, thanks to the filter above, now genuinely means
            // "labels are still hidden behind the permission prompt" rather than "matched a
            // blank placeholder". A throwaway request unlocks them; then look again.
            const unlock = await navigator.mediaDevices.getUserMedia({ video: true });
            unlock.getTracks().forEach((t) => t.stop());
            devices = await navigator.mediaDevices.enumerateDevices();
            match = findVideoInput(devices, label);
            return match?.deviceId ?? null;
        };

        const describeError = (err: unknown): string => {
            if (err instanceof DOMException) {
                switch (err.name) {
                    case "NotAllowedError":
                        return "Camera permission was denied";
                    case "NotFoundError":
                    case "OverconstrainedError":
                        return "Camera not found by the browser";
                    case "NotReadableError":
                        return "Camera is in use by another app";
                    default:
                        return `${err.name}: ${err.message}`;
                }
            }
            return err instanceof Error ? err.message : String(err);
        };

        const sync = async () => {
            // Drop streams for cameras that are no longer selected.
            for (const label of Object.keys(streamsRef.current)) {
                if (!videoDevices.includes(label)) {
                    streamsRef.current[label].getTracks().forEach((t) => t.stop());
                    delete streamsRef.current[label];
                }
            }

            // Acquire streams for newly selected cameras.
            for (const label of videoDevices) {
                // Not a real capture device - resolveDeviceId could never match it, and its
                // stream is supplied by the phoneCamera service instead.
                if (label === PHONE_CAMERA_DEVICE) continue;
                if (streamsRef.current[label]) continue;
                try {
                    const deviceId = await resolveDeviceId(label);
                    if (!deviceId) throw new Error("Camera not found by the browser");
                    const stream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: { exact: deviceId } },
                    });
                    if (cancelled) {
                        stream.getTracks().forEach((t) => t.stop());
                        return;
                    }
                    streamsRef.current[label] = stream;
                    setErrors((prev) => {
                        const next = { ...prev };
                        delete next[label];
                        return next;
                    });
                } catch (err) {
                    console.error(`Camera preview failed for "${label}":`, err);
                    if (!cancelled) {
                        setErrors((prev) => ({ ...prev, [label]: describeError(err) }));
                    }
                }
            }

            if (!cancelled) setStreams({ ...streamsRef.current });
        };

        sync();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [videoDevices.join("|")]);

    // Stop every open camera when the preview itself unmounts (modal closed).
    useEffect(() => {
        return () => {
            Object.values(streamsRef.current).forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
        };
    }, []);

    const [picW, picH] = bubblePicture(overlayShape, overlaySize);
    const border = BORDER_FRACTION[overlayBorder] ?? 0;
    const bubbleW = picW + 2 * border;
    // Heights in frame-height units: a width fraction times the aspect.
    const bubbleH = (picH + 2 * border) * ASPECT;

    // Shared by both variants so a camera that can't open reads the same either way.
    const renderPlaceholder = (label: string, isPhone: boolean) => (
        <div
            className="w-full h-full flex flex-col items-center justify-center gap-1 bg-neutral-700/80 text-white/80 text-center p-1"
            title={errors[label]}
        >
            <IoVideocamOffOutline className="text-base opacity-80" />
            <span className="text-[9px] leading-tight">
                {isPhone
                    ? "Phone not connected"
                    : !errors[label]
                    ? "Loading…"
                    : errors[label] === "Camera permission was denied"
                    ? "Permission needed"
                    : errors[label] === "Camera is in use by another app"
                    ? "In use elsewhere"
                    : errors[label] === "Camera not found by the browser"
                    ? "Not found"
                    : "Preview unavailable"}
            </span>
        </div>
    );

    if (variant === "full") {
        return (
            <div>
                {showLabel && <label className="block text-sm font-medium mb-2">Preview</label>}
                <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-black border border-gray-200 dark:border-neutral-700">
                    {videoDevices.length === 0 ? (
                        <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-xs">
                            No camera selected
                        </div>
                    ) : (
                        // Several cameras share the frame evenly - the camera-only modes record
                        // whichever is first, but showing them all makes it obvious which is which.
                        <div className="absolute inset-0 flex">
                            {videoDevices.map((label) => {
                                const isPhone = label === PHONE_CAMERA_DEVICE;
                                const stream = isPhone ? phoneStream : streams[label];
                                return (
                                    <div key={label} className="relative flex-1 min-w-0 border-r border-black last:border-r-0">
                                        {stream ? (
                                            <video
                                                autoPlay
                                                muted
                                                playsInline
                                                className="w-full h-full object-contain"
                                                ref={(el) => {
                                                    if (el && el.srcObject !== stream) el.srcObject = stream;
                                                }}
                                            />
                                        ) : (
                                            renderPlaceholder(label, isPhone)
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div>
            {showLabel && <label className="block text-sm font-medium mb-2">Preview</label>}
            <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-gradient-to-br from-slate-200 via-slate-100 to-slate-300 dark:from-neutral-800 dark:via-neutral-800 dark:to-neutral-900 border border-neutral-200 dark:border-neutral-700">
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-neutral-600 text-xs">
                    Your screen
                </div>

                {videoDevices.map((label, index) => {
                    const { xBase, yBase } = resolveAnchor(overlayPosition);
                    const leftPct = bubbleLeft(xBase, index, videoDevices.length, bubbleW) * 100;
                    const vertPct = MARGIN_FRACTION * ASPECT * 100;
                    const isPhone = label === PHONE_CAMERA_DEVICE;
                    const stream = isPhone ? phoneStream : streams[label];
                    const radius = outerRadius(overlayShape, picW, border, bubbleW);

                    return (
                        <div
                            key={label}
                            className="absolute shadow-lg"
                            style={{
                                left: `${leftPct}%`,
                                ...(yBase === "middle"
                                    ? { top: `${((1 - bubbleH) / 2) * 100}%` }
                                    : { [yBase]: `${vertPct}%` }),
                                width: `${bubbleW * 100}%`,
                                height: `${bubbleH * 100}%`,
                                borderRadius: radius,
                                background: border > 0 ? overlayBorderColor : "black",
                                // The border is the wrapper's background showing around the picture.
                                // Percentage padding resolves against the frame's width - the same
                                // unit `border` is in.
                                padding: `${border * 100}%`,
                            }}
                        >
                        <div
                            className="w-full h-full bg-black overflow-hidden"
                            style={{
                                borderRadius:
                                    overlayShape === "circle" ? "50%" : overlayShape === "rounded" ? `${(1 / 8) * 100}%` : 0,
                            }}
                        >
                            {stream ? (
                                <video
                                    autoPlay
                                    muted
                                    playsInline
                                    className="w-full h-full object-cover"
                                    ref={(el) => {
                                        if (el && el.srcObject !== stream) el.srcObject = stream;
                                    }}
                                />
                            ) : (
                                // A missing/denied browser preview doesn't mean the recording itself will
                                // fail - ffmpeg captures this device directly via dshow, independent of
                                // Chromium's own camera access. So this stays a calm, muted placeholder
                                // rather than reusing the alarming red/black "error" treatment, except for
                                // "permission denied", which the user actually can fix from here.
                                <div
                                    className="w-full h-full flex flex-col items-center justify-center gap-1 bg-neutral-700/80 text-white/80 text-center p-1"
                                    title={errors[label]}
                                >
                                    <IoVideocamOffOutline className="text-base opacity-80" />
                                    <span className="text-[9px] leading-tight">
                                        {isPhone
                                            ? "Phone not connected"
                                            : !errors[label]
                                            ? "Loading…"
                                            : errors[label] === "Camera permission was denied"
                                            ? "Permission needed"
                                            : errors[label] === "Camera is in use by another app"
                                            ? "In use elsewhere"
                                            : errors[label] === "Camera not found by the browser"
                                            ? "Not found"
                                            : "Preview unavailable"}
                                    </span>
                                </div>
                            )}
                        </div>
                        </div>
                    );
                })}

                {videoDevices.length === 0 && (
                    <div className="absolute bottom-2 right-2 text-[10px] text-gray-400 dark:text-neutral-600">
                        No camera selected
                    </div>
                )}
            </div>
        </div>
    );
};

export default CameraOverlayPreview;
