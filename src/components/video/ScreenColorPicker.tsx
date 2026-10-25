// components/video/ScreenColorPicker.tsx
//
// The eyedropper for the overlay panels' colours: pickScreenColor() turns the pointer into a
// crosshair over the whole window, with a loupe beside it showing the pixels around it magnified
// and the exact one it will pick in the middle, live as the video plays. Click picks it, Escape
// or a right-click cancels. The pixels are read from the screen itself (sample_screen_at_cursor,
// screen_color.rs) - what you see, overlays and all - since WebView2 has no working browser
// eyedropper.
//
// The overlay counts as part of the text panel (TEXT_EDIT_PANEL_ATTR) and never takes focus, so
// picking a colour doesn't end the text edit it's for.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { TEXT_EDIT_PANEL_ATTR } from "./VideoTextEditor";

const RADIUS = 5; // an 11 x 11 sample
const CELL = 11; // loupe px per sampled pixel
const LOUPE = (RADIUS * 2 + 1) * CELL;
const OFFSET = 22; // loupe's distance from the pointer - well clear of the pixels it samples

interface Sample {
  size: number;
  rgb: number[];
}

const hexAt = (s: Sample, i: number) => `#${[s.rgb[i * 3], s.rgb[i * 3 + 1], s.rgb[i * 3 + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const PickerOverlay: React.FC<{ onDone: (color: string | null) => void }> = ({ onDone }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [center, setCenter] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const centerRef = useRef<string | null>(null);

  // Sample continuously (one request in flight at a time) - the picture under a still pointer
  // keeps changing while the video plays.
  useEffect(() => {
    let alive = true;
    const loop = async () => {
      while (alive) {
        try {
          const s = await invoke<Sample>("sample_screen_at_cursor", { radius: RADIUS });
          if (!alive) return;
          const mid = Math.floor((s.size * s.size) / 2);
          const hex = hexAt(s, mid);
          centerRef.current = hex;
          setCenter(hex);
          const ctx = canvasRef.current?.getContext("2d");
          if (ctx) {
            ctx.imageSmoothingEnabled = false;
            for (let i = 0; i < s.size * s.size; i++) {
              ctx.fillStyle = hexAt(s, i);
              ctx.fillRect((i % s.size) * CELL, Math.floor(i / s.size) * CELL, CELL, CELL);
            }
            // A faint pixel grid, then the picked pixel ringed - dark and light, legible on anything.
            ctx.strokeStyle = "rgba(0,0,0,0.12)";
            ctx.lineWidth = 1;
            for (let k = 1; k < s.size; k++) {
              ctx.beginPath();
              ctx.moveTo(k * CELL + 0.5, 0);
              ctx.lineTo(k * CELL + 0.5, LOUPE);
              ctx.moveTo(0, k * CELL + 0.5);
              ctx.lineTo(LOUPE, k * CELL + 0.5);
              ctx.stroke();
            }
            const c = RADIUS * CELL;
            ctx.strokeStyle = "#000000";
            ctx.strokeRect(c - 0.5, c - 0.5, CELL + 1, CELL + 1);
            ctx.strokeStyle = "#ffffff";
            ctx.strokeRect(c + 0.5, c + 0.5, CELL - 1, CELL - 1);
          }
        } catch (e) {
          if (alive) setFailed(String(e));
          return;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    void loop();
    // Escape cancels - caught before anything else (the text box would take it as "cancel edit").
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onDone(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onDone]);

  // The loupe sits below-right of the pointer, flipping to the other side near the window's edge.
  const place = (p: { x: number; y: number }) => {
    const w = LOUPE + 4;
    const h = LOUPE + 30;
    const left = p.x + OFFSET + w > window.innerWidth ? p.x - OFFSET - w : p.x + OFFSET;
    const top = p.y + OFFSET + h > window.innerHeight ? p.y - OFFSET - h : p.y + OFFSET;
    return { left, top };
  };

  return (
    <div
      {...{ [TEXT_EDIT_PANEL_ATTR]: "" }}
      className="fixed inset-0"
      style={{ zIndex: 2147483000, cursor: "crosshair" }}
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={(e) => setPointer({ x: e.clientX, y: e.clientY })}
      // Picks on the click itself (after the button's released) and closes after it, so no half of
      // the click lands on whatever is underneath - the video, another overlay.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        onDone(centerRef.current);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onDone(null);
      }}
    >
      <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-neutral-900/90 text-[11px] text-white/85 shadow-lg ring-1 ring-white/10 pointer-events-none select-none">
        {failed ? `Can't read the screen: ${failed}` : "Click to pick a colour · Esc to cancel"}
      </div>
      {pointer && !failed && (
        <div className="absolute pointer-events-none flex flex-col items-center gap-1.5" style={place(pointer)}>
          <canvas ref={canvasRef} width={LOUPE} height={LOUPE} className="rounded-full shadow-xl ring-2 ring-white" style={{ width: LOUPE, height: LOUPE }} />
          {center && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-neutral-900/90 text-[11px] font-mono uppercase text-white shadow ring-1 ring-white/10">
              <span className="w-2.5 h-2.5 rounded-sm ring-1 ring-white/30" style={{ background: center }} />
              {center}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

let active: Promise<string | null> | null = null;

// Resolves with the picked colour ("#rrggbb"), or null when cancelled. One picker at a time.
export function pickScreenColor(): Promise<string | null> {
  if (active) return active;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  active = new Promise<string | null>((resolve) => {
    const done = (color: string | null) => {
      resolve(color);
      // After this event finishes - unmounting mid-handler would drop the click on the floor.
      setTimeout(() => {
        root.unmount();
        host.remove();
        active = null;
      });
    };
    root.render(<PickerOverlay onDone={done} />);
  });
  return active;
}
