// hooks/useClampedPopoverPosition.ts
//
// Clamps a fixed-position popover's anchor so it never renders partly (or entirely) off-screen.
// Callers compute an initial anchor from a trigger's own getBoundingClientRect() (e.g. "just below
// this chip"), but that only accounts for where the trigger sits, not how tall/wide the popover's
// own content turns out to be once it actually renders - a popover anchored below a chip that sits
// close to the window's own bottom edge (the audio-overlay timeline lane, in practice) can overflow
// past the bottom with nothing to pull it back, showing only its first row and clipping the rest.
import { useLayoutEffect, useRef, useState } from "react";

export interface PopoverAnchor {
  left: number;
  top: number;
}

// Measures the popover's actual rendered size and nudges left/top back within
// [margin, viewport - margin]. A single effect keyed on the anchor itself (rather than two
// separate effects - one resetting to the raw anchor, one clamping against whatever `position`
// happened to already be) - splitting those into two effects raced: both fire in the same commit
// whenever the anchor changes, but the clamp effect closed over `position` from *before* the
// reset effect's update took effect, so it measured the popover at its stale prior location (often
// the very first mount default) and its own setState - called second, so it always won the
// same-flush batch - clobbered the reset with a clamp computed from the wrong box entirely. In
// practice this snapped every freshly-opened popover to the (margin, margin) corner instead of its
// trigger, exactly when the previous position happened to be out of bounds (e.g. still at its
// {0,0} mount default the first time a popover in a given instance is ever opened). Measuring
// directly off the anchor here, in one pass, removes the stale read entirely.
export function useClampedPopoverPosition(anchor: PopoverAnchor, margin = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverAnchor>(anchor);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setPosition(anchor);
      return;
    }
    // Places the element at the raw anchor first so getBoundingClientRect() below reflects the
    // popover's real size *there*, not wherever it was left over from a previous open - a plain
    // state update wouldn't be visible until the next render/paint, too late for this same pass.
    el.style.left = `${anchor.left}px`;
    el.style.top = `${anchor.top}px`;
    const rect = el.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.top;
    if (rect.right > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (left < margin) left = margin;
    if (rect.bottom > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin);
    if (top < margin) top = margin;
    setPosition({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, margin]);

  return { ref, position };
}
