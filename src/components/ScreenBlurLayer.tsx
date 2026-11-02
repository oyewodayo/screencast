// ScreenBlurLayer.tsx
//
// Draw-mode handles for the privacy blur regions (the blur itself is native - see
// services/screen_blur.rs - and sits just under the overlay, so what you see inside each box is
// the real thing, live). With the Blur tool active: drag on empty space to blur an area, drag a
// region to move it, drag a corner to resize, x to remove. With any other tool the regions are just
// faint outlines you can draw over. Auto-blurred regions (e.g. WhatsApp's chat list) are placed by
// their rule, so they can only be hidden, not moved.
//
// During a drag nothing crosses to Rust per pointermove: the native side follows the cursor by
// itself (see useScreenBlur), and this only moves the outline.
import { useRef } from 'react';
import { IoClose, IoEyeOff, IoLink, IoSparkles } from 'react-icons/io5';
import type { BlurCorner, BlurGestureMode, BlurRect, BlurRegion } from '../hooks/useScreenBlur';

interface ScreenBlurLayerProps {
  regions: BlurRegion[];
  interactive: boolean;
  onBegin: (id: string, mode: BlurGestureMode, rect: BlurRect, pointer: [number, number]) => void;
  onTrack: (id: string, rect: BlurRect) => void;
  onEnd: (id: string, rect: BlurRect, isNew: boolean) => void;
  onRemove: (id: string) => void;
}

type Gesture =
  | { mode: 'new'; id: string; x0: number; y0: number; rect: BlurRect }
  | { mode: 'move'; id: string; x0: number; y0: number; orig: BlurRect; rect: BlurRect }
  | { mode: 'resize'; id: string; corner: BlurCorner; orig: BlurRect; rect: BlurRect };

// Any two corners -> a rect with positive size.
const fromPoints = (ax: number, ay: number, bx: number, by: number): BlurRect => ({
  x: Math.min(ax, bx),
  y: Math.min(ay, by),
  width: Math.abs(bx - ax),
  height: Math.abs(by - ay),
});

const CORNER_CURSOR: Record<BlurCorner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

const ScreenBlurLayer: React.FC<ScreenBlurLayerProps> = ({ regions, interactive, onBegin, onTrack, onEnd, onRemove }) => {
  const gestureRef = useRef<Gesture | null>(null);

  const begin = (e: React.PointerEvent, g: Gesture): void => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = g;
    const mode: BlurGestureMode = g.mode === 'resize' ? { mode: 'resize', corner: g.corner } : { mode: g.mode };
    onBegin(g.id, mode, g.rect, [e.clientX, e.clientY]);
  };

  const handleMove = (e: React.PointerEvent): void => {
    const g = gestureRef.current;
    if (!g) return;
    // A corner handle's events would otherwise bubble into its box and run this twice.
    e.stopPropagation();
    if (g.mode === 'new') {
      g.rect = fromPoints(g.x0, g.y0, e.clientX, e.clientY);
    } else if (g.mode === 'move') {
      g.rect = { ...g.orig, x: g.orig.x + e.clientX - g.x0, y: g.orig.y + e.clientY - g.y0 };
    } else {
      // The opposite corner stays put; dragging past it flips the box rather than inverting it.
      const o = g.orig;
      const fixedX = g.corner === 'nw' || g.corner === 'sw' ? o.x + o.width : o.x;
      const fixedY = g.corner === 'nw' || g.corner === 'ne' ? o.y + o.height : o.y;
      g.rect = fromPoints(fixedX, fixedY, e.clientX, e.clientY);
    }
    onTrack(g.id, g.rect);
  };

  const handleUp = (): void => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (g) onEnd(g.id, g.rect, g.mode === 'new');
  };

  return (
    <div className="absolute inset-0" style={{ pointerEvents: interactive ? 'auto' : 'none' }}>
      {/* Empty space: start a new region. */}
      {interactive && (
        <div
          className="absolute inset-0"
          style={{ cursor: 'crosshair' }}
          onPointerDown={(e) => {
            const id = `blur-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            begin(e, { mode: 'new', id, x0: e.clientX, y0: e.clientY, rect: { x: e.clientX, y: e.clientY, width: 0, height: 0 } });
          }}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
        />
      )}

      {regions.map((r) => {
        const editable = interactive && !r.auto;
        return (
          <div
            key={r.id}
            className="absolute rounded-md"
            style={{
              left: r.rect.x,
              top: r.rect.y,
              width: r.rect.width,
              height: r.rect.height,
              // Light line + dark halo: readable on any background the blur happens to sit on.
              border: `1.5px ${interactive ? 'solid' : 'dashed'} rgba(255,255,255,${interactive ? 0.9 : 0.45})`,
              boxShadow: interactive ? '0 0 0 1px rgba(0,0,0,0.35), 0 6px 24px rgba(0,0,0,0.25)' : 'none',
              cursor: editable ? 'move' : undefined,
              pointerEvents: interactive ? 'auto' : 'none',
            }}
            onPointerDown={
              editable
                ? (e) => begin(e, { mode: 'move', id: r.id, x0: e.clientX, y0: e.clientY, orig: r.rect, rect: r.rect })
                : (e) => e.stopPropagation()
            }
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerCancel={handleUp}
          >
            {interactive && r.rect.width >= 12 && r.rect.height >= 12 && (
              <>
                <div className="absolute -top-7 left-0 flex items-center gap-1 px-1.5 h-5 rounded-md bg-neutral-900/90 text-[10px] font-medium text-white/85 whitespace-nowrap select-none ring-1 ring-white/10">
                  {r.auto ? <IoSparkles size={11} /> : r.anchored ? <IoLink size={11} /> : <IoEyeOff size={11} />}
                  {r.auto ? `Auto · ${r.label ?? 'blur'}` : r.anchored ? 'Follows its window' : 'Pinned to screen'}
                </div>
                <button
                  className="absolute -top-7 right-0 w-5 h-5 flex items-center justify-center rounded-md bg-neutral-900/90 text-white/80 hover:text-white hover:bg-red-500 ring-1 ring-white/10"
                  aria-label={r.auto ? 'Unblur until this window closes' : 'Remove blur'}
                  data-tip={r.auto ? 'Unblur until this window closes' : 'Remove blur'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(r.id)}
                >
                  <IoClose size={13} />
                </button>
                {editable &&
                  (['nw', 'ne', 'sw', 'se'] as BlurCorner[]).map((c) => (
                    <div
                      key={c}
                      className="absolute w-3 h-3 rounded-[3px] bg-white ring-1 ring-black/40 shadow"
                      style={{
                        left: c === 'nw' || c === 'sw' ? -6 : undefined,
                        right: c === 'ne' || c === 'se' ? -6 : undefined,
                        top: c === 'nw' || c === 'ne' ? -6 : undefined,
                        bottom: c === 'sw' || c === 'se' ? -6 : undefined,
                        cursor: CORNER_CURSOR[c],
                      }}
                      onPointerDown={(e) => begin(e, { mode: 'resize', id: r.id, corner: c, orig: r.rect, rect: r.rect })}
                      onPointerMove={handleMove}
                      onPointerUp={handleUp}
                      onPointerCancel={handleUp}
                    />
                  ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default ScreenBlurLayer;
