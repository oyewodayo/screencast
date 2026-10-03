import { useState } from 'react';
import { MdClosedCaption, MdOutlineOpacity, MdSpeed, MdOutlineNoiseControlOff } from 'react-icons/md';
import { IoPlayCircleOutline, IoChevronForward, IoCheckmark, IoImageOutline, IoEyeOutline, IoScanOutline, IoDocumentTextOutline, IoLanguageOutline, IoMicOutline, IoSparkles } from 'react-icons/io5';
import { CAPTIONS_LANGUAGE_OPTIONS } from '../../utils/videoUtils';
import type { PlayerNoise } from '../VideoPlayer';

// Default strength each mode starts at - the same starting points NoiseReductionPopover's own mode
// buttons use, so the player and the editor agree on what "Reduce"/"Remove" sounds like.
const NOISE_MODES = [
  { mode: 'reduce', label: 'Reduce noise', defaultStrength: 0.5, tip: 'Softens hiss, hum and room noise while keeping a natural bit of ambience. Best for music or nature sound.' },
  { mode: 'remove', label: 'Remove noise', defaultStrength: 1, tip: "AI voice isolation - strips everything that isn't voice. Best for talks, lectures and interviews." },
] as const;

// Define the props interface
interface PlaytimeSettingsProps {
  onAutoplayChange: () => void;
  isAutoplay: boolean;
  playbackSpeed: string;
  onPlaybackSpeedChange: (speed: string) => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
  // Whether a sibling .vtt/.srt file next to the video is picked up automatically on open (see
  // VideoPlayer's own auto-detect effect) - exposed here since that behavior is otherwise silent
  // and undiscoverable, and some users may not want the app scanning for one at all.
  autoDetectCaptions: boolean;
  onAutoDetectCaptionsChange: () => void;
  hasCaptions: boolean;
  captionsVisible: boolean;
  onCaptionsVisibleChange: () => void;
  // Language the on-screen captions were generated in (null = loaded from a file / none) - so the
  // generate row can say "Regenerate" and the language row can flag a pending mismatch.
  generatedCaptionsLanguage: string | null;
  onLoadCaptionsFile: () => void;
  onGenerateCaptions: () => void;
  isGeneratingCaptions: boolean;
  captionsGenerationProgress: number | null;
  // First run only: the progress is the speech model's one-time download, not transcription.
  isDownloadingSpeechModel: boolean;
  captionsLanguage: string;
  onCaptionsLanguageChange: (lang: string) => void;
  // Overwrites this video's gallery/sidebar poster with whatever frame is on screen right now
  // (VideoPlayer.tsx reads videoRef.current.currentTime at call time - nothing here needs to know
  // the actual timestamp). thumbnailStatus mirrors captions' own generating/idle pattern above:
  // 'saving' while the backend re-extracts the frame, 'saved' briefly afterward for feedback,
  // null the rest of the time.
  onSetThumbnail: () => void;
  thumbnailStatus: 'idle' | 'saving' | 'saved' | 'error';
  // Live listening cleanup (VideoPlayer's Web Audio graph) - only changes what's heard, never the
  // file. noiseStatus is that graph's own status, so loading the AI model shows as such.
  noise: PlayerNoise;
  noiseStatus: 'idle' | 'calibrating' | 'active';
  onNoiseChange: (noise: PlayerNoise) => void;
}

const languageName = (code: string): string =>
  CAPTIONS_LANGUAGE_OPTIONS.find(([c]) => c === code)?.[1] ?? code;

