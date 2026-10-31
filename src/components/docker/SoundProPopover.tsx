// components/docker/SoundProPopover.tsx
//
// "Make it sound pro" (utils/soundPro.ts): where the video is going, which sound is the voice and
// which the music (guessed - a tap to change), what one click will do - then, once done, each change ticking in, and a Before/After switch to hear the difference
// while it plays. Before/After is an undo and a redo of the one step it made, so it's exact; any
// other edit in between ends the comparison (the step is no longer the last one) and the panel
// offers to run again on the edit as it now is.

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IoCheckmarkCircle, IoClose, IoEllipseOutline, IoPause, IoPlay } from "react-icons/io5";
import { MdOutlineSettingsVoice } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { planSoundPro, SOUND_DESTINATIONS, type SoundDestination, type SoundProInput, type SoundProStep, type SoundRole } from "../../utils/soundPro";
import type { VideoEditCommand } from "../../utils/videoEditTypes";
import type { SoundProPatch } from "../../hooks/useVideoEditStore";
import { describeProgress, type JobProgress } from "../../utils/jobProgress";

interface SoundProPopoverProps {
  anchor: { left: number; top: number };
  input: SoundProInput;
  apply: (patch: SoundProPatch) => void;
  // A cleaned voice renders before it plays cleaned - whether one is still going, and how far.
  cleaning: { pending: boolean; progress: JobProgress | null };
  undo: () => void;
  redo: () => void;
  undoTopLabel: VideoEditCommand["label"] | null;
  redoTopLabel: VideoEditCommand["label"] | null;
  onLoudnessChange: (lufs: number | null) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onClose: () => void;
}

const destinationFor = (lufs: number | null): SoundDestination => (Object.entries(SOUND_DESTINATIONS).find(([, d]) => d.lufs === lufs)?.[0] as SoundDestination | undefined) ?? "youtube";

const ROLE_LABELS: [SoundRole, string, string][] = [
  ["voice", "Voice", "Speech - noise removed, levelled, clear and close"],
  ["music", "Music", "Dips under the voice"],
  ["leave", "Leave", "Left exactly as it is"],
];

