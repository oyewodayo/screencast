import { useCallback, useEffect, useRef, useState, RefObject } from 'react';
import { invoke } from '@tauri-apps/api/tauri';

// Mirrors the Rust side's serde-serialized shapes exactly (src-tauri/src/commands/native_playback.rs).
interface PlaybackSessionInfo {
  session_id: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  sample_rate: number;
  channels: number;
}

interface VideoFrame {
  data_base64: string;
  pts: number;
}

interface AudioChunk {
  data_base64: string;
  pts: number;
  sample_count: number;
}

interface DecodedVideoFrame {
  bitmap: ImageBitmap;
  pts: number;
}

// How many decoded-but-not-yet-displayed video frames to keep buffered ahead of playback, and
// how many seconds of audio to keep scheduled ahead - both are the local prefetch cushion that
// absorbs IPC/decode jitter without needing the two pull loops to be perfectly synchronized with
// each other or with rendering.
const VIDEO_PREFETCH_TARGET = 10;
const AUDIO_PREFETCH_SECONDS = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Owns the whole native-decode playback runtime for one <canvas>: two independent pull loops
// (video frames, audio chunks) feeding local prefetch buffers, plus a requestAnimationFrame loop
// that paces video display against the audio clock (or a wall-clock fallback when the source has
// no audio), dropping any buffered frames that fall behind rather than trying to keep the two
// pipelines in lockstep. See the plan's "Architecture" section for the full reasoning - this is
// the browser-side half of the ffmpeg-decode-to-canvas fallback player.
export function useNativePlaybackEngine(canvasRef: RefObject<HTMLCanvasElement>) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const sessionIdRef = useRef<number | null>(null);
  const sessionInfoRef = useRef<PlaybackSessionInfo | null>(null);
  // Bumped on every start()/seek()/stop() - each pull/render loop closes over the id it was
  // started with and stops itself the moment this no longer matches, which is what lets a new
  // seek or file selection cleanly supersede whatever was running before without explicit
  // cross-loop signaling.
  const runIdRef = useRef(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const mutedRef = useRef(false);
  const volumeRef = useRef(1);
  // The AudioContext time (or scheduled-until horizon) up to which audio has already been
  // scheduled, so each newly-pulled chunk gets appended right after the previous one instead of
  // overlapping or leaving gaps.
  const audioScheduledUntilRef = useRef(0);

  const videoBufferRef = useRef<DecodedVideoFrame[]>([]);
  const lastDrawnBitmapRef = useRef<ImageBitmap | null>(null);

  // Media clock: `clockMediaTimeRef` is the media position (matching frame/chunk `pts` values)
  // at the moment it was last anchored (on start/seek/play/pause), and `clockRefTimeRef` is the
  // reference clock's value (AudioContext.currentTime if the source has audio, else
  // performance.now()/1000) at that same moment. Elapsed reference-clock time since the anchor,
  // added to the anchored media time, gives the current playback position - re-anchoring on
  // every play/pause/seek means pauses never leak into the elapsed-time math.
  const clockMediaTimeRef = useRef(0);
  const clockRefTimeRef = useRef(0);
  const playingRef = useRef(false);

  const rafRef = useRef<number | null>(null);
  const lastTimeUpdateRef = useRef(0);

  const referenceNow = useCallback((): number => {
    return audioContextRef.current ? audioContextRef.current.currentTime : performance.now() / 1000;
  }, []);

  const anchorClock = useCallback((mediaTime: number) => {
    clockMediaTimeRef.current = mediaTime;
    clockRefTimeRef.current = referenceNow();
  }, [referenceNow]);

  const mediaClock = useCallback((): number => {
    if (!playingRef.current) return clockMediaTimeRef.current;
    return clockMediaTimeRef.current + (referenceNow() - clockRefTimeRef.current);
  }, [referenceNow]);

  const videoPullLoop = useCallback(async (myRunId: number, sessionId: number) => {
    while (runIdRef.current === myRunId) {
      if (videoBufferRef.current.length >= VIDEO_PREFETCH_TARGET) {
        await sleep(50);
        continue;
      }
      let frame: VideoFrame | null;
      try {
        frame = await invoke<VideoFrame | null>('get_next_video_frame', { sessionId });
      } catch (err) {
        console.error('get_next_video_frame failed:', err);
        return;
      }
      if (runIdRef.current !== myRunId) return;
      if (!frame) {
        // Nothing new yet (or the stream ended) - back off briefly rather than hammering invoke.
        await sleep(100);
        continue;
      }
      try {
        const bytes = base64ToUint8Array(frame.data_base64);
        const bitmap = await createImageBitmap(
          new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })
        );
        if (runIdRef.current !== myRunId) {
          bitmap.close();
          return;
        }
        videoBufferRef.current.push({ bitmap, pts: frame.pts });
      } catch (err) {
        console.error('Failed to decode a video frame:', err);
      }
    }
  }, []);

  // Raw s16le PCM -> a Web Audio AudioBuffer, scheduled to start right after whatever was
  // scheduled before it. No decodeAudioData needed - this is why raw PCM (not a container) was
  // chosen for the audio pipe.
  const scheduleAudioChunk = useCallback((chunk: AudioChunk, sampleRate: number, channels: number) => {
    const ctx = audioContextRef.current;
    const gain = gainNodeRef.current;
    if (!ctx || !gain) return;

    const bytes = base64ToUint8Array(chunk.data_base64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameCount = chunk.sample_count;
    if (frameCount === 0) return;

    const audioBuffer = ctx.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        const byteIndex = (i * channels + ch) * 2;
        channelData[i] = view.getInt16(byteIndex, true) / 32768;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gain);

    const startAt = Math.max(audioScheduledUntilRef.current, ctx.currentTime);
    source.start(startAt);
    audioScheduledUntilRef.current = startAt + audioBuffer.duration;
  }, []);

  const audioPullLoop = useCallback(async (myRunId: number, sessionId: number, sampleRate: number, channels: number) => {
    while (runIdRef.current === myRunId) {
      const ctx = audioContextRef.current;
      const bufferedAhead = ctx ? audioScheduledUntilRef.current - ctx.currentTime : 0;
      if (bufferedAhead > AUDIO_PREFETCH_SECONDS) {
        await sleep(100);
        continue;
      }
      let chunk: AudioChunk | null;
      try {
        chunk = await invoke<AudioChunk | null>('get_next_audio_chunk', { sessionId });
      } catch (err) {
        console.error('get_next_audio_chunk failed:', err);
        return;
      }
      if (runIdRef.current !== myRunId) return;
      if (!chunk) {
        await sleep(100);
        continue;
      }
      scheduleAudioChunk(chunk, sampleRate, channels);
    }
  }, [scheduleAudioChunk]);

  const renderLoop = useCallback((myRunId: number) => {
    const tick = () => {
      if (runIdRef.current !== myRunId) return;
      const clock = mediaClock();
      const buf = videoBufferRef.current;

      // Advance past (and free) any buffered frames whose pts has already elapsed, keeping only
      // the latest one that's due - the explicit "drop frames to stay in sync" strategy.
      let selected: DecodedVideoFrame | null = null;
      while (buf.length > 0 && buf[0].pts <= clock) {
        if (selected) selected.bitmap.close();
        selected = buf.shift()!;
      }

      if (selected) {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx) {
          ctx.drawImage(selected.bitmap, 0, 0, canvas.width, canvas.height);
        }
        lastDrawnBitmapRef.current?.close();
        lastDrawnBitmapRef.current = selected.bitmap;
      }

      const now = performance.now();
      if (now - lastTimeUpdateRef.current > 200) {
        lastTimeUpdateRef.current = now;
        setCurrentTime(clock);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [mediaClock, canvasRef]);

  const clearBuffers = useCallback(() => {
    videoBufferRef.current.forEach((f) => f.bitmap.close());
    videoBufferRef.current = [];
    lastDrawnBitmapRef.current?.close();
    lastDrawnBitmapRef.current = null;
  }, []);

  const stopInternal = useCallback(() => {
    runIdRef.current += 1;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    clearBuffers();

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
      gainNodeRef.current = null;
    }

    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    sessionInfoRef.current = null;
    playingRef.current = false;
    setIsPlaying(false);
    setCurrentTime(0);

    if (sessionId !== null) {
      invoke('stop_native_playback', { sessionId }).catch((err) => {
        console.error('stop_native_playback failed:', err);
      });
    }
  }, [clearBuffers]);

  const start = useCallback(async (filePath: string, initialTime?: number, shouldAutoPlay = true): Promise<{ duration: number }> => {
    stopInternal();
    const myRunId = ++runIdRef.current;

    const info = await invoke<PlaybackSessionInfo>('start_native_playback', {
      inputPath: filePath,
      startTime: initialTime ?? null,
    });

    if (runIdRef.current !== myRunId) {
      // A newer start()/stop() landed while this was in flight - discard what we just started.
      invoke('stop_native_playback', { sessionId: info.session_id }).catch(() => {});
      throw new Error('Native playback start superseded by a newer request');
    }

    sessionIdRef.current = info.session_id;
    sessionInfoRef.current = info;
    setDuration(info.duration);

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = info.width;
      canvas.height = info.height;
    }

    if (info.has_audio) {
      const ctx = new AudioContext({ sampleRate: info.sample_rate });
      const gain = ctx.createGain();
      gain.gain.value = mutedRef.current ? 0 : volumeRef.current;
      gain.connect(ctx.destination);
      audioContextRef.current = ctx;
      gainNodeRef.current = gain;
      audioScheduledUntilRef.current = ctx.currentTime;
    }

    anchorClock(initialTime ?? 0);
    playingRef.current = shouldAutoPlay;
    setIsPlaying(shouldAutoPlay);
    if (shouldAutoPlay) audioContextRef.current?.resume();

    videoPullLoop(myRunId, info.session_id);
    if (info.has_audio) {
      audioPullLoop(myRunId, info.session_id, info.sample_rate, info.channels);
    }
    renderLoop(myRunId);

    return { duration: info.duration };
  }, [stopInternal, anchorClock, canvasRef, videoPullLoop, audioPullLoop, renderLoop]);

  const play = useCallback(() => {
    if (playingRef.current || sessionIdRef.current === null) return;
    playingRef.current = true;
    anchorClock(clockMediaTimeRef.current);
    audioContextRef.current?.resume();
    setIsPlaying(true);
  }, [anchorClock]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    clockMediaTimeRef.current = mediaClock();
    playingRef.current = false;
    audioContextRef.current?.suspend();
    setIsPlaying(false);
  }, [mediaClock]);

  const seek = useCallback(async (time: number) => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    const myRunId = ++runIdRef.current;

    clearBuffers();
    if (audioContextRef.current) {
      audioScheduledUntilRef.current = audioContextRef.current.currentTime;
    }

    const wasPlaying = playingRef.current;
    anchorClock(time);
    playingRef.current = wasPlaying;

    try {
      await invoke('seek_native_playback', { sessionId, timeSecs: time });
    } catch (err) {
      console.error('seek_native_playback failed:', err);
    }

    if (runIdRef.current !== myRunId) return; // superseded by a newer seek/stop while awaiting

    videoPullLoop(myRunId, sessionId);
    if (sessionInfoRef.current?.has_audio) {
      audioPullLoop(myRunId, sessionId, sessionInfoRef.current.sample_rate, sessionInfoRef.current.channels);
    }
    renderLoop(myRunId);
  }, [clearBuffers, anchorClock, videoPullLoop, audioPullLoop, renderLoop]);

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    if (gainNodeRef.current && !mutedRef.current) {
      gainNodeRef.current.gain.value = v;
    }
  }, []);

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = m ? 0 : volumeRef.current;
    }
  }, []);

  const stop = useCallback(() => {
    stopInternal();
  }, [stopInternal]);

  useEffect(() => {
    return () => {
      stopInternal();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { start, stop, play, pause, seek, setVolume, setMuted, isPlaying, currentTime, duration };
}
