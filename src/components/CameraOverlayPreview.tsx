import { useEffect, useRef, useState } from "react";

interface CameraOverlayPreviewProps {
    videoDevices: string[];
    overlayShape: string;
    overlayPosition: string;
    overlaySize: string;
}

// Mirrors map_overlay_size in src-tauri/src/commands/recording.rs - the actual capture
// resolution ffmpeg is told to use for each camera bubble.
const OVERLAY_PIXEL_SIZE: Record<string, [number, number]> = {
    small: [320, 240],
    medium: [640, 480],
};

// Mirrors overlay_pixel_dimensions in recording.rs: circle/rounded collapse to a square using
// the smaller dimension, same as the scale=w='min(iw,ih)':h='min(iw,ih)' filter does.
const overlayPixelDimensions = (shape: string, size: string): [number, number] => {
    const [w, h] = OVERLAY_PIXEL_SIZE[size] || OVERLAY_PIXEL_SIZE.small;
    if (shape === "circle" || shape === "rounded") {
        const s = Math.min(w, h);
        return [s, s];
    }
    return [w, h];
};

// Mirrors overlay_position_expr in recording.rs: cameras stack outward from the chosen anchor
// corner along the bottom edge with a fixed gap, computed here in the same reference-resolution
// pixel space so the preview's proportions match the real ffmpeg composite.
const REFERENCE_WIDTH = 1280;
const REFERENCE_HEIGHT = 720;
const GAP = 20;
const MARGIN_X = 100;
const MARGIN_Y = 50;

// Mirrors overlay_position_expr in recording.rs exactly, including its fallback: any
// unrecognized anchor (or "bottom_right") lands bottom-right.
type XBase = "left" | "center" | "right";
const resolveAnchor = (position: string): { xBase: XBase; yBase: "top" | "bottom" } => {
    switch (position) {
        case "top_left":
            return { xBase: "left", yBase: "top" };
        case "top_center":
            return { xBase: "center", yBase: "top" };
        case "top_right":
            return { xBase: "right", yBase: "top" };
        case "bottom_left":
            return { xBase: "left", yBase: "bottom" };
        case "bottom_center":
            return { xBase: "center", yBase: "bottom" };
        default:
            return { xBase: "right", yBase: "bottom" };
    }
};

const overlayXOffset = (xBase: XBase, index: number, count: number, camW: number) => {
    const step = index * (camW + GAP);
    if (xBase === "left") return MARGIN_X + step;
    if (xBase === "center") {
        const total = count * camW + Math.max(count - 1, 0) * GAP;
        return (REFERENCE_WIDTH - total) / 2 + step;
    }
    return REFERENCE_WIDTH - camW - MARGIN_X - step;
};

const shapeStyle = (shape: string): React.CSSProperties => {
    if (shape === "circle") return { borderRadius: "50%" };
    if (shape === "rounded") return { borderRadius: "10%" };
    return { borderRadius: 0 };
};

// Live preview of the webcam overlay(s) exactly as they'll be composited into the recording -
// same anchor/stacking/shape math as the Rust filter_complex builder, just reimplemented in CSS
// percentages instead of ffmpeg expressions. There's no live preview anywhere else in this app
// (the real composite only exists baked into the finished ffmpeg output), so this is the first
// place a user sees their camera arrangement before committing to a recording.
const CameraOverlayPreview = ({ videoDevices, overlayShape, overlayPosition, overlaySize }: CameraOverlayPreviewProps) => {
    const [streams, setStreams] = useState<Record<string, MediaStream>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const streamsRef = useRef<Record<string, MediaStream>>({});

    useEffect(() => {
        streamsRef.current = streams;
    }, [streams]);

    useEffect(() => {
        let cancelled = false;

        // ffmpeg's dshow device name (what the "Video device(s)" checklist and FormData use)
        // and Chromium's own MediaDeviceInfo.label are usually identical on Windows since both
        // read the same OS-level friendly name, but fall back to a case-insensitive/substring
        // match in case of minor formatting differences between the two enumerations.
        const findVideoInput = (devices: MediaDeviceInfo[], label: string) => {
            const videoInputs = devices.filter((d) => d.kind === "videoinput");
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

            // Device labels are blank until the page has been granted camera permission at
            // least once - unlock them with a throwaway request, then look again.
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

    const [camW, camH] = overlayPixelDimensions(overlayShape, overlaySize);
    const widthPct = (camW / REFERENCE_WIDTH) * 100;
    const heightPct = (camH / REFERENCE_HEIGHT) * 100;

    return (
        <div>
            <label className="block text-sm font-medium mb-2">Preview</label>
            <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-gradient-to-br from-gray-200 to-gray-300 dark:from-neutral-800 dark:to-neutral-900 border border-gray-200 dark:border-neutral-700">
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 dark:text-neutral-600 text-xs">
                    Your screen
                </div>

                {videoDevices.map((label, index) => {
                    const { xBase, yBase } = resolveAnchor(overlayPosition);
                    const leftPct = (overlayXOffset(xBase, index, videoDevices.length, camW) / REFERENCE_WIDTH) * 100;
                    const vertPct = (MARGIN_Y / REFERENCE_HEIGHT) * 100;
                    const stream = streams[label];

                    return (
                        <div
                            key={label}
                            className="absolute bg-black overflow-hidden shadow-lg"
                            style={{
                                left: `${leftPct}%`,
                                [yBase]: `${vertPct}%`,
                                width: `${widthPct}%`,
                                height: `${heightPct}%`,
                                ...shapeStyle(overlayShape),
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
                                <div className="w-full h-full flex items-center justify-center text-white text-[10px] text-center p-1">
                                    {errors[label] || "Loading..."}
                                </div>
                            )}
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
