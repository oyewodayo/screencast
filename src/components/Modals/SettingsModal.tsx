// components/Modals/SettingsModal.tsx
import React, { useEffect, useState } from "react";
import { IoClose, IoSettingsOutline, IoSunny, IoMoon, IoContrast, IoRefresh } from "react-icons/io5";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from "../../utils/appSettings";
import { ThemePreference, useTheme } from "../../contexts/ThemeContext";
import { formatFileSize } from "../../utils/Formater";
import { ANNOTATION_COLORS, ANNOTATION_FADES, ANNOTATION_POINTERS, ANNOTATION_STYLES, ANNOTATION_TAP_SOUNDS } from "../../utils/annotationStyles";
import { playTapSound } from "../../utils/annotationSound";
import { HandGraphic } from "../AnnotationPointer";
import AnnotationPreview from "./AnnotationPreview";
import ColorInput from "../common/ColorInput";

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

const PDF_PAGE_TURN_OPTIONS: { value: AppSettings["pdfPageTurn"]; label: string }[] = [
  { value: "flip", label: "Book flip" },
  { value: "instant", label: "Instant" },
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

// Pill-style single choice (annotation style/fade) - same look as a segmented control.
const Segmented = <T extends string>({ value, options, onChange, disabled }: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) => (
  <div className="flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800">
    {options.map((o) => (
      <button
        key={o.id}
        type="button"
        disabled={disabled}
        onClick={() => onChange(o.id)}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
          value === o.id
            ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-400 shadow-sm"
            : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100"
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

// Whether Windows has an OCR language for sensitive-text detection - it can't work without one.
const OcrStatus: React.FC = () => {
  const [language, setLanguage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    invoke<string | null>("screen_blur_ocr_language").then(setLanguage, () => setLanguage(null));
  }, []);
  if (language === undefined) return null;
  return language ? (
    <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">Reads text with Windows' built-in OCR ({language}) - nothing leaves this PC.</p>
  ) : (
    <p className="text-xs text-amber-600 dark:text-amber-400 text-right">
      Windows has no OCR language installed. Add one in Settings › Time &amp; language › Language (with "Optical character recognition").
    </p>
  );
};

// Mirrors services/telemetry.rs's TelemetrySettings. `available` is false in builds compiled
// without analytics/crash-report keys (dev and source builds), which send nothing regardless.
interface TelemetrySettings {
  enabled: boolean;
  available: boolean;
}

const PrivacySection: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TelemetrySettings | null>(null);

  useEffect(() => {
    invoke<TelemetrySettings>("get_telemetry_settings").then(setTelemetry).catch(console.error);
  }, []);

  const toggle = (enabled: boolean) => {
    setTelemetry((prev) => (prev ? { ...prev, enabled } : prev));
    invoke("set_telemetry_enabled", { enabled }).catch(console.error);
  };

  return (
    <Section title="Privacy">
      <Field label="Send anonymous usage statistics and crash reports">
        <input
          type="checkbox"
          checked={telemetry?.enabled ?? false}
          disabled={!telemetry}
          onChange={(e) => toggle(e.target.checked)}
          className="w-4 h-4 accent-blue-500 cursor-pointer"
        />
      </Field>
      <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
        Helps decide what to fix and build next. Sent: which features are used (e.g. "recording finished", with its length
        and type), crash details with your user folder removed from file paths, app version, OS, and a random ID for this
        install that isn't linked to you (deleted when you turn this off). Never sent: file names,
        file contents, recordings, documents, or anything you type. Turning this off takes effect immediately.
      </p>
      {telemetry && !telemetry.available && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">This build has no analytics configured, so nothing is sent either way.</p>
      )}
    </Section>
  );
};

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

type SectionKey = "appearance" | "recording" | "storage" | "cache" | "annotation" | "files" | "pdf" | "privacy" | "help";
const SECTION_NAV: { key: SectionKey; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "recording", label: "Recording" },
  { key: "storage", label: "Storage" },
  { key: "cache", label: "Cache" },
  { key: "annotation", label: "Annotation" },
  { key: "files", label: "Files" },
  { key: "pdf", label: "PDF Annotator" },
  { key: "privacy", label: "Privacy" },
  { key: "help", label: "Help & Shortcuts" },
];

// Mirrors the Rust side's CacheCategoryInfo (src-tauri/src/services/utility.rs) - one row per
// preview-cache namespace that currently has anything on disk.
interface CacheCategoryInfo {
  namespace: string;
  fileCount: number;
  totalBytes: number;
}

// Human-readable labels for the namespaces get_cache_info can report - see preview_cache_path's
// own doc comment (conversion.rs) for what actually writes into each one. An unrecognized
// namespace (a future cache this list hasn't been updated for) still renders fine via the
// fallback in the render code below, just without a friendly description.
const CACHE_CATEGORY_INFO: Record<string, { label: string; description: string }> = {
  // thumb_v1 predates EXIF-orientation support (see generate_plain_thumbnail) - still listed so
  // its leftovers can be cleared.
  thumb_v1: { label: "Image thumbnails (old)", description: "Earlier gallery-grid previews, before photo rotation was honored." },
  thumb_v2: { label: "Image thumbnails", description: "Gallery-grid preview images for photos." },
  image_clip_v1: { label: "Image clip previews", description: "Still-video previews of photos used as clips in the video editor." },
  video_canvas_v3: { label: "Video project canvases", description: "Blank frames video projects preview on." },
  video_thumb_v1: { label: "Video poster frames", description: "Gallery-grid preview frames for videos." },
  scrub_sprite_v1: { label: "Video scrub-bar previews", description: "Hover-preview thumbnails shown while dragging a video's timeline." },
  heic_v2: { label: "HEIC/HEIF photo previews", description: "Decoded previews for iPhone-style photos." },
  video: { label: "Playable-preview conversions", description: "Re-encoded copies of videos the built-in player can't decode natively (e.g. .avi)." },
};

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
  // "Start Briefcast when I sign in" lives with the OS (services/autostart.rs), not in the settings
  // file, so it's read from there and written back on Save. null until read.
  const [launchAtLogin, setLaunchAtLogin] = useState<boolean | null>(null);
  const [launchAtLoginSaved, setLaunchAtLoginSaved] = useState<boolean | null>(null);
  useEffect(() => {
    invoke<boolean>("get_launch_at_login")
      .then((enabled) => {
        setLaunchAtLogin(enabled);
        setLaunchAtLoginSaved(enabled);
      })
      .catch((err) => console.error("Couldn't read the sign-in setting:", err));
  }, []);

  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [pendingParentDir, setPendingParentDir] = useState<string | null>(null); // picked, awaiting confirm
  const [pendingIsReset, setPendingIsReset] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);

  // Generated-preview cache (Settings > Cache) - distinct from the Storage section above, which is
  // about the Briefcast library folder itself, not this disposable, auto-regenerating derived data.
  const [cacheInfo, setCacheInfo] = useState<CacheCategoryInfo[] | null>(null);
  const [cacheBusy, setCacheBusy] = useState<string | null>(null); // namespace being cleared, or "*" for all
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  // Audio/video device lists for the "Default audio device"/"Default video device(s)" pickers
  // below - the same devices RecordingDocker itself lists, fetched the same way (BottomDocker.tsx
  // does an identical pair of invokes for its own copies of these pickers).
  const [connectedAudioDevices, setConnectedAudioDevices] = useState<string[] | null>(null);
  const [connectedCameraDevices, setConnectedCameraDevices] = useState<string[] | null>(null);

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
    if (launchAtLogin !== null && launchAtLogin !== launchAtLoginSaved) {
      invoke("set_launch_at_login", { enabled: launchAtLogin }).catch((err) => console.error("Couldn't change the sign-in setting:", err));
    }
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

  const loadCacheInfo = async (): Promise<void> => {
    try {
      setCacheInfo(await invoke<CacheCategoryInfo[]>("get_cache_info"));
    } catch (err) {
      console.error("Failed to load cache info:", err);
    }
  };

  useEffect(() => {
    void loadCacheInfo();
  }, []);

  // Shared by both the per-category "Clear" buttons and "Clear all" - `namespace` omitted clears
  // everything. No confirmation step for a single category (small, scoped, and - like all of this
  // cache - regenerates automatically the next time it's needed); "Clear all" still gets one via
  // confirmClearAll below since it's the one action here with real (if still fully recoverable)
  // blast radius.
  const handleClearCache = async (namespace?: string): Promise<void> => {
    setCacheBusy(namespace ?? "*");
    setCacheError(null);
    try {
      await invoke("clear_preview_cache", { namespace: namespace ?? null });
      await loadCacheInfo();
      setConfirmClearAll(false);
    } catch (err) {
      setCacheError(String(err));
    } finally {
      setCacheBusy(null);
    }
  };

  const totalCacheBytes = cacheInfo?.reduce((sum, c) => sum + c.totalBytes, 0) ?? 0;

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

                <Field label="Show status bar">
                  <input
                    type="checkbox"
                    checked={settings.showDockerStatusBar}
                    onChange={(e) => update("showDockerStatusBar", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  The last row of the bottom bar - date/time, CPU RAM, OS and the "Request feature / Report a bug" link.
                </p>
              </Section>
            )}

            {activeSection === "appearance" && (
              <Section title="Closing the window">
                <Field label="The close button">
                  <select
                    className={fieldInputClass}
                    value={settings.closeToTray === null ? "ask" : settings.closeToTray ? "tray" : "quit"}
                    onChange={(e) => update("closeToTray", e.target.value === "ask" ? null : e.target.value === "tray")}
                  >
                    <option value="tray">Keeps Briefcast in the tray</option>
                    <option value="quit">Quits Briefcast</option>
                    <option value="ask">Asks the first time</option>
                  </select>
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  In the tray, Ctrl+Shift+R still starts a recording. Click the tray icon to reopen Briefcast, or right-click it to record, take a screenshot or quit.
                </p>
                <Field label="Free memory while in the tray">
                  <input
                    type="checkbox"
                    checked={settings.releaseWindowInTray}
                    disabled={settings.closeToTray === false}
                    onChange={(e) => update("releaseWindowInTray", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  After a minute in the tray, Briefcast closes its window to give back memory, and reopens it in a second or two when you click the tray icon. Recording, shortcuts and the phone remote keep working. It waits while an export, the live display or a phone-camera recording is running.
                </p>
                <Field label="Start Briefcast when I sign in">
                  <input
                    type="checkbox"
                    checked={launchAtLogin ?? false}
                    disabled={launchAtLogin === null}
                    onChange={(e) => setLaunchAtLogin(e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Starts in the tray without opening a window, so Ctrl+Shift+R works from the moment you sign in.
                </p>
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

                <Field label="Notify when a recording starts">
                  <input
                    type="checkbox"
                    checked={settings.notifyOnRecordingStart}
                    onChange={(e) => update("notifyOnRecordingStart", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Shows where the file will be saved and the recording shortcuts each time you start.
                </p>

                <Field label="Countdown before recording">
                  <div className="flex items-center gap-2">
                    <select
                      className={`${fieldInputClass} w-20`}
                      value={settings.recordingCountdownSeconds}
                      disabled={!settings.recordingCountdownEnabled}
                      onChange={(e) => update("recordingCountdownSeconds", Number(e.target.value))}
                    >
                      {[3, 5, 10].map((s) => (
                        <option key={s} value={s}>
                          {s} sec
                        </option>
                      ))}
                    </select>
                    <input
                      type="checkbox"
                      checked={settings.recordingCountdownEnabled}
                      onChange={(e) => update("recordingCountdownEnabled", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer"
                    />
                  </div>
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Counts down in the middle of the screen before capture starts, so you can get ready. Click the
                  countdown, or press Record again, to cancel.
                </p>

                <Field label="Mute notifications while recording">
                  <input
                    type="checkbox"
                    checked={settings.muteNotificationsWhileRecording}
                    onChange={(e) => update("muteNotificationsWhileRecording", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Turns off Windows notification pop-ups (WhatsApp, mail and the rest) from the moment you start
                  until you stop, so they never appear in your video. Your notification setting is put back
                  afterwards, even if Briefcast closes unexpectedly.
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
                <Field label="Enhance audio automatically">
                  <input
                    type="checkbox"
                    checked={settings.autoEnhanceAudio}
                    onChange={(e) => update("autoEnhanceAudio", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  After each recording: removes background noise, evens out your voice, lowers system
                  audio while you talk, and sets a consistent loudness. Turn off to keep the audio
                  exactly as recorded.
                </p>
                {/* System audio ("what you hear") is now attempted on every platform - WASAPI
                    loopback on Windows, an auto-selected PulseAudio monitor source on Linux, and
                    (best-effort - only if the user already has a known virtual-audio-loopback
                    device like BlackHole installed, since macOS has no built-in loopback at all)
                    avfoundation on macOS. See recording/{macos,linux}.rs's own
                    include_system_audio handling on the Rust side. */}
                {(settings.defaultRecordType === "sva" || settings.defaultRecordType === "sa" || settings.defaultRecordType === "s") && (
                  <Field label="Include system audio">
                    <input
                      type="checkbox"
                      checked={settings.defaultIncludeSystemAudio}
                      onChange={(e) => update("defaultIncludeSystemAudio", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer"
                    />
                  </Field>
                )}
                {(settings.defaultRecordType === "sva" || settings.defaultRecordType === "sa" || settings.defaultRecordType === "s") && (
                  <>
                    <Field label="Resolution">
                      <select
                        className={fieldInputClass}
                        value={settings.defaultResolutionWidth ?? ""}
                        onChange={(e) => update("defaultResolutionWidth", e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Auto - full display resolution on supported GPUs (default)</option>
                        <option value="1280">720p</option>
                        <option value="1920">1080p</option>
                        <option value="2560">1440p</option>
                        {/* A very large width rather than a separate "native" flag - see
                            RecordingDocker.tsx's NATIVE_RESOLUTION_WIDTH and FormData.resolution_width's
                            own doc comment (recording.rs) for why. */}
                        <option value={7680}>Native</option>
                      </select>
                    </Field>
                    <Field label="Frame rate">
                      <select
                        className={fieldInputClass}
                        value={settings.defaultFramerate ?? ""}
                        onChange={(e) => update("defaultFramerate", e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Auto - 60fps on supported GPUs (default)</option>
                        <option value="24">24 fps</option>
                        <option value="30">30 fps</option>
                        <option value="60">60 fps</option>
                      </select>
                    </Field>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                      Screen recordings are captured and encoded on your GPU (Quick Sync/NVENC/AMF) when it supports
                      it - up to 4K at 60fps with almost no CPU, so the app stays smooth while you record. Auto
                      records at your display's own resolution then; on other machines it records 1080p, and with a
                      webcam baked into the video it records 1080p at 30fps. Nothing to configure.
                    </p>
                  </>
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

            {activeSection === "cache" && (
              <Section title="Generated preview cache">
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Thumbnails and previews Briefcast generates from your files, kept so they don't have to be
                  rebuilt every time you browse. Clearing any of this is always safe — it just regenerates the
                  next time it's needed, and never touches your actual files.
                </p>

                {cacheError && <p className="text-xs text-red-500">{cacheError}</p>}

                {cacheInfo === null ? (
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">Loading…</p>
                ) : cacheInfo.length === 0 ? (
                  <p className="text-sm text-neutral-400 dark:text-neutral-500">Nothing cached right now.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {cacheInfo.map((c) => {
                      const info = CACHE_CATEGORY_INFO[c.namespace];
                      return (
                        <div key={c.namespace} className="flex items-center justify-between gap-4 py-1.5">
                          <div className="min-w-0">
                            <div className="text-sm text-neutral-700 dark:text-neutral-300">{info?.label ?? c.namespace}</div>
                            <div className="text-xs text-neutral-400 dark:text-neutral-500">
                              {info?.description ? `${info.description} ` : ""}
                              {c.fileCount} file{c.fileCount === 1 ? "" : "s"}, {formatFileSize(c.totalBytes)}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={cacheBusy !== null}
                            onClick={() => void handleClearCache(c.namespace)}
                            className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
                          >
                            {cacheBusy === c.namespace ? "Clearing…" : "Clear"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="pt-2 mt-1 border-t border-neutral-100 dark:border-neutral-800 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">
                      Total: {formatFileSize(totalCacheBytes)}
                    </span>
                    {confirmClearAll ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={cacheBusy !== null}
                          onClick={() => void handleClearCache()}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {cacheBusy === "*" ? "Clearing…" : "Confirm clear all"}
                        </button>
                        <button
                          type="button"
                          disabled={cacheBusy !== null}
                          onClick={() => setConfirmClearAll(false)}
                          className="px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={cacheBusy !== null || !cacheInfo?.length}
                        onClick={() => setConfirmClearAll(true)}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
                      >
                        Clear all cache
                      </button>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs text-neutral-400 dark:text-neutral-500">
                      After clearing, reload so open galleries and players pick up fresh previews right away.
                    </span>
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                    >
                      Reload app
                    </button>
                  </div>
                </div>
              </Section>
            )}

            {activeSection === "annotation" && (
              <>
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
                  anything to emphasize it. Press Esc or the shortcut again to stop.
                </p>
                <div className={`flex flex-col gap-3 transition-opacity ${settings.enableAnnotationTool ? "" : "opacity-40 pointer-events-none"}`}>
                  <Field label="Show toolbar while drawing">
                    <input
                      type="checkbox"
                      checked={settings.annotationShowToolbar}
                      onChange={(e) => update("annotationShowToolbar", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer"
                    />
                  </Field>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                    {settings.annotationShowToolbar
                      ? "Turn off to draw with nothing else on screen, so it looks like magic."
                      : "Hidden - drive it from the keyboard instead:"}
                  </p>
                  {/* Shown either way - they work with the toolbar too. */}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {[
                      ["Esc", "Stop drawing"],
                      ["Backspace", "Clear the screen"],
                      ["1 – 8", "Pick a colour"],
                      ["P  M  N  L", "Pen, Marker, Neon, Laser"],
                      ["Ctrl+Z", "Undo the last stroke"],
                      ["Hold Shift", "Draw a straight line"],
                      ["B", "Blur something private"],
                      ["Shift+Backspace", "Remove every blur"],
                    ].map(([keys, what]) => (
                      <div key={keys} className="flex items-center justify-between gap-2">
                        <span>{what}</span>
                        <kbd className="px-1.5 py-0.5 rounded-md font-mono text-[10px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
                          {keys}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>

              <Section title="Ink">
                {/* Everything below applies from the next time draw mode opens - no restart. */}
                <div className={`flex flex-col gap-3 transition-opacity ${settings.enableAnnotationTool ? "" : "opacity-40 pointer-events-none"}`}>
                  <AnnotationPreview
                    color={settings.annotationColor}
                    width={settings.annotationWidth}
                    style={settings.annotationStyle}
                    shadow={settings.annotationShadow}
                  />

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">Color</span>
                    <div className="flex items-center gap-1.5">
                      {ANNOTATION_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => update("annotationColor", c)}
                          aria-label={`Color ${c}`}
                          aria-pressed={settings.annotationColor.toLowerCase() === c}
                          className={`w-6 h-6 rounded-full ring-1 ring-black/15 dark:ring-white/25 transition-transform hover:scale-110 ${
                            settings.annotationColor.toLowerCase() === c ? "outline outline-2 outline-offset-2 outline-blue-500" : ""
                          }`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                      <label
                        className={`relative w-6 h-6 rounded-full cursor-pointer ring-1 ring-black/15 dark:ring-white/25 bg-[conic-gradient(#ef4444,#facc15,#22c55e,#3b82f6,#a855f7,#ef4444)] ${
                          ANNOTATION_COLORS.includes(settings.annotationColor.toLowerCase()) ? "" : "outline outline-2 outline-offset-2 outline-blue-500"
                        }`}
                        data-tip="Custom color"
                      >
                        <ColorInput
                          value={settings.annotationColor}
                          onChange={(e) => update("annotationColor", e.target.value)}
                          className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">Style</span>
                      <Segmented value={settings.annotationStyle} options={ANNOTATION_STYLES} onChange={(v) => update("annotationStyle", v)} />
                    </div>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                      {ANNOTATION_STYLES.find((st) => st.id === settings.annotationStyle)?.hint}
                    </p>
                  </div>

                  <Field label="Size">
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={2}
                        max={24}
                        step={1}
                        value={settings.annotationWidth}
                        onChange={(e) => update("annotationWidth", Number(e.target.value))}
                        className="w-32 accent-blue-500"
                      />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-6 text-right">{settings.annotationWidth}</span>
                    </div>
                  </Field>

                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">Fade out</span>
                      <Segmented
                        value={settings.annotationFade}
                        options={ANNOTATION_FADES}
                        onChange={(v) => update("annotationFade", v)}
                        disabled={settings.annotationStyle === "laser"}
                      />
                    </div>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                      {settings.annotationStyle === "laser"
                        ? "Laser trails always vanish in under a second."
                        : settings.annotationFade === "never"
                        ? "Strokes stay until you press Clear or leave draw mode."
                        : "How long each stroke stays before fading away."}
                    </p>
                  </div>

                  <Field label="Drop shadow">
                    <input
                      type="checkbox"
                      checked={settings.annotationShadow}
                      disabled={settings.annotationStyle === "neon" || settings.annotationStyle === "laser"}
                      onChange={(e) => update("annotationShadow", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                    />
                  </Field>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2">
                    {settings.annotationStyle === "neon" || settings.annotationStyle === "laser"
                      ? "Neon and Laser already glow, so they don't use a shadow."
                      : "Keeps ink readable on busy or same-coloured backgrounds."}
                  </p>
                </div>
              </Section>

              <Section title="Pointer and tap">
                <div className={`flex flex-col gap-3 transition-opacity ${settings.enableAnnotationTool ? "" : "opacity-40 pointer-events-none"}`}>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-sm text-neutral-700 dark:text-neutral-300">Pointer</span>
                      <div className="flex items-center gap-3">
                        {settings.annotationPointer === "hand" && (
                          <div className="relative w-6 h-9 overflow-hidden" aria-hidden>
                            <div className="absolute left-3 top-1.5" style={{ transform: "rotate(-26deg)" }}>
                              <HandGraphic color={settings.annotationColor} stick={false} />
                            </div>
                          </div>
                        )}
                        <Segmented value={settings.annotationPointer} options={ANNOTATION_POINTERS} onChange={(v) => update("annotationPointer", v)} />
                      </div>
                    </div>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                      {settings.annotationPointer === "hand"
                        ? "A little hand on a stick that follows your cursor, in the colour you're drawing with."
                        : settings.annotationPointer === "dot"
                        ? "A glowing dot in the ink colour."
                        : settings.annotationPointer === "custom"
                        ? "Your own image - its top centre is the point."
                        : "The system crosshair."}
                    </p>
                  </div>

                  {settings.annotationPointer === "custom" && (
                    <Field label="Pointer image">
                      <div className="flex items-center gap-2">
                        {settings.annotationPointerImage && (
                          <img src={settings.annotationPointerImage} alt="" className="h-8 w-auto max-w-[3rem] object-contain" />
                        )}
                        <input
                          type="file"
                          accept="image/png,image/webp"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (!file) return;
                            // Downscaled before it's stored: settings live in localStorage, and the
                            // pointer is only ever drawn ~64px tall.
                            const url = URL.createObjectURL(file);
                            const img = new Image();
                            img.onload = () => {
                              const scale = Math.min(1, 160 / img.naturalHeight);
                              const canvas = document.createElement("canvas");
                              canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                              canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                              canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
                              update("annotationPointerImage", canvas.toDataURL("image/png"));
                              URL.revokeObjectURL(url);
                            };
                            img.onerror = () => URL.revokeObjectURL(url);
                            img.src = url;
                          }}
                          className="text-xs text-neutral-500 dark:text-neutral-400 file:mr-2 file:px-2.5 file:py-1 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-100 dark:file:bg-neutral-800 file:text-neutral-700 dark:file:text-neutral-200 file:cursor-pointer"
                        />
                      </div>
                    </Field>
                  )}

                  <Field label="Tap ripple">
                    <input
                      type="checkbox"
                      checked={settings.annotationTapRipple}
                      onChange={(e) => update("annotationTapRipple", e.target.checked)}
                      className="w-4 h-4 accent-blue-500 cursor-pointer"
                    />
                  </Field>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2">A ring spreads from the point where you click, so viewers see exactly where.</p>

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">Tap sound</span>
                    <Segmented
                      value={settings.annotationTapSound}
                      options={ANNOTATION_TAP_SOUNDS}
                      onChange={(v) => {
                        update("annotationTapSound", v);
                        playTapSound(v, settings.annotationSoundVolume);
                      }}
                    />
                  </div>

                  <Field label="Volume">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={settings.annotationTapSound === "off"}
                      value={settings.annotationSoundVolume}
                      onChange={(e) => update("annotationSoundVolume", Number(e.target.value))}
                      onPointerUp={() => playTapSound(settings.annotationTapSound, settings.annotationSoundVolume)}
                      className="w-32 accent-blue-500 disabled:opacity-40"
                    />
                  </Field>
                </div>
              </Section>

              <Section title="Privacy blur">
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-1">
                  Press B while drawing and drag over anything private. The blur stays on screen and in recordings, and you
                  can still click and type underneath it.
                </p>
                <Field label="Strength">
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={settings.annotationBlurStrength}
                      onChange={(e) => {
                        const strength = Number(e.target.value);
                        update("annotationBlurStrength", strength);
                        // Live: any blur already on screen changes as the slider moves.
                        void invoke("screen_blur_configure", { config: { strength } }).catch(() => {});
                      }}
                      className="w-32 accent-blue-500"
                    />
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-8 text-right">
                      {settings.annotationBlurStrength}
                    </span>
                  </div>
                </Field>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2">
                  Even at 0 text can't be read. Higher adds more blur and frost.
                </p>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">Auto-blur WhatsApp chats</span>
                    <Segmented
                      value={settings.annotationAutoBlurWhatsApp}
                      options={[
                        { id: "off", label: "Off" },
                        { id: "recording", label: "While recording" },
                        { id: "always", label: "Always" },
                      ]}
                      onChange={(v) => update("annotationAutoBlurWhatsApp", v)}
                    />
                  </div>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                    {settings.annotationAutoBlurWhatsApp === "off"
                      ? "WhatsApp is never blurred automatically."
                      : "Follows the WhatsApp window as it moves, resizes or switches chats."}
                  </p>
                </div>
                {settings.annotationAutoBlurWhatsApp !== "off" && (
                  <div className="flex items-center justify-end gap-4 text-sm text-neutral-700 dark:text-neutral-300">
                    {(
                      [
                        ["chatList", "Chat list"],
                        ["contact", "Contact name & photo"],
                        ["messages", "Messages"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={settings.annotationBlurWhatsAppParts[key]}
                          onChange={(e) => update("annotationBlurWhatsAppParts", { ...settings.annotationBlurWhatsAppParts, [key]: e.target.checked })}
                          className="w-4 h-4 accent-blue-500 cursor-pointer"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-1 pt-2">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">Auto-blur sensitive text</span>
                    <Segmented
                      value={settings.annotationAutoBlurText}
                      options={[
                        { id: "off", label: "Off" },
                        { id: "recording", label: "While recording" },
                        { id: "always", label: "Always" },
                      ]}
                      onChange={(v) => update("annotationAutoBlurText", v)}
                    />
                  </div>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500 text-right">
                    {settings.annotationAutoBlurText === "off"
                      ? "Text on screen is never blurred automatically."
                      : "Watches the window you're using and blurs what matches below. A safety net, not a guarantee: new text can show for a moment before it's blurred, and unusual fonts can be missed."}
                  </p>
                  {settings.annotationAutoBlurText !== "off" && <OcrStatus />}
                </div>
                {settings.annotationAutoBlurText !== "off" && (
                  <>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm text-neutral-700 dark:text-neutral-300">
                      {(
                        [
                          ["passwords", "Passwords & PINs"],
                          ["keys", "API keys, tokens & private keys"],
                          ["financial", "Card & bank numbers"],
                          ["personal", "Emails & phone numbers"],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={settings.annotationBlurTextRules[key]}
                            onChange={(e) => update("annotationBlurTextRules", { ...settings.annotationBlurTextRules, [key]: e.target.checked })}
                            className="w-4 h-4 accent-blue-500 cursor-pointer"
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <Field label="Also blur these words">
                      <input
                        type="text"
                        value={settings.annotationBlurKeywords}
                        onChange={(e) => update("annotationBlurKeywords", e.target.value)}
                        placeholder="Client name, project codename…"
                        className="w-56 px-2 py-1 rounded-md text-sm bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400"
                      />
                    </Field>
                    <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2 text-right">Separate with commas. Matching ignores upper/lower case.</p>
                  </>
                )}

                <div className="flex items-center justify-between gap-4 pt-2">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300">Blur the whole window you're using</span>
                  <kbd className="px-1.5 py-0.5 rounded-md font-mono text-[10px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
                    Ctrl+Alt+B
                  </kbd>
                </div>
                <p className="text-xs text-neutral-400 dark:text-neutral-500 -mt-2">Works anywhere. Press it again to unblur.</p>
              </Section>
              </>
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

            {activeSection === "privacy" && <PrivacySection />}

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
                <Field label="Fit to screen on open">
                  <input
                    type="checkbox"
                    checked={settings.pdfFitOnOpen}
                    onChange={(e) => update("pdfFitOnOpen", e.target.checked)}
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
                  />
                </Field>
                <Field label="Default zoom">
                  <div className={`flex items-center gap-2 ${settings.pdfFitOnOpen ? "opacity-40" : ""}`}>
                    <input
                      type="range"
                      min={15}
                      max={300}
                      step={5}
                      disabled={settings.pdfFitOnOpen}
                      value={Math.round(settings.pdfDefaultZoom * 100)}
                      onChange={(e) => update("pdfDefaultZoom", Number(e.target.value) / 100)}
                      className="w-28 accent-blue-500"
                    />
                    <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-10 text-right">{Math.round(settings.pdfDefaultZoom * 100)}%</span>
                  </div>
                </Field>
                <Field label="Two-page turn">
                  <select
                    className={fieldInputClass}
                    value={settings.pdfPageTurn}
                    onChange={(e) => update("pdfPageTurn", e.target.value as AppSettings["pdfPageTurn"])}
                  >
                    {PDF_PAGE_TURN_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Pen color">
                  <ColorInput
                    value={settings.pdfDefaultPenColor}
                    onChange={(e) => update("pdfDefaultPenColor", e.target.value)}
                    className="w-7 h-7 p-0 border-0 rounded-full cursor-pointer bg-transparent"
                  />
                </Field>
                <Field label="Highlighter color">
                  <ColorInput
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
                  <ShortcutRow keys="Ctrl+Alt+B" description="Blur the active window, or unblur it" />
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
