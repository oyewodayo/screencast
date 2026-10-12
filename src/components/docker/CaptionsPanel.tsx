// components/docker/CaptionsPanel.tsx
//
// The video editor's Captions tool - generates a word-timed transcript for every source file on
// the timeline (offline whisper.cpp, generate_caption_words in conversion.rs), then styles and
// positions it as burned-in captions that Save exports into the video itself (see captions.ts).
// Docks into the sidebar's Tools tab like the other settings panels (ToolPanelHost.tsx), floating
// as a popover only when there's no sidebar to dock into.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { IoCheckmark, IoClose, IoCopyOutline, IoDocumentAttachOutline, IoDownloadOutline, IoRefresh, IoTrashOutline } from "react-icons/io5";
import { MdClosedCaptionOff } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useToolPanelHost } from "./ToolPanelHost";
import Slider from "./Slider";
import NumberStepper from "./NumberStepper";
import { CaptionPosition, CaptionSettings, CaptionTrack, CaptionWord } from "../../utils/videoEditTypes";
import { CAPTION_PRESETS, CAPTION_PRESET_ORDER, CaptionLine, captionBoxStyle, captionWordStyle, cuesToCaptionWords, parseSubtitleFile } from "../../utils/captions";
import { CAPTIONS_LANGUAGE_OPTIONS } from "../../utils/videoUtils";
import { trackEvent } from "../../utils/telemetry";

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

const EMPHASIS_SWATCHES = ["#d07cff", "#facc15", "#4ade80", "#38bdf8", "#f87171", "#ffffff", "#111827"];
const POSITIONS: { value: CaptionPosition; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

const formatTime = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[10px] uppercase tracking-wide text-white/40">{children}</span>
);

