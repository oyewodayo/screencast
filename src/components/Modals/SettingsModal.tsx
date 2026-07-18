// components/Modals/SettingsModal.tsx
import React, { useState } from "react";
import { IoClose, IoSettingsOutline } from "react-icons/io5";
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../utils/appSettings";

interface SettingsModalProps {
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

const RECORD_TYPE_OPTIONS: { value: string; label: string; category: "video" | "audio" | "image" }[] = [
  { value: "sva", label: "Screen record (Screen + Video + Audio)", category: "video" },
  { value: "sa", label: "Screen record (Screen + Audio)", category: "video" },
  { value: "va", label: "Screen record (Video and Audio)", category: "video" },
  { value: "s", label: "Screen record (Screen only)", category: "video" },
  { value: "c", label: "Screenshot", category: "image" },
  { value: "v", label: "Video", category: "video" },
  { value: "a", label: "Audio", category: "audio" },
];

const EXT_OPTIONS: Record<"video" | "audio" | "image", string[]> = {
  video: ["avi", "mkv", "webm", "mov", "mp4"],
  audio: ["mp3", "wav", "aac", "wma"],
  image: ["png", "jpeg", "webp"],
};

const PDF_TOOL_OPTIONS: { value: AppSettings["pdfDefaultTool"]; label: string }[] = [
  { value: "none", label: "None (Select)" },
  { value: "pen", label: "Pen" },
  { value: "highlighter", label: "Highlighter" },
  { value: "eraser", label: "Eraser" },
];

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="mb-6 last:mb-0">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400 mb-3">{title}</h3>
    <div className="flex flex-col gap-3">{children}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="flex items-center justify-between gap-4">
    <span className="text-sm text-neutral-700">{label}</span>
    {children}
  </label>
);

const fieldInputClass =
  "text-sm rounded-lg border border-neutral-200 px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent";

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const recordCategory = RECORD_TYPE_OPTIONS.find((o) => o.value === settings.defaultRecordType)?.category ?? "video";

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleRecordTypeChange = (value: string): void => {
    const newCategory = RECORD_TYPE_OPTIONS.find((o) => o.value === value)?.category ?? "video";
    const validExts = EXT_OPTIONS[newCategory];
    setSettings((prev) => ({
      ...prev,
      defaultRecordType: value,
      defaultFileExt: validExts.includes(prev.defaultFileExt) ? prev.defaultFileExt : validExts[0],
    }));
  };

  const handleSave = (): void => {
    saveSettings(settings);
    onSave(settings);
    onClose();
  };

  const handleResetDefaults = (): void => {
    setSettings({ ...DEFAULT_SETTINGS });
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 sticky top-0 bg-white rounded-t-2xl">
          <div className="flex items-center gap-2">
            <IoSettingsOutline className="text-neutral-500" size={18} />
            <h2 className="text-sm font-semibold text-neutral-800">Settings</h2>
          </div>
          <button type="button" title="Close" onClick={onClose} className="p-1 rounded-full hover:bg-neutral-100 text-neutral-400 hover:text-neutral-700">
            <IoClose size={18} />
          </button>
        </div>

        <div className="px-5 py-5">
          <Section title="Recording defaults">
            <Field label="Recording type">
              <select
                className={fieldInputClass}
                value={settings.defaultRecordType}
                onChange={(e) => handleRecordTypeChange(e.target.value)}
              >
                {RECORD_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="File format">
              <select className={fieldInputClass} value={settings.defaultFileExt} onChange={(e) => update("defaultFileExt", e.target.value)}>
                {EXT_OPTIONS[recordCategory].map((ext) => (
                  <option key={ext} value={ext}>
                    {ext.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="File name prefix">
              <input
                type="text"
                className={`${fieldInputClass} w-36`}
                value={settings.defaultFileNamePrefix}
                onChange={(e) => update("defaultFileNamePrefix", e.target.value)}
                placeholder="Recording"
              />
            </Field>
          </Section>

          <Section title="PDF annotator defaults">
            <Field label="Starting tool">
              <select
                className={fieldInputClass}
                value={settings.pdfDefaultTool}
                onChange={(e) => update("pdfDefaultTool", e.target.value as AppSettings["pdfDefaultTool"])}
              >
                {PDF_TOOL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default zoom">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={15}
                  max={300}
                  step={5}
                  value={Math.round(settings.pdfDefaultZoom * 100)}
                  onChange={(e) => update("pdfDefaultZoom", Number(e.target.value) / 100)}
                  className="w-28 accent-blue-500"
                />
                <span className="text-xs text-neutral-500 tabular-nums w-10 text-right">{Math.round(settings.pdfDefaultZoom * 100)}%</span>
              </div>
            </Field>
            <Field label="Pen color">
              <input
                type="color"
                value={settings.pdfDefaultPenColor}
                onChange={(e) => update("pdfDefaultPenColor", e.target.value)}
                className="w-7 h-7 p-0 border-0 rounded-full cursor-pointer bg-transparent"
              />
            </Field>
            <Field label="Highlighter color">
              <input
                type="color"
                value={settings.pdfDefaultHighlighterColor}
                onChange={(e) => update("pdfDefaultHighlighterColor", e.target.value)}
                className="w-7 h-7 p-0 border-0 rounded-full cursor-pointer bg-transparent"
              />
            </Field>
            <Field label="Default stroke width">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={settings.pdfDefaultStrokeWidth}
                  onChange={(e) => update("pdfDefaultStrokeWidth", Number(e.target.value))}
                  className="w-28 accent-blue-500"
                />
                <span className="text-xs text-neutral-500 tabular-nums w-6 text-right">{settings.pdfDefaultStrokeWidth}</span>
              </div>
            </Field>
          </Section>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-neutral-100">
          <button type="button" onClick={handleResetDefaults} className="text-xs text-neutral-400 hover:text-neutral-600">
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-sm text-neutral-600 hover:bg-neutral-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
