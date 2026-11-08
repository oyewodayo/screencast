// components/LiveCameraRecordingView.tsx
//
// What the app shows while a camera-only recording ("va"/"v") is in progress: the picture ffmpeg
// is actually writing to the file, including the side-by-side composite when several cameras are
// selected.
//
// It renders JPEG frames fetched from the backend rather than a MediaStream, and that is forced
// rather than chosen. A Windows camera is exclusive - while ffmpeg has it open, this WebView's own
// getUserMedia on the same device fails with NotReadableError ("Could not start video source"),
// verified directly against the recording pipeline. So the app cannot watch the camera itself
// during a recording; the only process that can see it is the ffmpeg already recording it, which
// therefore publishes a small frame for this component to poll (see preview_sidecar_path and
// get_recording_preview_frame in src-tauri/src/commands/recording.rs).
//
// The upside of being forced down this route: what's on screen is the real composite being
// encoded, not a reconstruction of it, so it can't drift from the finished file.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoVideocam } from "react-icons/io5";
import { PHONE_CAMERA_DEVICE } from "../services/phoneCamera";

interface LiveCameraRecordingViewProps {
    // Every camera the user ticked, phone sentinel included - this component works out for itself
    // which of them ffmpeg is actually compositing.
    videoDevices: string[];
    isPaused: boolean;
}

// ffmpeg publishes the preview at 12fps (~83ms apart), so the poll has to be quicker than that to
// see every frame rather than alias against them. At 80ms the round trip put each iteration at
// ~94ms and delivered ~8.5 frames a second - the poller, not the pipeline, was the limit. 40ms
// clears the source rate with margin.
//
// Affordable because a poll is now a memory copy: the frame is held in RAM by
// services/preview_stream.rs and returned as raw bytes, so there is no file read, no base64, and
// no JSON on this path.
const POLL_MS = 40;

const LiveCameraRecordingView = ({ videoDevices, isPaused }: LiveCameraRecordingViewProps) => {
    const [frame, setFrame] = useState<string | null>(null);
    // Set once the first frame lands, so the "starting up" message doesn't flash back in if a
    // later poll happens to come back empty.
    const startedRef = useRef(false);
    // The object URL currently on screen. Each frame creates one and the previous must be revoked
    // by hand - left alone, a blob per frame at this rate leaks steadily for the whole recording,
    // which is precisely the kind of slow growth that only shows up on a long take.
    const urlRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        let timer: number | undefined;

        const poll = async () => {
            try {
                // Raw JPEG bytes rather than a data URL - see get_recording_preview_frame. An
                // empty body means "nothing to show yet", which is normal before ffmpeg's first
                // frame and after the recording ends.
                const bytes = await invoke<ArrayBuffer>("get_recording_preview_frame");
                if (cancelled) return;
                if (bytes && bytes.byteLength > 0) {
                    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
                    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
                    urlRef.current = url;
                    startedRef.current = true;
                    setFrame(url);
                }
            } catch {
                // The recording ended between the poll being scheduled and it running. Keeping the
                // last frame on screen is better than blanking it for the moment before this
                // component unmounts anyway.
            }
            if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
        };

        poll();
        return () => {
            cancelled = true;
            if (timer) window.clearTimeout(timer);
            if (urlRef.current) {
                URL.revokeObjectURL(urlRef.current);
                urlRef.current = null;
            }
        };
    }, []);

    // Only the computer's own cameras are in this picture. The phone is recorded by the WebView
    // into its own `_webcam.mp4` layer and never reaches ffmpeg's composite, so counting it here
    // claimed "2 cameras, side by side" over a frame showing exactly one.
    const composited = videoDevices.filter((d) => d !== PHONE_CAMERA_DEVICE);
    const hasPhone = videoDevices.includes(PHONE_CAMERA_DEVICE);

    const caption =
        (composited.length > 1
            ? `${composited.length} cameras, side by side`
            : composited.length === 1
            ? "1 camera"
            : "No camera selected") +
        (hasPhone ? ", plus your phone as a separate layer" : "");

    return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-4 p-6">
            <div className="relative w-full max-w-3xl aspect-video rounded-xl overflow-hidden bg-black ring-1 ring-black/10 dark:ring-white/10 shadow-lg">
                {frame ? (
                    <img src={frame} alt="" className="w-full h-full object-contain" />
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-neutral-400">
                        <IoVideocam size={26} className="opacity-70" />
                        <span className="text-xs">
                            {startedRef.current ? "Reconnecting…" : "Starting camera…"}
                        </span>
                    </div>
                )}

                <div className="absolute top-3 left-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/60 backdrop-blur-sm text-white text-[11px] font-medium">
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${
                            isPaused ? "bg-amber-400" : "bg-red-500 animate-pulse"
                        }`}
                    />
                    {isPaused ? "Paused" : "Recording"}
                </div>
            </div>

            <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {caption} — this is what's being saved to your recording.
            </p>
        </div>
    );
};

export default LiveCameraRecordingView;
