// components/docker/ClipContextMenu.tsx
//
// Right-click menu for a clip on the video timeline - replaces the webview's native menu (which
// only offered "Save image as / Copy image" for the filmstrip thumbnail under the cursor) with the
// things you actually want to do to a clip: watch it on its own, save it as a file, split,
// duplicate, move, and set its transition, motion, color and length without opening a panel.
// Every action goes through the edit store like the toolbar's own buttons, so each one is a
// single undo step.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IoChevronForward,
  IoCopyOutline,
  IoCutOutline,
  IoDownloadOutline,
  IoFolderOpenOutline,
  IoMoveOutline,
  IoPlayCircleOutline,
  IoSparklesOutline,
  IoSwapHorizontalOutline,
  IoTimeOutline,
  IoTrashOutline,
  IoCheckmark,
  IoColorPaletteOutline,
  IoScanOutline,
  IoPauseCircleOutline,
  IoPlayBackOutline,
  IoRepeatOutline,
  IoAddCircleOutline,
  IoGitMergeOutline,
} from "react-icons/io5";
import { MdFlip } from "react-icons/md";
import { PopoverAnchor, useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { Clip, ColorFilterPreset, KenBurnsPreset, TransitionType } from "../../utils/videoEditTypes";
import { COLOR_FILTER_PRESETS, KEN_BURNS_PRESETS, TRANSITION_PRESETS } from "../../utils/videoColorFilters";
import { clipOutputDuration } from "../../utils/clipTiming";

export type ClipMoveTarget = "earlier" | "later" | "start" | "end";

interface ClipContextMenuProps {
  anchor: PopoverAnchor;
  clip: Clip;
  index: number;
  clipCount: number;
  isImage: boolean;
  // Whether the playhead is inside this clip (Split cuts there).
  canSplit: boolean;
  // Delete is refused when it would leave a recording with no clips at all.
  canDelete: boolean;
  // How many clips Duplicate/Delete act on - more than 1 when this clip is part of a Ctrl/Shift
  // multi-selection.
  selectionCount: number;
  // Merge the multi-selection into one clip. `mergeIsInstant`: they're back-to-back split pieces
  // that simply join; otherwise merging renders them into one new clip.
  onMerge: () => void;
  mergeIsInstant: boolean;
  onView: () => void;
  onSaveAs: () => void;
  onSplit: () => void;
  onDuplicate: () => void;
  // Picks another image/video to play in this clip's place.
  onReplace: () => void;
  // Picks images/videos to add right before or after this clip.
  onInsert: (where: "before" | "after") => void;
  onFreezeFrame: () => void;
  onToggleReverse: () => void;
  onMove: (target: ClipMoveTarget) => void;
  onSetTransition: (type: TransitionType | null) => void;
  onSetMotion: (preset: KenBurnsPreset | null) => void;
  onSetColor: (preset: ColorFilterPreset) => void;
  onSetLength: (seconds: number) => void;
  // Sets every image clip on the timeline to one length.
  onSetAllImageLengths: (seconds: number) => void;
  onToggleMirror: () => void;
  onOpenEffects: () => void;
  onReveal: () => void;
  onDelete: () => void;
  onClose: () => void;
}

// Down to a tenth of a second, for photo montages where each picture just flashes by.
const IMAGE_LENGTHS = [0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 8, 10, 15];
const ALL_IMAGE_LENGTHS = [0.1, 0.2, 0.3, 0.5, 1, 2];
const lengthLabel = (sec: number) => (sec < 1 ? `${sec}s` : `${sec} second${sec === 1 ? "" : "s"}`);

type SubmenuId = "insert" | "move" | "transition" | "motion" | "color" | "length";

const itemClass =
  "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:text-neutral-500 disabled:hover:bg-transparent disabled:cursor-default outline-none focus-visible:bg-white/10";

const ClipContextMenu: React.FC<ClipContextMenuProps> = (props) => {
  const { anchor, clip, index, clipCount, isImage, canSplit, canDelete, selectionCount, onClose } = props;
  const many = selectionCount > 1;
  const { ref, position } = useClampedPopoverPosition(anchor);
  const [openSubmenu, setOpenSubmenu] = useState<SubmenuId | null>(null);
  const [submenuTop, setSubmenuTop] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  // Where the open flyout actually sits - next to its row, nudged up so it never runs off the
  // bottom of the window (Transition's list is taller than the space below a low row).
  const [submenuOffset, setSubmenuOffset] = useState(0);
  useLayoutEffect(() => {
    const flyout = submenuRef.current;
    const menu = ref.current;
    if (!flyout || !menu) return;
    const menuTop = menu.getBoundingClientRect().top;
    const overflow = menuTop + submenuTop + flyout.offsetHeight - (window.innerHeight - 8);
    // Up by however much it overflows, but never above the window's own top edge.
    setSubmenuOffset(Math.max(8 - menuTop, submenuTop - Math.max(0, overflow)) - submenuTop);
  }, [openSubmenu, submenuTop, ref]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Capture phase, so a click that starts a drag/scrub elsewhere still closes the menu first.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, ref]);

  // Runs the action, then closes - every menu choice is one-shot.
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const openSub = (id: SubmenuId) => (event: React.MouseEvent<HTMLElement>) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const menuTop = ref.current?.getBoundingClientRect().top ?? 0;
    setSubmenuTop(event.currentTarget.getBoundingClientRect().top - menuTop - 4);
    setOpenSubmenu(id);
  };
  // A short grace period, so moving diagonally into the flyout doesn't close it on the way.
  const scheduleCloseSub = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenSubmenu(null), 180);
  };
  const keepSub = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  // Flyouts open to the right unless the menu sits too close to the right edge.
  const flyLeft = position.left + 200 + 190 > window.innerWidth;

  const submenuItem = (id: SubmenuId, icon: React.ReactNode, label: string, value: string | null, disabled = false) => (
    <button
      type="button"
      disabled={disabled}
      onMouseEnter={disabled ? undefined : openSub(id)}
      onMouseLeave={scheduleCloseSub}
      onClick={disabled ? undefined : openSub(id)}
      className={`${itemClass} ${openSubmenu === id ? "bg-white/10" : ""}`}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {value && <span className="text-[10px] text-neutral-400 truncate max-w-[84px]">{value}</span>}
      <IoChevronForward size={11} className="text-neutral-500" />
    </button>
  );

  const choice = (key: string, label: string, selected: boolean, onPick: () => void, disabled = false) => (
    <button key={key} type="button" disabled={disabled} onClick={act(onPick)} className={itemClass}>
      <span className="w-3 shrink-0">{selected && <IoCheckmark size={12} className="text-teal-400" />}</span>
      {label}
    </button>
  );

  const transitionLabel = clip.transitionIn ? TRANSITION_PRESETS.find((p) => p.value === clip.transitionIn?.type)?.label ?? "On" : null;
  const motionLabel = clip.kenBurns ? KEN_BURNS_PRESETS.find((p) => p.value === clip.kenBurns?.preset)?.label ?? "On" : null;
  const colorLabel = clip.colorFilter && clip.colorFilter.preset !== "none" ? COLOR_FILTER_PRESETS.find((p) => p.value === clip.colorFilter?.preset)?.label ?? null : null;
  const lengthSec = clipOutputDuration(clip);

  const renderSubmenu = () => {
    switch (openSubmenu) {
      case "insert":
        return [
          choice("before", "Before this clip…", false, () => props.onInsert("before")),
          choice("after", "After this clip…", false, () => props.onInsert("after")),
        ];
      case "move":
        return [
          choice("earlier", "Move earlier", false, () => props.onMove("earlier"), index === 0),
          choice("later", "Move later", false, () => props.onMove("later"), index === clipCount - 1),
          choice("start", "Move to start", false, () => props.onMove("start"), index === 0),
          choice("end", "Move to end", false, () => props.onMove("end"), index === clipCount - 1),
        ];
      case "transition":
        return [
          choice("none", "None", !clip.transitionIn, () => props.onSetTransition(null)),
          ...TRANSITION_PRESETS.map((p) => choice(p.value, p.label, clip.transitionIn?.type === p.value, () => props.onSetTransition(p.value))),
        ];
      case "motion":
        return [
          choice("none", "None", !clip.kenBurns, () => props.onSetMotion(null)),
          ...KEN_BURNS_PRESETS.map((p) => choice(p.value, p.label, clip.kenBurns?.preset === p.value, () => props.onSetMotion(p.value))),
        ];
      case "color":
        return COLOR_FILTER_PRESETS.map((p) =>
          choice(p.value, p.label, (clip.colorFilter?.preset ?? "none") === p.value, () => props.onSetColor(p.value))
        );
      case "length":
        return [
          ...IMAGE_LENGTHS.map((sec) => choice(String(sec), lengthLabel(sec), Math.abs(lengthSec - sec) < 0.01, () => props.onSetLength(sec))),
          <div key="all-label" className="mt-1 pt-1.5 px-3 pb-1 border-t border-white/10 text-[10px] uppercase tracking-wide text-neutral-500">
            Every image
          </div>,
          ...ALL_IMAGE_LENGTHS.map((sec) => choice(`all-${sec}`, `All images ${lengthLabel(sec)}`, false, () => props.onSetAllImageLengths(sec))),
        ];
      default:
        return null;
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "fixed", left: position.left, top: position.top, zIndex: 10000 }}
      className="w-[200px] py-1 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-xl ring-1 ring-white/10"
    >
      <div className="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
        {isImage ? "Image" : "Video"} clip {index + 1} of {clipCount} · {lengthSec.toFixed(1)}s
      </div>
      <button type="button" onClick={act(props.onView)} className={itemClass}>
        <IoPlayCircleOutline size={14} /> View clip
      </button>
      <button type="button" onClick={act(props.onSaveAs)} className={itemClass}>
        <IoDownloadOutline size={14} /> Save clip as…
      </button>
      <div className="my-1 border-t border-white/10" />
      <button type="button" disabled={!canSplit} onClick={act(props.onSplit)} className={itemClass} title={canSplit ? undefined : "Move the playhead inside this clip to split it there"}>
        <IoCutOutline size={14} /> Split at playhead
      </button>
      <button type="button" onClick={act(props.onDuplicate)} className={itemClass}>
        <IoCopyOutline size={14} /> {many ? `Duplicate ${selectionCount} clips` : "Duplicate"}
      </button>
      <button type="button" onClick={act(props.onReplace)} className={itemClass} title="Swap in another image or video - keeps this clip's place, length and effects">
        <IoRepeatOutline size={14} /> Replace…
      </button>
      {many && (
        <button
          type="button"
          onClick={act(props.onMerge)}
          className={itemClass}
          title={
            props.mergeIsInstant
              ? "Join these back-to-back pieces into one clip"
              : "Render these into one clip (in timeline order, where the first one is) - their effects and the transitions between them are baked in"
          }
        >
          <IoGitMergeOutline size={14} /> Merge {selectionCount} clips{props.mergeIsInstant ? "" : "…"}
        </button>
      )}
      {submenuItem("insert", <IoAddCircleOutline size={14} />, "Insert clip", null)}
      {!isImage && (
        <>
          <button
            type="button"
            disabled={!canSplit}
            onClick={act(props.onFreezeFrame)}
            className={itemClass}
            title={canSplit ? "Hold the frame at the playhead for 2 seconds" : "Move the playhead inside this clip to freeze a frame there"}
          >
            <IoPauseCircleOutline size={14} /> Freeze frame at playhead
          </button>
          <button type="button" onClick={act(props.onToggleReverse)} className={itemClass} title="Play this clip backwards, picture and sound">
            <IoPlayBackOutline size={14} />
            <span className="flex-1">Reverse</span>
            {clip.reversedFrom && <IoCheckmark size={12} className="text-teal-400" />}
          </button>
        </>
      )}
      {submenuItem("move", <IoMoveOutline size={14} />, "Move", null, clipCount < 2)}
      <div className="my-1 border-t border-white/10" />
      {submenuItem("transition", <IoSwapHorizontalOutline size={14} />, "Transition in", index === 0 ? null : transitionLabel, index === 0)}
      {submenuItem("motion", <IoScanOutline size={14} />, "Motion", motionLabel)}
      {submenuItem("color", <IoColorPaletteOutline size={14} />, "Color", colorLabel)}
      {isImage && submenuItem("length", <IoTimeOutline size={14} />, "Length", `${lengthSec.toFixed(1)}s`)}
      <button type="button" onClick={act(props.onToggleMirror)} className={itemClass}>
        <MdFlip size={14} />
        <span className="flex-1">Mirror</span>
        {clip.flipHorizontal && <IoCheckmark size={12} className="text-teal-400" />}
      </button>
      <button type="button" onClick={act(props.onOpenEffects)} className={itemClass}>
        <IoSparklesOutline size={14} /> All effects…
      </button>
      <div className="my-1 border-t border-white/10" />
      <button type="button" onClick={act(props.onReveal)} className={itemClass}>
        <IoFolderOpenOutline size={14} /> Show source in folder
      </button>
      <button type="button" disabled={!canDelete} onClick={act(props.onDelete)} className={`${itemClass} text-red-300`}>
        <IoTrashOutline size={14} /> {many ? `Delete ${selectionCount} clips` : "Delete clip"}
      </button>

      {openSubmenu && (
        <div
          ref={submenuRef}
          role="menu"
          onMouseEnter={keepSub}
          onMouseLeave={scheduleCloseSub}
          style={{ position: "absolute", top: submenuTop + submenuOffset, [flyLeft ? "right" : "left"]: "100%" }}
          className={`w-[180px] max-h-[60vh] overflow-y-auto py-1 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-xl ring-1 ring-white/10 ${flyLeft ? "mr-1" : "ml-1"}`}
        >
          {renderSubmenu()}
        </div>
      )}
    </div>,
    document.body
  );
};

export default ClipContextMenu;
