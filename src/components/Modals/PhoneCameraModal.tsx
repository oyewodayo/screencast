// components/Modals/PhoneCameraModal.tsx
//
// The pairing panel for using a phone as a camera. See src/services/phoneCamera.ts and
// src-tauri/src/services/phone_camera.rs for how the connection is actually made; this component
// is only the surface that gets the user from "phone in hand" to "stream on screen".
//
// The one piece of friction worth explaining here rather than hiding: the phone will show a
// certificate warning. That isn't a bug to be papered over - browsers refuse camera access on an
// insecure origin, so Briefcast has to serve HTTPS, and a self-signed cert is the only kind it can
// mint for a LAN IP. Users who hit an unexplained "Your connection is not private" screen assume
// something is broken and stop, so the warning is called out up front, before they see it.

import { useEffect, useRef, useState } from "react";
import { IoClose, IoPhonePortraitOutline, IoCheckmarkCircle, IoWarning, IoCopyOutline } from "react-icons/io5";
import {
    startPhoneCamera,
    stopPhoneCamera,
    subscribePhoneCamera,
    getPhoneCameraState,
    type PhoneCameraState,
} from "../../services/phoneCamera";

interface PhoneCameraModalProps {
    onClose: () => void;
    // Fired once a stream is actually live, so the caller can tick "Phone camera" on in the
    // device checklist without the user having to go back and do it by hand.
    onConnected?: () => void;
}

