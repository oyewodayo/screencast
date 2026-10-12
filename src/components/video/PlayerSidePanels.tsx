// components/video/PlayerSidePanels.tsx
//
// The player's own sidebar panels (rendered by VideoPlayer into the sidebar's Tools tab, see
// ToolPanelHost.tsx): viewing captions - styled with the same presets/controls as the editor's
// burned-in captions but only ever shown over the player, never saved into the video - and
// chapters. Presentational; VideoPlayer owns the state.
import React, { useState } from "react";
import { IoAddCircleOutline, IoBookmarkOutline, IoClose, IoDocumentAttachOutline, IoMicOutline, IoSparklesOutline, IoTrashOutline } from "react-icons/io5";
import { MdClosedCaptionOff } from "react-icons/md";
import { DOCKED_PANEL_CLASS } from "../docker/ToolPanelHost";
import { CaptionSettings } from "../../utils/videoEditTypes";
import { CaptionLine } from "../../utils/captions";
import { CaptionStyleControls, CaptionTranscript, Toggle, TranscriptOnlyButton, formatCaptionTime, useTranscriptOnly } from "../captions/CaptionControls";

const PanelShell: React.FC<{ icon: React.ReactNode; title: string; actions?: React.ReactNode; onClose: () => void; children: React.ReactNode }> = ({
  icon,
  title,
  actions,
  onClose,
  children,
}) => (
  <div className={`${DOCKED_PANEL_CLASS} p-3 gap-3`}>
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium flex items-center gap-1.5">
        {icon}
        {title}
      </span>
      <div className="flex items-center gap-1.5">
        {actions}
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>
    </div>
    {children}
  </div>
);

// ---------- captions ----------