const SoundProPopover: React.FC<SoundProPopoverProps> = ({ anchor, input, apply, cleaning, undo, redo, undoTopLabel, redoTopLabel, onLoudnessChange, isPlaying, onTogglePlay, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const [destination, setDestination] = useState<SoundDestination>(() => destinationFor(input.loudnessLufs));
  const [roles, setRoles] = useState<Record<string, SoundRole>>({});
  const plan = useMemo(() => planSoundPro(input, destination, roles), [input, destination, roles]);
  // After it's run: what it did (frozen - the plan recomputes against the new edit), the loudness to
  // go back to, whether its step is in the edit, and whether the step exists at all (loudness alone
  // changes nothing in the edit).
  const [done, setDone] = useState<{ steps: SoundProStep[]; previousLufs: number | null; lufs: number; editStep: boolean } | null>(null);
  const [hearing, setHearing] = useState<"after" | "before">("after");

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (e.target instanceof Element && (e.target.closest("[data-sound-pro-popover]") || e.target.closest("[data-sound-pro-button]"))) return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [onClose]);

  // Another edit since - the comparison's over; back to the plan for the edit as it is now.
  const stillComparable = !done || !done.editStep || (hearing === "after" ? undoTopLabel === "sound-pro" : redoTopLabel === "sound-pro");
  useEffect(() => {
    if (!stillComparable) {
      setDone(null);
      setHearing("after");
    }
  }, [stillComparable]);

  const run = () => {
    if (plan.changesEdit) apply({ clips: plan.clips, audioOverlays: plan.audioOverlays, master: plan.master, videoAudioFx: plan.videoAudioFx });
    onLoudnessChange(plan.loudnessLufs);
    setDone({ steps: plan.steps, previousLufs: input.loudnessLufs, lufs: plan.loudnessLufs, editStep: plan.changesEdit });
    setHearing("after");
  };

  const hear = (which: "before" | "after") => {
    if (!done || which === hearing) return;
    if (done.editStep) (which === "before" ? undo : redo)();
    onLoudnessChange(which === "before" ? done.previousLufs : done.lufs);
    setHearing(which);
  };

  const nothingToDo = !plan.changesEdit && plan.steps.every((s) => s.already);
  const steps = done?.steps ?? plan.steps;

  return createPortal(
    <div
      ref={ref}
      data-sound-pro-popover
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className="w-72 p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <MdOutlineSettingsVoice size={15} className="text-amber-300" />
        <span className="flex-1 text-xs font-medium">{done ? (hearing === "after" ? "Sounds pro." : "The original") : "Make it sound pro"}</span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      {!done && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Where's it going?</span>
          <div className="grid grid-cols-3 gap-1">
            {(Object.keys(SOUND_DESTINATIONS) as SoundDestination[]).map((d) => (
              <button
                key={d}
                type="button"
                title={SOUND_DESTINATIONS[d].hint}
                onClick={() => setDestination(d)}
                className={`px-1 py-1 rounded text-[11px] transition-colors ${destination === d ? "text-amber-200 bg-amber-400/10 ring-1 ring-amber-300/40" : "text-white/70 hover:text-white hover:bg-white/10"}`}
              >
                {SOUND_DESTINATIONS[d].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!done && plan.sources.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-white/40">What's what</span>
          {plan.sources.map((src) => (
            <div key={src.key} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-[11px] text-white/80" title={src.name}>
                {src.name}
              </span>
              <div className="shrink-0 flex p-0.5 rounded bg-white/5">
                {ROLE_LABELS.map(([role, label, hint]) => (
                  <button
                    key={role}
                    type="button"
                    title={hint}
                    onClick={() => setRoles((r) => ({ ...r, [src.key]: role }))}
                    className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                      src.role === role ? (role === "voice" ? "bg-teal-400/20 text-teal-200" : role === "music" ? "bg-amber-400/15 text-amber-200" : "bg-white/15 text-white") : "text-white/45 hover:text-white"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={`flex items-start gap-2 text-[11px] transition-all duration-300 ${done ? "opacity-100 translate-x-0" : ""}`}
            style={done ? { animation: `soundProTick 360ms ease-out ${i * 140}ms both` } : undefined}
          >
            {done || s.already ? (
              <IoCheckmarkCircle size={14} className={`shrink-0 mt-px ${s.already && !done ? "text-white/30" : "text-teal-300"}`} />
            ) : (
              <IoEllipseOutline size={14} className="shrink-0 mt-px text-white/30" />
            )}
            <span className={s.already && !done ? "text-white/40" : "text-white/80"}>{s.text}</span>
          </li>
        ))}
        {steps.length === 0 && <li className="text-[11px] text-white/50">Add some sound to the timeline first.</li>}
      </ul>

      {!done ? (
        <button
          type="button"
          disabled={nothingToDo || steps.length === 0}
          onClick={run}
          className="w-full py-1.5 rounded-md text-xs font-semibold text-neutral-900 bg-gradient-to-r from-teal-300 to-amber-300 hover:brightness-110 disabled:opacity-40 disabled:cursor-default"
        >
          {nothingToDo ? "Already sounding pro" : "Make it sound pro"}
        </button>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              title={isPlaying ? "Pause" : "Play - then switch to hear the difference"}
              className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20"
            >
              {isPlaying ? <IoPause size={13} /> : <IoPlay size={13} className="ml-0.5" />}
            </button>
            <div className="flex-1 grid grid-cols-2 p-0.5 rounded-md bg-white/5 ring-1 ring-white/10">
              {(["before", "after"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => hear(w)}
                  className={`py-1 rounded text-[11px] capitalize transition-colors ${hearing === w ? (w === "after" ? "bg-teal-400/20 text-teal-200" : "bg-white/15 text-white") : "text-white/50 hover:text-white"}`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          {cleaning.pending ? (
            <span className="text-[10px] text-amber-200/80">
              Cleaning the voice{cleaning.progress ? ` - ${describeProgress(cleaning.progress)}` : "…"}. After plays it cleaned as soon as it's ready.
            </span>
          ) : (
            <span className="text-[10px] text-white/40">Play and switch between them to hear the difference. Undo (Ctrl+Z) takes it all back.</span>
          )}
          <button type="button" onClick={onClose} className="w-full py-1 rounded-md text-[11px] text-white/70 hover:text-white bg-white/5 hover:bg-white/10">
            {hearing === "after" ? "Keep it" : "Keep the original"}
          </button>
        </div>
      )}
      <style>{`@keyframes soundProTick { from { opacity: 0; transform: translateX(-6px) scale(0.96); } to { opacity: 1; transform: none; } }`}</style>
    </div>,
    document.body
  );
};

export default SoundProPopover;