const PhoneCameraModal = ({ onClose, onConnected }: PhoneCameraModalProps) => {
    const [state, setState] = useState<PhoneCameraState>(getPhoneCameraState());
    const [copied, setCopied] = useState(false);
    // Which of the machine's addresses is currently on offer. Auto-detection can pick a virtual
    // adapter (WSL, Hyper-V) the phone has no route to, and the only symptom is a QR that silently
    // never connects - so the others are one click away rather than undiscoverable.
    const [addressIndex, setAddressIndex] = useState(0);
    const videoRef = useRef<HTMLVideoElement>(null);
    const notifiedRef = useRef(false);

    useEffect(() => subscribePhoneCamera(setState), []);

    // Start the server when the panel opens. Deliberately NOT stopped on unmount: closing the
    // panel after pairing must not kill the stream the user just set up - they still have to get
    // back to the recording bar and press record. stopPhoneCamera is wired to the explicit
    // "Disconnect" button and to the end of a recording session instead.
    useEffect(() => {
        void startPhoneCamera().catch(() => {
            /* surfaced through state.error by the service */
        });
    }, []);

    useEffect(() => {
        if (state.status === "live" && !notifiedRef.current) {
            notifiedRef.current = true;
            onConnected?.();
        }
        if (state.status !== "live") notifiedRef.current = false;
    }, [state.status, onConnected]);

    useEffect(() => {
        if (videoRef.current && state.stream) videoRef.current.srcObject = state.stream;
    }, [state.stream]);

    // Index 0 is the auto-detected address; the rest come from info.alternatives.
    const addresses = state.info
        ? [
              { url: state.info.url, host: state.info.host, qr_svg: state.info.qr_svg },
              ...state.info.alternatives,
          ]
        : [];
    const active = addresses[Math.min(addressIndex, Math.max(addresses.length - 1, 0))];

    const handleCopy = async () => {
        if (!active) return;
        try {
            await navigator.clipboard.writeText(active.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            /* clipboard unavailable - the address is on screen to type anyway */
        }
    };

    const handleDisconnect = async () => {
        await stopPhoneCamera();
        onClose();
    };

    const statusLabel = () => {
        switch (state.status) {
            case "live": return "Phone connected";
            case "connecting": return "Phone found - waiting for camera…";
            case "waiting": return "Waiting for your phone";
            case "error": return "Connection problem";
            default: return "Starting…";
        }
    };

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="w-[760px] max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-neutral-200 dark:border-neutral-800">
                    <IoPhonePortraitOutline className="text-neutral-500 dark:text-neutral-400" size={18} />
                    <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">Use your phone as a camera</h2>
                    <span
                        className={`ml-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            state.status === "live"
                                ? "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400"
                                : state.status === "error"
                                ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400"
                                : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                        }`}
                    >
                        <span
                            className={`w-1.5 h-1.5 rounded-full ${
                                state.status === "live"
                                    ? "bg-green-500"
                                    : state.status === "error"
                                    ? "bg-red-500"
                                    : "bg-neutral-400 animate-pulse"
                            }`}
                        />
                        {statusLabel()}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="ml-auto p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        title="Close"
                    >
                        <IoClose size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-5">
                    {state.error && (
                        <div className="mb-4 flex gap-2.5 p-3 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300 text-[13px] leading-relaxed">
                            <IoWarning className="shrink-0 mt-0.5" size={16} />
                            <span>{state.error}</span>
                        </div>
                    )}

                    {state.status === "live" ? (
                        <div>
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                className="w-full aspect-video rounded-xl bg-black object-contain"
                            />
                            <div className="mt-3 flex items-center gap-2 text-[13px] text-neutral-600 dark:text-neutral-400">
                                <IoCheckmarkCircle className="text-green-500" size={16} />
                                <span>
                                    Your phone is now available as <strong className="font-medium text-neutral-800 dark:text-neutral-200">Phone camera</strong> in the
                                    recording bar. It records as a separate picture-in-picture layer you can move and resize in the editor.
                                </span>
                            </div>
                        </div>
                    ) : (
                        <div className="flex gap-6">
                            <div className="shrink-0">
                                {active?.qr_svg ? (
                                    <div
                                        className="w-[212px] h-[212px] p-2 rounded-xl bg-white ring-1 ring-neutral-200 dark:ring-neutral-700 [&>svg]:w-full [&>svg]:h-full"
                                        dangerouslySetInnerHTML={{ __html: active.qr_svg }}
                                    />
                                ) : (
                                    <div className="w-[212px] h-[212px] rounded-xl bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
                                )}
                            </div>

                            <div className="flex-1 min-w-0">
                                <ol className="space-y-3 text-[13px] text-neutral-700 dark:text-neutral-300">
                                    <li className="flex gap-2.5">
                                        <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-semibold flex items-center justify-center">1</span>
                                        <span>Make sure your phone is on the same Wi-Fi network as this computer (your phone's hotspot works too).</span>
                                    </li>
                                    <li className="flex gap-2.5">
                                        <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-semibold flex items-center justify-center">2</span>
                                        <span>Scan the code with your phone's camera, or open the address below in its browser.</span>
                                    </li>
                                    <li className="flex gap-2.5">
                                        <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-semibold flex items-center justify-center">3</span>
                                        <span>
                                            Your browser will warn that the connection <em>isn't private</em>. That's expected — tap{" "}
                                            <strong className="font-medium">Advanced</strong> then{" "}
                                            <strong className="font-medium">Proceed</strong>. Briefcast has to use HTTPS because browsers
                                            won't share a camera over a plain connection, and it can only issue its own certificate for
                                            your local network.
                                        </span>
                                    </li>
                                    <li className="flex gap-2.5">
                                        <span className="shrink-0 w-5 h-5 rounded-full bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[11px] font-semibold flex items-center justify-center">4</span>
                                        <span>Tap <strong className="font-medium">Start camera</strong> and allow camera access.</span>
                                    </li>
                                </ol>

                                {active && (
                                    <div className="mt-4">
                                        <div className="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-1.5">Address</div>
                                        <div className="flex items-center gap-2">
                                            <code className="flex-1 min-w-0 truncate px-3 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-[13px] text-neutral-800 dark:text-neutral-200">
                                                {active.url}
                                            </code>
                                            <button
                                                type="button"
                                                onClick={handleCopy}
                                                title="Copy address"
                                                className="shrink-0 px-2.5 py-2 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                                            >
                                                {copied ? <IoCheckmarkCircle className="text-green-500" size={16} /> : <IoCopyOutline size={16} />}
                                            </button>
                                        </div>

                                        {addresses.length > 1 && (
                                            <div className="mt-2.5">
                                                <div className="text-[12px] text-neutral-500 dark:text-neutral-400">
                                                    Phone not connecting? This computer has more than one network address &mdash; try another:
                                                </div>
                                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                                    {addresses.map((a, i) => (
                                                        <button
                                                            key={a.url}
                                                            type="button"
                                                            onClick={() => setAddressIndex(i)}
                                                            className={`px-2 py-1 rounded-md text-[12px] font-medium border ${
                                                                i === addressIndex
                                                                    ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 border-transparent"
                                                                    : "bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                                                            }`}
                                                        >
                                                            {a.host}
                                                            {i === 0 ? " (auto)" : ""}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2 px-5 py-3.5 border-t border-neutral-200 dark:border-neutral-800">
                    <span className="text-[12px] text-neutral-400 dark:text-neutral-500">
                        Nothing is installed on your phone — the video goes straight from its browser to Briefcast.
                    </span>
                    <div className="ml-auto flex gap-2">
                        {state.status === "live" && (
                            <button
                                type="button"
                                onClick={handleDisconnect}
                                className="px-3.5 py-2 rounded-lg text-[13px] font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                            >
                                Disconnect
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-3.5 py-2 rounded-lg text-[13px] font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90"
                        >
                            {state.status === "live" ? "Done" : "Close"}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PhoneCameraModal;
