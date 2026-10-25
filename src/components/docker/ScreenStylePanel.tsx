// components/docker/ScreenStylePanel.tsx
//
// Screen-recording polish for the whole video - the Screen Studio look:
//  - Frame: the edited picture on a wallpaper (gradient, colour or picture) with padding, rounded
//    corners and a shadow (screenStyle.ts).
//  - Pointer: for recordings made with "Editable pointer" on, the pointer the editor draws -
//    size, smoothing, click ripples, hide when idle (pointerTrack.ts).
//  - Shortcut keys: chips for the keyboard shortcuts recorded with "Record shortcuts" (keystrokes.ts).
// Docked into the sidebar's Tools tab when it's open, floating otherwise (ToolPanelHost.tsx).
import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoClose, IoImageOutline } from "react-icons/io5";
import { MdOutlineWallpaper } from "react-icons/md";
import { useClampedPopoverPosition } from "../../hooks/useClampedPopoverPosition";
import { DOCKED_PANEL_CLASS, useDockSnap, useFloatingDismiss, useToolPanelHost } from "./ToolPanelHost";
import Slider from "./Slider";
import { DEFAULT_SCREEN_STYLE, SCREEN_COLOR_SWATCHES, SCREEN_GRADIENTS, paintGradient, type ScreenBackground, type ScreenStyle } from "../../utils/screenStyle";
import type { PointerStyle } from "../../utils/pointerTrack";
import type { KeystrokeStyle } from "../../utils/keystrokes";
import { IMAGE_CLIP_EXTENSIONS } from "../../utils/videoEditTypes";

interface Props {
  anchor: { left: number; top: number };
  screenStyle: ScreenStyle | null;
  onScreenStyle: (style: ScreenStyle | null) => void;
  pointerStyle: PointerStyle;
  onPointerStyle: (patch: Partial<PointerStyle>) => void;
  keystrokeStyle: KeystrokeStyle;
  onKeystrokeStyle: (patch: Partial<KeystrokeStyle>) => void;
  // Whether any clip comes from a recording with an editable pointer / recorded shortcuts.
  hasPointer: boolean;
  shortcutCount: number;
  onClose: () => void;
}

const RIPPLE_COLORS = ["#3b82f6", "#f59e0b", "#ef4444", "#10b981", "#a855f7", "#ffffff"];

// A wallpaper tile: the gradient itself, painted by the export's own painter, with a window on it.
const GradientTile: React.FC<{ id: string; active: boolean; label: string; onClick: () => void }> = ({ id, active, label, onClick }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const spec = SCREEN_GRADIENTS.find((g) => g.id === id);
    if (!spec) return;
    paintGradient(ctx, spec, c.width, c.height);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "rgba(250,250,250,0.92)";
    ctx.beginPath();
    ctx.roundRect(c.width * 0.18, c.height * 0.2, c.width * 0.64, c.height * 0.6, 3);
    ctx.fill();
  }, [id]);
  return (
    <button type="button" title={label} onClick={onClick} className="flex flex-col items-center gap-0.5 group">
      <canvas
        ref={ref}
        width={64}
        height={40}
        className={`w-12 h-[30px] rounded-md transition-all ${active ? "ring-2 ring-emerald-400 ring-offset-1 ring-offset-neutral-900" : "ring-1 ring-white/15 group-hover:ring-white/40"}`}
      />
      <span className={`text-[10px] ${active ? "text-emerald-300" : "text-white/55"}`}>{label}</span>
    </button>
  );
};

const Row: React.FC<{ label: string; value: string; children: React.ReactNode }> = ({ label, value, children }) => (
  <div className="flex items-center gap-2 text-[11px]">
    <span className="w-16 shrink-0 text-white/60">{label}</span>
    {children}
    <span className="w-9 shrink-0 text-right tabular-nums text-white/60">{value}</span>
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
  <label className="flex items-start gap-2 text-[11px] cursor-pointer" title={hint}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-emerald-400" />
    <span className="text-white/80">{label}</span>
  </label>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
    <span className="text-[11px] font-medium uppercase tracking-wide text-white/45">{title}</span>
    {children}
  </div>
);

