// hooks/useDocDictation.ts
//
// Microphone → whisper → document pipeline for Docs dictation (editor side: docDictationExtension.ts;
// text rules: dictationText.ts).
//
// The previous version recorded one MediaRecorder blob for the whole session and only transcribed
// it after Stop, so nothing reliable appeared until the user finished talking - and long dictation
// meant a long wait. Here the mic is read as raw PCM, cut into utterances at natural pauses by a
// small energy-based voice-activity detector with an adaptive noise floor, and each utterance is
// transcribed as soon as it ends while recording continues. Side benefits:
//   - silence is never sent to whisper, which is where its "Thank you." hallucinations come from;
//   - chunks are already 16kHz mono WAV, so the backend skips its ffmpeg pass;
//   - each chunk carries the document text before the cursor as whisper's prompt, and the language
//     auto-detected on the first chunk is locked for the rest (detection on a two-word utterance
//     is unreliable).
//
// The Web Speech API, where the WebView has a working one, only drives a grey interim preview at
// the cursor; whisper's text is what actually gets inserted.
import { MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { applyDictationOps, documentTextBeforeDictation } from "../utils/docDictationExtension";
import { buildWhisperPrompt, isLikelyHallucination, parseDictation, stripNonSpeech } from "../utils/dictationText";

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
const FRAME_SIZE = 1024; // ScriptProcessor buffer at the context rate
const PRE_ROLL_MS = 300; // audio kept from before speech onset so the first syllable isn't clipped
const END_SILENCE_MS = 550; // pause that ends an utterance - long enough for a breath between clauses
const SOFT_MAX_MS = 15000; // past this, cut at the next short pause
const SOFT_SILENCE_MS = 250;
const HARD_MAX_MS = 28000; // whisper's window is 30s
const MIN_SPEECH_MS = 280; // shorter "utterances" are clicks/coughs
const PREVIEW_MIN_SPEECH_MS = 600; // first grey preview once there is this much speech
const PREVIEW_INTERVAL_MS = 900; // then refresh it this often (a run takes ~0.3-0.8s)

// Disabled for the rest of the session once the engine reports it can't run (WebView2 ships the
// API surface without a working backend on many machines).
let webSpeechUnavailable = false;

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (webSpeechUnavailable) return null;
  const w = window as typeof window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
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

interface Utterance {
  samples: Float32Array;
  speechMs: number;
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
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(() => languageLabel(readStoredDetectedLanguage()));

  const editorRef = useRef(editor);
  editorRef.current = editor;
  const titleRef = useRef(title);
  titleRef.current = title;
  const languageRef = useRef(language);
  languageRef.current = language;

  const levelRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  // Auto mode's detected language, kept across sessions: whisper's detection pass costs ~1.1s per
  // phrase on its own (measured: 0.75s with -l en vs 1.9s with -l auto for the same 6s clip), so
  // only the very first phrase ever pays it. Picking a language in the menu clears it.
  const lockedLanguageRef = useRef<string | null>(readStoredDetectedLanguage());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef(0);
  const disposedRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const messageTimerRef = useRef<number | null>(null);
  const previewRunRef = useRef<Promise<void>>(Promise.resolve());
  // True once the Web Speech API has produced results this session - it then owns the preview.
  const webSpeechLiveRef = useRef(false);

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
    async ({ samples, speechMs }: Utterance) => {
      const ed = editorRef.current;
      if (!ed || disposedRef.current) return;
      const requested = languageRef.current;
      const lang = requested === "auto" ? lockedLanguageRef.current ?? "auto" : requested;
      try {
        const result = await invoke<{ text: string; language: string | null }>("transcribe_doc_audio", {
          audioBytes: Array.from(encodeWav(samples)),
          mimeType: "audio/wav",
          language: lang,
          prompt: buildWhisperPrompt(titleRef.current, documentTextBeforeDictation(ed)),
        });
        if (disposedRef.current) return;
        if (requested === "auto" && result.language && !lockedLanguageRef.current && speechMs > 1200) {
          lockedLanguageRef.current = result.language;
          try {
            localStorage.setItem(DETECTED_STORAGE_KEY, result.language);
          } catch {
            // per-viewer convenience only
          }
        }
        const effective = lang === "auto" ? result.language ?? "en" : lang;
        if (isLikelyHallucination(result.text, speechMs)) return;
        const ops = parseDictation(result.text, { commands: effective === "en" });
        const target = editorRef.current;
        if (!target || ops.length === 0) return;
        if (applyDictationOps(target, ops)) stopRef.current();
      } catch (err) {
        console.error("Dictation chunk failed:", err);
        flashMessage(err instanceof Error ? err.message : String(err), 6000);
      }
    },
    [flashMessage]
  );

  const enqueue = useCallback(
    (utterance: Utterance) => {
      updatePending(1);
      if (!disposedRef.current) editorRef.current?.commands.setDictationPreview("");
      // Waits out any in-flight preview first so the two whisper runs don't split the CPU.
      queueRef.current = queueRef.current
        .then(() => previewRunRef.current)
        .then(() => transcribe(utterance))
        .finally(() => updatePending(-1));
    },
    [transcribe, updatePending]
  );

  const startPreview = useCallback((onUtteranceCut: { current: () => void }): SpeechRecognitionLike | null => {
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
    recognition.lang = languageRef.current === "auto" ? navigator.language || "en-US" : languageRef.current;
    recognition.onresult = (event) => {
      webSpeechLiveRef.current = true;
      latestLength = event.results.length;
      let text = "";
      for (let i = base; i < event.results.length; i++) text += event.results[i][0]?.transcript ?? "";
      editorRef.current?.commands.setDictationPreview(text.trim());
    };
    recognition.onerror = (event) => {
      if (["network", "not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"].includes(event.error)) {
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
  }, []);

  // Interim text for the grey preview only - never inserted, so no commands/context fitting.
  const previewTranscribe = useCallback(async (samples: Float32Array, lang: string): Promise<string> => {
    const ed = editorRef.current;
    if (!ed) return "";
    try {
      const result = await invoke<{ text: string; language: string | null }>("transcribe_doc_audio", {
        audioBytes: Array.from(encodeWav(samples)),
        mimeType: "audio/wav",
        language: lang,
        prompt: buildWhisperPrompt(titleRef.current, documentTextBeforeDictation(ed)),
      });
      const text = stripNonSpeech(result.text).replace(/\s+/g, " ").trim();
      return isLikelyHallucination(text, PREVIEW_MIN_SPEECH_MS) ? "" : text;
    } catch {
      return ""; // the final transcription reports errors; a failed preview just shows nothing
    }
  }, []);

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
    levelRef.current = 0;
    if (disposedRef.current) return; // unmounting - the editor may already be destroyed
    setSpeaking(false);
    editorRef.current?.commands.pauseDictation();
    if (pendingRef.current > 0) {
      setPhase("finishing");
    } else {
      editorRef.current?.commands.endDictation();
      setPhase("idle");
    }
  }, []);
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
    flashMessage(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      setPhase(pendingRef.current > 0 ? "finishing" : "idle");
      const name = err instanceof DOMException ? err.name : "";
      flashMessage(name === "NotAllowedError" ? "Microphone permission denied" : name === "NotFoundError" ? "No microphone found" : String(err), 6000);
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
    const preRollFrames = Math.ceil(PRE_ROLL_MS / frameMs);
    const preRoll: Float32Array[] = [];
    let segment: Float32Array[] | null = null;
    let segmentMs = 0;
    let speechMs = 0;
    let silenceMs = 0;
    let noiseFloor = 0.008;
    let speakingNow = false;
    const utteranceCut = { current: () => {} };
    // Rolling whisper preview of the utterance in progress - the grey words-as-you-speak text,
    // replaced by the final transcript once the pause comes. `segmentId` drops a preview that
    // returns after its utterance was already cut.
    let segmentId = 0;
    let lastPreviewAtMs = 0;
    let previewInFlight = false;

    const maybePreview = () => {
      if (!segment || previewInFlight || webSpeechLiveRef.current || pendingRef.current > 0) return;
      if (speechMs < PREVIEW_MIN_SPEECH_MS || segmentMs - lastPreviewAtMs < PREVIEW_INTERVAL_MS) return;
      const lang = languageRef.current === "auto" ? lockedLanguageRef.current : languageRef.current;
      if (!lang) return; // auto-detect would add ~1.1s per preview - wait for the first phrase to lock it
      lastPreviewAtMs = segmentMs;
      previewInFlight = true;
      const id = segmentId;
      const samples = concat(segment);
      const run = previewTranscribe(samples, lang)
        .then((text) => {
          if (id === segmentId && segment && text && !disposedRef.current) editorRef.current?.commands.setDictationPreview(text);
        })
        .finally(() => {
          previewInFlight = false;
        });
      previewRunRef.current = run;
    };

    const cut = () => {
      if (!segment) return;
      segmentId += 1;
      lastPreviewAtMs = 0;
      // Keep ~300ms of the trailing silence; whisper does better with a little tail.
      const keep = Math.max(0, segment.length - Math.max(0, Math.floor((silenceMs - 300) / frameMs)));
      const frames = segment.slice(0, keep);
      const ms = speechMs;
      segment = null;
      segmentMs = speechMs = silenceMs = 0;
      utteranceCut.current();
      if (ms >= MIN_SPEECH_MS) enqueue({ samples: concat(frames), speechMs: ms });
      else editorRef.current?.commands.setDictationPreview("");
    };

    processor.onaudioprocess = (event) => {
      const frame = downsample(event.inputBuffer.getChannelData(0), ctx.sampleRate);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / Math.max(1, frame.length));

      // Noise floor follows quiet frames quickly and loud ones very slowly, so it tracks a fan or
      // room tone without ever climbing to speech level.
      noiseFloor = rms < noiseFloor ? noiseFloor * 0.85 + rms * 0.15 : noiseFloor * 0.998 + rms * 0.002;
      const threshold = Math.max(0.01, noiseFloor * 3);
      const isSpeech = rms > threshold;
      levelRef.current = Math.min(1, rms / Math.max(0.05, threshold * 4));

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
        return;
      }

      segment.push(frame);
      segmentMs += frameMs;
      if (isSpeech) {
        speechMs += frameMs;
        silenceMs = 0;
      } else {
        silenceMs += frameMs;
      }
      if (silenceMs >= END_SILENCE_MS || (segmentMs >= SOFT_MAX_MS && silenceMs >= SOFT_SILENCE_MS) || segmentMs >= HARD_MAX_MS) cut();
      else maybePreview();
    };

    const recognition = startPreview(utteranceCut);
    sessionRef.current = { stream, ctx, processor, recognition, flush: cut };
    ed.chain().focus().beginDictation().run();
    setPhase("listening");
  }, [enqueue, flashMessage, phase, previewTranscribe, startPreview]);

  const toggle = useCallback(() => {
    if (sessionRef.current) stop();
    else void start();
  }, [start, stop]);

  // First-run model download and per-chunk progress come from the backend as events.
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
        if (downloaded < total) setMessage(`Downloading speech model (one time) ${Math.round((downloaded / total) * 100)}%`);
        else setMessage(null);
      })
    );
    track(
      listen<string>("docs-dictation-language", (event) => {
        setDetectedLanguage(event.payload);
      })
    );
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopRef.current();
      if (messageTimerRef.current !== null) window.clearTimeout(messageTimerRef.current);
    };
  }, []);

  return { phase, speaking, pending, message, language, detectedLanguage, levelRef, setLanguage, start, stop, toggle };
}
