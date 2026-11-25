import React, { useEffect, useRef, useState } from "react";
import { IoMicOutline, IoMicOffOutline } from "react-icons/io5";

interface LiveMicMeterProps {
    audioDevice?: string;
    className?: string;
}

export const LiveMicMeter: React.FC<LiveMicMeterProps> = ({ audioDevice, className = "" }) => {
    const [active, setActive] = useState<boolean>(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textRef = useRef<HTMLSpanElement | null>(null);
    const micIconRef = useRef<HTMLSpanElement | null>(null);
    const visibleRef = useRef<boolean>(true);

    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof IntersectionObserver === "undefined") return;
        const obs = new IntersectionObserver(
            (entries) => {
                visibleRef.current = entries.some((e) => e.isIntersecting);
            },
            { threshold: 0 }
        );
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        if (!audioDevice || audioDevice.trim() === "") {
            setActive(false);
            return;
        }

        let isCancelled = false;
        let stream: MediaStream | null = null;
        let audioCtx: AudioContext | null = null;
        let animId = 0;
        let peakLevel = 0;

        const startMeter = async () => {
            try {
                let deviceId: string | undefined = undefined;
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const match = devices.find(
                        (d) => d.kind === "audioinput" && (d.label === audioDevice || d.deviceId === audioDevice)
                    );
                    if (match?.deviceId) {
                        deviceId = match.deviceId;
                    }
                } catch {
                    // Fall back to default
                }

                if (isCancelled) return;

                const constraints: MediaStreamConstraints = {
                    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
                    video: false,
                };

                stream = await navigator.mediaDevices.getUserMedia(constraints);
                if (isCancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }

                setActive(true);

                const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                audioCtx = new AudioContextClass();
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.4;
                source.connect(analyser);

                const dataArray = new Uint8Array(analyser.fftSize);

                let lastDraw = 0;
                const draw = (ts: number) => {
                    if (isCancelled) return;
                    // Skip drawing when scrolled off-screen or hidden, and cap to ~30fps to save CPU.
                    if (!visibleRef.current || document.hidden || ts - lastDraw < 32) {
                        animId = requestAnimationFrame(draw);
                        return;
                    }
                    lastDraw = ts;
                    analyser.getByteTimeDomainData(dataArray);

                    let sumSquares = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        const norm = (dataArray[i] - 128) / 128;
                        sumSquares += norm * norm;
                    }
                    const rms = Math.sqrt(sumSquares / dataArray.length);
                    const targetLevel = Math.min(1, Math.max(0, rms * 4.5));

                    if (targetLevel > peakLevel) {
                        peakLevel = targetLevel;
                    } else {
                        peakLevel = Math.max(0, peakLevel * 0.90);
                    }

                    // Direct canvas rendering — NO React state re-renders, 0% CPU impact on scrolling!
                    const canvas = canvasRef.current;
                    if (canvas) {
                        const ctx = canvas.getContext("2d");
                        if (ctx) {
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            const segments = 10;
                            const litCount = Math.round(peakLevel * segments);
                            const segWidth = 4;
                            const segGap = 2;

                            for (let i = 0; i < segments; i++) {
                                const x = i * (segWidth + segGap);
                                if (i < litCount) {
                                    if (i >= 8) {
                                        ctx.fillStyle = "#f43f5e"; // rose
                                    } else if (i >= 6) {
                                        ctx.fillStyle = "#fbbf24"; // amber
                                    } else {
                                        ctx.fillStyle = "#10b981"; // emerald
                                    }
                                } else {
                                    ctx.fillStyle = "rgba(120, 120, 120, 0.25)";
                                }
                                ctx.fillRect(x, 0, segWidth, canvas.height);
                            }
                        }
                    }

                    if (textRef.current) {
                        textRef.current.textContent = `${Math.round(peakLevel * 100)}%`;
                    }
                    if (micIconRef.current) {
                        micIconRef.current.style.color = peakLevel > 0.08 ? "#10b981" : "#9ca3af";
                    }

                    animId = requestAnimationFrame(draw);
                };

                animId = requestAnimationFrame(draw);
            } catch {
                if (!isCancelled) {
                    setActive(false);
                }
            }
        };

        // Defer opening the mic by 180 ms so the modal opens and paints at 60 fps first without
        // blocking on WASAPI/enumerateDevices during the open transition.
        const startTimer = window.setTimeout(() => {
            if (!isCancelled) void startMeter();
        }, 180);

        return () => {
            isCancelled = true;
            window.clearTimeout(startTimer);
            if (animId) cancelAnimationFrame(animId);
            // Release WASAPI/MediaStream handles on the next macrotask so closing the modal paints
            // immediately (<16 ms) instead of blocking the UI thread during React unmount.
            const s = stream;
            const ctx = audioCtx;
            if (s || ctx) {
                window.setTimeout(() => {
                    if (s) s.getTracks().forEach((t) => t.stop());
                    if (ctx && ctx.state !== "closed") void ctx.close();
                }, 0);
            }
        };
    }, [audioDevice]);

    return (
        <div ref={rootRef} className={`flex items-center gap-1.5 ${className}`} title={active ? "Microphone input active" : "Microphone inactive"}>
            <span ref={micIconRef} className="transition-colors duration-75">
                {active ? <IoMicOutline className="w-3.5 h-3.5" /> : <IoMicOffOutline className="w-3.5 h-3.5 text-neutral-400" />}
            </span>

            <div className="flex items-center h-3 px-1 py-0.5 bg-neutral-100 dark:bg-neutral-800/80 rounded border border-neutral-200/80 dark:border-neutral-700/80">
                <canvas ref={canvasRef} width={58} height={8} className="block" />
            </div>

            {active && (
                <span ref={textRef} className="text-[10px] font-mono text-neutral-400 dark:text-neutral-500 select-none w-6 text-right">
                    0%
                </span>
            )}
        </div>
    );
};

export default LiveMicMeter;