const ScreenStylePanel: React.FC<Props> = ({ anchor, screenStyle, onScreenStyle, pointerStyle, onPointerStyle, keystrokeStyle, onKeystrokeStyle, hasPointer, shortcutCount, onClose }) => {
  const { ref, position } = useClampedPopoverPosition(anchor);
  const dockHost = useToolPanelHost();
  useFloatingDismiss("[data-screen-style-panel]", onClose, !!dockHost);
  useDockSnap(ref, !!dockHost);
  const style = screenStyle ?? DEFAULT_SCREEN_STYLE;
  const set = (patch: Partial<ScreenStyle>) => onScreenStyle({ ...style, ...patch });
  const setBackground = (background: ScreenBackground) => set({ background });
  const bg = style.background;
  const pickPicture = async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Pictures", extensions: IMAGE_CLIP_EXTENSIONS.filter((e) => !["heic", "heif"].includes(e)) }] });
    if (typeof selected === "string") setBackground({ kind: "image", path: selected });
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return createPortal(
    <div
      ref={ref}
      data-screen-style-panel
      style={dockHost ? undefined : { position: "fixed", left: position.left, top: position.top, zIndex: 9999 }}
      className={
        dockHost
          ? `${DOCKED_PANEL_CLASS} p-3 gap-3`
          : "w-80 max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain p-3 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-white/90 flex flex-col gap-3"
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <MdOutlineWallpaper size={14} />
          Screen style
        </span>
        <button type="button" title="Close" onClick={onClose} className="shrink-0 p-0.5 rounded hover:bg-white/10 text-white/60 hover:text-white">
          <IoClose size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <Toggle checked={!!screenStyle} onChange={(on) => onScreenStyle(on ? style : null)} label="Frame the video on a background" />
        {screenStyle && (
          <>
            <div className="flex gap-1 text-[11px]">
              {(["gradient", "color", "image"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    if (kind === bg.kind) return;
                    if (kind === "gradient") setBackground({ kind, preset: SCREEN_GRADIENTS[0].id });
                    else if (kind === "color") setBackground({ kind, color: SCREEN_COLOR_SWATCHES[0] });
                    else void pickPicture();
                  }}
                  className={`px-2 py-0.5 rounded ${bg.kind === kind ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/5"}`}
                >
                  {kind === "gradient" ? "Wallpaper" : kind === "color" ? "Colour" : "Picture"}
                </button>
              ))}
            </div>
            {bg.kind === "gradient" && (
              <div className="grid grid-cols-4 gap-x-1 gap-y-1.5">
                {SCREEN_GRADIENTS.map((g) => (
                  <GradientTile key={g.id} id={g.id} label={g.label} active={bg.preset === g.id} onClick={() => setBackground({ kind: "gradient", preset: g.id })} />
                ))}
              </div>
            )}
            {bg.kind === "color" && (
              <div className="flex flex-wrap items-center gap-1.5">
                {SCREEN_COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => setBackground({ kind: "color", color: c })}
                    className={`w-5 h-5 rounded-full ring-offset-1 ring-offset-neutral-900 ${bg.color.toLowerCase() === c ? "ring-2 ring-emerald-400" : "ring-1 ring-white/20 hover:ring-white/50"}`}
                    style={{ background: c }}
                  />
                ))}
                <label title="Any colour" className="relative w-5 h-5 rounded-full overflow-hidden ring-1 ring-white/20 hover:ring-white/50 cursor-pointer" style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}>
                  <input type="color" value={bg.color} onChange={(e) => setBackground({ kind: "color", color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                </label>
              </div>
            )}
            {bg.kind === "image" && (
              <div className="flex items-center gap-2">
                <img src={convertFileSrc(bg.path)} alt="" className="w-12 h-8 rounded object-cover ring-1 ring-white/15" />
                <button type="button" onClick={() => void pickPicture()} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10">
                  <IoImageOutline size={12} />
                  Choose another picture…
                </button>
              </div>
            )}
            <Row label="Padding" value={pct(style.padding / 0.3)}>
              <Slider value={style.padding} min={0} max={0.3} step={0.005} marks={[DEFAULT_SCREEN_STYLE.padding]} onChange={(padding) => set({ padding })} />
            </Row>
            <Row label="Corners" value={pct(style.radius / 0.1)}>
              <Slider value={style.radius} min={0} max={0.1} step={0.002} marks={[DEFAULT_SCREEN_STYLE.radius]} onChange={(radius) => set({ radius })} />
            </Row>
            <Row label="Shadow" value={pct(style.shadow)}>
              <Slider value={style.shadow} min={0} max={1} step={0.02} onChange={(shadow) => set({ shadow })} />
            </Row>
            <p className="text-[10.5px] leading-snug text-white/45">The whole edit sits in the frame - text, pictures and blurs move with it. Captions and shortcut keys stay on the background.</p>
          </>
        )}
      </div>

      <Section title="Pointer">
        {hasPointer ? (
          <>
            <Toggle checked={pointerStyle.show} onChange={(show) => onPointerStyle({ show })} label="Show the pointer" hint="Recorded separately from the screen, so it's drawn here - off leaves it out of the video entirely." />
            {pointerStyle.show && (
              <>
                <Row label="Size" value={`${pointerStyle.size.toFixed(1)}×`}>
                  <Slider value={pointerStyle.size} min={0.5} max={3} step={0.1} marks={[1]} onChange={(size) => onPointerStyle({ size })} />
                </Row>
                <Row label="Smoothing" value={pct(pointerStyle.smoothing)}>
                  <Slider value={pointerStyle.smoothing} min={0} max={1} step={0.05} onChange={(smoothing) => onPointerStyle({ smoothing })} />
                </Row>
                <Toggle checked={pointerStyle.hideIdle} onChange={(hideIdle) => onPointerStyle({ hideIdle })} label="Hide when it stops moving" />
                <Toggle checked={pointerStyle.ripples} onChange={(ripples) => onPointerStyle({ ripples })} label="Ripple on every click" />
                {pointerStyle.ripples && (
                  <div className="flex items-center gap-1.5 pl-5">
                    {RIPPLE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        title={c}
                        onClick={() => onPointerStyle({ rippleColor: c })}
                        className={`w-4 h-4 rounded-full ring-offset-1 ring-offset-neutral-900 ${pointerStyle.rippleColor.toLowerCase() === c ? "ring-2 ring-emerald-400" : "ring-1 ring-white/20 hover:ring-white/50"}`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <p className="text-[10.5px] leading-snug text-white/45">
            This recording's pointer is part of the picture. Turn on <span className="text-white/70">Editable pointer</span> in Screen Options before recording to smooth it, resize it and show clicks here.
          </p>
        )}
      </Section>

      <Section title="Shortcut keys">
        {shortcutCount > 0 ? (
          <>
            <Toggle checked={keystrokeStyle.show} onChange={(show) => onKeystrokeStyle({ show })} label={`Show the ${shortcutCount} shortcut${shortcutCount === 1 ? "" : "s"} pressed`} />
            {keystrokeStyle.show && (
              <>
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="w-16 shrink-0 text-white/60">Position</span>
                  {(["bottom", "top"] as const).map((p) => (
                    <button key={p} type="button" onClick={() => onKeystrokeStyle({ position: p })} className={`px-2 py-0.5 rounded ${keystrokeStyle.position === p ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/5"}`}>
                      {p === "bottom" ? "Bottom" : "Top"}
                    </button>
                  ))}
                </div>
                <Row label="Size" value={`${keystrokeStyle.size.toFixed(1)}×`}>
                  <Slider value={keystrokeStyle.size} min={0.6} max={2} step={0.1} marks={[1]} onChange={(size) => onKeystrokeStyle({ size })} />
                </Row>
              </>
            )}
          </>
        ) : (
          <p className="text-[10.5px] leading-snug text-white/45">
            No shortcuts recorded. Turn on <span className="text-white/70">Record shortcuts</span> in Screen Options to show the keys you press (Ctrl + C, Alt + Tab…) - ordinary typing is never recorded.
          </p>
        )}
      </Section>
    </div>,
    dockHost ?? document.body
  );
};

export default ScreenStylePanel;
