import React, { useEffect, useRef, useState } from "react";
import { IoMicOutline, IoMicOffOutline } from "react-icons/io5";

interface LiveMicMeterProps {
    audioDevice?: string;
    className?: string;
}

export const LiveMicMeter: React.FC<LiveMicMeterProps> = ({ audioDevice, className = "" }) => {
    const [level, setLevel] = useState<number>(0);
    const [active, setActive] = useState<boolean>(false);
    const [hasPermission, setHasPermission] = useState<boolean>(true);
    const animRef = useRef<number>(0);
    const peakRef = useRef<number>(0);

    useEffect(() => {
        if (!audioDevice || audioDevice.trim() === "") {
            setActive(false);
            setLevel(0);
            return;
        }

        let isCancelled = false;
        let stream: MediaStream | null = null;
        let audioCtx: AudioContext | null = null;

        const startMeter = async () => {
            try {
                // Find matching device ID by label if possible
                let deviceId: string | undefined = undefined;
                try {
                    const devices = await navigator.mediaDevices.enumerateDevices();
                    const match = devices.find(
                        (d) => d.kind === "audioinput" && (d.label === audioDevice || d.deviceId === audioDevice)
                    );
                    if (match && match.deviceId) {
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

                setHasPermission(true);
                setActive(true);

                const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                audioCtx = new AudioContextClass();
                const source = audioCtx.createMediaStreamSource(stream);
                const analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.5;
                source.connect(analyser);

                const dataArray = new Uint8Array(analyser.fftSize);

                const update = () => {
                    if (isCancelled) return;
                    analyser.getByteTimeDomainData(dataArray);

                    let sumSquares = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        const norm = (dataArray[i] - 128) / 128;
                        sumSquares += norm * norm;
                    }
                    const rms = Math.sqrt(sumSquares / dataArray.length);

                    // Map typical conversational speech (RMS 0.02 - 0.25) into a 0..1 scale
                    const targetLevel = Math.min(1, Math.max(0, rms * 4.5));

                    // Smooth decay so meter feels natural
                    if (targetLevel > peakRef.current) {
                        peakRef.current = targetLevel;
                    } else {
                        peakRef.current = Math.max(0, peakRef.current * 0.88);
                    }

                    setLevel(peakRef.current);
                    animRef.current = requestAnimationFrame(update);
                };

                animRef.current = requestAnimationFrame(update);
            } catch (err) {
                if (!isCancelled) {
                    setHasPermission(false);
                    setActive(false);
                    setLevel(0);
                }
            }
        };

        void startMeter();

        return () => {
            isCancelled = true;
            if (animRef.current) {
                cancelAnimationFrame(animRef.current);
            }
            if (stream) {
                stream.getTracks().forEach((t) => t.stop());
            }
            if (audioCtx && audioCtx.state !== "closed") {
                void audioCtx.close();
            }
        };
    }, [audioDevice]);

    // 10 segmented LED blocks for the VU meter
    const SEGMENTS = 10;
    const activeSegments = Math.round(level * SEGMENTS);

    return (
        <div className={`flex items-center gap-1.5 ${className}`} title={active ? "Microphone input active" : "Microphone inactive"}>
            {active && hasPermission ? (
                <IoMicOutline className={`w-3.5 h-3.5 transition-colors ${level > 0.05 ? "text-emerald-500 animate-pulse" : "text-neutral-400"}`} />
            ) : (
                <IoMicOffOutline className="w-3.5 h-3.5 text-neutral-400" />
            )}

            <div className="flex items-center gap-0.5 h-3 px-1 py-0.5 bg-neutral-100 dark:bg-neutral-800/80 rounded border border-neutral-200/80 dark:border-neutral-700/80">
                {Array.from({ length: SEGMENTS }).map((_, idx) => {
                    const isLit = idx < activeSegments;
                    let colorClass = "bg-neutral-200 dark:bg-neutral-700";
                    if (isLit) {
                        if (idx >= 8) {
                            colorClass = "bg-rose-500 shadow-sm shadow-rose-500/50";
                        } else if (idx >= 6) {
                            colorClass = "bg-amber-400 shadow-sm shadow-amber-400/50";
                        } else {
                            colorClass = "bg-emerald-500 shadow-sm shadow-emerald-500/50";
                        }
                    }

                    return (
                        <div
                            key={idx}
                            className={`w-1 h-2 rounded-[1px] transition-colors duration-75 ${colorClass}`}
                        />
                    );
                })}
            </div>
            {active && (
                <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-500 select-none">
                    {Math.round(level * 100)}%
                </span>
            )}
        </div>
    );
};

export default LiveMicMeter;
