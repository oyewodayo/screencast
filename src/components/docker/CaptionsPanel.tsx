// components/docker/CaptionsPanel.tsx
//
// The video editor's Captions tool - generates a word-timed transcript for every source file on
// the timeline (offline whisper.cpp, generate_caption_words in conversion.rs), then styles and
// positions it as burned-in captions that Save exports into the video itself (see captions.ts).
// Docks into the sidebar's Tools tab like the other settings panels (ToolPanelHost.tsx), floating
// as a popover only when there's no sidebar to dock into. The style controls and caption list are
// shared with the player's viewing-captions panel (captions/CaptionControls.tsx).
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoDocumentAttachOutline, IoRefresh, IoTrashOutline } from "react-icons/io5";
import { MdClosedCaptionOff } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "./ToolPanelHost";
import { CaptionSettings, CaptionTrack, CaptionWord } from "../../utils/videoEditTypes";
import { CaptionLine, cuesToCaptionWords, parseSubtitleFile } from "../../utils/captions";
import { CAPTIONS_LANGUAGE_OPTIONS } from "../../utils/videoUtils";
import { trackEvent } from "../../utils/telemetry";
import { CaptionStyleControls, CaptionTranscript, Toggle, TranscriptOnlyButton, useTranscriptOnly } from "../captions/CaptionControls";

interface CaptionsPanelProps {
  anchor: { left: number; top: number };
  captions: CaptionTrack | null;
  lines: CaptionLine[];
  // Every distinct source file the timeline's clips use - each needs its own transcript.
  sourcePaths: string[];
  // The file this editing session was opened on - where an imported subtitle file's timings are
  // applied by default.
  primarySourcePath: string;
  currentOutputTime: number;
  onGenerated: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
  onUpdateSettings: (patch: Partial<CaptionSettings>) => void;
  onEditLine: (line: CaptionLine, text: string) => void;
  onClear: () => void;
  onSeekLine: (line: CaptionLine) => void;
  onClose: () => void;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

const CaptionsPanel: React.FC<CaptionsPanelProps> = ({
  anchor,
  captions,
  lines,
  sourcePaths,
  primarySourcePath,
  currentOutputTime,
  onGenerated,
  onUpdateSettings,
  onEditLine,
  onClear,
  onSeekLine,
  onClose,
}) => {
  const { ref: popoverRef, position } = useClampedPopoverPosition(anchor);
  // Docked into the sidebar's Tools tab when it's there - see ToolPanelHost.tsx.
  const dockHost = useToolPanelHost();
  const [language, setLanguage] = useState<string>(captions?.language ?? "auto");
  const [generating, setGenerating] = useState<{ index: number; total: number; progress: number; downloadingModel: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOnly, setTranscriptOnly] = useTranscriptOnly();

  useEffect(() => {
    // A docked panel stays open until its X / toolbar button closes it.
    if (dockHost) return;
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-captions-panel]")) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose, dockHost]);

  const missingSources = sourcePaths.filter((p) => !captions?.transcripts[p]);

  // An interrupted generation (app closed mid-way) keeps its finished pieces - generate_caption_words
  // resumes from them. Shown on the button so "Generate" doesn't look like starting over.
  const [resumable, setResumable] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    if (captions || generating) return;
    let cancelled = false;
    Promise.all(
      sourcePaths.map((p) =>
        invoke<{ done: number; total: number } | null>("caption_job_progress", { inputPath: p, language, words: true }).catch(() => null)
      )
    ).then((jobs) => {
      if (cancelled) return;
      const found = jobs.filter((j): j is { done: number; total: number } => !!j);
      setResumable(found.length > 0 ? { done: found.reduce((a, j) => a + j.done, 0), total: found.reduce((a, j) => a + j.total, 0) } : null);
    });
    return () => {
      cancelled = true;
    };
  }, [captions, generating, sourcePaths, language]);
  const [importTarget, setImportTarget] = useState<string>(primarySourcePath);

