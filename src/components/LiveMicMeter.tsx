import React, { useEffect, useRef, useState } from "react";
import { IoMicOutline, IoMicOffOutline } from "react-icons/io5";

interface LiveMicMeterProps {
    audioDevice?: string;
    className?: string;
}

export const LiveMicMeter: React.FC<LiveMicMeterProps> = ({ audioDevice, className = "" }) => {
    const [active, setActive] = useState<boolean>(false);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const textRef = useRef<HTMLSpanElement | null>(null);
    const micIconRef = useRef<HTMLSpanElement | null>(null);

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

                const draw = () => {
                    if (isCancelled) return;
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

        void startMeter();

        return () => {
            isCancelled = true;
            if (animId) cancelAnimationFrame(animId);
            if (stream) stream.getTracks().forEach((t) => t.stop());
            if (audioCtx && audioCtx.state !== "closed") void audioCtx.close();
        };
    }, [audioDevice]);

    return (
        <div className={`flex items-center gap-1.5 ${className}`} title={active ? "Microphone input active" : "Microphone inactive"}>
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
