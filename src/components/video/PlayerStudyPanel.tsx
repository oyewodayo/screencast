// components/video/PlayerStudyPanel.tsx
//
// Docked Learning / Study Mode sidebar panel for Briefcast's Smart Video Player (renders in
// ToolPanelHost right alongside Chapters & Captions). Designed for frictionless active learning:
//   - Timestamped quick-note composer with optional Auto-pause while typing & auto-resume on save
//   - Instant 0ms live video frame snapshot ("Slide") + spoken caption quote capture
//   - Built-in A–B Study Loop repeater ([ / ] / \) for drilling hard concepts
//   - Color-coded tags (Note, Key Idea, Question, Action), instant search & auto-following list
//   - 1-click Copy Markdown and Turn into Study Doc (embeds notes + captured slides into Briefcast Docs)
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IoCameraOutline,
  IoChatbubbleEllipsesOutline,
  IoCheckmark,
  IoClose,
  IoCopyOutline,
  IoDocumentTextOutline,
  IoRepeatOutline,
  IoSchoolOutline,
  IoSearchOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { DOCKED_PANEL_CLASS } from "../docker/ToolPanelHost";
import { formatCaptionTime } from "../captions/CaptionControls";
import {
  STUDY_NOTE_TAGS,
  filterStudyNotes,
  tagMeta,
  studyNotesToMarkdown,
  type StudyNote,
  type StudyNoteTag,
} from "../../utils/videoStudyNotes";

export interface AbLoopState {
  start: number | null;
  end: number | null;
}

export interface PlayerStudyPanelProps {
  videoTitle: string;
  notes: StudyNote[];
  autoPauseOnType: boolean;
  onAutoPauseChange: (enabled: boolean) => void;
  currentTime: number;
  isPlaying: boolean;
  hasCaptions: boolean;
  abLoop: AbLoopState;
  onSetLoopA: () => void;
  onSetLoopB: () => void;
  onClearLoop: () => void;
  onSeek: (time: number) => void;
  onPauseForNote: () => void;
  onResumeAfterNote: () => void;
  onCaptureFrame: () => string | null;
  onCaptureQuote: () => string;
  onAddNote: (draft: { time: number; text: string; tag: StudyNoteTag; quote?: string; snapshotDataUrl?: string }) => void;
  onUpdateNote: (id: string, patch: Partial<Pick<StudyNote, "text" | "tag" | "snapshotDataUrl">>) => void;
  onDeleteNote: (id: string) => void;
  onClearAllNotes: () => void;
  onTurnIntoDoc: () => void;
  focusComposerSignal: number;
  onClose: () => void;
}