  // An existing .srt/.vtt, in place of (or replacing) a generated transcript for one source file.
  // Its times are that file's own, the same as a sidecar subtitle file next to the video.
  const importSubtitles = async () => {
    setError(null);
    try {
      const selected = await openFileDialog({ multiple: false, filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }] });
      if (!selected || Array.isArray(selected)) return;
      const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: selected });
      const cues = parseSubtitleFile(new TextDecoder("utf-8").decode(new Uint8Array(bytes)));
      if (cues.length === 0) {
        setError(`No captions found in ${fileName(selected)}.`);
        return;
      }
      const target = sourcePaths.includes(importTarget) ? importTarget : primarySourcePath;
      onGenerated(captions?.language ?? "auto", { [target]: cuesToCaptionWords(cues) });
      trackEvent("editor_captions_imported", { cues: cues.length });
    } catch (err) {
      console.error("Caption import failed:", err);
      setError(`Couldn't import captions: ${err}`);
    }
  };

  // Transcribes each file in turn (whisper already uses every core but one, so in parallel would
  // only make each slower) and hands the whole batch to the store as one undoable step.
  const generate = async (paths: string[], lang: string) => {
    if (paths.length === 0 || generating) return;
    setError(null);
    setGenerating({ index: 0, total: paths.length, progress: 0, downloadingModel: false });
    const unlisten = await listen<number>("captions-progress", (event) => {
      setGenerating((g) => (g ? { ...g, progress: event.payload, downloadingModel: false } : g));
    });
    const unlistenModel = await listen<{ downloaded: number; total: number }>("whisper-model-download", (event) => {
      const { downloaded, total } = event.payload;
      setGenerating((g) => (g ? { ...g, downloadingModel: downloaded < total, progress: downloaded < total ? (downloaded / total) * 100 : 0 } : g));
    });
    try {
      const transcripts: Record<string, CaptionWord[]> = {};
      for (let i = 0; i < paths.length; i++) {
        setGenerating((g) => (g ? { ...g, index: i, progress: 0 } : g));
        // eslint-disable-next-line no-await-in-loop
        transcripts[paths[i]] = await invoke<CaptionWord[]>("generate_caption_words", { inputPath: paths[i], language: lang });
      }
      onGenerated(lang, transcripts);
      trackEvent("editor_captions_generated", { language: lang, files: paths.length });
    } catch (err) {
      console.error("Caption generation failed:", err);
      setError(String(err));
    } finally {
      unlisten();
      unlistenModel();
      setGenerating(null);
    }
  };

  const settings = captions?.settings ?? null;
  const hasWords = !!captions && Object.values(captions.transcripts).some((w) => w.length > 0);

  const languagePicker = (
    <select
      value={language}
      onChange={(e) => setLanguage(e.target.value)}
      disabled={!!generating}
      className="flex-1 min-w-0 px-2 py-1 rounded bg-white/10 text-[11px] text-white outline-none focus:ring-1 focus:ring-blue-400/60"
    >
      {CAPTIONS_LANGUAGE_OPTIONS.map(([code, name]) => (
        <option key={code} value={code} className="bg-neutral-900">
          {name}
        </option>
      ))}
    </select>
  );

  const importRow = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void importSubtitles()}
        disabled={!!generating}
        title="Use an existing .srt or .vtt file - word highlighting is estimated, since these only time whole lines"
        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-40"
      >
        <IoDocumentAttachOutline size={12} />
        Import .srt / .vtt
      </button>
      {sourcePaths.length > 1 && (
        <select
          value={importTarget}
          onChange={(e) => setImportTarget(e.target.value)}
          title="Which video the file's timings belong to"
          className="flex-1 min-w-0 px-1.5 py-1 rounded bg-white/10 text-[11px] text-white outline-none"
        >
          {sourcePaths.map((p) => (
            <option key={p} value={p} className="bg-neutral-900">
              for {fileName(p)}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  const progressBlock = generating && (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-[10px] text-white/60">
        <span>
          {generating.downloadingModel
            ? "Downloading speech model (one time)…"
            : generating.total > 1
              ? `Transcribing file ${generating.index + 1} of ${generating.total}…`
              : "Transcribing…"}
        </span>
        <span className="tabular-nums">{Math.round(generating.progress)}%</span>
      </div>
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${generating.progress}%` }} />
      </div>
    </div>
  );

  const showTranscriptOnly = transcriptOnly && !!settings && lines.length > 0;

  return createPortal(
    <div
      ref={popoverRef}
      data-captions-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={
        dockHost
          ? `${DOCKED_PANEL_CLASS} p-3 gap-3`
          : "w-80 max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <MdClosedCaptionOff size={14} />
          Captions
        </span>
        <div className="flex items-center gap-1.5">
          {settings && lines.length > 0 && <TranscriptOnlyButton on={transcriptOnly} onChange={setTranscriptOnly} />}
          {settings && <Toggle on={settings.enabled} onChange={(enabled) => onUpdateSettings({ enabled })} label="Show captions" />}
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      {!captions ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] leading-relaxed text-white/60">
            Turn the speech in this video into captions you can style, position and edit - then Save to burn them into the exported video. Runs
            offline on this computer.
          </p>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="shrink-0 text-white/60">Language</span>
            {languagePicker}
          </div>
          {progressBlock || (
            <button
              type="button"
              onClick={() => void generate(sourcePaths, language)}
              disabled={sourcePaths.length === 0}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
            >
              {resumable ? `Resume generating${resumable.total > 0 ? ` (${resumable.done} of ${resumable.total} parts done)` : ""}` : "Generate captions"}
            </button>
          )}
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-white/30">
            <span className="flex-1 h-px bg-white/10" />
            or
            <span className="flex-1 h-px bg-white/10" />
          </div>
          {importRow}
        </div>
      ) : showTranscriptOnly ? (
        <CaptionTranscript
          title="Captions"
          lines={lines}
          currentTime={currentOutputTime}
          onSeek={onSeekLine}
          onEdit={onEditLine}
          exportBaseName={fileName(primarySourcePath).replace(/\.[^.]+$/, "")}
          tall
          onError={setError}
        />
      ) : (
        <>
          {!hasWords && !generating && <p className="text-[11px] text-amber-300/90">No speech was found in this video.</p>}
          {missingSources.length > 0 && !generating && (
            <button
              type="button"
              onClick={() => void generate(missingSources, captions.language)}
              className="text-left px-2 py-1.5 rounded bg-blue-500/10 ring-1 ring-blue-400/30 text-[11px] text-blue-200 hover:bg-blue-500/20"
            >
              {missingSources.length === 1 ? "1 clip has" : `${missingSources.length} clips have`} no captions yet - generate them
            </button>
          )}
          {progressBlock}

          {settings && (
            <>
              <CaptionStyleControls settings={settings} onUpdate={onUpdateSettings} />

              {lines.length > 0 && (
                <CaptionTranscript
                  title="Edit captions"
                  lines={lines}
                  currentTime={currentOutputTime}
                  onSeek={onSeekLine}
                  onEdit={onEditLine}
                  exportBaseName={fileName(primarySourcePath).replace(/\.[^.]+$/, "")}
                  onError={setError}
                />
              )}

              <div className="pt-2 border-t border-white/10">{importRow}</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 flex items-center gap-1.5">{languagePicker}</div>
                <button
                  type="button"
                  title="Transcribe again in the selected language (replaces your edits)"
                  disabled={!!generating}
                  onClick={() => void generate(sourcePaths, language)}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10 disabled:opacity-40"
                >
                  <IoRefresh size={12} />
                  Redo
                </button>
                <button type="button" title="Remove captions" onClick={onClear} className="shrink-0 p-1 rounded text-white/50 hover:text-red-400 hover:bg-white/10">
                  <IoTrashOutline size={13} />
                </button>
              </div>
            </>
          )}
        </>
      )}

      {error && <p className="text-[11px] leading-snug text-red-300 break-words">{error}</p>}
    </div>,
    dockHost ?? document.body
  );
};

export default CaptionsPanel;
