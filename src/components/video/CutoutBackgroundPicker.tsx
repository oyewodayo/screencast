// components/video/CutoutBackgroundPicker.tsx
//
// "What's behind you" for a cut-out person (cutoutBackground.ts): four tiles that look like what
// they do - see-through, blurred, a colour, a picture - and, under the chosen one, its one or two
// controls. Every choice shows straight away in the preview; nothing has to be processed again.
import React from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { IoImageOutline } from "react-icons/io5";
import { BACKGROUND_SWATCHES, BLUR_DEFAULT, type CutoutBackground } from "../../utils/cutoutBackground";
import { IMAGE_CLIP_EXTENSIONS } from "../../utils/videoEditTypes";

interface Props {
  value: CutoutBackground | undefined;
  onChange: (bg: CutoutBackground | undefined) => void;
  // A bubble baked into a recording has nothing to see through to - "None" isn't offered.
  allowNone: boolean;
}

const CHECKER = "repeating-conic-gradient(#3f3f46 0% 25%, #27272a 0% 50%) 50% / 10px 10px";

const Tile: React.FC<{ active: boolean; label: string; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, label, title, onClick, children }) => (
  <button type="button" title={title} onClick={onClick} className="flex flex-col items-center gap-1 group">
    <span
      className={`relative w-12 h-9 rounded-md overflow-hidden transition-all ${
        active ? "ring-2 ring-emerald-400 ring-offset-1 ring-offset-neutral-900" : "ring-1 ring-white/15 group-hover:ring-white/40"
      }`}
    >
      {children}
      {/* The person, so each tile reads as "you, in front of this". */}
      <span className="absolute left-1/2 bottom-0 -translate-x-1/2 w-4 h-5 pointer-events-none">
        <span className="absolute left-1/2 top-0 -translate-x-1/2 w-2 h-2 rounded-full bg-neutral-200/90" />
        <span className="absolute left-0 bottom-0 w-4 h-2.5 rounded-t-full bg-neutral-200/90" />
      </span>
    </span>
    <span className={`text-[10px] ${active ? "text-emerald-300" : "text-white/60"}`}>{label}</span>
  </button>
);

const CutoutBackgroundPicker: React.FC<Props> = ({ value, onChange, allowNone }) => {
  const kind = value?.kind ?? "none";
  const color = value?.kind === "color" ? value.color : BACKGROUND_SWATCHES[0];
  const pickPicture = async () => {
    const selected = await openFileDialog({ multiple: false, filters: [{ name: "Pictures", extensions: IMAGE_CLIP_EXTENSIONS.filter((e) => !["heic", "heif"].includes(e)) }] });
    if (typeof selected === "string") onChange({ kind: "image", path: selected });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-1">
        {allowNone && (
          <Tile active={kind === "none"} label="None" title="See-through - whatever's under the layer shows" onClick={() => onChange(undefined)}>
            <span className="absolute inset-0" style={{ background: CHECKER }} />
          </Tile>
        )}
        <Tile active={kind === "blur"} label="Blur" title="Your own background, softly blurred" onClick={() => onChange({ kind: "blur", amount: value?.kind === "blur" ? value.amount : BLUR_DEFAULT })}>
          <span className="absolute inset-0 bg-gradient-to-br from-amber-200 via-sky-400 to-indigo-600 blur-[3px] scale-125" />
        </Tile>
        <Tile active={kind === "color"} label="Colour" title="A solid colour" onClick={() => onChange({ kind: "color", color })}>
          <span className="absolute inset-0" style={{ background: color }} />
        </Tile>
        <Tile active={kind === "image"} label="Picture" title="A picture of your own" onClick={() => (value?.kind === "image" ? undefined : void pickPicture())}>
          {value?.kind === "image" ? (
            <img src={convertFileSrc(value.path)} alt="" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <span className="absolute inset-0 flex items-start justify-center pt-1 bg-neutral-700 text-white/60">
              <IoImageOutline size={12} />
            </span>
          )}
        </Tile>
      </div>

      {value?.kind === "blur" && (
        <label className="flex items-center gap-2 text-[11px]">
          <span className="w-10 shrink-0 text-white/60">Amount</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.01}
            value={value.amount}
            onChange={(e) => onChange({ kind: "blur", amount: Number(e.target.value) })}
            className="flex-1 min-w-0 accent-emerald-400"
          />
          <span className="w-8 shrink-0 text-right tabular-nums text-white/60">{Math.round(value.amount * 100)}%</span>
        </label>
      )}

      {value?.kind === "color" && (
        <div className="flex flex-wrap items-center gap-1.5">
          {BACKGROUND_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => onChange({ kind: "color", color: c })}
              className={`w-5 h-5 rounded-full ring-offset-1 ring-offset-neutral-900 ${value.color.toLowerCase() === c ? "ring-2 ring-emerald-400" : "ring-1 ring-white/20 hover:ring-white/50"}`}
              style={{ background: c }}
            />
          ))}
          <label title="Any colour" className="relative w-5 h-5 rounded-full overflow-hidden ring-1 ring-white/20 hover:ring-white/50 cursor-pointer" style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}>
            <input type="color" value={value.color} onChange={(e) => onChange({ kind: "color", color: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </div>
      )}

      {value?.kind === "image" && (
        <button type="button" onClick={() => void pickPicture()} className="self-start px-2 py-1 rounded text-[11px] text-white/80 bg-white/5 hover:bg-white/10">
          Choose another picture…
        </button>
      )}
    </div>
  );
};

export default CutoutBackgroundPicker;
