// components/video/HighlightIntroPanel.tsx
//
// The flash-cut highlight intro builder: how many cuts and how long, on the music's beat or not,
// a steady pace or a build-up, flash/whip between cuts, how it lands in the video, and which
// moments it takes - shown live as a strip of cut lengths and where each comes from, re-rollable.
// Applying puts the intro at the very front as one undo step (insertHighlightIntro).
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IoClose, IoDiceOutline } from "react-icons/io5";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { AudioOverlay, Clip, ClipTransitionIn, TransitionType, isImageClipPath } from "../../utils/videoEditTypes";
import { beatOutputTimes } from "../../utils/beatSync";
import { HighlightIntroOptions, IntroCutStyle, buildHighlightIntro, introCutLengths, pickIntroMoments } from "../../utils/highlightIntro";

interface HighlightIntroPanelProps {
  anchor: PopoverAnchor;
  clips: Clip[];
  selectedClipIds: string[];
  audioOverlays: AudioOverlay[];
  onApply: (introClips: Clip[], into: ClipTransitionIn | null, keepMusicInPlace: boolean) => void;
  onClose: () => void;
}

type Into = "cut" | Extract<TransitionType, "lightleak" | "fadewhite" | "whip" | "horzopen">;
const INTO: { value: Into; label: string }[] = [
  { value: "lightleak", label: "Light leak" },
  { value: "fadewhite", label: "Flash" },
  { value: "whip", label: "Whip" },
  { value: "horzopen", label: "Bar open" },
  { value: "cut", label: "Cut" },
];
// A distinct colour per source clip in the preview strip.
const STRIP_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"];