export const PlayerStudyPanel: React.FC<PlayerStudyPanelProps> = ({
  videoTitle,
  notes,
  autoPauseOnType,
  onAutoPauseChange,
  currentTime,
  isPlaying,
  hasCaptions,
  abLoop,
  onSetLoopA,
  onSetLoopB,
  onClearLoop,
  onSeek,
  onPauseForNote,
  onResumeAfterNote,
  onCaptureFrame,
  onCaptureQuote,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onClearAllNotes,
  onTurnIntoDoc,
  focusComposerSignal,
  onClose,
}) => {
  const [draftText, setDraftText] = useState("");
  const [draftTag, setDraftTag] = useState<StudyNoteTag>("note");
  const [draftSnapshot, setDraftSnapshot] = useState<string | null>(null);
  const [draftQuote, setDraftQuote] = useState<string | null>(null);
  const [draftTime, setDraftTime] = useState<number | null>(null);

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<StudyNoteTag | "all">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [copied, setCopied] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; time: number; caption?: string } | null>(null);

  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const pausedByTypingRef = useRef(false);

  // Pressing `N` while watching focuses the composer immediately and arms auto-pause if active.
  useEffect(() => {
    if (focusComposerSignal <= 0) return;
    const el = composerRef.current;
    if (!el) return;
    el.focus();
    if (autoPauseOnType && isPlaying) {
      pausedByTypingRef.current = true;
      onPauseForNote();
    }
    setDraftTime((prev) => prev ?? currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusComposerSignal]);

  const filteredNotes = useMemo(() => filterStudyNotes(notes, query, tagFilter), [notes, query, tagFilter]);

  const activeNoteId = useMemo(() => {
    let best: StudyNote | null = null;
    for (const n of filteredNotes) {
      if (n.time <= currentTime + 1.5) best = n;
      else break;
    }
    return best?.id;
  }, [filteredNotes, currentTime]);

  const activeIndex = useMemo(() => filteredNotes.findIndex((n) => n.id === activeNoteId), [filteredNotes, activeNoteId]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    if (list.contains(document.activeElement)) return;
    if (Date.now() - lastUserScrollRef.current < 3500) return;
    const row = list.children[activeIndex] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    if (top >= list.scrollTop && top + row.offsetHeight <= list.scrollTop + list.clientHeight) return;
    list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: "smooth" });
  }, [activeIndex]);

  const handleDraftChange = (value: string) => {
    if (!draftText && value.trim().length > 0) {
      setDraftTime((prev) => prev ?? currentTime);
      if (autoPauseOnType && isPlaying && !pausedByTypingRef.current) {
        pausedByTypingRef.current = true;
        onPauseForNote();
      }
    }
    setDraftText(value);
  };

  const handleSnapSlide = () => {
    const snap = onCaptureFrame();
    if (!snap) return;
    setDraftSnapshot(snap);
    setDraftTime((prev) => prev ?? currentTime);
    composerRef.current?.focus();
  };

  const handleGrabQuote = () => {
    const q = onCaptureQuote();
    if (!q) return;
    setDraftQuote(q);
    setDraftTime((prev) => prev ?? currentTime);
    composerRef.current?.focus();
  };

  const handleSaveDraft = () => {
    const trimmed = draftText.trim();
    if (!trimmed && !draftSnapshot && !draftQuote) return;
    onAddNote({
      time: draftTime ?? currentTime,
      text: trimmed,
      tag: draftTag,
      quote: draftQuote ?? undefined,
      snapshotDataUrl: draftSnapshot ?? undefined,
    });
    setDraftText("");
    setDraftSnapshot(null);
    setDraftQuote(null);
    setDraftTime(null);
    if (pausedByTypingRef.current) {
      pausedByTypingRef.current = false;
      onResumeAfterNote();
    }
  };

  const handleCopyMarkdown = async () => {
    const md = studyNotesToMarkdown(notes, { videoTitle, includeHeader: true });
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const abActive = abLoop.start !== null && abLoop.end !== null && abLoop.end > abLoop.start;

  return (
    <div className={`${DOCKED_PANEL_CLASS} p-3 gap-2.5`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5 text-white">
          <IoSchoolOutline size={14} className="text-emerald-400" />
          Study Mode
          {notes.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums bg-emerald-500/20 text-emerald-300">
              {notes.length}
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onAutoPauseChange(!autoPauseOnType)}
            title="Automatically pause playback when you start typing a note, and resume when you press Enter"
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              autoPauseOnType ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/30" : "bg-white/5 text-white/50 hover:text-white/80"
            }`}
          >
            {autoPauseOnType ? "Auto-pause" : "Keep playing"}
          </button>
          <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
            <IoClose size={14} />
          </button>
        </div>
      </div>

      {/* A–B Study Loop repeater */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-white/[0.04] ring-1 ring-white/10">
        <IoRepeatOutline size={13} className={abActive ? "text-amber-400 shrink-0" : "text-white/45 shrink-0"} />
        <span className="text-[10px] font-medium text-white/60 shrink-0">A–B</span>
        <button
          type="button"
          onClick={onSetLoopA}
          title="Set loop start A at current time ([)"
          className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums transition-colors ${
            abLoop.start !== null ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/35" : "bg-white/10 text-white/75 hover:bg-white/15"
          }`}
        >
          {abLoop.start !== null ? `A ${formatCaptionTime(abLoop.start)}` : "Set A"}
        </button>
        <button
          type="button"
          onClick={onSetLoopB}
          title="Set loop end B at current time (])"
          className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums transition-colors ${
            abLoop.end !== null ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/35" : "bg-white/10 text-white/75 hover:bg-white/15"
          }`}
        >
          {abLoop.end !== null ? `B ${formatCaptionTime(abLoop.end)}` : "Set B"}
        </button>
        {(abLoop.start !== null || abLoop.end !== null) && (
          <button
            type="button"
            onClick={onClearLoop}
            title="Clear A–B loop (\)"
            className="ml-auto px-1.5 py-0.5 rounded text-[10px] text-white/50 hover:text-white hover:bg-white/10"
          >
            Clear
          </button>
        )}
      </div>

      {/* Quick-note composer */}
      <div className="rounded-lg bg-white/[0.04] ring-1 ring-white/10 focus-within:ring-emerald-400/50 p-2 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1 flex-wrap">
            {STUDY_NOTE_TAGS.map((t) => {
              const active = draftTag === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setDraftTag(t.id)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    active ? `${t.badgeClass} ring-1` : "text-white/55 hover:text-white/85 hover:bg-white/5"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${t.dotClass}`} />
                  {t.shortLabel}
                </button>
              );
            })}
          </div>
          <span
            className="text-[10px] tabular-nums text-emerald-300/90 font-medium shrink-0"
            title="Timestamp this note will be anchored to"
          >
            @{formatCaptionTime(draftTime ?? currentTime)}
          </span>
        </div>

        <textarea
          ref={composerRef}
          rows={2}
          value={draftText}
          onChange={(e) => handleDraftChange(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSaveDraft();
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
              if (pausedByTypingRef.current) {
                pausedByTypingRef.current = false;
                onResumeAfterNote();
              }
            }
          }}
          placeholder="Jot an idea, formula, or question… (Enter to save)"
          className="w-full resize-none bg-transparent text-[11.5px] leading-relaxed text-white placeholder-white/35 outline-none"
        />

        {draftQuote && (
          <div className="relative pl-2 pr-5 py-1 border-l-2 border-sky-400/60 bg-sky-500/10 rounded-r text-[10.5px] italic text-white/80 leading-snug">
            “{draftQuote}”
            <button
              type="button"
              onClick={() => setDraftQuote(null)}
              title="Remove quote"
              className="absolute top-1 right-1 text-white/40 hover:text-white"
            >
              <IoClose size={11} />
            </button>
          </div>
        )}

        {draftSnapshot && (
          <div className="relative rounded overflow-hidden ring-1 ring-white/15">
            <img src={draftSnapshot} alt="Captured video frame" className="w-full h-24 object-cover" />
            <button
              type="button"
              onClick={() => setDraftSnapshot(null)}
              title="Remove captured slide"
              className="absolute top-1 right-1 p-0.5 rounded-full bg-black/75 text-white/80 hover:text-white"
            >
              <IoClose size={11} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between gap-1.5 pt-1 border-t border-white/10">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleSnapSlide}
              title="Capture current video frame into this note (S for instant snap)"
              className="flex items-center gap-1 px-2 py-1 rounded text-[10.5px] text-white/75 hover:text-white bg-white/5 hover:bg-white/10 transition-colors"
            >
              <IoCameraOutline size={12} />
              Slide
            </button>
            <button
              type="button"
              onClick={handleGrabQuote}
              disabled={!hasCaptions}
              title={hasCaptions ? "Quote the spoken caption at this timestamp" : "Load or generate captions to quote speech"}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10.5px] text-white/75 hover:text-white bg-white/5 hover:bg-white/10 disabled:opacity-35 transition-colors"
            >
              <IoChatbubbleEllipsesOutline size={12} />
              Quote
            </button>
          </div>
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={!draftText.trim() && !draftSnapshot && !draftQuote}
            className="px-2.5 py-1 rounded text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-35 transition-colors"
          >
            Save
          </button>
        </div>
      </div>

      {/* Search & filter strip */}
      {notes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="relative flex items-center">
            <IoSearchOutline size={12} className="absolute left-2 text-white/40 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Filter notes or timestamps…"
              className="w-full pl-6 pr-6 py-1 rounded bg-white/5 ring-1 ring-white/10 text-[11px] text-white placeholder-white/35 outline-none focus:ring-emerald-400/50"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 text-white/40 hover:text-white"
              >
                <IoClose size={12} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
            <button
              type="button"
              onClick={() => setTagFilter("all")}
              className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 transition-colors ${
                tagFilter === "all" ? "bg-white/15 text-white font-medium" : "text-white/50 hover:text-white/80"
              }`}
            >
              All ({notes.length})
            </button>
            {STUDY_NOTE_TAGS.map((t) => {
              const count = notes.filter((n) => n.tag === t.id).length;
              if (count === 0) return null;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTagFilter(tagFilter === t.id ? "all" : t.id)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0 transition-colors ${
                    tagFilter === t.id ? `${t.badgeClass} ring-1 font-medium` : "text-white/55 hover:text-white/85"
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${t.dotClass}`} />
                  {t.shortLabel} ({count})
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Notes list */}
      {notes.length === 0 ? (
        <div className="py-3 px-1 text-[11px] leading-relaxed text-white/50 space-y-1.5">
          <p>Capture timestamped ideas, questions, and slide snapshots as you watch — saved automatically alongside the video.</p>
          <p className="text-[10px] text-white/40">
            Shortcuts: <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/70">N</kbd> note ·{" "}
            <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/70">S</kbd> snap slide ·{" "}
            <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/70">[</kbd>{" "}
            <kbd className="px-1 py-0.5 rounded bg-white/10 text-white/70">]</kbd> A–B loop
          </p>
        </div>
      ) : filteredNotes.length === 0 ? (
        <p className="py-3 text-center text-[11px] text-white/45">No notes match your filter.</p>
      ) : (
        <div
          ref={listRef}
          onWheel={() => (lastUserScrollRef.current = Date.now())}
          onPointerDown={() => (lastUserScrollRef.current = Date.now())}
          className="relative flex flex-col gap-1.5 max-h-[calc(100vh-450px)] min-h-[120px] overflow-y-auto overscroll-contain -mx-1 px-1"
        >
          {filteredNotes.map((note) => {
            const active = note.id === activeNoteId;
            const meta = tagMeta(note.tag);
            const isEditing = editingId === note.id;
            return (
              <div
                key={note.id}
                className={`group rounded-md p-2 flex flex-col gap-1.5 transition-colors ${
                  active ? "bg-emerald-500/15 ring-1 ring-emerald-400/35" : "bg-white/[0.03] hover:bg-white/[0.06] ring-1 ring-white/5"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => onSeek(note.time)}
                      title="Jump to this moment"
                      className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums ${
                        active ? "bg-emerald-500/30 text-emerald-200" : "bg-white/10 text-white/75 hover:bg-emerald-600 hover:text-white"
                      }`}
                    >
                      {formatCaptionTime(note.time)}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const order: StudyNoteTag[] = ["note", "key", "question", "todo"];
                        const next = order[(order.indexOf(note.tag) + 1) % order.length];
                        onUpdateNote(note.id, { tag: next });
                      }}
                      title="Click to cycle tag"
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-medium ring-1 ${meta.badgeClass}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`} />
                      {meta.shortLabel}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDeleteNote(note.id)}
                    title="Delete note"
                    className="shrink-0 p-0.5 rounded text-white/30 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10 transition-opacity"
                  >
                    <IoTrashOutline size={12} />
                  </button>
                </div>

                {isEditing ? (
                  <textarea
                    autoFocus
                    rows={2}
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onBlur={() => {
                      onUpdateNote(note.id, { text: editingText.trim() });
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onUpdateNote(note.id, { text: editingText.trim() });
                        setEditingId(null);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                    className="w-full resize-none rounded bg-white/10 px-1.5 py-1 text-[11px] text-white outline-none"
                  />
                ) : (
                  <p
                    onClick={() => {
                      setEditingId(note.id);
                      setEditingText(note.text);
                    }}
                    title="Click to edit note"
                    className="text-[11.5px] leading-snug text-white/90 whitespace-pre-wrap break-words cursor-text"
                  >
                    {note.text || <span className="italic text-white/40">Click to add commentary…</span>}
                  </p>
                )}

                {note.quote && (
                  <div className="pl-2 border-l-2 border-sky-400/50 text-[10.5px] italic text-white/65 leading-snug">
                    “{note.quote}”
                  </div>
                )}

                {note.snapshotDataUrl && (
                  <button
                    type="button"
                    onClick={() => setLightboxSrc({ src: note.snapshotDataUrl!, time: note.time, caption: note.text })}
                    title="Click to inspect captured slide"
                    className="block rounded overflow-hidden ring-1 ring-white/10 hover:ring-emerald-400/50 transition-all"
                  >
                    <img src={note.snapshotDataUrl} alt={`Slide at ${formatCaptionTime(note.time)}`} className="w-full h-24 object-cover" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer export actions */}
      <div className="pt-2 border-t border-white/10 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onTurnIntoDoc}
            title="Create a linked Briefcast Study Doc containing your notes, captured slides, chapters & transcript"
            className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
          >
            <IoDocumentTextOutline size={13} />
            Turn into Study Doc
          </button>
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => void handleCopyMarkdown()}
              title="Copy all study notes as Markdown"
              className="px-2 py-1.5 rounded-md text-[11px] text-white/80 bg-white/10 hover:bg-white/15 flex items-center gap-1 transition-colors"
            >
              {copied ? <IoCheckmark size={13} className="text-emerald-400" /> : <IoCopyOutline size={12} />}
              {copied ? "Copied" : "MD"}
            </button>
          )}
        </div>
        {notes.length > 0 && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Remove all ${notes.length} study notes from this video?`)) onClearAllNotes();
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-white/45 hover:text-red-400 hover:bg-white/5"
            >
              <IoTrashOutline size={11} />
              Clear notes
            </button>
          </div>
        )}
      </div>

      {/* Lightbox for inspecting captured slides */}
      {lightboxSrc &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setLightboxSrc(null)}
          >
            <div className="relative max-w-4xl w-full flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
              <img src={lightboxSrc.src} alt="Captured video frame" className="max-h-[80vh] w-auto rounded-lg shadow-2xl ring-1 ring-white/20" />
              <div className="flex items-center gap-3 text-xs text-white/85">
                <button
                  type="button"
                  onClick={() => {
                    onSeek(lightboxSrc.time);
                    setLightboxSrc(null);
                  }}
                  className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-medium tabular-nums"
                >
                  Jump to {formatCaptionTime(lightboxSrc.time)}
                </button>
                {lightboxSrc.caption && <span className="max-w-xl truncate text-white/80">{lightboxSrc.caption}</span>}
                <button
                  type="button"
                  onClick={() => setLightboxSrc(null)}
                  className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white"
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
