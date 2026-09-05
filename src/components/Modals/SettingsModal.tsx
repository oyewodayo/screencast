// components/Modals/SettingsModal.tsx
import React, { useEffect, useState } from "react";
import { IoClose, IoSettingsOutline, IoSunny, IoMoon, IoContrast, IoRefresh } from "react-icons/io5";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../utils/appSettings";
import { ThemePreference, useTheme } from "../../contexts/ThemeContext";

interface SettingsModalProps {
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  // Fired after the Briefcast storage folder has actually moved (see the Storage section below) -
  // Dashboard.tsx owns the file list and whichever file is currently open, neither of which this
  // modal has access to, so it can't refresh/invalidate those itself.
  onStorageChanged: () => void;
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

const HOME_BACKGROUND_OPTIONS: { value: AppSettings["homeBackgroundStyle"]; label: string }[] = [
  { value: "graph", label: "Graph-like" },
  { value: "plain", label: "Plain" },
];

type SectionKey = "appearance" | "recording" | "storage" | "annotation" | "files" | "pdf" | "help";
const SECTION_NAV: { key: SectionKey; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "recording", label: "Recording" },
  { key: "storage", label: "Storage" },
  { key: "annotation", label: "Annotation" },
  { key: "files", label: "Files" },
  { key: "pdf", label: "PDF Annotator" },
  { key: "help", label: "Help & Shortcuts" },
];

// One row of the keyboard-shortcuts reference in the Help section below - keys as shown here are
// always the Windows/Linux form ("Ctrl+..."); the section adds a single blanket note about Cmd on
// macOS rather than repeating it per row (matches how Tauri's own global shortcuts are registered:
// "CommandOrControl+..." resolves to Ctrl or Cmd depending on the OS automatically).
const ShortcutRow: React.FC<{ keys: string; description: string }> = ({ keys, description }) => (
  <div className="flex items-center justify-between gap-4">
    <span className="text-sm text-neutral-700 dark:text-neutral-300">{description}</span>
    <kbd className="shrink-0 px-2 py-1 rounded-md text-xs font-mono bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300">
      {keys}
    </kbd>
  </div>
);

const BulletList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="list-disc pl-4 space-y-1.5 text-sm text-neutral-700 dark:text-neutral-300 marker:text-neutral-300 dark:marker:text-neutral-600">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

