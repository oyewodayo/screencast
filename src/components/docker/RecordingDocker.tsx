// components/docker/RecordingDocker.tsx
import React from "react";
import {
  IoCameraOutline,
  IoChevronDown,
  IoDesktopOutline,
  IoMic,
  IoMicOutline,
  IoPause,
  IoPencil,
  IoPhonePortraitOutline,
  IoPlay,
  IoRefresh,
  IoSquare,
  IoVideocam,
  IoVideocamOutline,
} from "react-icons/io5";
import { PHONE_CAMERA_DEVICE, PHONE_CAMERA_LABEL } from "../../services/phoneCamera";
import DockerDropdown, { DropdownOption } from "./DockerDropdown";

// Represents "Native" (no downscale) as a plain width rather than a separate value/flag - see
// FormData.resolution_width's own doc comment (recording.rs) for why the backend already expects
// exactly this: comfortably above any realistic display's own width, so `min(iw, this)` in the
// scale filter always resolves to the source's actual width.
const NATIVE_RESOLUTION_WIDTH = 7680;

interface RecordingDockerProps {
  fileName: string;
  onFileNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  fileExt: string;
  onFileExtChange: (ext: string) => void;
  recordType: string;
  onRecordTypeChange: (recordType: string) => void;
  audioDevice: string;
  onAudioDeviceChange: (device: string) => void;
  connectedAudioDevices: string[] | null;
  connectedCameraDevices: string[] | null;
  videoDevices: string[];
  onToggleVideoDevice: (device: string) => void;
  onRefreshDevices: () => void;
  // Opens the pairing panel for the phone-camera entry below. That entry is always listed (a
  // phone can never show up in device detection), so it needs its own way in.
  onOpenPhoneCamera: () => void;
  isPhoneCameraConnected: boolean;
  // System/"what you hear" audio capture - attempted on every platform now (WASAPI on Windows, a
  // PulseAudio monitor source on Linux, avfoundation + a known virtual-audio device on macOS),
  // only offered for the screen-capture record types (sva/sa/s), see this component's own render
  // logic below and start_recording's handling of FormData.include_system_audio on the backend.
  includeSystemAudio: boolean;
  onToggleIncludeSystemAudio: () => void;
  // Click tracking (services/click_tracker.rs, a Win32 mouse hook) is still Windows-only with no
  // equivalent elsewhere - see BottomDocker.tsx's own doc comment on this prop.
  isClickTrackingSupported: boolean;
  // Records the (single) selected webcam as its own separate file instead of baking it into the
  // screen recording - see Dashboard.tsx's own doc comment on this state and
  // recording_with_output_sva (win.rs) for why it only applies to record_type "sva" with exactly
  // one camera selected.
  separateWebcamCapture: boolean;
  onToggleSeparateWebcamCapture: () => void;
  // Records click position/timing to a sidecar JSON for the editor's own "auto zoom on click"
  // tool - Windows-only (services/click_tracker.rs), offered for the same screen-capture record
  // types as includeSystemAudio above.
  trackClicks: boolean;
  onToggleTrackClicks: () => void;
  // Max output width / target capture fps for the screen-capture record types - null means "let
  // the backend use its own default" (see FormData.resolution_width/framerate's own doc comments,
  // recording.rs). Only offered for the same record types includeSystemAudio/trackClicks above
  // are, since "va"/"v"/"a" never touch the screen at all.
  resolutionWidth: number | null;
  onResolutionWidthChange: (width: number | null) => void;
  framerate: number | null;
  onFramerateChange: (fps: number | null) => void;
  isRecording: boolean;
  isPaused: boolean;
  onScreenshotClick: () => void;
  onStartRecordingClick: () => void;
  onStopRecordingClick: () => void;
  onPauseRecordingClick: () => void;
  onResumeRecordingClick: () => void;
}