const Chips = <T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) => (
  <div className="flex flex-wrap gap-1">
    {options.map((o) => (
      <button
        key={String(o.value)}
        type="button"
        onClick={() => onChange(o.value)}
        className={`h-6 px-2 rounded text-[11px] transition-colors ${value === o.value ? "bg-blue-500/25 text-blue-200 ring-1 ring-blue-400/50" : "bg-white/[0.06] text-white/65 hover:text-white hover:bg-white/10"}`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-start gap-2 text-[11px]">
    <span className="w-16 shrink-0 pt-1 text-white/60">{label}</span>
    <div className="flex-1 min-w-0">{children}</div>
  </div>
);

const HighlightIntroPanel: React.FC<HighlightIntroPanelProps> = ({ anchor, clips, selectedClipIds, audioOverlays, onApply, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const videoClips = clips.filter((c) => !isImageClipPath(c.sourcePath));
  const selectedVideo = videoClips.filter((c) => selectedClipIds.includes(c.id));
  const beats = useMemo(() => beatOutputTimes(audioOverlays), [audioOverlays]);
  const hasMusic = audioOverlays.some((o) => !o.muted);

  const [fromSelected, setFromSelected] = useState(selectedVideo.length > 0);
  const [cuts, setCuts] = useState(8);
  const [cutSec, setCutSec] = useState(0.3);
  const [pace, setPace] = useState<HighlightIntroOptions["pace"]>("build");
  const [order, setOrder] = useState<HighlightIntroOptions["order"]>("shuffle");
  const [between, setBetween] = useState<IntroCutStyle>("flash");
  const [into, setInto] = useState<Into>("lightleak");
  const [onBeat, setOnBeat] = useState(beats.length > 1);
  const [everyBeats, setEveryBeats] = useState(1);
  const [muteCuts, setMuteCuts] = useState(hasMusic);
  const [seed, setSeed] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const opts: HighlightIntroOptions = {
    sourceClipIds: fromSelected ? selectedVideo.map((c) => c.id) : [],
    cuts,
    cutSec,
    pace,
    order,
    between,
    muteCuts,
    beats: onBeat && beats.length > 1 ? beats : null,
    everyBeats,
    seed,
  };
  const lengths = introCutLengths(opts);
  const moments = pickIntroMoments(clips, lengths, opts);
  const total = moments.reduce((sum, m) => sum + (m.end - m.start) / (m.clip.speed ?? 1), 0);
  const clipColor = (clip: Clip) => STRIP_COLORS[Math.max(0, videoClips.findIndex((c) => c.id === clip.id)) % STRIP_COLORS.length];

  const apply = () => {
    const intro = buildHighlightIntro(clips, opts, () => crypto.randomUUID());
    if (intro.length === 0) return;
    onApply(intro, into === "cut" ? null : { type: into, duration: into === "lightleak" ? 0.6 : 0.4 }, !!opts.beats);
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Highlight intro"
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-[380px] max-h-[82vh] overflow-y-auto p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-2xl ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Highlight intro</span>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 -m-1 rounded text-white/50 hover:text-white hover:bg-white/10">
          <IoClose size={14} />
        </button>
      </div>
      <p className="text-[10.5px] leading-snug text-white/50">A burst of quick cuts from across your footage, before the video starts.</p>

      {/* Live preview: each cut's length, coloured by the clip it comes from. */}
      <div className="flex flex-col gap-1">
        <div className="flex h-7 rounded-md overflow-hidden ring-1 ring-white/10">
          {moments.map((m, i) => (
            <div
              key={i}
              title={`Cut ${i + 1}: ${((m.end - m.start) / (m.clip.speed ?? 1)).toFixed(2)}s from clip ${clips.indexOf(m.clip) + 1} at ${m.start.toFixed(1)}s`}
              className="h-full border-r border-black/50 last:border-r-0"
              style={{ flexGrow: (m.end - m.start) / (m.clip.speed ?? 1), background: clipColor(m.clip), opacity: 0.55 + 0.45 * (i % 2) }}
            />
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-white/50 tabular-nums">
          <span>
            {moments.length} cuts · {total.toFixed(1)}s
          </span>
          <button type="button" onClick={() => setSeed((s) => s + 1)} className="flex items-center gap-1 px-1.5 h-5 rounded text-white/70 hover:text-white hover:bg-white/10" title="Pick different moments">
            <IoDiceOutline size={12} /> Re-roll moments
          </button>
        </div>
      </div>

      <Row label="Footage">
        <Chips
          options={[
            { value: "all", label: `Whole timeline (${videoClips.length})` },
            ...(selectedVideo.length > 0 ? [{ value: "selected", label: `Selected clips (${selectedVideo.length})` }] : []),
          ]}
          value={fromSelected ? "selected" : "all"}
          onChange={(v) => setFromSelected(v === "selected")}
        />
      </Row>

      {beats.length > 1 ? (
        <Row label="Timing">
          <div className="flex flex-col gap-1.5">
            <Chips
              options={[
                { value: "beat", label: "On the beat" },
                { value: "free", label: "Free" },
              ]}
              value={onBeat ? "beat" : "free"}
              onChange={(v) => setOnBeat(v === "beat")}
            />
            {onBeat && (
              <Chips
                options={[
                  { value: 1, label: "Every beat" },
                  { value: 2, label: "Every 2" },
                  { value: 4, label: "Every bar (4)" },
                ]}
                value={everyBeats}
                onChange={setEveryBeats}
              />
            )}
          </div>
        </Row>
      ) : (
        hasMusic && <p className="text-[10.5px] text-white/45">Tip: detect beats on your music track to cut exactly on the beat.</p>
      )}

      <Row label="Cuts">
        <div className="flex items-center gap-2">
          <input type="range" min={3} max={24} step={1} value={cuts} onChange={(e) => setCuts(Number(e.target.value))} className="flex-1 accent-blue-400" />
          <span className="w-6 text-right tabular-nums text-white/60">{cuts}</span>
        </div>
      </Row>
      {!opts.beats && (
        <>
          <Row label="Cut length">
            <div className="flex items-center gap-2">
              <input type="range" min={0.1} max={1} step={0.02} value={cutSec} onChange={(e) => setCutSec(Number(e.target.value))} className="flex-1 accent-blue-400" />
              <span className="w-10 text-right tabular-nums text-white/60">{cutSec.toFixed(2)}s</span>
            </div>
          </Row>
          <Row label="Pace">
            <Chips
              options={[
                { value: "build", label: "Build up (faster and faster)" },
                { value: "steady", label: "Steady" },
              ]}
              value={pace}
              onChange={setPace}
            />
          </Row>
        </>
      )}
      <Row label="Order">
        <Chips
          options={[
            { value: "shuffle", label: "Shuffled" },
            { value: "story", label: "In story order" },
          ]}
          value={order}
          onChange={setOrder}
        />
      </Row>
      <Row label="Between">
        <Chips
          options={[
            { value: "flash", label: "Flash" },
            { value: "whip", label: "Whip" },
            { value: "cut", label: "Hard cut" },
          ]}
          value={between}
          onChange={setBetween}
        />
      </Row>
      <Row label="Into video">
        <Chips options={INTO} value={into} onChange={setInto} />
      </Row>
      <Row label="Sound">
        <Chips
          options={[
            { value: "mute", label: "Mute the cuts" },
            { value: "keep", label: "Keep their sound" },
          ]}
          value={muteCuts ? "mute" : "keep"}
          onChange={(v) => setMuteCuts(v === "mute")}
        />
      </Row>

      <button
        type="button"
        disabled={moments.length === 0}
        onClick={apply}
        className="h-8 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-500 disabled:opacity-50 transition-colors"
      >
        Add {total.toFixed(1)}s intro at the start
      </button>
      <p className="text-[10px] leading-snug text-white/40">
        Everything else moves along so titles and overlays stay on their shots{opts.beats ? " - your music stays put, so the cuts land on its beats" : ""}. One undo removes it all.
      </p>
    </div>,
    document.body
  );
};

export default HighlightIntroPanel;