const Toggle: React.FC<{ on: boolean; onChange: (next: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={() => onChange(!on)}
    className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors ${on ? "bg-blue-500" : "bg-white/20"}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-[14px] h-[14px] rounded-full bg-white transition-transform ${on ? "translate-x-[14px]" : ""}`} />
  </button>
);

// One editable caption line - commits on blur/Enter, Escape reverts.
const CaptionLineRow: React.FC<{
  line: CaptionLine;
  active: boolean;
  onSeek: () => void;
  onCommit: (text: string) => void;
}> = ({ line, active, onSeek, onCommit }) => {
  const original = line.words.map((w) => w.text).join(" ");
  const [value, setValue] = useState(original);
  useEffect(() => setValue(original), [original]);
  const commit = () => {
    if (value.trim() !== original) onCommit(value);
  };
  return (
    <div className={`flex items-start gap-2 px-1.5 py-1 rounded ${active ? "bg-blue-500/25 ring-1 ring-blue-400/40" : "hover:bg-white/5"}`}>
      <button
        type="button"
        onClick={onSeek}
        title="Jump to this line"
        className={`shrink-0 mt-[3px] text-[10px] tabular-nums ${active ? "text-blue-300" : "text-white/40 hover:text-white/80"}`}
      >
        {formatTime(line.start)}
      </button>
      <textarea
        value={value}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep Space/Delete/arrows from reaching the timeline's shortcuts
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.key === "Escape") {
            setValue(original);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        className="flex-1 min-w-0 resize-none bg-transparent text-[11px] leading-snug text-white/85 outline-none rounded px-1 focus:bg-white/10 [field-sizing:content]"
      />
    </div>
  );
};

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

  // Follows playback through the caption list: keeps the line being spoken in view (a third of the
  // way down, so what's coming next is visible too). Holds off while a line is being edited, and
  // for a few seconds after the user scrolls the list themselves, so it never fights them.
  const listRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const activeLineIndex = lines.findIndex((l) => currentOutputTime >= l.start && currentOutputTime < l.end);
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeLineIndex < 0) return;
    if (list.contains(document.activeElement)) return;
    if (Date.now() - lastUserScrollRef.current < 3000) return;
    const row = list.children[activeLineIndex] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    if (top >= list.scrollTop && top + row.offsetHeight <= list.scrollTop + list.clientHeight) return;
    list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: "smooth" });
  }, [activeLineIndex]);
  const [importTarget, setImportTarget] = useState<string>(primarySourcePath);
  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

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
  const preset = settings ? CAPTION_PRESETS[settings.preset] : null;
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

  // The captions as plain text, one caption line per row - what Copy and Download (.txt) hand out.
  const transcriptText = () => lines.map((line) => line.words.map((w) => w.text).join(" ")).join("\n") + "\n";
  const [exportDone, setExportDone] = useState<"copied" | "saved" | null>(null);
  useEffect(() => {
    if (!exportDone) return;
    const t = setTimeout(() => setExportDone(null), 1800);
    return () => clearTimeout(t);
  }, [exportDone]);

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText());
      setExportDone("copied");
    } catch (err) {
      setError(`Couldn't copy captions: ${err}`);
    }
  };

  const downloadTranscript = async () => {
    const base = fileName(primarySourcePath).replace(/\.[^.]+$/, "");
    const outputPath = await saveFileDialog({
      defaultPath: `${base} captions.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    }).catch(() => null);
    if (!outputPath) return; // cancelled
    try {
      // Docs' plain-text export command - writes `content` to exactly the chosen path.
      await invoke<string>("export_doc", { docTitle: `${base} captions`, extension: "txt", content: transcriptText(), outputPath });
      setExportDone("saved");
    } catch (err) {
      setError(`Couldn't save captions: ${err}`);
    }
  };

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
              Generate captions
            </button>
          )}
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-white/30">
            <span className="flex-1 h-px bg-white/10" />
            or
            <span className="flex-1 h-px bg-white/10" />
          </div>
          {importRow}
        </div>
      ) : (
        <>
          {!hasWords && !generating && (
            <p className="text-[11px] text-amber-300/90">No speech was found in this video.</p>
          )}
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

          {settings && preset && (
            <>
              <div className={`flex flex-col gap-1.5 ${settings.enabled ? "" : "opacity-50"}`}>
                <SectionLabel>Style</SectionLabel>
                <div className="grid grid-cols-2 gap-1.5">
                  {CAPTION_PRESET_ORDER.map((key) => {
                    const def = CAPTION_PRESETS[key];
                    const selected = settings.preset === key;
                    const thumbSettings: CaptionSettings = { ...settings, preset: key, emphasisColor: selected ? settings.emphasisColor : def.emphasisColor };
                    return (
                      <button
                        key={key}
                        type="button"
                        title={def.label}
                        onClick={() => onUpdateSettings({ preset: key, emphasisColor: def.emphasisColor, uppercase: def.uppercase })}
                        className={`h-11 flex items-center justify-center rounded-md bg-neutral-700/60 overflow-hidden transition-shadow ${
                          selected ? "ring-2 ring-blue-400" : "ring-1 ring-white/10 hover:ring-white/30"
                        }`}
                      >
                        <span style={captionBoxStyle(def, 12)}>
                          <span style={captionWordStyle(def, thumbSettings, true, 12)}>{def.uppercase ? "THIS" : "This"}</span>{" "}
                          <span style={captionWordStyle(def, thumbSettings, false, 12)}>{def.uppercase ? "IS STYLED" : "is styled"}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <SectionLabel>Word emphasis</SectionLabel>
                  <Toggle on={settings.emphasis} onChange={(emphasis) => onUpdateSettings({ emphasis })} label="Highlight the word being spoken" />
                </div>
                {settings.emphasis && (
                  <div className="flex items-center gap-1.5">
                    {EMPHASIS_SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => onUpdateSettings({ emphasisColor: c })}
                        className={`w-5 h-5 rounded-full ring-offset-1 ring-offset-neutral-900 ${
                          settings.emphasisColor.toLowerCase() === c ? "ring-2 ring-blue-400" : "ring-1 ring-white/20"
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <label title="Custom colour" className="relative w-5 h-5 rounded-full ring-1 ring-white/20 overflow-hidden cursor-pointer bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
                      <input
                        type="color"
                        value={settings.emphasisColor}
                        onChange={(e) => onUpdateSettings({ emphasisColor: e.target.value })}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <SectionLabel>Position</SectionLabel>
                <div className="flex rounded-md bg-white/5 p-0.5">
                  {POSITIONS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => onUpdateSettings({ position: p.value })}
                      className={`flex-1 py-1 rounded text-[11px] transition-colors ${
                        settings.position === p.value ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-400/40" : "text-white/60 hover:text-white"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {settings.position !== "middle" && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="w-14 shrink-0 text-white/60">From edge</span>
                    <Slider value={settings.offset * 100} min={0} max={40} step={1} onChange={(v) => onUpdateSettings({ offset: v / 100 })} />
                    <NumberStepper value={settings.offset * 100} min={0} max={40} step={1} decimals={0} suffix="%" onChange={(v) => onUpdateSettings({ offset: v / 100 })} />
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <SectionLabel>Text</SectionLabel>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-14 shrink-0 text-white/60">Size</span>
                  <Slider value={settings.size * 100} min={50} max={200} step={5} marks={[100]} onChange={(v) => onUpdateSettings({ size: v / 100 })} />
                  <NumberStepper value={settings.size * 100} min={50} max={200} step={5} decimals={0} suffix="%" onChange={(v) => onUpdateSettings({ size: v / 100 })} />
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-white/60">Words per line</span>
                  <NumberStepper value={settings.maxWordsPerLine} min={1} max={14} step={1} decimals={0} suffix="" onChange={(v) => onUpdateSettings({ maxWordsPerLine: v })} />
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-white/60">ALL CAPS</span>
                  <Toggle on={settings.uppercase} onChange={(uppercase) => onUpdateSettings({ uppercase })} label="All caps" />
                </div>
              </div>

              {lines.length > 0 && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <SectionLabel>Edit captions ({lines.length})</SectionLabel>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        title={exportDone === "copied" ? "Copied" : "Copy captions to clipboard"}
                        onClick={() => void copyTranscript()}
                        className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10"
                      >
                        {exportDone === "copied" ? <IoCheckmark size={13} className="text-green-400" /> : <IoCopyOutline size={13} />}
                      </button>
                      <button
                        type="button"
                        title={exportDone === "saved" ? "Saved" : "Download captions as a text file"}
                        onClick={() => void downloadTranscript()}
                        className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10"
                      >
                        {exportDone === "saved" ? <IoCheckmark size={13} className="text-green-400" /> : <IoDownloadOutline size={13} />}
                      </button>
                    </div>
                  </div>
                  <div
                    ref={listRef}
                    onWheel={() => (lastUserScrollRef.current = Date.now())}
                    onPointerDown={() => (lastUserScrollRef.current = Date.now())}
                    className="relative max-h-72 overflow-y-auto overscroll-contain -mx-1.5 flex flex-col"
                  >
                    {lines.map((line, index) => (
                      <CaptionLineRow
                        key={line.id}
                        line={line}
                        active={index === activeLineIndex}
                        onSeek={() => onSeekLine(line)}
                        onCommit={(text) => onEditLine(line, text)}
                      />
                    ))}
                  </div>
                </div>
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
                <button
                  type="button"
                  title="Remove captions"
                  onClick={onClear}
                  className="shrink-0 p-1 rounded text-white/50 hover:text-red-400 hover:bg-white/10"
                >
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
