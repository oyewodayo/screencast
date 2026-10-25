// components/docker/ChaptersPanel.tsx
//
// Chapters of the edited video (videoChapters.ts): placed at the playhead, suggested from the
// transcript, or taken from the markers the recording already has (its .chapters.json - the
// player's own chapters). Each is anchored to a moment of its source, so it stays on its shot as
// the timeline changes. Exported into the file, its .chapters.json, and YouTube's description.
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { IoBookmarkOutline, IoClose, IoSparklesOutline } from "react-icons/io5";
import { CaptionTrack, Clip, VideoChapter } from "../../utils/videoEditTypes";
import { chapterAtOutputTime, chapterOutputTime, formatChapterTimestamp, suggestChapters, youtubeChapterLines } from "../../utils/videoChapters";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";

interface Props {
  anchor: { left: number; top: number };
  clips: Clip[];
  chapters: VideoChapter[];
  captions: CaptionTrack | null;
  currentOutputTime: number;
  durationSec: number;
  primarySourcePath: string;
  onChange: (chapters: VideoChapter[]) => void;
  onSeek: (outputTime: number) => void;
  onClose: () => void;
}

const LabelField: React.FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim() || value);
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
        e.stopPropagation();
      }}
      className="flex-1 min-w-0 bg-transparent rounded px-1 py-0.5 text-[12px] text-white outline-none hover:bg-white/5 focus:bg-white/10"
    />
  );
};

const ChaptersPanel: React.FC<Props> = ({ anchor, clips, chapters, captions, currentOutputTime, durationSec, primarySourcePath, onChange, onSeek, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const dockHost = useToolPanelHost();
  useFloatingDismiss("[data-chapters-panel]", onClose, !!dockHost);
  useDockSnap(ref, !!dockHost);
  const [recordingMarkers, setRecordingMarkers] = useState<{ time: number; label: string }[]>([]);
  const [note, setNote] = useState<string | null>(null);

  // The recording's own chapter markers (placed in the player), in its source seconds.
  useEffect(() => {
    invoke<string | null>("load_video_chapters", { videoPath: primarySourcePath })
      .then((json) => {
        const parsed: { time: number; label: string }[] = json ? JSON.parse(json) : [];
        setRecordingMarkers(parsed.filter((c) => Number.isFinite(c.time)));
      })
      .catch(() => setRecordingMarkers([]));
  }, [primarySourcePath]);

  const rows = useMemo(
    () => chapters.map((c) => ({ chapter: c, time: chapterOutputTime(clips, c) })).sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity)),
    [chapters, clips]
  );
  const placed = rows.filter((r) => r.time !== null).map((r) => ({ time: r.time!, label: r.chapter.label }));
  const youtube = youtubeChapterLines(placed, durationSec);

  const add = () => {
    const c = chapterAtOutputTime(clips, currentOutputTime, `Chapter ${chapters.length + 1}`);
    if (c) onChange([...chapters, c]);
  };
  const suggest = () => {
    const s = suggestChapters(clips, captions, durationSec);
    if (s.length === 0) {
      setNote("Not enough speech to find chapters in - add them at the playhead instead");
      return;
    }
    onChange(s.map((x) => chapterAtOutputTime(clips, x.time, x.label)).filter((c): c is VideoChapter => c !== null));
    setNote(`Found ${s.length} chapters - rename any that need it`);
  };
  const importMarkers = () => {
    const imported = recordingMarkers.map((m) => ({ id: crypto.randomUUID(), sourcePath: primarySourcePath, sourceTime: m.time, label: m.label }));
    onChange([...chapters.filter((c) => !imported.some((m) => Math.abs(m.sourceTime - c.sourceTime) < 0.5)), ...imported]);
  };

  return createPortal(
    <div
      ref={ref}
      data-chapters-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={
        dockHost
          ? `${DOCKED_PANEL_CLASS} p-3 gap-3`
          : "w-80 max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <IoBookmarkOutline size={14} />
          Chapters
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>
      <p className="text-[11px] leading-snug text-white/50">Saved into the exported file, and into its YouTube description so viewers can jump between them.</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={add} className="px-2 py-1 rounded text-[11px] text-white/85 bg-white/[0.07] hover:bg-white/10">
          Add at playhead
        </button>
        <button
          type="button"
          onClick={suggest}
          disabled={!captions}
          title={captions ? "Split the video where the talk moves on, titled from what's said" : "Generate captions first (Captions tool) - suggestions come from the transcript"}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/85 bg-white/[0.07] hover:bg-white/10 disabled:opacity-40"
        >
          <IoSparklesOutline size={11} />
          {chapters.length ? "Suggest again" : "Suggest from transcript"}
        </button>
        {recordingMarkers.length > 0 && (
          <button type="button" onClick={importMarkers} title="The chapter markers placed on this recording in the player" className="px-2 py-1 rounded text-[11px] text-white/85 bg-white/[0.07] hover:bg-white/10">
            Use the recording's markers ({recordingMarkers.length})
          </button>
        )}
      </div>
      {note && <span className="text-[11px] text-white/55">{note}</span>}
      {rows.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {rows.map(({ chapter, time }) => (
            <div key={chapter.id} className={`flex items-center gap-1.5 rounded px-1 ${time !== null && Math.abs(time - currentOutputTime) < 0.5 ? "bg-violet-500/15" : ""}`}>
              <button
                type="button"
                disabled={time === null}
                onClick={() => time !== null && onSeek(time)}
                title={time === null ? "Its moment has been cut out of the video" : "Go there"}
                className="w-12 shrink-0 text-left tabular-nums text-[11px] text-violet-300 hover:text-violet-200 disabled:text-white/30"
              >
                {time === null ? "cut" : formatChapterTimestamp(time)}
              </button>
              <LabelField value={chapter.label} onCommit={(label) => onChange(chapters.map((c) => (c.id === chapter.id ? { ...c, label } : c)))} />
              <button type="button" title="Remove" onClick={() => onChange(chapters.filter((c) => c.id !== chapter.id))} className="px-1 text-white/35 hover:text-red-400">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {placed.length > 0 && youtube.problem && <span className="text-[11px] text-amber-200/80">For YouTube: {youtube.problem.toLowerCase()}.</span>}
      {chapters.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="self-end text-[10px] text-white/40 hover:text-white/80">
          Remove all
        </button>
      )}
    </div>,
    dockHost ?? document.body
  );
};

export default ChaptersPanel;
