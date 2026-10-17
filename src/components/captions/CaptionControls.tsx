// components/captions/CaptionControls.tsx
//
// The caption UI shared by both sidebar caption panels - the video editor's burned-in captions
// (docker/CaptionsPanel.tsx) and the player's viewing captions (video/PlayerSidePanels.tsx):
// style/emphasis/position/text controls, the live-following caption list (with copy and .txt
// download), and the "transcript only" view that hides everything but that list.
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { IoCheckmark, IoCopyOutline, IoDownloadOutline, IoListOutline } from "react-icons/io5";
import Slider from "../docker/Slider";
import NumberStepper from "../docker/NumberStepper";
import { CaptionPosition, CaptionSettings } from "../../utils/videoEditTypes";
import { CAPTION_PRESETS, CAPTION_PRESET_ORDER, CaptionLine, captionBoxStyle, captionWordStyle } from "../../utils/captions";

const EMPHASIS_SWATCHES = ["#d07cff", "#facc15", "#4ade80", "#38bdf8", "#f87171", "#ffffff", "#111827"];
const POSITIONS: { value: CaptionPosition; label: string }[] = [
  { value: "top", label: "Top" },
  { value: "middle", label: "Middle" },
  { value: "bottom", label: "Bottom" },
];

export const formatCaptionTime = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="text-[10px] uppercase tracking-wide text-white/40">{children}</span>
);

