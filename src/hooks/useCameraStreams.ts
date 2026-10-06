import { useEffect, useRef, useState } from "react";
import { PHONE_CAMERA_DEVICE } from "../services/phoneCamera";

// Opens a live MediaStream for each camera in `labels` (ffmpeg/dshow device names, as the
// "Video device(s)" list and FormData use them), keeps the set in step as `labels` changes, and
// stops every stream it opened on unmount. Shared by the recording modal's preview and the live
// display window (PresentationWindow).
//
// The phone entry is skipped: its stream arrives over WebRTC and is owned by the phoneCamera
// service, which callers read directly.
//
// "hd" asks for up to 1080p - what a TV or projector needs. The default leaves the browser's own
// default (usually 640x480), plenty for a small preview and cheap to run for several cameras.
export type CameraQuality = "preview" | "hd";

// ffmpeg's dshow device name and Chromium's own MediaDeviceInfo.label are usually identical on
// Windows since both read the same OS-level friendly name, but fall back to a case-insensitive/
// substring match in case of minor formatting differences between the two enumerations.
//
// Entries with a blank label or deviceId are filtered out FIRST, and that is load-bearing, not
// defensive tidying. Until the page has been granted camera permission, enumerateDevices() still
// lists every videoinput but blanks both fields - and the substring fallback below reads
// `label.includes(d.label)`, which against an empty d.label is `"Integrated Webcam".includes("")`,
// i.e. true for every device. That made this return a placeholder whose deviceId was "", which
// resolveDeviceId then treated as a successful match and returned early from - skipping the very
// permission prompt that would have populated the labels. The result was a camera that could never
// preview on a fresh permission state, reported only as the generic "Preview unavailable".
const findVideoInput = (devices: MediaDeviceInfo[], label: string) => {
    const videoInputs = devices.filter((d) => d.kind === "videoinput" && d.deviceId !== "" && d.label !== "");
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

    // No usable match yet - which, thanks to the filter above, genuinely means "labels are still
    // hidden behind the permission prompt" rather than "matched a blank placeholder". A throwaway
    // request unlocks them; then look again.
    const unlock = await navigator.mediaDevices.getUserMedia({ video: true });
    unlock.getTracks().forEach((t) => t.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
    match = findVideoInput(devices, label);
    return match?.deviceId ?? null;
};

export const describeCameraError = (err: unknown): string => {
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

// A short, calm status for a camera with no stream: missing/denied preview doesn't mean a
// recording will fail - ffmpeg opens the device itself via dshow.
export const cameraStatusText = (error: string | undefined): string =>
    !error
        ? "Loading…"
        : error === "Camera permission was denied"
        ? "Permission needed"
        : error === "Camera is in use by another app"
        ? "In use elsewhere"
        : error === "Camera not found by the browser"
        ? "Not found"
        : "Preview unavailable";

export const useCameraStreams = (labels: string[], quality: CameraQuality = "preview") => {
    const [streams, setStreams] = useState<Record<string, MediaStream>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const streamsRef = useRef<Record<string, MediaStream>>({});
    const key = labels.join("|");

    useEffect(() => {
        let cancelled = false;

        const sync = async () => {
            // Drop streams for cameras that are no longer wanted.
            for (const label of Object.keys(streamsRef.current)) {
                if (!labels.includes(label)) {
                    streamsRef.current[label].getTracks().forEach((t) => t.stop());
                    delete streamsRef.current[label];
                }
            }

            // Open the newly wanted ones.
            for (const label of labels) {
                if (label === PHONE_CAMERA_DEVICE) continue;
                if (streamsRef.current[label]) continue;
                try {
                    const deviceId = await resolveDeviceId(label);
                    if (!deviceId) throw new Error("Camera not found by the browser");
                    const stream = await navigator.mediaDevices.getUserMedia({
                        video:
                            quality === "hd"
                                ? {
                                      deviceId: { exact: deviceId },
                                      width: { ideal: 1920 },
                                      height: { ideal: 1080 },
                                      frameRate: { ideal: 30 },
                                  }
                                : { deviceId: { exact: deviceId } },
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
                    if (!cancelled) setErrors((prev) => ({ ...prev, [label]: describeCameraError(err) }));
                }
            }

            if (!cancelled) setStreams({ ...streamsRef.current });
        };

        sync();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, quality]);

    // Stop every open camera on unmount (modal closed, display window closed).
    useEffect(() => {
        return () => {
            Object.values(streamsRef.current).forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
            streamsRef.current = {};
        };
    }, []);

    return { streams, errors };
};