// Both the picked-folder path (change location) and the OS default path (reset) already come from
// Rust as a real, OS-native path string - joining "Briefcast" onto it for the confirm preview
// re-uses whichever separator that string already uses instead of hardcoding one, so the preview
// doesn't show a mismatched slash direction on Windows.
const joinDisplayPath = (parent: string, child: string): string => `${parent}${parent.includes("\\") ? "\\" : "/"}${child}`;

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, onSave, onStorageChanged }) => {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<SectionKey>("appearance");

  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [pendingParentDir, setPendingParentDir] = useState<string | null>(null); // picked, awaiting confirm
  const [pendingIsReset, setPendingIsReset] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  // Audio/video device lists for the "Default audio device"/"Default video device(s)" pickers
  // below - the same devices RecordingDocker itself lists, fetched the same way (BottomDocker.tsx
  // does an identical pair of invokes for its own copies of these pickers).
  const [connectedAudioDevices, setConnectedAudioDevices] = useState<string[] | null>(null);
  const [connectedCameraDevices, setConnectedCameraDevices] = useState<string[] | null>(null);

  // WASAPI loopback ("system audio") is Windows-only - see BottomDocker.tsx's identical check
  // for why the equivalent checkbox in the recording panel is gated the same way. Without this,
  // the default here could be turned on for a macOS/Linux install and never do anything.
  const [isSystemAudioSupported, setIsSystemAudioSupported] = useState(true);
  useEffect(() => {
    invoke<string>('get_platform')
      .then((platform) => setIsSystemAudioSupported(platform === 'windows'))
      .catch((err) => console.error('Failed to detect platform:', err));
  }, []);

  const loadDevices = (): void => {
    invoke<string[]>("get_connected_audios").then(setConnectedAudioDevices).catch(console.error);
    invoke<string[]>("get_connected_cameras").then(setConnectedCameraDevices).catch(console.error);
  };

  useEffect(() => {
    (async () => {
      try {
        const [cur, def] = await Promise.all([invoke<string>("get_briefcast_dir"), invoke<string>("get_default_briefcast_dir")]);
        setCurrentDir(cur);
        setDefaultDir(def);
      } catch (err) {
        console.error("Failed to load the current storage location:", err);
      }
    })();
    loadDevices();
  }, []);

  const toggleDefaultVideoDevice = (device: string): void => {
    setSettings((prev) => ({
      ...prev,
      defaultVideoDevices: prev.defaultVideoDevices.includes(device)
        ? prev.defaultVideoDevices.filter((d) => d !== device)
        : [...prev.defaultVideoDevices, device],
    }));
  };

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

  const handlePickLocation = async (): Promise<void> => {
    setStorageError(null);
    try {
      const selected = await openFileDialog({ directory: true, multiple: false, title: "Choose a new location for your Briefcast folder" });
      if (!selected || Array.isArray(selected)) return; // cancelled
      setPendingIsReset(false);
      setPendingParentDir(selected);
    } catch (err) {
      console.error("Failed to open folder picker:", err);
    }
  };

  const handleArmReset = (): void => {
    setStorageError(null);
    setPendingParentDir(null);
    setPendingIsReset(true);
  };

  const handleCancelStorageChange = (): void => {
    setPendingParentDir(null);
    setPendingIsReset(false);
    setStorageError(null);
  };

  // Both branches end up calling the same Rust-side "move everything from the current root to a
  // new one" logic (see set_briefcast_dir/reset_briefcast_dir in services/utility.rs) - this just
  // picks which command and which resulting path to expect back.
  const handleConfirmStorageChange = async (): Promise<void> => {
    if (!pendingIsReset && pendingParentDir == null) return;
    setStorageBusy(true);
    setStorageError(null);
    try {
      const newDir = pendingIsReset
        ? await invoke<string>("reset_briefcast_dir")
        : await invoke<string>("set_briefcast_dir", { newParentDir: pendingParentDir });
      setCurrentDir(newDir);
      setPendingParentDir(null);
      setPendingIsReset(false);
      onStorageChanged();
    } catch (err) {
      setStorageError(String(err));
    } finally {
      setStorageBusy(false);
    }
  };

  const hasPendingStorageChange = pendingParentDir != null || pendingIsReset;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (storageBusy) return; // a move is in flight - don't let the modal get yanked away mid-move
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[760px] h-[560px] max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 shrink-0">
          <div className="flex items-center gap-2">
            <IoSettingsOutline className="text-neutral-500 dark:text-neutral-400" size={18} />
            <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">Settings</h2>
          </div>
          <button
            type="button"
            title="Close"
            disabled={storageBusy}
            onClick={onClose}
            className="p-1 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 disabled:opacity-40"
          >
            <IoClose size={18} />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-44 shrink-0 border-r border-neutral-100 dark:border-neutral-800 overflow-y-auto py-3 px-2 flex flex-col gap-0.5">
            {SECTION_NAV.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveSection(s.key)}
                className={`text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeSection === s.key
                    ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                    : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {activeSection === "appearance" && (
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

                <div>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1.5">Home screen background</p>
                  <div className="flex items-center gap-1.5 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800">
                    {HOME_BACKGROUND_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => update("homeBackgroundStyle", opt.value)}
                        className={`flex-1 px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          settings.homeBackgroundStyle === opt.value
                            ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-50 shadow-sm"
                            : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {activeSection === "recording" && (
              <Section title="Recording defaults">
                <Field label="Show recording panel in bottom bar">
                  <input
                    type="checkbox"
                    checked={settings.showRecordingDocker}
                    onChange={(e) => update("showRecordingDocker", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  When off, the fields below still apply as defaults, but the panel itself is hidden - use the
                  screen/webcam/mic shortcut icons at the bottom-right of the app to start a recording instead.
                </p>

                <Field label="Show recording panel buttons">
                  <input
                    type="checkbox"
                    checked={settings.showRecordingPanelButtons}
                    onChange={(e) => update("showRecordingPanelButtons", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  The screenshot/screen-webcam-mic/record-button cluster itself, distinct from the panel above.
                  Press Ctrl+Shift+B (Cmd+Shift+B on Mac) any time to hide or show it instantly - handy right
                  before presenting or recording a screen that includes this window, so it doesn't end up in
                  the video.
                </p>

                <Field label="Recording type">
                  <select className={fieldInputClass} value={settings.defaultRecordType} onChange={(e) => handleRecordTypeChange(e.target.value)}>
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
                <Field label="Audio device">
                  <select
                    className={fieldInputClass}
                    value={settings.defaultAudioDevice}
                    onChange={(e) => update("defaultAudioDevice", e.target.value)}
                  >
                    <option value="">First detected device</option>
                    {connectedAudioDevices?.map((device) => (
                      <option key={device} value={device}>
                        {device}
                      </option>
                    ))}
                  </select>
                </Field>
                {(settings.defaultRecordType === "sva" || settings.defaultRecordType === "sa" || settings.defaultRecordType === "s") && (
                  <Field label="Include system audio">
                    <input
                      type="checkbox"
                      checked={settings.defaultIncludeSystemAudio && isSystemAudioSupported}
                      disabled={!isSystemAudioSupported}
                      title={isSystemAudioSupported ? undefined : "System audio capture is Windows-only for now - not available on this platform."}
                      onChange={(e) => update("defaultIncludeSystemAudio", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    />
                  </Field>
                )}
                {(settings.defaultRecordType === "sva" || settings.defaultRecordType === "sa" || settings.defaultRecordType === "s") && !isSystemAudioSupported && (
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                    System audio capture (WASAPI loopback) isn't available on this platform yet.
                  </p>
                )}
                <div className="flex items-start justify-between gap-4">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300 pt-1.5">Video device(s)</span>
                  <div className="flex items-center gap-1.5">
                    <div className="p-2 rounded-lg text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700 max-h-28 overflow-y-auto min-w-[200px]">
                      {connectedCameraDevices && connectedCameraDevices.length > 0 ? (
                        connectedCameraDevices.map((device) => (
                          <label key={device} className="flex items-center gap-2 py-0.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={settings.defaultVideoDevices.includes(device)}
                              onChange={() => toggleDefaultVideoDevice(device)}
                            />
                            <span className="truncate">{device}</span>
                          </label>
                        ))
                      ) : (
                        <span className="text-neutral-500">No video cameras detected</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={loadDevices}
                      title="Refresh device list"
                      className="p-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    >
                      <IoRefresh />
                    </button>
                  </div>
                </div>
              </Section>
            )}

            {activeSection === "storage" && (
              <Section title="Storage location">
                <div className="text-sm text-neutral-700 dark:text-neutral-300">Briefcast files are stored at:</div>
                <div
                  className="text-xs font-mono px-2.5 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 truncate"
                  title={currentDir ?? undefined}
                >
                  {currentDir ?? "Loading…"}
                </div>

                {hasPendingStorageChange ? (
                  <div className="flex flex-col gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 ring-1 ring-amber-200 dark:ring-amber-500/20">
                    <p className="text-xs text-neutral-700 dark:text-neutral-300">
                      Move all files and folders to{" "}
                      <span className="font-mono break-all">
                        {pendingIsReset ? defaultDir : pendingParentDir != null ? joinDisplayPath(pendingParentDir, "Briefcast") : ""}
                      </span>
                      ?
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={storageBusy}
                        onClick={() => void handleConfirmStorageChange()}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {storageBusy ? "Moving…" : "Move"}
                      </button>
                      <button
                        type="button"
                        disabled={storageBusy}
                        onClick={handleCancelStorageChange}
                        className="px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void handlePickLocation()}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                    >
                      Change Location…
                    </button>
                    {defaultDir != null && currentDir !== null && currentDir !== defaultDir && (
                      <button type="button" onClick={handleArmReset} className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300">
                        Reset to default location
                      </button>
                    )}
                  </div>
                )}

                {storageError && <p className="text-xs text-red-500">{storageError}</p>}
                <p className="text-xs text-neutral-400 dark:text-neutral-500">
                  Choosing a new location moves every existing file and folder there — nothing is duplicated or left behind.
                </p>
              </Section>
            )}

            {activeSection === "annotation" && (
              <Section title="Presentation annotation">
                <Field label="Enable annotation tool">
                  <input
                    type="checkbox"
                    checked={settings.enableAnnotationTool}
                    onChange={(e) => update("enableAnnotationTool", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  While enabled, press Ctrl+Shift+D (Cmd+Shift+D on Mac) anywhere to draw on screen — circle or underline
                  anything to emphasize it. Strokes fade out on their own after a few seconds.
                </p>
              </Section>
            )}

            {activeSection === "files" && (
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
                    <span className="text-sm text-neutral-500 dark:text-neutral-400">{settings.trashRetentionDays <= 0 ? "never" : "days"}</span>
                  </div>
                </Field>
              </Section>
            )}

            {activeSection === "pdf" && (
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
            )}

            {activeSection === "help" && (
              <>
                <Section title="Keyboard shortcuts">
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1 mb-1">
                    Shown in their Windows/Linux form - use Cmd instead of Ctrl on macOS. Each one works from
                    anywhere, not just while Briefcast is the focused window.
                  </p>
                  <ShortcutRow keys="Ctrl+Shift+R" description="Start or stop recording, using your current recording settings" />
                  <ShortcutRow keys="Ctrl+Shift+H" description="Show/hide the floating recording overlay (while recording)" />
                  <ShortcutRow keys="Ctrl+Shift+B" description="Show/hide the recording panel buttons - handy right before presenting" />
                  <ShortcutRow keys="Ctrl+Shift+D" description="Toggle the annotation tool's draw mode (see Annotation settings)" />
                </Section>

                <Section title="File selection">
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1 mb-1">
                    Unlike the shortcuts above, these only work while Briefcast is the focused window. The
                    Ctrl/Shift-click gestures are specific to the image gallery grid (Image tab &gt; a folder); the
                    sidebar's own file list selects via its checkboxes instead.
                  </p>
                  <ShortcutRow keys="Ctrl/Cmd+Click" description="Add or remove one photo from the current selection, in the image gallery" />
                  <ShortcutRow keys="Shift+Click" description="Select every photo between your last click and this one, in the image gallery" />
                  <ShortcutRow keys="Esc" description="Clear the current file selection - sidebar or image gallery" />
                </Section>

                <Section title="Recording & screenshots">
                  <BulletList items={[
                    <>Record screen, webcam, and mic in any combination - Screen+Video+Audio, Screen+Audio, Video+Audio, Screen only, Video only, or Audio only.</>,
                    <>Pause and resume a recording without losing your place - paused time is never included in the finished video.</>,
                    <>Take a Full Screen, Monitor, or Window screenshot from the same target picker recording uses.</>,
                    <>Overlay one or more webcams onto a screen recording - choose their shape, corner position, and size.</>,
                    <>Capture system audio ("what you hear") alongside your mic (Windows only).</>,
                  ]} />
                </Section>

                <Section title="File library">
                  <BulletList items={[
                    <>The sidebar lists every file by type (video/audio/image/PDF/document) - drag and drop to import from outside Briefcast.</>,
                    <>Deleted files go to Trash first, not straight to permanent deletion - restore them or empty Trash from Settings &gt; Files, which also auto-purges anything older than your configured retention period.</>,
                    <>Convert one file or many at once: video to MP4/MOV/MKV/AVI/WebM, audio to MP3/WAV/AAC/FLAC/OGG/M4A, images to PNG/JPEG/WebP/BMP - with an option to keep the original.</>,
                  ]} />
                </Section>

                <Section title="Editing a recording">
                  <BulletList items={[
                    <>Trim, split, and reorder clips on a timeline.</>,
                    <>Add text, image, and blur overlays, plus extra audio tracks.</>,
                    <>Apply color-filter presets, Ken Burns pan/zoom, and transitions between clips.</>,
                  ]} />
                </Section>

                <Section title="Docs">
                  <BulletList items={[
                    <>A rich-text note editor - headings, text/highlight color, alignment, tables, and inline images.</>,
                    <>Import Word (.docx) files; export to Word, Markdown, plain text, or print/save as PDF.</>,
                    <>Link a note to a specific recording in your library.</>,
                  ]} />
                </Section>

                <Section title="Board">
                  <BulletList items={[
                    <>Arrange several images into one composed layout, then export it as a new flattened image.</>,
                    <>Style each image's border, padding, corner rounding, and background independently.</>,
                    <>Boards are saved projects - reopen and keep editing one any time.</>,
                  ]} />
                </Section>

                <Section title="PDF annotator">
                  <BulletList items={[
                    <>Pen, highlighter, text notes, and eraser, with adjustable color and stroke width.</>,
                    <>Zoom, page thumbnails, table of contents, single/two-page view, and a fullscreen presentation mode.</>,
                    <>Export a flattened, standalone annotated PDF.</>,
                  ]} />
                </Section>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 shrink-0">
          <button
            type="button"
            disabled={storageBusy}
            onClick={handleResetDefaults}
            className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 disabled:opacity-40"
          >
            Reset to defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={storageBusy}
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={storageBusy}
              onClick={handleSave}
              className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
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
