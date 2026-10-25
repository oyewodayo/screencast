// components/shorts/ShortsStudio.tsx
//
// Make it a Short: one click from a long recording to a few ready-to-post vertical clips. Listens
// to the video (the Captions tool's transcript - made here first if there isn't one), finds the
// moments that stand on their own (shortsFinder.ts), and shows each as a live phone-shaped preview
// (ShortPreview) - framed following the subject, captioned, titled, pauses tightened
// (shortsBuild.ts). Titles are editable, any moment can be swapped for the next best one, and
// Export queues them all in the background export queue as ordinary exports of their own timelines.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IoCheckmark, IoClose, IoRefresh, IoSparkles, IoWarningOutline } from "react-icons/io5";
import type { CaptionStylePreset, CaptionWord, TextOverlay, VideoEditState } from "../../utils/videoEditTypes";
import { isImageClipPath } from "../../utils/videoEditTypes";
import { resolveAssetUrl } from "../../utils/clipPreviewSource";
import { buildTranscriptTokens, withDetectedPauses } from "../../utils/transcriptEdit";
import { findShortMoments, type ShortMoment } from "../../utils/shortsFinder";
import { buildShort, DEFAULT_SHORT_STYLE, makeTitleOverlay, momentHasHiddenAreas, remapKnots, SHORT_CAPTION_STYLES, SHORT_SIZE, type BuiltShort, type ShortStyle } from "../../utils/shortsBuild";
import { speechLoudnessProbe } from "../../utils/speechLoudness";
import { analyzeReframe } from "../../utils/reframeAnalysis";
import type { ReframeKnot } from "../../utils/reframeTrack";
import { buildCaptionLines, CAPTION_PRESETS } from "../../utils/captions";
import { enqueue, type ExportJobPayload } from "../../utils/exportQueue";
import type { ExportOptions } from "../../hooks/useVideoEditStore";
import { useTranscriptGeneration } from "../captions/useTranscriptGeneration";
import { trackEvent } from "../../utils/telemetry";
import ShortPreview, { cardHeight, MAX_CARD_W } from "./ShortPreview";

const SLOTS = 3;
const STYLE_KEY = "briefcast.shorts.style";

interface Props {
  editState: VideoEditState;
  // Every video file on the timeline (what gets transcribed).
  sourcePaths: string[];
  // The timeline's own frame in pixels.
  frame: { width: number; height: number } | null;
  sourceDuration: (path: string) => number | null;
  // The file the editor has open - shorts are saved next to it, named after it.
  primaryPath: string;
  onTranscribed: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
  prepareExport: (frame: { width: number; height: number } | null, options: ExportOptions, override: VideoEditState) => Promise<ExportJobPayload | null>;
  onClose: () => void;
}

type Phase = "intro" | "listening" | "finding" | "results" | "empty" | "error";

const fmt = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

function loadStyle(): ShortStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw) return { ...DEFAULT_SHORT_STYLE, ...JSON.parse(raw) };
  } catch {
    /* no storage - defaults */
  }
  return DEFAULT_SHORT_STYLE;
}