const PlaytimeSettings: React.FC<PlaytimeSettingsProps> = ({
  onAutoplayChange,
  isAutoplay,
  playbackSpeed,
  onPlaybackSpeedChange,
  opacity,
  onOpacityChange,
  autoDetectCaptions,
  onAutoDetectCaptionsChange,
  hasCaptions,
  captionsVisible,
  onCaptionsVisibleChange,
  generatedCaptionsLanguage,
  onLoadCaptionsFile,
  onGenerateCaptions,
  isGeneratingCaptions,
  captionsGenerationProgress,
  isDownloadingSpeechModel,
  captionsLanguage,
  onCaptionsLanguageChange,
  onSetThumbnail,
  thumbnailStatus,
  noise,
  noiseStatus,
  onNoiseChange
}) => {
  // A native <select>'s open dropdown list is rendered by the OS, not the page, so it can't pick
  // up this app's styling (that's what was showing as a plain, unstyled white popup) - this
  // in-menu accordion replaces it with rows built from the same .settings-row styling as the rest
  // of this flyout.
  const [showSpeedOptions, setShowSpeedOptions] = useState<boolean>(false);
  const [showCaptionsOptions, setShowCaptionsOptions] = useState<boolean>(false);
  const [showNoiseOptions, setShowNoiseOptions] = useState<boolean>(false);

  const handleOpacity = (event: React.ChangeEvent<HTMLInputElement>): void => {
    onOpacityChange(parseFloat(event.target.value));
  };

  const handlePlaybackSpeedSelect = (speed: string): void => {
    onPlaybackSpeedChange(speed);
    setShowSpeedOptions(false);
  };

  // Predefined playback speed options
  const playbackSpeeds = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '1.75', '2'];
  const normalizedSpeed = playbackSpeed.replace('x', '');

  return (
    <div className="origin-bottom-right absolute bottom-full right-0 settings-menu rounded-md shadow-lg bg-white dark:bg-neutral-800 text-gray-800 dark:text-neutral-100 ring-1 ring-black dark:ring-white/10 ring-opacity-5 z-50">
      {/* Autoplay */}
      <button className="settings-row" onClick={onAutoplayChange} data-tip="Plays the next file in the folder when this one ends">
        <span className="settings-row-label">
          <IoPlayCircleOutline />
          Autoplay
        </span>
        <label className="switch" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isAutoplay}
            onChange={onAutoplayChange}
            name="autoplay"
          />
          <span className="slider round"></span>
        </label>
      </button>

      <div className="settings-divider" />

      {/* Playback Speed */}
      <button className="settings-row" onClick={() => setShowSpeedOptions((prev) => !prev)} data-tip="Speed up or slow down playback">
        <span className="settings-row-label">
          <MdSpeed />
          Playback speed
        </span>
        <span className="settings-row-value">
          {normalizedSpeed === '1' ? 'Normal' : `${normalizedSpeed}x`}
          <IoChevronForward className={`settings-chevron ${showSpeedOptions ? 'settings-chevron-open' : ''}`} />
        </span>
      </button>

      {showSpeedOptions && (
        <div className="settings-submenu">
          {playbackSpeeds.map((speed) => (
            <button
              key={speed}
              className="settings-row settings-submenu-item"
              onClick={() => handlePlaybackSpeedSelect(speed)}
            >
              <span>{speed === '1' ? 'Normal' : `${speed}x`}</span>
              {normalizedSpeed === speed && <IoCheckmark className="settings-check" />}
            </button>
          ))}
        </div>
      )}

      <div className="settings-divider" />

      {/* Opacity */}
      <div className="settings-row" data-tip="Fades the picture - handy for following along with something behind it">
        <span className="settings-row-label">
          <MdOutlineOpacity />
          Opacity
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.1}
          value={opacity}
          onChange={handleOpacity}
          name="video-opacity"
          className="settings-slider"
        />
      </div>

      <div className="settings-divider" />

      {/* Noise - live listening cleanup */}
      <button
        className="settings-row"
        onClick={() => setShowNoiseOptions((prev) => !prev)}
        data-tip="Clean up background noise as you listen - only changes what you hear, never the file"
      >
        <span className="settings-row-label">
          <MdOutlineNoiseControlOff />
          Noise
        </span>
        <span className="settings-row-value">
          {!noise
            ? 'Off'
            : noiseStatus === 'calibrating'
            ? noise.mode === 'remove' ? 'Loading AI…' : 'Learning…'
            : noise.mode === 'remove' ? 'Removed' : 'Reduced'}
          <IoChevronForward className={`settings-chevron ${showNoiseOptions ? 'settings-chevron-open' : ''}`} />
        </span>
      </button>

      {showNoiseOptions && (
        <div className="settings-submenu">
          <button
            className="settings-row settings-submenu-item"
            onClick={() => onNoiseChange(null)}
            data-tip="Play the original audio, untouched"
          >
            <span>Off</span>
            {!noise && <IoCheckmark className="settings-check" />}
          </button>
          {NOISE_MODES.map((m) => (
            <button
              key={m.mode}
              className="settings-row settings-submenu-item"
              // Keeps the current strength when switching between modes.
              onClick={() => onNoiseChange({ mode: m.mode, strength: noise?.strength ?? m.defaultStrength })}
              data-tip={m.tip}
            >
              <span className="settings-row-label">
                {m.label}
                {m.mode === 'remove' && <IoSparkles className="settings-sparkle" />}
              </span>
              {noise?.mode === m.mode && <IoCheckmark className="settings-check" />}
            </button>
          ))}
          {noise && (
            <div
              className="settings-row settings-submenu-item"
              data-tip={noise.mode === 'remove' ? 'How much of the AI-cleaned voice to blend over the original' : 'How deep to cut the noise'}
            >
              <span className="settings-row-label">{noise.mode === 'remove' ? 'Amount' : 'Strength'}</span>
              <span className="settings-row-value">
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={noise.strength}
                  onChange={(e) => onNoiseChange({ ...noise, strength: parseFloat(e.target.value) })}
                  name="noise-strength"
                  className="settings-slider"
                />
                <span className="settings-slider-value">{Math.round(noise.strength * 100)}%</span>
              </span>
            </div>
          )}
        </div>
      )}

      <div className="settings-divider" />

      {/* Thumbnail */}
      <button
        className="settings-row"
        onClick={onSetThumbnail}
        disabled={thumbnailStatus === 'saving'}
        data-tip="Embeds this frame as the video file's own cover image, so it's also what shows in File Explorer or when you share the file elsewhere - not just inside Briefcast."
      >
        <span className="settings-row-label">
          <IoImageOutline />
          {thumbnailStatus === 'saved'
            ? 'Thumbnail updated'
            : thumbnailStatus === 'error'
            ? 'Failed - try again'
            : 'Set current frame as thumbnail'}
        </span>
        {thumbnailStatus === 'saving' && <span className="settings-row-value">Saving…</span>}
      </button>

      <div className="settings-divider" />

      {/* Captions */}
      <button className="settings-row" onClick={() => setShowCaptionsOptions((prev) => !prev)} data-tip="Show, load or generate subtitles">
        <span className="settings-row-label">
          <MdClosedCaption />
          Captions
        </span>
        <span className="settings-row-value">
          {isGeneratingCaptions
            ? `${Math.round(captionsGenerationProgress ?? 0)}%`
            : !hasCaptions
            ? 'None'
            : captionsVisible
            ? generatedCaptionsLanguage
              ? languageName(generatedCaptionsLanguage)
              : 'On'
            : 'Off'}
          <IoChevronForward className={`settings-chevron ${showCaptionsOptions ? 'settings-chevron-open' : ''}`} />
        </span>
      </button>

      {showCaptionsOptions && (
        <div className="settings-submenu">
          {hasCaptions && (
            <button className="settings-row settings-submenu-item" onClick={onCaptionsVisibleChange}>
              <span className="settings-row-label">
                <IoEyeOutline />
                Show captions
              </span>
              <label className="switch" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={captionsVisible} onChange={onCaptionsVisibleChange} name="captions-visible" />
                <span className="slider round"></span>
              </label>
            </button>
          )}
          <button className="settings-row settings-submenu-item" onClick={onAutoDetectCaptionsChange}>
            <span className="settings-row-label">
              <IoScanOutline />
              Auto-load matching file
            </span>
            <label className="switch" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={autoDetectCaptions} onChange={onAutoDetectCaptionsChange} name="captions-autodetect" />
              <span className="slider round"></span>
            </label>
          </button>
          <button className="settings-row settings-submenu-item" onClick={onLoadCaptionsFile} disabled={isGeneratingCaptions}>
            <span className="settings-row-label">
              <IoDocumentTextOutline />
              Load caption file…
            </span>
            <span className="settings-row-value">.vtt / .srt</span>
          </button>

          <div className="settings-subheader">Generate from audio · offline</div>
          <div className="settings-row settings-submenu-item">
            <span className="settings-row-label">
              <IoLanguageOutline />
              Language
            </span>
            <select
              className="settings-select"
              value={captionsLanguage}
              onChange={(e) => onCaptionsLanguageChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              disabled={isGeneratingCaptions}
            >
              {CAPTIONS_LANGUAGE_OPTIONS.map(([code, name]) => (
                <option key={code} value={code}>{name}</option>
              ))}
            </select>
          </div>
          {isGeneratingCaptions ? (
            <div className="settings-row settings-submenu-item settings-progress-row">
              <span className="settings-row-label">
                <IoMicOutline />
                {isDownloadingSpeechModel ? 'Downloading speech model…' : 'Transcribing…'} {Math.round(captionsGenerationProgress ?? 0)}%
              </span>
              <div className="settings-progress">
                <div className="settings-progress-fill" style={{ width: `${captionsGenerationProgress ?? 0}%` }} />
              </div>
            </div>
          ) : (
            <button className="settings-row settings-submenu-item" onClick={onGenerateCaptions}>
              <span className="settings-row-label">
                <IoMicOutline />
                {generatedCaptionsLanguage ? 'Regenerate captions' : 'Generate captions'}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default PlaytimeSettings
