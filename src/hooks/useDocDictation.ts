// hooks/useDocDictation.ts
//
// Microphone → whisper → document pipeline for Docs dictation (editor side: docDictationExtension.ts;
// text rules: dictationText.ts).
//
// Reads the mic as raw 16kHz mono PCM, filters it through a speech-band (100–3800 Hz) + zero-crossing
// voice-activity detector with an adaptive noise floor, streams rolling word-by-word previews while
// the user speaks, and cuts utterances at natural pauses.
import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { applyDictationOps, documentTextBeforeDictation } from "../utils/docDictationExtension";
import {
  buildWhisperPrompt,
  isLikelyHallucination,
  parseDictation,
  stripNonSpeech,
} from "../utils/dictationText";

export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

export const DICTATION_LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Detect automatically" },
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "uk", label: "Ukrainian" },
  { code: "tr", label: "Turkish" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "yo", label: "Yoruba" },
  { code: "sw", label: "Swahili" },
];

const LANGUAGE_STORAGE_KEY = "briefcast.docs.dictationLanguage";
const DETECTED_STORAGE_KEY = "briefcast.docs.dictationDetectedLanguage";
const SAMPLE_RATE = 16000;
const FRAME_SIZE = 1024; // ScriptProcessor buffer at the context rate (~64ms at 16kHz)
const PRE_ROLL_MS = 160; // audio kept from before speech onset so the first consonant isn't clipped
const END_SILENCE_MS = 340; // pause that ends a short utterance
const CLAUSE_MAX_MS = 1750; // past ~1.75s, cut on a brief clause pause
const CLAUSE_SILENCE_MS = 210;
const SOFT_MAX_MS = 3800; // past ~3.8s, cut on any short word-boundary pause
const SOFT_SILENCE_MS = 140;
const HARD_MAX_MS = 7500; // cap chunk length so real-time dictation never stalls on a long monologue
const MIN_SPEECH_MS = 240; // shorter bursts are mouse clicks / breaths
const PREVIEW_MIN_SPEECH_MS = 320; // start rolling word-by-word preview after ~0.32s of speech
const PREVIEW_INTERVAL_MS = 460; // refresh rolling preview every ~0.46s while speaking
const WORD_TICK_MS = 30; // word-by-word reveal cadence for smooth real-time typing feel

// Disabled for the rest of the session once the engine reports it can't run (WebView2 ships the
// API surface without a working backend on many machines).
let webSpeechUnavailable = false;

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (webSpeechUnavailable) return null;
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function readStoredLanguage(): string {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored && DICTATION_LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch {
    // storage unavailable - fall through to the default
  }
  return "auto";
}