// The record types, in the same order and with the same icon language as the Screen Options
// modal's header (EnhancedScreenOptions.tsx), so the two read as one control.
const RECORD_TYPES: { value: string; label: string; icons: React.ReactNode[] }[] = [
  { value: "sva", label: "Screen + Camera", icons: [<IoDesktopOutline key="s" />, <IoVideocam key="v" />, <IoMic key="a" />] },
  { value: "sa", label: "Screen + Mic", icons: [<IoDesktopOutline key="s" />, <IoMic key="a" />] },
  { value: "s", label: "Screen only", icons: [<IoDesktopOutline key="s" />] },
  { value: "va", label: "Camera + Mic", icons: [<IoVideocam key="v" />, <IoMic key="a" />] },
  { value: "v", label: "Camera only", icons: [<IoVideocam key="v" />] },
  { value: "a", label: "Audio only", icons: [<IoMic key="a" />] },
];

const FORMATS: Record<"image" | "audio" | "video", { value: string; label: string }[]> = {
  image: [
    { value: "png", label: "PNG" },
    { value: "jpeg", label: "JPEG" },
    { value: "webp", label: "WebP" },
  ],
  audio: [
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "aac", label: "AAC" },
    { value: "wma", label: "WMA" },
  ],
  video: [
    { value: "mp4", label: "MP4" },
    { value: "mkv", label: "MKV" },
    { value: "mov", label: "MOV" },
    { value: "webm", label: "WebM" },
    { value: "avi", label: "AVI" },
  ],
};

const SCREEN_TYPES = ["sva", "sa", "s"];
const MIC_TYPES = ["sva", "sa", "va", "a"];
const CAMERA_TYPES = ["sva", "va", "v"];

// A chip that opens a DockerDropdown: caption icon, small caption, current value, chevron.
const ChipSelect: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  title?: string;
  className?: string;
  emptyLabel?: string;
}> = ({ icon, label, value, options, onChange, title, className = "", emptyLabel }) => {
  const current = options.find((o) => o.value === value);
  return (
    <DockerDropdown
      value={value}
      options={options}
      onChange={onChange}
      title={label}
      triggerTitle={title}
      emptyLabel={emptyLabel}
      triggerClassName={`docker-chip flex items-center gap-2.5 h-10 pl-3 pr-2.5 rounded-xl border border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80 hover:border-neutral-300 dark:hover:border-neutral-600 text-left transition-colors ${className}`}
    >
      <span className="text-neutral-400 dark:text-neutral-500 shrink-0">{icon}</span>
      <span className="flex flex-col min-w-0 leading-tight">
        <span className="docker-chip-caption text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
          {label}
        </span>
        <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
          {current?.label ?? emptyLabel ?? value}
        </span>
      </span>
      <IoChevronDown className="shrink-0 ml-1 text-neutral-400" size={14} />
    </DockerDropdown>
  );
};

