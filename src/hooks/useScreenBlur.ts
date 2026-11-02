// hooks/useScreenBlur.ts
//
// The annotation overlay's side of the privacy blur (services/screen_blur.rs owns the actual blur
// windows). Rust is the source of truth for where each region is - a region attached to an app
// window moves when that window does, and auto-blur rules add their own - and reports every change
// as a `screen-blur-changed` event.
//
// A drag is two calls, not one per pointermove: `begin` hands the gesture to the native side, which
// then follows the cursor itself at vsync, and `end` settles the final rect. In between, the outline
// here tracks the pointer locally (an override) - both follow the same physical cursor, so they move
// together with no IPC in the loop.
//
// Commands still go through one queue, so a quick drag's `end` can never overtake its `begin`
// (Tauri runs async commands concurrently).
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface BlurRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlurRegion {
  id: string;
  rect: BlurRect;
  visible: boolean;
  anchored: boolean;
  // Placed by an auto-blur rule (label names it) - not movable; removing hides it for that window.
  auto: boolean;
  label: string | null;
}

export type BlurCorner = 'nw' | 'ne' | 'sw' | 'se';
export type BlurGestureMode = { mode: 'new' } | { mode: 'move' } | { mode: 'resize'; corner: BlurCorner };

type BlurOp =
  | { kind: 'begin'; id: string; mode: BlurGestureMode; rect: BlurRect; pointer: [number, number] }
  | { kind: 'end'; id: string; rect: BlurRect }
  | { kind: 'remove'; id: string }
  | { kind: 'clear' };

// Rects make a round trip through physical pixels, so "the same" can differ by a rounding step.
const near = (a: BlurRect, b: BlurRect): boolean =>
  Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5 && Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5;

// Below this a "region" is a stray click, not a deliberate blur.
const MIN_SIZE = 12;

export default function useScreenBlur(active: boolean) {
  const [regions, setRegions] = useState<BlurRegion[]>([]);
  const [overrides, setOverrides] = useState<Record<string, BlurRect>>({});
  // Overrides whose gesture has ended - dropped once Rust reports the region where we put it.
  const settlingRef = useRef(new Set<string>());
  const queueRef = useRef<{ busy: boolean; ops: BlurOp[] }>({ busy: false, ops: [] });

  const pump = useCallback(async () => {
    const q = queueRef.current;
    if (q.busy) return;
    q.busy = true;
    while (q.ops.length > 0) {
      const op = q.ops.shift()!;
      try {
        if (op.kind === 'begin') await invoke('screen_blur_gesture_begin', { id: op.id, mode: op.mode, rect: op.rect, pointer: op.pointer });
        else if (op.kind === 'end') await invoke('screen_blur_gesture_end', { id: op.id, rect: op.rect });
        else if (op.kind === 'remove') await invoke('screen_blur_remove', { id: op.id });
        else await invoke('screen_blur_clear');
      } catch (err) {
        console.error('Screen blur:', err);
      }
    }
    q.busy = false;
  }, []);

  const enqueue = useCallback(
    (op: BlurOp) => {
      queueRef.current.ops.push(op);
      void pump();
    },
    [pump]
  );

  const applyRegions = useCallback((next: BlurRegion[]) => {
    setRegions(next);
    if (settlingRef.current.size === 0) return;
    setOverrides((prev) => {
      let changed = false;
      const out = { ...prev };
      for (const id of [...settlingRef.current]) {
        const reg = next.find((r) => r.id === id);
        if (!reg || !out[id] || near(reg.rect, out[id])) {
          delete out[id];
          settlingRef.current.delete(id);
          changed = true;
        }
      }
      return changed ? out : prev;
    });
  }, []);

  // Fresh positions each time draw mode opens (regions may have moved with their windows while the
  // overlay was hidden), then live updates.
  useEffect(() => {
    const unlisten = listen<BlurRegion[]>('screen-blur-changed', (e) => applyRegions(e.payload));
    if (active) {
      invoke<BlurRegion[]>('screen_blur_list').then(applyRegions, (err) => console.error('Screen blur:', err));
    }
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [active, applyRegions]);

  const begin = useCallback(
    (id: string, mode: BlurGestureMode, rect: BlurRect, pointer: [number, number]) => {
      settlingRef.current.delete(id);
      setOverrides((prev) => ({ ...prev, [id]: rect }));
      enqueue({ kind: 'begin', id, mode, rect, pointer });
    },
    [enqueue]
  );

  // Mid-gesture: the outline only. The real blur is already following the cursor natively.
  const track = useCallback((id: string, rect: BlurRect) => {
    setOverrides((prev) => ({ ...prev, [id]: rect }));
  }, []);

  const end = useCallback(
    (id: string, rect: BlurRect, isNew: boolean) => {
      enqueue({ kind: 'end', id, rect });
      if (isNew && (rect.width < MIN_SIZE || rect.height < MIN_SIZE)) {
        setOverrides(({ [id]: _drop, ...rest }) => rest);
        enqueue({ kind: 'remove', id });
        return;
      }
      settlingRef.current.add(id);
    },
    [enqueue]
  );

  const remove = useCallback(
    (id: string) => {
      settlingRef.current.delete(id);
      setOverrides(({ [id]: _drop, ...rest }) => rest);
      setRegions((prev) => prev.filter((r) => r.id !== id));
      enqueue({ kind: 'remove', id });
    },
    [enqueue]
  );

  const clear = useCallback(() => {
    settlingRef.current.clear();
    setOverrides({});
    setRegions([]);
    enqueue({ kind: 'clear' });
  }, [enqueue]);

  // What to draw: every region on screen (with its in-flight override), plus regions still being
  // drawn that Rust hasn't reported yet.
  const shown: BlurRegion[] = regions
    .filter((r) => r.visible)
    .map((r) => (overrides[r.id] ? { ...r, rect: overrides[r.id] } : r));
  for (const [id, rect] of Object.entries(overrides)) {
    if (!regions.some((r) => r.id === id)) shown.push({ id, rect, visible: true, anchored: false, auto: false, label: null });
  }

  return { regions: shown, count: regions.length, begin, track, end, remove, clear };
}