const ShortsStudio: React.FC<Props> = ({ editState, sourcePaths, frame, sourceDuration, primaryPath, onTranscribed, prepareExport, onClose }) => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  // Cards as large as the window allows, so a whole card with its title and actions is always in view.
  const [cardW, setCardW] = useState(MAX_CARD_W);
  useEffect(() => {
    const fit = () => {
      // Room the header, the text under each card and the footer take.
      const free = window.innerHeight - 32 - 380;
      let w = Math.max(150, Math.min(MAX_CARD_W, Math.floor((free * 9) / 16)));
      while (w > 150 && cardHeight(w) > free) w -= 2;
      setCardW(w);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const close = () => {
    setShown(false);
    window.setTimeout(onClose, 180);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captions = editState.captions;
  const missing = sourcePaths.filter((p) => !captions?.transcripts[p]);
  const language = captions?.language ?? "auto";
  const { generate, generating, error: transcribeError } = useTranscriptGeneration({
    sourcePaths,
    language,
    hasTranscripts: !!captions,
    onGenerated: onTranscribed,
    telemetryEvent: "shorts_transcribed",
  });

  const [phase, setPhase] = useState<Phase>(missing.length === 0 ? "finding" : "intro");
  const [error, setError] = useState<string | null>(null);
  const [moments, setMoments] = useState<ShortMoment[]>([]);
  const [slots, setSlots] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [style, setStyleState] = useState<ShortStyle>(loadStyle);
  const [silences, setSilences] = useState<Record<string, { start: number; end: number }[]>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [knots, setKnots] = useState<Record<string, ReframeKnot[] | "failed">>({});
  const [exporting, setExporting] = useState(false);
  // The one player every card plays on (ShortPreview explains why there's only one).
  const [sharedVideo, setSharedVideo] = useState<HTMLVideoElement | null>(null);
  // Each short's first frame, by where it starts.
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [exported, setExported] = useState<number | null>(null);

  const setStyle = (patch: Partial<ShortStyle>) =>
    setStyleState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(STYLE_KEY, JSON.stringify(next));
      } catch {
        /* remembered for this session only */
      }
      return next;
    });

  // Once there's a transcript for every file, find the moments.
  const transcribing = !!generating;
  useEffect(() => {
    if (transcribing) return;
    if (phase === "listening" && missing.length === 0) setPhase("finding");
    if (phase === "listening" && transcribeError) {
      setError(transcribeError);
      setPhase("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcribing, missing.length, transcribeError, phase]);

  const startListening = () => {
    setPhase("listening");
    void generate(missing, language);
  };

  useEffect(() => {
    if (phase !== "finding" || !captions) return;
    let cancelled = false;
    (async () => {
      try {
        const paths = Array.from(new Set(editState.clips.map((c) => c.sourcePath).filter((p) => captions.transcripts[p])));
        const [found, probe] = await Promise.all([
          Promise.all(
            paths.map(async (p) => [p, await invoke<{ start: number; end: number }[]>("detect_silence", { inputPath: p, minDuration: 0.4 }).catch(() => [])] as const)
          ),
          speechLoudnessProbe(editState.clips, sourceDuration).catch(() => null),
        ]);
        if (cancelled) return;
        const silenceMap = Object.fromEntries(found);
        const tokens = withDetectedPauses(buildTranscriptTokens(editState.clips, captions), silenceMap);
        const result = findShortMoments(tokens, probe);
        setSilences(silenceMap);
        setMoments(result);
        setSlots(result.slice(0, SLOTS).map((m) => m.id));
        setTitles(Object.fromEntries(result.map((m) => [m.id, m.title])));
        setPhase(result.length ? "results" : "empty");
        trackEvent("shorts_found", { count: result.length });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const byId = useMemo(() => new Map(moments.map((m) => [m.id, m])), [moments]);
  const shorts = useMemo(() => {
    const out: { moment: ShortMoment; built: BuiltShort; key: string }[] = [];
    for (const id of slots) {
      const moment = byId.get(id);
      if (!moment) continue;
      // Built without its title, so typing one doesn't rebuild (and restart) the preview - the title
      // is laid over it separately (titleOverlay) and added for export.
      const built = buildShort(editState, moment, "", style, silences);
      out.push({ moment, built, key: `${id}|${style.teaser && moment.teaser ? "t" : ""}|${style.tighten ? "k" : ""}` });
    }
    return out;
  }, [slots, byId, editState, style, silences]);

  // Each short's title overlay, kept while its text and length stay the same.
  const titleCache = useRef(new Map<string, TextOverlay>());
  const titleOverlay = (id: string, durationSec: number): TextOverlay | null => {
    const text = (titles[id] ?? "").trim();
    if (!style.title || !text) return null;
    const key = `${id}|${text}|${durationSec.toFixed(3)}`;
    let o = titleCache.current.get(key);
    if (!o) {
      o = makeTitleOverlay(text, durationSec);
      titleCache.current.set(key, o);
    }
    return o;
  };

  // First frames for the still cards (ffmpeg grabs them; cached on disk).
  useEffect(() => {
    let cancelled = false;
    for (const s of shorts) {
      const c = s.built.state.clips[0];
      if (!c) continue;
      const key = `${c.sourcePath}|${c.start.toFixed(3)}`;
      if (posters[key]) continue;
      (async () => {
        const path = isImageClipPath(c.sourcePath) ? c.sourcePath : await invoke<string>("extract_frame_still", { sourcePath: c.sourcePath, time: c.start + 0.05 });
        const url = await resolveAssetUrl(path);
        if (!cancelled) setPosters((prev) => ({ ...prev, [key]: url }));
      })().catch((err) => console.warn("Couldn't grab a short's first frame:", err));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shorts]);
  const posterOf = (s: { built: BuiltShort }) => {
    const c = s.built.state.clips[0];
    return c ? posters[`${c.sourcePath}|${c.start.toFixed(3)}`] ?? null : null;
  };

  // The camera path for each short, one at a time (each analysis already uses the whole machine).
  const reframeFor = async (s: { built: BuiltShort }): Promise<ReframeKnot[]> => {
    if (!frame) return [];
    const raw = await analyzeReframe(s.built.untightened, frame, SHORT_SIZE);
    return remapKnots(raw, s.built.untightened, s.built.cuts);
  };
  const knotsRef = useRef(knots);
  knotsRef.current = knots;
  useEffect(() => {
    if (phase !== "results" || style.layout !== "follow") return;
    let cancelled = false;
    (async () => {
      for (const s of shorts) {
        if (cancelled) return;
        if (knotsRef.current[s.key]) continue;
        try {
          const k = await reframeFor(s);
          if (!cancelled) setKnots((prev) => ({ ...prev, [s.key]: k }));
        } catch (err) {
          console.warn("Couldn't follow the subject for a short:", err);
          if (!cancelled) setKnots((prev) => ({ ...prev, [s.key]: "failed" }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, style.layout, shorts.map((s) => s.key).join(",")]);

  const swap = (slot: number) => {
    const used = new Set(slots);
    const next = moments.find((m) => !used.has(m.id));
    if (!next) return;
    setPlaying(null);
    setSlots((s) => s.map((id, i) => (i === slot ? next.id : id)));
  };
  const spare = moments.length - slots.length;

  const chosen = shorts.filter((s) => !excluded.has(s.moment.id));
  const exportAll = async () => {
    if (chosen.length === 0) return;
    setPlaying(null);
    setExporting(true);
    setError(null);
    const dir = primaryPath.replace(/[\\/][^\\/]*$/, "");
    const sep = primaryPath.includes("\\") ? "\\" : "/";
    const stem = (primaryPath.split(/[\\/]/).pop() ?? "Video").replace(/\.[^.]+$/, "");
    try {
      for (let i = 0; i < chosen.length; i++) {
        const s = chosen[i];
        let track: [number, number, number][] | undefined;
        if (style.layout === "follow") {
          const known = knots[s.key];
          // eslint-disable-next-line no-await-in-loop
          const k = Array.isArray(known) ? known : await reframeFor(s).catch(() => null);
          if (k && k.length) track = k.map((p) => [p.t, p.x, p.y]);
        }
        const title = (titles[s.moment.id] ?? "").trim();
        const overlay = titleOverlay(s.moment.id, s.built.durationSec);
        // eslint-disable-next-line no-await-in-loop
        const payload = await prepareExport(
          frame,
          {
            quality: "standard",
            outputPath: `${dir}${sep}${stem} - Short ${slots.indexOf(s.moment.id) + 1}.mp4`,
            outputFrame: { ...SHORT_SIZE, mode: style.layout === "follow" ? "fill" : "fit-blur", anchorX: 0.5, anchorY: 0.5, track },
            loudnessLufs: -14,
          },
          { ...s.built.state, textOverlays: overlay ? [overlay] : [] }
        );
        if (!payload) continue;
        payload.share = { ...payload.share, title: title || payload.share.title, chapters: [] };
        enqueue(payload, title || `${stem} - Short`, `Short · 9:16 · ${fmt(s.built.durationSec)}`);
      }
      trackEvent("shorts_exported", { count: chosen.length, layout: style.layout, captions: style.captions ?? "off", teaser: style.teaser });
      setExported(chosen.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const steps: { label: string; state: "done" | "active" | "todo"; progress?: number }[] = [
    {
      label: generating?.downloadingModel ? "Getting the speech model ready (one time)" : "Listening to your video",
      state: phase === "listening" ? "active" : "done",
      progress: phase === "listening" && generating ? ((generating.index + generating.progress / 100) / generating.total) * 100 : undefined,
    },
    { label: "Finding the moments that stand on their own", state: phase === "finding" ? "active" : phase === "listening" ? "todo" : "done" },
    { label: "Framing them for vertical", state: "todo" },
  ];

  return createPortal(
    <div
      className={`fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`relative flex max-h-[calc(100vh-32px)] w-[min(1040px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl bg-[#111114] text-white shadow-2xl ring-1 ring-white/10 transition-all duration-200 ease-out ${
          shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.98] opacity-0"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
            <IoSparkles size={17} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold tracking-tight">Make it a Short</div>
            <div className="text-xs text-white/45">Your strongest moments as vertical clips - captioned, titled and framed for TikTok, Reels and Shorts</div>
          </div>
          <button type="button" title="Close (Esc)" onClick={close} className="rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white">
            <IoClose size={18} />
          </button>
        </div>

        {/* The shared player: rendered (a display:none <video> may never load), never seen. */}
        <video ref={setSharedVideo} className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0" preload="auto" playsInline />

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {phase === "intro" && (
            <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
              <div className="mb-6 flex gap-2" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-24 w-[54px] rounded-xl bg-gradient-to-b from-white/[0.09] to-white/[0.02] ring-1 ring-white/10" style={{ transform: `translateY(${i === 1 ? -8 : 0}px)` }} />
                ))}
              </div>
              <h2 className="text-lg font-semibold tracking-tight">Find the Shorts hiding in this video</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-white/55">
                Briefcast listens to the whole video, picks the moments that work on their own, and turns each one into a vertical clip with captions, a hook title and tight pacing.
              </p>
              <button type="button" onClick={startListening} className="mt-7 rounded-xl bg-violet-500 px-5 py-2.5 text-[13px] font-medium text-white shadow-lg shadow-violet-500/20 transition hover:bg-violet-400 active:scale-[0.98]">
                Find my best moments
              </button>
              <span className="mt-3 text-[11px] text-white/35">Runs on this computer - nothing is uploaded</span>
            </div>
          )}

          {(phase === "listening" || phase === "finding") && (
            <div className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-20">
              {steps.map((s) => (
                <div key={s.label} className={`flex items-start gap-3 transition-opacity duration-300 ${s.state === "todo" ? "opacity-35" : "opacity-100"}`}>
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                    {s.state === "done" ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/20 text-violet-300">
                        <IoCheckmark size={12} />
                      </span>
                    ) : s.state === "active" ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-violet-300/30 border-t-violet-300" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-white/40" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/85">{s.label}</div>
                    {s.progress !== undefined && (
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-violet-400 transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, s.progress)}%` }} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {phase === "listening" && <p className="pl-8 text-[11px] text-white/35">Long recordings take a while the first time - you can keep editing; this window can stay open in the background.</p>}
            </div>
          )}

          {(phase === "empty" || phase === "error") && (
            <div className="mx-auto max-w-sm px-6 py-20 text-center">
              <div className="text-[14px] font-medium">{phase === "empty" ? "No moment long enough to stand on its own" : "Something went wrong"}</div>
              <p className="mt-2 text-[12px] leading-relaxed text-white/50">
                {phase === "empty" ? "A Short needs about 20 seconds of continuous talk. Try a longer recording, or one with more speech." : error}
              </p>
            </div>
          )}

          {phase === "results" && (
            <div className="flex flex-wrap justify-center gap-7 px-6 pt-2 pb-6">
              {shorts.map((s, i) => {
                const id = s.moment.id;
                const off = excluded.has(id);
                const k = knots[s.key];
                const captionSettings = s.built.state.captions?.settings ?? null;
                return (
                  <div
                    key={id}
                    className={`flex flex-col transition-all duration-500 ease-out ${off ? "opacity-40" : "opacity-100"}`}
                    style={{ width: cardW, transitionDelay: `${i * 70}ms` }}
                  >
                    <ShortPreview
                      width={cardW}
                      clips={s.built.state.clips}
                      frame={frame}
                      layout={style.layout}
                      knots={Array.isArray(k) ? k : null}
                      title={titleOverlay(id, s.built.durationSec)}
                      captionLines={captionLinesOf(s.built)}
                      captionSettings={captionSettings}
                      poster={posterOf(s)}
                      video={playing === id ? sharedVideo : null}
                      playing={playing === id}
                      onTogglePlay={() => setPlaying((p) => (p === id ? null : id))}
                      onEnded={() => setPlaying((p) => (p === id ? null : p))}
                    >
                      <span className="pointer-events-none absolute left-2.5 bottom-3 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white/90 backdrop-blur-md">
                        {fmt(s.built.durationSec)}
                      </span>
                      {style.layout === "follow" && !k && (
                        <span className="pointer-events-none absolute right-2.5 bottom-3 animate-pulse rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/70 backdrop-blur-md">Framing…</span>
                      )}
                      <button
                        type="button"
                        title={off ? "Include this Short" : "Leave this one out"}
                        onClick={(e) => {
                          e.stopPropagation();
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          });
                        }}
                        className={`absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full ring-1 backdrop-blur-md transition ${
                          off ? "bg-black/40 text-transparent ring-white/40 hover:ring-white/70" : "bg-violet-500 text-white ring-violet-300/50"
                        }`}
                      >
                        <IoCheckmark size={13} />
                      </button>
                    </ShortPreview>

                    <textarea
                      value={titles[id] ?? ""}
                      onChange={(e) => setTitles((t) => ({ ...t, [id]: e.target.value.replace(/\s*\n\s*/g, " ") }))}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          e.currentTarget.blur();
                        }
                      }}
                      rows={2}
                      placeholder="Add a title"
                      spellCheck={false}
                      className="mt-3 w-full resize-none rounded-lg bg-transparent px-2 py-1.5 text-[13px] font-medium leading-snug text-white/90 outline-none transition-colors placeholder:text-white/30 hover:bg-white/[0.05] focus:bg-white/[0.08]"
                    />
                    <div className="px-2 text-[11px] leading-snug text-white/45">
                      {s.moment.reasons.slice(0, 2).join(" · ") || "A complete thought"}
                    </div>
                    {momentHasHiddenAreas(editState, s.moment) && (
                      <div className="mt-1.5 flex items-start gap-1 px-2 text-[11px] leading-snug text-amber-300/80">
                        <IoWarningOutline size={12} className="mt-px shrink-0" />
                        Blurs and covers here aren't carried into Shorts - check before posting
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between px-2 text-[11px] text-white/40">
                      <span className="tabular-nums">from {fmt(s.moment.start)}</span>
                      {spare > 0 && (
                        <button type="button" onClick={() => swap(i)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-white/10 hover:text-white">
                          <IoRefresh size={11} />
                          Another moment
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer: the look of every short, and Export */}
        {phase === "results" && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-white/[0.06] bg-white/[0.015] px-6 py-3.5">
            <Field label="Captions">
              <Segmented
                value={style.captions ?? "off"}
                options={[
                  ...SHORT_CAPTION_STYLES.map((p) => ({
                    value: p as string,
                    label: <span style={{ fontFamily: CAPTION_PRESETS[p].fontFamily, fontWeight: CAPTION_PRESETS[p].bold ? 700 : 400 }}>{CAPTION_PRESETS[p].label}</span>,
                  })),
                  { value: "off", label: "Off" },
                ]}
                onChange={(v) => setStyle({ captions: v === "off" ? null : (v as CaptionStylePreset) })}
              />
            </Field>
            <Field label="Framing">
              <Segmented
                value={style.layout}
                options={[
                  { value: "follow", label: "Follow action", hint: "Crops to fill the screen, moving with the speaker or your clicks" },
                  { value: "whole", label: "Whole frame", hint: "The whole picture, over a soft blur of itself" },
                ]}
                onChange={(v) => setStyle({ layout: v as ShortStyle["layout"] })}
              />
            </Field>
            <div className="flex items-center gap-4">
              <Toggle label="Title" checked={style.title} onChange={(title) => setStyle({ title })} />
              <Toggle label="Tight pacing" hint="Removes ums and shortens long pauses" checked={style.tighten} onChange={(tighten) => setStyle({ tighten })} />
              <Toggle label="Cold open" hint="Opens on a punchy line from later in the clip, then flashes to the start" checked={style.teaser} onChange={(teaser) => setStyle({ teaser })} />
            </div>
            <div className="ml-auto flex items-center gap-3">
              {error && <span className="max-w-[220px] truncate text-[11px] text-red-300" title={error}>{error}</span>}
              {exported !== null ? (
                <>
                  <span className="flex items-center gap-1.5 text-[12px] text-white/70">
                    <IoCheckmark className="text-violet-300" size={14} />
                    {exported === 1 ? "Your Short is rendering" : `${exported} Shorts are rendering`} - saved next to your video
                  </span>
                  <button type="button" onClick={close} className="rounded-xl bg-white/10 px-4 py-2 text-[13px] font-medium transition hover:bg-white/15">
                    Done
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={chosen.length === 0 || exporting}
                  onClick={() => void exportAll()}
                  className="rounded-xl bg-violet-500 px-5 py-2 text-[13px] font-medium text-white shadow-lg shadow-violet-500/20 transition hover:bg-violet-400 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
                >
                  {exporting ? "Preparing…" : chosen.length === 1 ? "Export Short" : `Export ${chosen.length} Shorts`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

// Caption lines of a short (memoised per built short - they're rebuilt only when it changes).
const lineCache = new WeakMap<BuiltShort, ReturnType<typeof buildCaptionLines>>();
function captionLinesOf(built: BuiltShort) {
  let lines = lineCache.get(built);
  if (!lines) {
    lines = built.state.captions ? buildCaptionLines(built.state.clips, built.state.captions) : [];
    lineCache.set(built, lines);
  }
  return lines;
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2">
    <span className="text-[11px] text-white/40">{label}</span>
    {children}
  </div>
);

function Segmented({ value, options, onChange }: { value: string; options: { value: string; label: React.ReactNode; hint?: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-lg bg-white/[0.06] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-[11px] transition-all duration-150 ${value === o.value ? "bg-white/[0.14] text-white shadow-sm" : "text-white/55 hover:text-white/85"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" title={hint} onClick={() => onChange(!checked)} className="group flex items-center gap-2 text-[11px] text-white/60 hover:text-white/85">
      <span className={`relative block h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${checked ? "bg-violet-500" : "bg-white/15"}`}>
        <span className={`absolute left-0 top-0.5 block h-3 w-3 rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-3.5" : "translate-x-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

export default ShortsStudio;