// An on/off pill with a sliding switch - reads as a setting at a glance, unlike a bare checkbox.
const TogglePill: React.FC<{
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}> = ({ label, checked, onToggle, disabled, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={onToggle}
    title={title}
    className={`docker-chip flex items-center gap-2.5 h-10 px-3 rounded-xl border text-[13px] font-medium transition-colors ${
      disabled
        ? "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 text-neutral-400 dark:text-neutral-600 cursor-not-allowed"
        : checked
        ? "border-blue-500/40 bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300"
        : "border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80 text-neutral-700 dark:text-neutral-200 hover:border-neutral-300 dark:hover:border-neutral-600"
    }`}
  >
    <span
      className={`relative inline-flex w-7 h-4 shrink-0 rounded-full transition-colors ${
        checked && !disabled ? "bg-blue-500" : "bg-neutral-300 dark:bg-neutral-600"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
          checked && !disabled ? "translate-x-3" : ""
        }`}
      />
    </span>
    <span className="whitespace-nowrap">{label}</span>
  </button>
);

// The default docker content: screen/video/audio recording setup. This is exactly what used to
// be BottomDocker's inline `scopedDocker()` closure, pulled out into its own component so
// BottomDocker can act as a plain switcher between this and FileToolsDocker (see dockerMode in
// Dashboard.tsx) instead of only ever having one thing to show.
const RecordingDocker: React.FC<RecordingDockerProps> = ({
  fileName,
  onFileNameChange,
  fileExt,
  onFileExtChange,
  recordType,
  onRecordTypeChange,
  audioDevice,
  onAudioDeviceChange,
  connectedAudioDevices,
  connectedCameraDevices,
  videoDevices,
  onToggleVideoDevice,
  onRefreshDevices,
  onOpenPhoneCamera,
  isPhoneCameraConnected,
  includeSystemAudio,
  onToggleIncludeSystemAudio,
  isClickTrackingSupported,
  separateWebcamCapture,
  onToggleSeparateWebcamCapture,
  trackClicks,
  onToggleTrackClicks,
  resolutionWidth,
  onResolutionWidthChange,
  framerate,
  onFramerateChange,
  isRecording,
  isPaused,
  onScreenshotClick,
  onStartRecordingClick,
  onStopRecordingClick,
  onPauseRecordingClick,
  onResumeRecordingClick,
}) => {
  const formats = recordType === "c" ? FORMATS.image : recordType === "a" ? FORMATS.audio : FORMATS.video;
  const hasScreen = SCREEN_TYPES.includes(recordType);
  const hasMic = MIC_TYPES.includes(recordType);
  const hasCamera = CAMERA_TYPES.includes(recordType);

  return (
    <div className="docker-panel docker-recording w-full flex flex-col gap-3 overflow-auto rounded-2xl border border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/60 p-3">
      {/* Top row: what's recorded and what it's called, then the primary actions. */}
      <div className="docker-top-row flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          {/* The file name, edited in place - with its format as a suffix, the way the file will
              actually be named on disk. */}
          <div className="docker-chip flex items-center h-10 rounded-xl border border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80 focus-within:ring-2 focus-within:ring-blue-500/30 focus-within:border-blue-500/50 transition-shadow">
            <IoPencil className="ml-3 text-neutral-400 shrink-0" size={13} />
            <input
              type="text"
              name="file_name"
              id="file_name"
              value={fileName}
              onChange={onFileNameChange}
              disabled={isRecording}
              placeholder="Recording name"
              title="File name"
              className="docker-name-input w-44 bg-transparent px-2 text-[13px] font-medium text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 outline-none disabled:opacity-60"
            />
            <div className="h-full border-l border-neutral-200 dark:border-neutral-700/80">
              <DockerDropdown
                value={fileExt}
                options={formats.map((f) => ({ value: f.value, label: `.${f.label.toLowerCase()}`, hint: f.label }))}
                onChange={onFileExtChange}
                disabled={isRecording}
                title="File format"
                triggerTitle="File format"
                triggerClassName="flex items-center gap-1 h-[38px] pl-3 pr-3 rounded-r-xl text-[12px] font-semibold text-neutral-600 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white disabled:cursor-not-allowed"
              >
                .{fileExt.toLowerCase()}
                <IoChevronDown className="text-neutral-400" size={12} />
              </DockerDropdown>
            </div>
          </div>

          {/* Record type as segmented pills rather than a long dropdown - every mode is visible
              and one click away. */}
          <div
            role="radiogroup"
            aria-label="Recording type"
            className={`docker-types flex flex-wrap items-center gap-0.5 p-1 rounded-xl bg-neutral-200/60 dark:bg-neutral-800 ${
              isRecording ? "opacity-60 pointer-events-none" : ""
            }`}
          >
            {RECORD_TYPES.map((t) => {
              const active = t.value === recordType;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onRecordTypeChange(t.value)}
                  title={t.label}
                  className={`docker-type flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12px] font-medium whitespace-nowrap transition-all ${
                    active
                      ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100"
                  }`}
                >
                  <span className={`flex items-center gap-0.5 ${active ? "text-blue-500" : ""}`}>{t.icons}</span>
                  <span className="docker-type-label">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="docker-actions-row flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={onScreenshotClick}
            disabled={isRecording}
            title="Take a screenshot"
            className="docker-chip flex items-center gap-2 h-10 px-3.5 rounded-xl border border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80 text-[13px] font-medium text-neutral-700 dark:text-neutral-200 hover:border-neutral-300 dark:hover:border-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <IoCameraOutline size={16} />
            <span className="docker-action-label">Screenshot</span>
          </button>

          {!isRecording ? (
            <button
              type="button"
              onClick={onStartRecordingClick}
              className="docker-chip group flex items-center gap-2 h-10 pl-3 pr-4 rounded-xl bg-red-600 hover:bg-red-500 active:bg-red-700 text-white text-[13px] font-semibold shadow-sm shadow-red-600/30 transition-colors"
            >
              <span className="flex items-center justify-center w-4 h-4 rounded-full border-2 border-white/90">
                <span className="w-1.5 h-1.5 rounded-full bg-white" />
              </span>
              Start recording
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={isPaused ? onResumeRecordingClick : onPauseRecordingClick}
                className="docker-chip flex items-center gap-2 h-10 px-3.5 rounded-xl border border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80 text-[13px] font-medium text-neutral-800 dark:text-neutral-100 hover:border-neutral-300 dark:hover:border-neutral-600"
              >
                {isPaused ? <IoPlay size={14} /> : <IoPause size={14} />}
                {isPaused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={onStopRecordingClick}
                className="docker-chip flex items-center gap-2 h-10 pl-3 pr-4 rounded-xl bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-[13px] font-semibold hover:bg-neutral-800 dark:hover:bg-neutral-100"
              >
                <span className="relative flex w-2 h-2">
                  {!isPaused && <span className="absolute inline-flex w-full h-full rounded-full bg-red-500 opacity-75 animate-ping" />}
                  <span className="relative inline-flex w-2 h-2 rounded-full bg-red-500" />
                </span>
                <IoSquare size={10} />
                Stop
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bottom row: devices, then capture options. Locked while recording - changes wouldn't
          reach a capture that's already running. */}
      <div
        className={`docker-fields-row flex flex-wrap items-center gap-2 ${isRecording ? "opacity-60 pointer-events-none" : ""}`}
        aria-disabled={isRecording}
      >
        {hasMic && (
          <ChipSelect
            icon={<IoMicOutline size={16} />}
            label="Microphone"
            value={audioDevice}
            onChange={onAudioDeviceChange}
            className="max-w-[280px]"
            options={(connectedAudioDevices ?? []).map((device) => ({ value: device, label: device }))}
            emptyLabel="No microphone detected"
          />
        )}

        {hasCamera && (
          <div className="docker-chip flex items-center gap-1 h-10 pl-3 pr-1 rounded-xl border border-neutral-200 dark:border-neutral-700/80 bg-white dark:bg-neutral-800/80">
            <IoVideocamOutline className="text-neutral-400 dark:text-neutral-500 shrink-0 mr-1" size={16} />
            {connectedCameraDevices && connectedCameraDevices.length > 0 ? (
              connectedCameraDevices.map((device) => {
                // The phone entry is always present but only usable once paired, so it carries
                // its own label and status, and opens the pairing panel instead of silently doing
                // nothing when it isn't paired yet.
                const isPhone = device === PHONE_CAMERA_DEVICE;
                const selected = videoDevices.includes(device);
                return (
                  <button
                    key={device}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => (isPhone && !isPhoneCameraConnected ? onOpenPhoneCamera() : onToggleVideoDevice(device))}
                    title={isPhone && !isPhoneCameraConnected ? "Pair your phone to use it as a camera" : device}
                    className={`flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[12px] font-medium max-w-[180px] transition-colors ${
                      selected
                        ? "bg-blue-500 text-white"
                        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    }`}
                  >
                    {isPhone && <IoPhonePortraitOutline className="shrink-0" size={12} />}
                    <span className="truncate">{isPhone ? PHONE_CAMERA_LABEL : device}</span>
                    {isPhone && (
                      <span
                        className={`shrink-0 w-1.5 h-1.5 rounded-full ${isPhoneCameraConnected ? "bg-green-400" : "bg-neutral-400"}`}
                        title={isPhoneCameraConnected ? "Connected" : "Not paired"}
                      />
                    )}
                    {isPhone && !isPhoneCameraConnected && (
                      <span className="shrink-0 text-[10px] px-1.5 py-px rounded-full bg-neutral-100 dark:bg-neutral-700 text-neutral-500 dark:text-neutral-400">
                        Set up
                      </span>
                    )}
                  </button>
                );
              })
            ) : (
              <span className="px-1 text-[12px] text-neutral-500">No cameras detected</span>
            )}
            <button
              type="button"
              onClick={onRefreshDevices}
              title="Refresh devices"
              className="flex items-center justify-center w-7 h-7 ml-0.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              <IoRefresh size={14} />
            </button>
          </div>
        )}

        {hasScreen && (
          <>
            <ChipSelect
              icon={<IoDesktopOutline size={15} />}
              label="Resolution"
              value={resolutionWidth == null ? "" : String(resolutionWidth)}
              onChange={(v) => onResolutionWidthChange(v ? Number(v) : null)}
              title="Auto records at your display's full resolution (up to 4K) when your GPU can capture it, 1080p otherwise. Lower is smaller and easier to edit/share."
              options={[
                { value: "", label: "Auto", hint: "up to 4K" },
                { value: "1280", label: "720p", hint: "HD" },
                { value: "1920", label: "1080p", hint: "Full HD" },
                { value: "2560", label: "1440p", hint: "QHD" },
                { value: String(NATIVE_RESOLUTION_WIDTH), label: "Native", hint: "display's own" },
              ]}
            />
            <ChipSelect
              icon={<span className="text-[10px] font-bold">FPS</span>}
              label="Frame rate"
              value={framerate == null ? "" : String(framerate)}
              onChange={(v) => onFramerateChange(v ? Number(v) : null)}
              title="Auto is 60fps when your GPU can capture the screen, 30fps otherwise (and 30fps with a webcam baked into the video)"
              options={[
                { value: "", label: "Auto", hint: "60 or 30" },
                { value: "24", label: "24 fps", hint: "film" },
                { value: "30", label: "30 fps" },
                { value: "60", label: "60 fps", hint: "smoothest" },
              ]}
            />
          </>
        )}

        {(hasScreen || (recordType === "sva" && videoDevices.length >= 1)) && (
          <span className="docker-divider hidden sm:block w-px h-6 mx-1 bg-neutral-200 dark:bg-neutral-700" />
        )}

        {/* Only meaningful for the screen-capture record types - "va"/"v"/"a" don't grab the
            screen at all, so there's no "what's playing while I record" scenario for them. */}
        {hasScreen && (
          <TogglePill
            label="System audio"
            checked={includeSystemAudio}
            onToggle={onToggleIncludeSystemAudio}
            title="Captures whatever's playing through your speakers (e.g. a video open in another app) alongside the screen capture. On macOS this needs a virtual-audio-loopback device (e.g. BlackHole) already installed."
          />
        )}

        {/* Same screen-capturing record types click_tracker.rs's own gate uses (start_recording,
            recording.rs). */}
        {hasScreen && (
          <TogglePill
            label="Track clicks"
            checked={trackClicks && isClickTrackingSupported}
            onToggle={onToggleTrackClicks}
            disabled={!isClickTrackingSupported}
            title={
              isClickTrackingSupported
                ? "Records where and when you click, so the editor can suggest zooming in on each one afterward."
                : "Click tracking is Windows-only for now - not available on this platform."
            }
          />
        )}

        {/* Only meaningful for "sva" with exactly one camera - see recording_with_output_sva's own
            doc comment (win.rs) for why more than one camera isn't supported here. */}
        {recordType === "sva" && videoDevices.length >= 1 && (
          <TogglePill
            label="Separate webcam file"
            checked={separateWebcamCapture && videoDevices.length === 1}
            onToggle={onToggleSeparateWebcamCapture}
            disabled={videoDevices.length !== 1}
            title={
              videoDevices.includes(PHONE_CAMERA_DEVICE)
                ? "The phone camera is always recorded as its own separate file, so this setting doesn't apply while it's selected."
                : videoDevices.length === 1
                ? "Records the webcam as its own file instead of baking it into the screen recording, so you can reposition/resize/reshape it later in the editor's picture-in-picture layer - and switch between screen and camera while recording (Alt+Shift+V)."
                : "Only supported with exactly one camera selected."
            }
          />
        )}
      </div>
    </div>
  );
};

export default RecordingDocker;
