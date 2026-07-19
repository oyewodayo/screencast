// components/Modals/SettingsModal.tsx
import React, { useState } from "react";
import { IoClose, IoSettingsOutline, IoSunny, IoMoon, IoContrast } from "react-icons/io5";
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../utils/appSettings";
import { ThemePreference, useTheme } from "../../contexts/ThemeContext";

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
    <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 mb-3">{title}</h3>
    <div className="flex flex-col gap-3">{children}</div>
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="flex items-center justify-between gap-4">
    <span className="text-sm text-neutral-700 dark:text-neutral-300">{label}</span>
    {children}
  </label>
);

const fieldInputClass =
  "text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 px-2.5 py-1.5 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  { value: "light", label: "Light", icon: <IoSunny size={15} /> },
  { value: "dark", label: "Dark", icon: <IoMoon size={15} /> },
  { value: "system", label: "System", icon: <IoContrast size={15} /> },
];

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const { theme, setTheme } = useTheme();

  const recordCategory = RECORD_TYPE_OPTIONS.find((o) => o.value === settings.defaultRecordType)?.category ?? "video";

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // Theme applies (and persists) immediately, like every other system theme toggle — it doesn't
  // wait for the Save button. Also mirrored into local `settings` so a subsequent Save of the
  // other fields doesn't clobber it back to whatever it was when this modal opened.
  const handleThemeChange = (value: ThemePreference): void => {
    setTheme(value);
    update("theme", value);
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
    setTheme(DEFAULT_SETTINGS.theme);
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[440px] max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 sticky top-0 bg-white dark:bg-neutral-900 rounded-t-2xl">
          <div className="flex items-center gap-2">
            <IoSettingsOutline className="text-neutral-500 dark:text-neutral-400" size={18} />
            <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Settings</h2>
          </div>
          <button type="button" title="Close" onClick={onClose} className="p-1 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">
            <IoClose size={18} />
          </button>
        </div>

        <div className="px-5 py-5">
          <Section title="Appearance">
            <div className="flex items-center gap-1.5 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleThemeChange(opt.value)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    theme === opt.value
                      ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-50 shadow-sm"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  }`}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </Section>

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

          <Section title="Files">
            <Field label="Auto-delete trash after">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={365}
                  className={`${fieldInputClass} w-16 text-right`}
                  value={settings.trashRetentionDays}
                  onChange={(e) => update("trashRetentionDays", Math.max(0, Number(e.target.value) || 0))}
                />
                <span className="text-sm text-neutral-500 dark:text-neutral-400">
                  {settings.trashRetentionDays <= 0 ? "never" : "days"}
                </span>
              </div>
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
                <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-10 text-right">{Math.round(settings.pdfDefaultZoom * 100)}%</span>
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
                <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-6 text-right">{settings.pdfDefaultStrokeWidth}</span>
              </div>
            </Field>
          </Section>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-neutral-100 dark:border-neutral-800">
          <button type="button" onClick={handleResetDefaults} className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300">
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
