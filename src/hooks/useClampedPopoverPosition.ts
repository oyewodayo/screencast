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

// Measures the popover's actual rendered size after each layout and nudges left/top back within
// [margin, viewport - margin]. Converges within one extra layout pass - once corrected, re-
// measuring finds the box already fits, so this never loops.
export function useClampedPopoverPosition(anchor: PopoverAnchor, margin = 8) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverAnchor>(anchor);

  // Resets to the caller's raw anchor whenever it changes (a new trigger was clicked) - the
  // measure-and-correct pass below then runs against this fresh starting point.
  useLayoutEffect(() => {
    setPosition(anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = position.left;
    let top = position.top;
    if (rect.right > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - rect.width - margin);
    if (rect.left < margin) left = margin;
    if (rect.bottom > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - rect.height - margin);
    if (rect.top < margin) top = margin;
    if (left !== position.left || top !== position.top) setPosition({ left, top });
  });

  return { ref, position };
}