function readStoredDetectedLanguage(): string | null {
  try {
    const stored = localStorage.getItem(DETECTED_STORAGE_KEY);
    return stored && /^[a-z]{2,3}$/.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function browserFallbackLanguage(): string {
  try {
    const nav = (navigator.language || "en").split("-")[0].toLowerCase();
    if (DICTATION_LANGUAGES.some((l) => l.code === nav && l.code !== "auto")) return nav;
  } catch {
    // ignore
  }
  return "en";
}

function languageLabel(code: string | null): string | null {
  if (!code) return null;
  return DICTATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

function encodeWav(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// Box-filter downsample for when the WebView refuses a 16kHz AudioContext.
function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return new Float32Array(input);
  const ratio = fromRate / SAMPLE_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

// Computes speech-band RMS (approx 100 Hz – 3800 Hz) and Zero-Crossing Rate so 50/60 Hz hum,
// breath puffs, and high-frequency mouse/keyboard clicks don't trigger false speech segments.
function analyzeSpeechFrame(frame: Float32Array): { bandRms: number; zcr: number } {
  const n = frame.length;
  if (n === 0) return { bandRms: 0, zcr: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;

  // 1-pole high-pass (~110 Hz at 16kHz) + 1-pole low-pass (~3800 Hz at 16kHz)
  const hpAlpha = 0.955;
  const lpAlpha = 0.62;
  let prevX = frame[0] - mean;
  let hpY = 0;
  let lpY = 0;
  let prevLpY = 0;
  let sumSq = 0;
  let zeroCrossings = 0;

  for (let i = 0; i < n; i++) {
    const x = frame[i] - mean;
    hpY = hpAlpha * (hpY + x - prevX);
    prevX = x;
    lpY = lpY + lpAlpha * (hpY - lpY);
    sumSq += lpY * lpY;
    if (i > 0 && ((lpY >= 0 && prevLpY < 0) || (lpY < 0 && prevLpY >= 0))) {
      zeroCrossings++;
    }
    prevLpY = lpY;
  }

  return {
    bandRms: Math.sqrt(sumSq / n),
    zcr: zeroCrossings / n,
  };
}

interface PreviewSnapshot {
  segmentId: number;
  speechMs: number;
  lang: string;
  promise: Promise<{ text: string; language: string | null } | null>;
}

interface Utterance {
  segmentId: number;
  samples: Float32Array;
  speechMs: number;
  reusePreview?: Promise<{ text: string; language: string | null } | null>;
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  processor: ScriptProcessorNode;
  recognition: SpeechRecognitionLike | null;
  flush: () => void;
}

export interface DocDictation {
  phase: DictationPhase;
  speaking: boolean;
  pending: number;
  // Transient status/error line for the header ("Downloading speech model 40%", errors).
  message: string | null;
  language: string;
  detectedLanguage: string | null;
  // 0..1 mic level, written ~15x/s - read it from a rAF loop (DictationLevelMeter) instead of state
  // so the whole editor doesn't re-render at audio rate.
  levelRef: MutableRefObject<number>;
  setLanguage: (code: string) => void;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
}

export default function useDocDictation(editor: Editor | null, title: string): DocDictation {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [language, setLanguageState] = useState<string>(readStoredLanguage);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(() =>
    languageLabel(readStoredDetectedLanguage())
  );

  const editorRef = useRef(editor);
  editorRef.current = editor;
  const titleRef = useRef(title);
  titleRef.current = title;
  const languageRef = useRef(language);
  languageRef.current = language;

  const levelRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const lockedLanguageRef = useRef<string | null>(readStoredDetectedLanguage());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const disposedRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const messageTimerRef = useRef<number | null>(null);
  const previewRunRef = useRef<Promise<unknown>>(Promise.resolve());
  const latestPreviewRef = useRef<PreviewSnapshot | null>(null);
  const webSpeechLiveRef = useRef(false);

  // Word-by-word progressive preview ticker state so multi-word interim updates type out smoothly.
  const previewTargetWordsRef = useRef<string[]>([]);
  const previewShownCountRef = useRef(0);
  const previewTickTimerRef = useRef<number | null>(null);

  const clearPreviewTicker = useCallback(() => {
    if (previewTickTimerRef.current !== null) {
      window.clearTimeout(previewTickTimerRef.current);
      previewTickTimerRef.current = null;
    }
  }, []);

  const setPreviewImmediate = useCallback(
    (text: string) => {
      clearPreviewTicker();
      const cleaned = text.trim();
      previewTargetWordsRef.current = cleaned ? cleaned.split(/\s+/) : [];
      previewShownCountRef.current = previewTargetWordsRef.current.length;
      if (!disposedRef.current) {
        editorRef.current?.commands.setDictationPreview(cleaned);
      }
    },
    [clearPreviewTicker]
  );

  const streamPreviewWords = useCallback(
    (fullText: string) => {
      if (disposedRef.current) return;
      const cleaned = fullText.trim();
      if (!cleaned) {
        setPreviewImmediate("");
        return;
      }
      const nextWords = cleaned.split(/\s+/);
      const prevWords = previewTargetWordsRef.current;

      let common = 0;
      const maxCheck = Math.min(previewShownCountRef.current, prevWords.length, nextWords.length);
      while (common < maxCheck && prevWords[common] === nextWords[common]) {
        common++;
      }

      previewTargetWordsRef.current = nextWords;
      previewShownCountRef.current = Math.max(1, common + 1);
      editorRef.current?.commands.setDictationPreview(
        nextWords.slice(0, previewShownCountRef.current).join(" ")
      );

      clearPreviewTicker();
      const step = () => {
        if (disposedRef.current) return;
        const target = previewTargetWordsRef.current;
        if (previewShownCountRef.current < target.length) {
          previewShownCountRef.current += 1;
          editorRef.current?.commands.setDictationPreview(
            target.slice(0, previewShownCountRef.current).join(" ")
          );
          previewTickTimerRef.current = window.setTimeout(step, WORD_TICK_MS);
        } else {
          previewTickTimerRef.current = null;
        }
      };
      if (previewShownCountRef.current < nextWords.length) {
        previewTickTimerRef.current = window.setTimeout(step, WORD_TICK_MS);
      }
    },
    [clearPreviewTicker, setPreviewImmediate]
  );

  const flashMessage = useCallback((text: string | null, ms = 4000) => {
    if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current);
    setMessage(text);
    if (text && ms > 0) messageTimerRef.current = window.setTimeout(() => setMessage(null), ms);
  }, []);

  const setLanguage = useCallback((code: string) => {
    setLanguageState(code);
    lockedLanguageRef.current = null;
    setDetectedLanguage(null);
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
      localStorage.removeItem(DETECTED_STORAGE_KEY);
    } catch {
      // per-viewer convenience only
    }
  }, []);

  const updatePending = useCallback((delta: number) => {
    pendingRef.current = Math.max(0, pendingRef.current + delta);
    if (disposedRef.current) return;
    setPending(pendingRef.current);
    editorRef.current?.commands.setDictationPending(pendingRef.current);
    if (pendingRef.current === 0 && !sessionRef.current) {
      editorRef.current?.commands.endDictation();
      setPhase("idle");
    }
  }, []);

  const transcribe = useCallback(
    async ({ samples, speechMs, reusePreview }: Utterance) => {
      const ed = editorRef.current;
      if (!ed || disposedRef.current) return;
      const requested = languageRef.current;
      const lang = requested === "auto" ? lockedLanguageRef.current ?? "auto" : requested;
      const precedingText = documentTextBeforeDictation(ed);
      try {
        let result: { text: string; language: string | null } | null = null;
        if (reusePreview) {
          result = await reusePreview;
        }
        if (!result) {
          const prompt =
            speechMs >= 650 ? buildWhisperPrompt(titleRef.current, precedingText) : "";
          result = await invoke<{ text: string; language: string | null }>("transcribe_doc_audio", {
            audioBytes: Array.from(encodeWav(samples)),
            mimeType: "audio/wav",
            language: lang,
            prompt: prompt || null,
          });
        }
        if (disposedRef.current || !result) return;
        if (requested === "auto" && result.language && !lockedLanguageRef.current && speechMs > 900) {
          lockedLanguageRef.current = result.language;
          try {
            localStorage.setItem(DETECTED_STORAGE_KEY, result.language);
          } catch {
            // per-viewer convenience only
          }
        }

        const effective = lang === "auto" ? result.language ?? browserFallbackLanguage() : lang;
        if (
          isLikelyHallucination(result.text, speechMs, {
            title: titleRef.current,
            precedingText,
          })
        ) {
          if (pendingRef.current <= 1) setPreviewImmediate("");
          return;
        }

        const ops = parseDictation(result.text, { commands: effective === "en" });
        const target = editorRef.current;
        if (!target || ops.length === 0) {
          if (pendingRef.current <= 1) setPreviewImmediate("");
          return;
        }
        // Clear preview in the exact same turn that committed text lands so there is never a blank gap.
        setPreviewImmediate("");
        if (applyDictationOps(target, ops)) stopRef.current();
      } catch (err) {
        console.error("Dictation chunk failed:", err);
        setPreviewImmediate("");
        flashMessage(err instanceof Error ? err.message : String(err), 6000);
      }
    },
    [flashMessage, setPreviewImmediate]
  );

  const enqueue = useCallback(
    (utterance: Utterance) => {
      updatePending(1);
      queueRef.current = queueRef.current
        .then(() => previewRunRef.current)
        .then(() => transcribe(utterance))
        .finally(() => updatePending(-1));
    },
    [transcribe, updatePending]
  );

  const startPreview = useCallback(
    (onUtteranceCut: { current: () => void }): SpeechRecognitionLike | null => {
      const Recognition = getSpeechRecognitionCtor();
      if (!Recognition) return null;
      let recognition: SpeechRecognitionLike;
      try {
        recognition = new Recognition();
      } catch {
        webSpeechUnavailable = true;
        return null;
      }
      let base = 0;
      let latestLength = 0;
      let running = true;
      onUtteranceCut.current = () => {
        base = latestLength;
      };
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang =
        languageRef.current === "auto" ? navigator.language || "en-US" : languageRef.current;
      recognition.onresult = (event) => {
        webSpeechLiveRef.current = true;
        latestLength = event.results.length;
        let text = "";
        for (let i = base; i < event.results.length; i++) {
          text += event.results[i][0]?.transcript ?? "";
        }
        streamPreviewWords(text.trim());
      };
      recognition.onerror = (event) => {
        if (
          [
            "network",
            "not-allowed",
            "service-not-allowed",
            "audio-capture",
            "language-not-supported",
          ].includes(event.error)
        ) {
          webSpeechUnavailable = true;
          running = false;
        }
      };
      recognition.onend = () => {
        base = 0;
        latestLength = 0;
        if (!running || !sessionRef.current) return;
        try {
          recognition.start();
        } catch {
          // engine still winding down - the preview is optional
        }
      };
      try {
        recognition.start();
      } catch {
        return null;
      }
      return recognition;
    },
    [streamPreviewWords]
  );

  // Interim whisper run for rolling word-by-word preview (and reusable by final `transcribe()`
  // when no further speech frames arrive before the utterance cuts).
  const previewTranscribe = useCallback(
    async (
      samples: Float32Array,
      lang: string,
      speechMs: number
    ): Promise<{ text: string; language: string | null } | null> => {
      const ed = editorRef.current;
      if (!ed) return null;
      const precedingText = documentTextBeforeDictation(ed);
      try {
        const prompt = speechMs >= 650 ? buildWhisperPrompt(titleRef.current, precedingText) : "";
        const result = await invoke<{ text: string; language: string | null }>(
          "transcribe_doc_audio",
          {
            audioBytes: Array.from(encodeWav(samples)),
            mimeType: "audio/wav",
            language: lang,
            prompt: prompt || null,
          }
        );
        const text = stripNonSpeech(result.text).replace(/\s+/g, " ").trim();
        if (
          !text ||
          isLikelyHallucination(text, speechMs, {
            title: titleRef.current,
            precedingText,
          })
        ) {
          return null;
        }
        return { text: result.text, language: result.language };
      } catch {
        return null;
      }
    },
    []
  );

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.flush();
    session.processor.onaudioprocess = null;
    session.processor.disconnect();
    session.stream.getTracks().forEach((t) => t.stop());
    void session.ctx.close().catch(() => {});
    if (session.recognition) {
      session.recognition.onresult = null;
      session.recognition.onerror = null;
      session.recognition.onend = null;
      try {
        session.recognition.abort();
      } catch {
        // already stopped
      }
    }
    clearPreviewTicker();
    levelRef.current = 0;
    if (disposedRef.current) return;
    setSpeaking(false);
    editorRef.current?.commands.pauseDictation();
    if (pendingRef.current > 0) {
      setPhase("finishing");
    } else {
      editorRef.current?.commands.endDictation();
      setPhase("idle");
    }
  }, [clearPreviewTicker]);
  stopRef.current = stop;

  const start = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || sessionRef.current || phase === "starting") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      flashMessage("Microphone is not available");
      return;
    }
    setPhase("starting");
    webSpeechLiveRef.current = false;
    latestPreviewRef.current = null;
    flashMessage(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      setPhase(pendingRef.current > 0 ? "finishing" : "idle");
      const name = err instanceof DOMException ? err.name : "";
      flashMessage(
        name === "NotAllowedError"
          ? "Microphone permission denied"
          : name === "NotFoundError"
            ? "No microphone found"
            : String(err),
        6000
      );
      return;
    }
    if (disposedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(FRAME_SIZE, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    const frameMs = (FRAME_SIZE / ctx.sampleRate) * 1000;
    const preRollFrames = Math.max(2, Math.ceil(PRE_ROLL_MS / frameMs));
    const preRoll: Float32Array[] = [];
    let segment: Float32Array[] | null = null;
    let segmentMs = 0;
    let speechMs = 0;
    let silenceMs = 0;
    let maxSpeechRms = 0;
    let noiseFloor = 0.006;
    let speakingNow = false;
    const utteranceCut = { current: () => {} };
    let segmentId = 0;
    let lastPreviewAtMs = 0;
    let previewInFlight = false;

    const trimTrailingSilence = (frames: Float32Array[], trailingSilenceMs: number): Float32Array => {
      const dropFrames = Math.max(0, Math.floor((trailingSilenceMs - 140) / frameMs));
      const keep = Math.max(1, frames.length - dropFrames);
      return concat(frames.slice(0, keep));
    };

    const maybePreview = () => {
      if (!segment || previewInFlight || webSpeechLiveRef.current || pendingRef.current > 0) return;
      if (speechMs < PREVIEW_MIN_SPEECH_MS || segmentMs - lastPreviewAtMs < PREVIEW_INTERVAL_MS) {
        return;
      }
      if (maxSpeechRms < Math.max(0.014, noiseFloor * 3.0)) return;

      const lang =
        languageRef.current === "auto"
          ? lockedLanguageRef.current ?? browserFallbackLanguage()
          : languageRef.current;

      lastPreviewAtMs = segmentMs;
      previewInFlight = true;
      const id = segmentId;
      const snapshotSpeechMs = speechMs;
      const samples = trimTrailingSilence(segment, silenceMs);

      const promise = previewTranscribe(samples, lang, snapshotSpeechMs);
      latestPreviewRef.current = {
        segmentId: id,
        speechMs: snapshotSpeechMs,
        lang,
        promise,
      };
      const run = promise
        .then((res) => {
          if (id === segmentId && segment && res?.text && !disposedRef.current) {
            const cleaned = stripNonSpeech(res.text).replace(/\s+/g, " ").trim();
            if (cleaned) streamPreviewWords(cleaned);
          }
        })
        .finally(() => {
          previewInFlight = false;
        });
      previewRunRef.current = run;
    };

    const cut = () => {
      if (!segment) return;
      const finishedSegmentId = segmentId;
      segmentId += 1;
      lastPreviewAtMs = 0;
      const samples = trimTrailingSilence(segment, silenceMs);
      const ms = speechMs;
      const peak = maxSpeechRms;
      const currentNoiseFloor = noiseFloor;
      segment = null;
      segmentMs = speechMs = silenceMs = maxSpeechRms = 0;
      utteranceCut.current();

      if (ms < MIN_SPEECH_MS || peak < Math.max(0.014, currentNoiseFloor * 3.1)) {
        if (pendingRef.current === 0) {
          setPreviewImmediate("");
        }
        return;
      }

      const snap = latestPreviewRef.current;
      const requested = languageRef.current;
      const canReuseSnap =
        snap &&
        snap.segmentId === finishedSegmentId &&
        Math.abs(ms - snap.speechMs) <= frameMs * 1.1 &&
        (requested !== "auto" || lockedLanguageRef.current !== null);

      enqueue({
        segmentId: finishedSegmentId,
        samples,
        speechMs: ms,
        reusePreview: canReuseSnap ? snap.promise : undefined,
      });
    };

    processor.onaudioprocess = (event) => {
      const frame = downsample(event.inputBuffer.getChannelData(0), ctx.sampleRate);
      const { bandRms, zcr } = analyzeSpeechFrame(frame);

      noiseFloor =
        bandRms < noiseFloor
          ? noiseFloor * 0.85 + bandRms * 0.15
          : noiseFloor * 0.997 + bandRms * 0.003;
      const threshold = Math.max(0.011, noiseFloor * 3.0);
      const isSpeech = bandRms > threshold && zcr >= 0.008 && zcr <= 0.45;
      levelRef.current = Math.min(1, bandRms / Math.max(0.045, threshold * 3.8));

      if (isSpeech !== speakingNow) {
        speakingNow = isSpeech;
        setSpeaking(isSpeech);
      }

      if (!segment) {
        preRoll.push(frame);
        if (preRoll.length > preRollFrames) preRoll.shift();
        if (!isSpeech) return;
        segment = preRoll.splice(0);
        segmentMs = segment.length * frameMs;
        speechMs = frameMs;
        silenceMs = 0;
        maxSpeechRms = bandRms;
        return;
      }

      segment.push(frame);
      segmentMs += frameMs;
      if (isSpeech) {
        speechMs += frameMs;
        silenceMs = 0;
        if (bandRms > maxSpeechRms) maxSpeechRms = bandRms;
      } else {
        silenceMs += frameMs;
      }

      const shouldCut =
        silenceMs >= END_SILENCE_MS ||
        (speechMs >= CLAUSE_MAX_MS && silenceMs >= CLAUSE_SILENCE_MS) ||
        (segmentMs >= SOFT_MAX_MS && silenceMs >= SOFT_SILENCE_MS) ||
        segmentMs >= HARD_MAX_MS;

      if (shouldCut) cut();
      else maybePreview();
    };

    const recognition = startPreview(utteranceCut);
    sessionRef.current = { stream, ctx, processor, recognition, flush: cut };
    ed.chain().focus().beginDictation().run();
    setPhase("listening");
  }, [
    enqueue,
    flashMessage,
    phase,
    previewTranscribe,
    setPreviewImmediate,
    startPreview,
    streamPreviewWords,
  ]);

  const toggle = useCallback(() => {
    if (sessionRef.current) stop();
    else void start();
  }, [start, stop]);

  // First-run model download, detected language, and real-time partial segment streaming from backend.
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (disposed) fn();
        else unlisteners.push(fn);
      });
    track(
      listen<{ downloaded: number; total: number }>("whisper-model-download", (event) => {
        const { downloaded, total } = event.payload;
        if (downloaded < total) {
          setMessage(`Downloading speech model (one time) ${Math.round((downloaded / total) * 100)}%`);
        } else {
          setMessage(null);
        }
      })
    );
    track(
      listen<string>("docs-dictation-language", (event) => {
        setDetectedLanguage(event.payload);
      })
    );
    track(
      listen<string>("docs-dictation-partial", (event) => {
        if (!sessionRef.current || webSpeechLiveRef.current) return;
        const ed = editorRef.current;
        if (!ed) return;
        const cleaned = stripNonSpeech(event.payload).replace(/\s+/g, " ").trim();
        if (
          cleaned &&
          !isLikelyHallucination(cleaned, PREVIEW_MIN_SPEECH_MS, {
            title: titleRef.current,
            precedingText: documentTextBeforeDictation(ed),
          })
        ) {
          streamPreviewWords(cleaned);
        }
      })
    );
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [streamPreviewWords]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      clearPreviewTicker();
      stopRef.current();
      if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current);
    };
  }, [clearPreviewTicker]);

  return {
    phase,
    speaking,
    pending,
    message,
    language,
    detectedLanguage,
    levelRef,
    setLanguage,
    start,
    stop,
    toggle,
  };
}