export const PlayerCaptionsPanel: React.FC<{
  hasCaptions: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: CaptionSettings;
  onUpdateSettings: (patch: Partial<CaptionSettings>) => void;
  lines: CaptionLine[];
  currentTime: number;
  onSeek: (time: number) => void;
  exportBaseName: string;
  onLoadFile: () => void;
  onGenerate: () => void;
  generating: { progress: number; downloadingModel: boolean } | null;
  onClose: () => void;
}> = (props) => {
  const [transcriptOnly, setTranscriptOnly] = useTranscriptOnly();
  const [error, setError] = useState<string | null>(null);
  const showList = props.hasCaptions && props.lines.length > 0;

  return (
    <PanelShell
      icon={<MdClosedCaptionOff size={14} />}
      title="Captions"
      onClose={props.onClose}
      actions={
        props.hasCaptions && (
          <>
            {showList && <TranscriptOnlyButton on={transcriptOnly} onChange={setTranscriptOnly} />}
            <Toggle on={props.visible} onChange={props.onVisibleChange} label="Show captions on the video" />
          </>
        )
      }
    >
      {!props.hasCaptions ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-[11px] leading-relaxed text-white/60">
            Captions for watching - shown over the player only, never saved into the video. Load a subtitle file, or generate them from the
            speech (offline).
          </p>
          {props.generating ? (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-[10px] text-white/60">
                <span>{props.generating.downloadingModel ? "Downloading speech model (one time)…" : "Transcribing…"}</span>
                <span className="tabular-nums">{Math.round(props.generating.progress)}%</span>
              </div>
              <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${props.generating.progress}%` }} />
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={props.onGenerate}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white"
              >
                <IoMicOutline size={13} />
                Generate
              </button>
              <button
                type="button"
                onClick={props.onLoadFile}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-white/80 bg-white/10 hover:bg-white/15"
              >
                <IoDocumentAttachOutline size={13} />
                Load file…
              </button>
            </div>
          )}
        </div>
      ) : transcriptOnly && showList ? (
        <CaptionTranscript
          title="Captions"
          lines={props.lines}
          currentTime={props.currentTime}
          onSeek={(line) => props.onSeek(line.start)}
          exportBaseName={props.exportBaseName}
          tall
          onError={setError}
        />
      ) : (
        <>
          <CaptionStyleControls settings={{ ...props.settings, enabled: props.visible }} onUpdate={props.onUpdateSettings} />
          {showList && (
            <CaptionTranscript
              title="Captions"
              lines={props.lines}
              currentTime={props.currentTime}
              onSeek={(line) => props.onSeek(line.start)}
              exportBaseName={props.exportBaseName}
              onError={setError}
            />
          )}
          <div className="pt-2 border-t border-white/10 flex items-center gap-2">
            <button
              type="button"
              onClick={props.onLoadFile}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/70 hover:text-white hover:bg-white/10"
            >
              <IoDocumentAttachOutline size={12} />
              Load another file…
            </button>
          </div>
        </>
      )}
      {error && <p className="text-[11px] leading-snug text-red-300 break-words">{error}</p>}
    </PanelShell>
  );
};

// ---------- chapters ----------

export interface PlayerChapter {
  id: string;
  time: number;
  label: string;
}

export const PlayerChaptersPanel: React.FC<{
  chapters: PlayerChapter[];
  activeChapterId: string | undefined;
  currentTime: number;
  isDetecting: boolean;
  onSeek: (time: number) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onDetect: () => void;
  onClose: () => void;
}> = (props) => (
  <PanelShell
    icon={<IoBookmarkOutline size={14} />}
    title="Chapters"
    onClose={props.onClose}
    actions={props.chapters.length > 0 && <span className="text-[11px] tabular-nums text-white/40">{props.chapters.length}</span>}
  >
    <div className="flex gap-2">
      <button
        type="button"
        onClick={props.onAdd}
        title={`Add a chapter at ${formatCaptionTime(props.currentTime)}`}
        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white"
      >
        <IoAddCircleOutline size={14} />
        Add at {formatCaptionTime(props.currentTime)}
      </button>
      <button
        type="button"
        onClick={props.onDetect}
        disabled={props.isDetecting}
        title="Find chapter breaks from pauses in the audio"
        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-white/80 bg-white/10 hover:bg-white/15 disabled:opacity-50"
      >
        <IoSparklesOutline size={13} />
        {props.isDetecting ? "Detecting…" : "Auto-detect"}
      </button>
    </div>

    {props.chapters.length === 0 ? (
      <p className="text-[11px] leading-relaxed text-white/50">No chapters yet. Mark moments to jump between them - they also show as ticks on the player's timeline.</p>
    ) : (
      <div className="flex flex-col gap-0.5 max-h-[calc(100vh-280px)] overflow-y-auto overscroll-contain -mx-1.5">
        {props.chapters.map((chapter, i) => {
          const active = chapter.id === props.activeChapterId;
          const untitled = chapter.label === formatCaptionTime(chapter.time);
          return (
            <div key={chapter.id} className={`group flex items-center gap-2 px-1.5 py-1 rounded ${active ? "bg-blue-500/25 ring-1 ring-blue-400/40" : "hover:bg-white/5"}`}>
              <button
                type="button"
                onClick={() => props.onSeek(chapter.time)}
                title="Jump to this chapter"
                className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] tabular-nums ${active ? "bg-blue-500/30 text-blue-200" : "bg-white/10 text-white/70 hover:text-white"}`}
              >
                {formatCaptionTime(chapter.time)}
              </button>
              <input
                value={untitled ? "" : chapter.label}
                placeholder={`Chapter ${i + 1}`}
                onChange={(e) => props.onRename(chapter.id, e.target.value || formatCaptionTime(chapter.time))}
                onKeyDown={(e) => {
                  e.stopPropagation(); // typing a name never triggers player shortcuts
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="flex-1 min-w-0 bg-transparent text-[11px] text-white/90 placeholder-white/35 outline-none rounded px-1 py-0.5 focus:bg-white/10"
              />
              <button
                type="button"
                onClick={() => props.onDelete(chapter.id)}
                title="Delete chapter"
                className="shrink-0 p-1 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10 transition-opacity"
              >
                <IoTrashOutline size={12} />
              </button>
            </div>
          );
        })}
      </div>
    )}
  </PanelShell>
);
