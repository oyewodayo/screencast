import { useState } from 'react';
import { MdClosedCaption, MdOutlineOpacity, MdSpeed } from 'react-icons/md';
import { IoPlayCircleOutline, IoChevronForward, IoCheckmark, IoImageOutline } from 'react-icons/io5';
import { CAPTIONS_LANGUAGE_OPTIONS } from '../../utils/videoUtils';

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
  onLoadCaptionsFile: () => void;
  onGenerateCaptions: () => void;
  isGeneratingCaptions: boolean;
  captionsGenerationProgress: number | null;
  captionsLanguage: string;
  onCaptionsLanguageChange: (lang: string) => void;
  // Overwrites this video's gallery/sidebar poster with whatever frame is on screen right now
  // (VideoPlayer.tsx reads videoRef.current.currentTime at call time - nothing here needs to know
  // the actual timestamp). thumbnailStatus mirrors captions' own generating/idle pattern above:
  // 'saving' while the backend re-extracts the frame, 'saved' briefly afterward for feedback,
  // null the rest of the time.
  onSetThumbnail: () => void;
  thumbnailStatus: 'idle' | 'saving' | 'saved' | 'error';
}

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
  onLoadCaptionsFile,
  onGenerateCaptions,
  isGeneratingCaptions,
  captionsGenerationProgress,
  captionsLanguage,
  onCaptionsLanguageChange,
  onSetThumbnail,
  thumbnailStatus
}) => {
  // A native <select>'s open dropdown list is rendered by the OS, not the page, so it can't pick
  // up this app's styling (that's what was showing as a plain, unstyled white popup) - this
  // in-menu accordion replaces it with rows built from the same .settings-row styling as the rest
  // of this flyout.
  const [showSpeedOptions, setShowSpeedOptions] = useState<boolean>(false);
  const [showCaptionsOptions, setShowCaptionsOptions] = useState<boolean>(false);

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
      <button className="settings-row" onClick={onAutoplayChange}>
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
      <button className="settings-row" onClick={() => setShowSpeedOptions((prev) => !prev)}>
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
      <div className="settings-row">
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

      {/* Thumbnail */}
      <button
        className="settings-row"
        onClick={onSetThumbnail}
        disabled={thumbnailStatus === 'saving'}
        title="Embeds this frame as the video file's own cover image, so it's also what shows in File Explorer or when you share the file elsewhere - not just inside Briefcast."
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
      <button className="settings-row" onClick={() => setShowCaptionsOptions((prev) => !prev)}>
        <span className="settings-row-label">
          <MdClosedCaption />
          Captions
        </span>
        <span className="settings-row-value">
          {isGeneratingCaptions ? `${Math.round(captionsGenerationProgress ?? 0)}%` : hasCaptions ? 'On' : 'Off'}
          <IoChevronForward className={`settings-chevron ${showCaptionsOptions ? 'settings-chevron-open' : ''}`} />
        </span>
      </button>

      {showCaptionsOptions && (
        <div className="settings-submenu">
          <button className="settings-row settings-submenu-item" onClick={onAutoDetectCaptionsChange}>
            <span>Auto-detect from file</span>
            <label className="switch" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={autoDetectCaptions} onChange={onAutoDetectCaptionsChange} name="captions-autodetect" />
              <span className="slider round"></span>
            </label>
          </button>
          <button className="settings-row settings-submenu-item" onClick={onLoadCaptionsFile} disabled={isGeneratingCaptions}>
            <span>Load caption file…</span>
          </button>
          <div className="settings-row settings-submenu-item">
            <span>Generate language</span>
            <select
              className="text-xs rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 px-1.5 py-1 focus:outline-none"
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
          <button className="settings-row settings-submenu-item" onClick={onGenerateCaptions} disabled={isGeneratingCaptions}>
            <span>{isGeneratingCaptions ? `Generating… ${Math.round(captionsGenerationProgress ?? 0)}%` : 'Generate from audio (offline)'}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default PlaytimeSettings