export const Toggle: React.FC<{ on: boolean; onChange: (next: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    title={label}
    onClick={() => onChange(!on)}
    className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors ${on ? "bg-blue-500" : "bg-white/20"}`}
  >
    <span className={`absolute top-0.5 left-0.5 w-[14px] h-[14px] rounded-full bg-white transition-transform ${on ? "translate-x-[14px]" : ""}`} />
  </button>
);

// ---------- transcript-only view ----------

const TRANSCRIPT_ONLY_KEY = "briefcast.captions.transcriptOnly";

// Remembered per viewer (not per video) - someone who reads along in transcript-only mode wants it
// that way next time too. Storage can be unavailable; the toggle then just doesn't persist.
export function useTranscriptOnly(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TRANSCRIPT_ONLY_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(TRANSCRIPT_ONLY_KEY, next ? "1" : "0");
    } catch {
      /* not persisted */
    }
  };
  return [value, set];
}

export const TranscriptOnlyButton: React.FC<{ on: boolean; onChange: (next: boolean) => void }> = ({ on, onChange }) => (
  <button
    type="button"
    title={on ? "Show all caption settings" : "Show only the captions list"}
    aria-pressed={on}
    onClick={() => onChange(!on)}
    className={`shrink-0 p-1 rounded transition-colors ${on ? "bg-blue-500/20 text-blue-300" : "text-white/60 hover:text-white hover:bg-white/10"}`}
  >
    <IoListOutline size={14} />
  </button>
);

// ---------- style controls ----------

// The style tiles' sample line; with word emphasis on, the highlight steps along it the way it
// follows speech in the video.
const SAMPLE_WORDS = ["This", "is", "styled"];
const SAMPLE_WORD_MS = 420;

export const CaptionStyleControls: React.FC<{
  settings: CaptionSettings;
  onUpdate: (patch: Partial<CaptionSettings>) => void;
}> = ({ settings, onUpdate }) => {
  const [spoken, setSpoken] = useState(0);
  useEffect(() => {
    if (!settings.emphasis) return;
    const timer = window.setInterval(() => setSpoken((i) => (i + 1) % SAMPLE_WORDS.length), SAMPLE_WORD_MS);
    return () => window.clearInterval(timer);
  }, [settings.emphasis]);
  return (
  <>
    <div className={`flex flex-col gap-1.5 ${settings.enabled ? "" : "opacity-50"}`}>
      <SectionLabel>Style</SectionLabel>
      <div className="grid grid-cols-2 gap-1.5">
        {CAPTION_PRESET_ORDER.map((key) => {
          const def = CAPTION_PRESETS[key];
          const selected = settings.preset === key;
          const thumbSettings: CaptionSettings = { ...settings, preset: key, emphasisColor: selected ? settings.emphasisColor : def.emphasisColor };
          return (
            <button
              key={key}
              type="button"
              title={def.label}
              onClick={() => onUpdate({ preset: key, emphasisColor: def.emphasisColor, uppercase: def.uppercase })}
              className={`h-11 flex items-center justify-center rounded-md bg-neutral-700/60 overflow-hidden transition-shadow ${
                selected ? "ring-2 ring-blue-400" : "ring-1 ring-white/10 hover:ring-white/30"
              }`}
            >
              <span style={captionBoxStyle(def, 12)}>
                {SAMPLE_WORDS.map((word, i) => (
                  <React.Fragment key={word}>
                    {i > 0 && " "}
                    <span style={captionWordStyle(def, thumbSettings, settings.emphasis ? i === spoken : i === 0, 12)}>{def.uppercase ? word.toUpperCase() : word}</span>
                  </React.Fragment>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>

    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <SectionLabel>Word emphasis</SectionLabel>
        <Toggle on={settings.emphasis} onChange={(emphasis) => onUpdate({ emphasis })} label="Highlight the word being spoken" />
      </div>
      {settings.emphasis && (
        <div className="flex items-center gap-1.5">
          {EMPHASIS_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => onUpdate({ emphasisColor: c })}
              className={`w-5 h-5 rounded-full ring-offset-1 ring-offset-neutral-900 ${
                settings.emphasisColor.toLowerCase() === c ? "ring-2 ring-blue-400" : "ring-1 ring-white/20"
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
          <label title="Custom colour" className="relative w-5 h-5 rounded-full ring-1 ring-white/20 overflow-hidden cursor-pointer bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
            <input type="color" value={settings.emphasisColor} onChange={(e) => onUpdate({ emphasisColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </div>
      )}
    </div>

    <div className="flex flex-col gap-1.5">
      <SectionLabel>Position</SectionLabel>
      <div className="flex rounded-md bg-white/5 p-0.5">
        {POSITIONS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onUpdate({ position: p.value })}
            className={`flex-1 py-1 rounded text-[11px] transition-colors ${
              settings.position === p.value ? "bg-blue-500/20 text-blue-300 ring-1 ring-blue-400/40" : "text-white/60 hover:text-white"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {settings.position !== "middle" && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-14 shrink-0 text-white/60">From edge</span>
          <Slider value={settings.offset * 100} min={0} max={40} step={1} onChange={(v) => onUpdate({ offset: v / 100 })} />
          <NumberStepper value={settings.offset * 100} min={0} max={40} step={1} decimals={0} suffix="%" onChange={(v) => onUpdate({ offset: v / 100 })} />
        </div>
      )}
    </div>

    <div className="flex flex-col gap-1.5">
      <SectionLabel>Text</SectionLabel>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-14 shrink-0 text-white/60">Size</span>
        <Slider value={settings.size * 100} min={50} max={200} step={5} marks={[100]} onChange={(v) => onUpdate({ size: v / 100 })} />
        <NumberStepper value={settings.size * 100} min={50} max={200} step={5} decimals={0} suffix="%" onChange={(v) => onUpdate({ size: v / 100 })} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-white/60">Words per line</span>
        <NumberStepper value={settings.maxWordsPerLine} min={1} max={14} step={1} decimals={0} suffix="" onChange={(v) => onUpdate({ maxWordsPerLine: v })} />
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-white/60">ALL CAPS</span>
        <Toggle on={settings.uppercase} onChange={(uppercase) => onUpdate({ uppercase })} label="All caps" />
      </div>
    </div>
  </>
  );
};

// ---------- caption list ----------

const LineRow: React.FC<{
  line: CaptionLine;
  active: boolean;
  onSeek: () => void;
  onCommit?: (text: string) => void;
}> = ({ line, active, onSeek, onCommit }) => {
  const original = line.words.map((w) => w.text).join(" ");
  const [value, setValue] = useState(original);
  useEffect(() => setValue(original), [original]);
  return (
    <div className={`flex items-start gap-2 px-1.5 py-1 rounded ${active ? "bg-blue-500/25 ring-1 ring-blue-400/40" : "hover:bg-white/5"}`}>
      <button
        type="button"
        onClick={onSeek}
        title="Jump to this line"
        className={`shrink-0 mt-[3px] text-[10px] tabular-nums ${active ? "text-blue-300" : "text-white/40 hover:text-white/80"}`}
      >
        {formatCaptionTime(line.start)}
      </button>
      {onCommit ? (
        <textarea
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => value.trim() !== original && onCommit(value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep Space/Delete/arrows from reaching the timeline's shortcuts
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            } else if (e.key === "Escape") {
              setValue(original);
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
          className="flex-1 min-w-0 resize-none bg-transparent text-[11px] leading-snug text-white/85 outline-none rounded px-1 focus:bg-white/10 [field-sizing:content]"
        />
      ) : (
        // Read-only (the player's viewing captions): the whole row seeks.
        <button type="button" onClick={onSeek} className={`flex-1 min-w-0 text-left text-[11px] leading-snug px-1 ${active ? "text-white" : "text-white/80"}`}>
          {original}
        </button>
      )}
    </div>
  );
};

// The caption lines with timestamps, following playback (the active line kept in view a third of
// the way down; holds off while a line is being edited and for a few seconds after the user
// scrolls the list themselves). Copy / Download hand out one caption line per row as plain text.
export const CaptionTranscript: React.FC<{
  title: string;
  lines: CaptionLine[];
  currentTime: number;
  onSeek: (line: CaptionLine) => void;
  // Editable rows when set (the editor's burned-in captions); read-only otherwise.
  onEdit?: (line: CaptionLine, text: string) => void;
  // Default file name (without extension) for the .txt download.
  exportBaseName: string;
  tall?: boolean;
  onError: (message: string) => void;
}> = ({ title, lines, currentTime, onSeek, onEdit, exportBaseName, tall, onError }) => {
  const listRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);
  const activeIndex = lines.findIndex((l) => currentTime >= l.start && currentTime < l.end);
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    if (list.contains(document.activeElement)) return;
    if (Date.now() - lastUserScrollRef.current < 3000) return;
    const row = list.children[activeIndex] as HTMLElement | undefined;
    if (!row) return;
    const top = row.offsetTop;
    if (top >= list.scrollTop && top + row.offsetHeight <= list.scrollTop + list.clientHeight) return;
    list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3), behavior: "smooth" });
  }, [activeIndex]);

  const [done, setDone] = useState<"copied" | "saved" | null>(null);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 1800);
    return () => clearTimeout(t);
  }, [done]);

  const text = () => lines.map((line) => line.words.map((w) => w.text).join(" ")).join("\n") + "\n";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setDone("copied");
    } catch (err) {
      onError(`Couldn't copy captions: ${err}`);
    }
  };
  const download = async () => {
    const outputPath = await saveFileDialog({ defaultPath: `${exportBaseName} captions.txt`, filters: [{ name: "Text", extensions: ["txt"] }] }).catch(() => null);
    if (!outputPath) return; // cancelled
    try {
      // Docs' plain-text export command - writes `content` to exactly the chosen path.
      await invoke<string>("export_doc", { docTitle: `${exportBaseName} captions`, extension: "txt", content: text(), outputPath });
      setDone("saved");
    } catch (err) {
      onError(`Couldn't save captions: ${err}`);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>
          {title} ({lines.length})
        </SectionLabel>
        <div className="flex items-center gap-0.5">
          <button type="button" title={done === "copied" ? "Copied" : "Copy captions to clipboard"} onClick={() => void copy()} className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10">
            {done === "copied" ? <IoCheckmark size={13} className="text-green-400" /> : <IoCopyOutline size={13} />}
          </button>
          <button type="button" title={done === "saved" ? "Saved" : "Download captions as a text file"} onClick={() => void download()} className="p-1 rounded text-white/60 hover:text-white hover:bg-white/10">
            {done === "saved" ? <IoCheckmark size={13} className="text-green-400" /> : <IoDownloadOutline size={13} />}
          </button>
        </div>
      </div>
      <div
        ref={listRef}
        onWheel={() => (lastUserScrollRef.current = Date.now())}
        onPointerDown={() => (lastUserScrollRef.current = Date.now())}
        className={`relative overflow-y-auto overscroll-contain -mx-1.5 flex flex-col ${tall ? "max-h-[calc(100vh-260px)]" : "max-h-72"}`}
      >
        {lines.map((line, index) => (
          <LineRow
            key={line.id}
            line={line}
            active={index === activeIndex}
            onSeek={() => onSeek(line)}
            onCommit={onEdit ? (t) => onEdit(line, t) : undefined}
          />
        ))}
      </div>
    </div>
  );
};
