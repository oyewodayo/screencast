import { useState } from 'react';
import { MdOutlineOpacity, MdSpeed } from 'react-icons/md';
import { IoPlayCircleOutline, IoChevronForward, IoCheckmark } from 'react-icons/io5';

// Define the props interface
interface PlaytimeSettingsProps {
  onAutoplayChange: () => void;
  isAutoplay: boolean;
  playbackSpeed: string;
  onPlaybackSpeedChange: (speed: string) => void;
  opacity: number;
  onOpacityChange: (opacity: number) => void;
}

const PlaytimeSettings: React.FC<PlaytimeSettingsProps> = ({
  onAutoplayChange,
  isAutoplay,
  playbackSpeed,
  onPlaybackSpeedChange,
  opacity,
  onOpacityChange
}) => {
  // A native <select>'s open dropdown list is rendered by the OS, not the page, so it can't pick
  // up this app's styling (that's what was showing as a plain, unstyled white popup) - this
  // in-menu accordion replaces it with rows built from the same .settings-row styling as the rest
  // of this flyout.
  const [showSpeedOptions, setShowSpeedOptions] = useState<boolean>(false);

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
    </div>
  )
}

export default PlaytimeSettings
