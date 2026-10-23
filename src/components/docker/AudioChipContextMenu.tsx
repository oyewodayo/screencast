// components/docker/AudioChipContextMenu.tsx
//
// Right-click menu for a piece of audio on the timeline - the audio lane's counterpart to
// ClipContextMenu, same look and dismissal rules. Its headline action saves the piece as its own
// audio file exactly as it sounds on the timeline (the part of the song used, its volume, fades
// and mixer effects - extract_clip_audio), which makes the editor a quick place to cut, shape and
// pull a sound out without rendering a video at all.
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  IoCopyOutline,
  IoCutOutline,
  IoDownloadOutline,
  IoFolderOpenOutline,
  IoOptionsOutline,
  IoPulseOutline,
  IoTrashOutline,
  IoVolumeHighOutline,
  IoVolumeMuteOutline,
} from "react-icons/io5";
import { MdOutlineNoiseControlOff } from "react-icons/md";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { isNeutralFx } from "../../utils/audioFx";
import { hasAutomation } from "../../utils/audioAutomation";

export type AudioSaveFormat = "mp3" | "wav";

interface AudioChipContextMenuProps {
  anchor: PopoverAnchor;
  overlay: AudioOverlay;
  // The playhead is inside this piece (Split cuts there).
  canSplit: boolean;
  onSaveAs: (format: AudioSaveFormat) => void;
  onEdit: () => void;
  // Opens its volume automation line on the timeline (AutomationLine).
  onDrawVolume: () => void;
  // Opens its noise clean-up (Reduce / Remove).
  onCleanup: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  onToggleMute: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const itemClass =
  "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:text-neutral-500 disabled:hover:bg-transparent disabled:cursor-default outline-none focus-visible:bg-white/10";

const formatLength = (sec: number) => `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, "0")}`;

const AudioChipContextMenu: React.FC<AudioChipContextMenuProps> = (props) => {
  const { anchor, overlay, canSplit, onClose } = props;
  const { ref, position } = useClampedPopoverPosition(anchor);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, ref]);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const name = overlay.label ?? overlay.library?.title ?? overlay.src.split(/[\\/]/).pop() ?? "Audio";
  // What the saved file will carry beyond the cut itself - said on the menu so it's no surprise.
  const shaping = [
    Math.abs(overlay.volume - 1) > 0.005 ? "volume" : null,
    (overlay.fadeInSec ?? 0) > 0 || (overlay.fadeOutSec ?? 0) > 0 ? "fades" : null,
    !isNeutralFx(overlay.fx) ? "effects" : null,
    hasAutomation(overlay) ? "volume line" : null,
    (overlay.noiseReduction ?? 0) > 0 ? "noise clean-up" : null,
  ].filter(Boolean);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 10000 }}
      className="w-[220px] py-1 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-xl ring-1 ring-white/10"
    >
      <div className="px-3 pt-1 pb-1.5 flex items-baseline gap-2 text-[10px] uppercase tracking-wide text-neutral-500">
        <span className="truncate normal-case tracking-normal text-[11px] text-neutral-300">{name}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatLength(overlay.endTime - overlay.startTime)}</span>
      </div>
      <button type="button" onClick={act(() => props.onSaveAs("mp3"))} className={itemClass}>
        <IoDownloadOutline size={14} /> Save audio as MP3…
      </button>
      <button type="button" onClick={act(() => props.onSaveAs("wav"))} className={itemClass}>
        <IoDownloadOutline size={14} /> Save audio as WAV…
      </button>
      <div className="px-3 pb-1 pl-[34px] text-[10px] leading-snug text-neutral-500">
        {shaping.length > 0 ? `Just this part, with its ${shaping.join(", ").replace(/, ([^,]*)$/, " and $1")}` : "Just the part on the timeline"}
      </div>
      <div className="my-1 border-t border-white/10" />
      <button type="button" onClick={act(props.onEdit)} className={itemClass}>
        <IoOptionsOutline size={14} /> Volume, fades and effects…
      </button>
      <button type="button" onClick={act(props.onDrawVolume)} className={itemClass} title="Ride the level over time - points on a line, like a mixing desk's automation">
        <IoPulseOutline size={14} /> {overlay.gain?.length ? "Edit volume line" : "Draw volume line"}
      </button>
      <button type="button" onClick={act(props.onCleanup)} className={itemClass} title="Reduce or remove background noise - hiss, hum, room, wind">
        <MdOutlineNoiseControlOff size={14} /> {(overlay.noiseReduction ?? 0) > 0 ? "Noise clean-up (on)…" : "Reduce / remove noise…"}
      </button>
      <button type="button" disabled={!canSplit} onClick={act(props.onSplit)} className={itemClass} title={canSplit ? undefined : "Move the playhead inside this audio to cut it there"}>
        <IoCutOutline size={14} /> Split at playhead
      </button>
      <button type="button" onClick={act(props.onDuplicate)} className={itemClass}>
        <IoCopyOutline size={14} /> Duplicate
      </button>
      <button type="button" onClick={act(props.onToggleMute)} className={itemClass}>
        {overlay.muted ? <IoVolumeHighOutline size={14} /> : <IoVolumeMuteOutline size={14} />} {overlay.muted ? "Unmute" : "Mute"}
      </button>
      <div className="my-1 border-t border-white/10" />
      <button type="button" onClick={act(props.onReveal)} className={itemClass}>
        <IoFolderOpenOutline size={14} /> Show source in folder
      </button>
      <button type="button" onClick={act(props.onDelete)} className={`${itemClass} text-red-300`}>
        <IoTrashOutline size={14} /> Delete audio
      </button>
    </div>,
    document.body
  );
};

export default AudioChipContextMenu;
