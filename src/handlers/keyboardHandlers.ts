
// handlers/keyboardHandlers.ts
import { skipTime, adjustPlaybackRate } from '../utils/videoUtils';

interface KeyboardHandlers {
  togglePauseAndPlay?: () => void;
  toggleFullScreenMode?: () => void;
  toggleTheaterMode?: () => void;
  toggleMiniPlayerMode?: () => void;
  toggleMute?: () => void;
  toggleCaptions?: () => void;
  playbackSpeedIncrease?: () => void;
  playbackSpeedReduce?: () => void;
  onPlaybackRateChange?: (rate: number) => void;
  onVolumeChange?: (volume: number) => void;
}

interface PlayerState {
  // Define your player state properties here
  // Example:
  // isPlaying: boolean;
  // isMuted: boolean;
  // etc.
  [key: string]: any;
}

interface KeyboardShortcut {
  key: string;
  description: string;
}

/**
 * Create keyboard event handler for video player
 * @param handlers - Object containing handler functions
 * @returns Keyboard event handler function
 */
export const createKeyboardHandler = (
  handlers: KeyboardHandlers
): (e: KeyboardEvent) => void => {
  return (e: KeyboardEvent) => {
    // Don't trigger if user is typing in an input field
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    switch (e.key) {
      case "k":
      case " ":
        e.preventDefault();
        handlers.togglePauseAndPlay?.();
        break;
      case "f":
        e.preventDefault();
        handlers.toggleFullScreenMode?.();
        break;
      case "t":
        e.preventDefault();
        handlers.toggleTheaterMode?.();
        break;
      case "i":
        e.preventDefault();
        handlers.toggleMiniPlayerMode?.();
        break;
      case "m":
        e.preventDefault();
        handlers.toggleMute?.();
        break;
      case "ArrowLeft":
      case "j":
        e.preventDefault();
        handlers.playbackSpeedReduce?.();
        break;
      case "ArrowRight":
      case "l":
        e.preventDefault();
        handlers.playbackSpeedIncrease?.();
        break;
      case "c":
        e.preventDefault();
        handlers.toggleCaptions?.();
        break;
      default:
        break;
    }
  };
};

/**
 * Enhanced keyboard handler with more features
 * @param videoElement - Video element reference
 * @param state - Current player state
 * @param handlers - Handler functions
 * @returns Enhanced keyboard event handler
 */
export const createEnhancedKeyboardHandler = (
  videoElement: HTMLVideoElement | null,
  state: PlayerState,
  handlers: KeyboardHandlers
): (e: KeyboardEvent) => void => {
  return (e: KeyboardEvent) => {
    // Don't trigger if user is typing in an input field
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    switch (e.key) {
      case "k":
      case " ":
        e.preventDefault();
        handlers.togglePauseAndPlay?.();
        break;

      case "f":
        e.preventDefault();
        handlers.toggleFullScreenMode?.();
        break;

      case "t":
        e.preventDefault();
        handlers.toggleTheaterMode?.();
        break;

      case "i":
        e.preventDefault();
        handlers.toggleMiniPlayerMode?.();
        break;

      case "m":
        e.preventDefault();
        handlers.toggleMute?.();
        break;

      case "c":
        e.preventDefault();
        handlers.toggleCaptions?.();
        break;

      // Time skipping
      case "ArrowLeft":
        e.preventDefault();
        if (videoElement) skipTime(videoElement, -10); // Skip back 10 seconds
        break;

      case "ArrowRight":
        e.preventDefault();
        if (videoElement) skipTime(videoElement, 10); // Skip forward 10 seconds
        break;

      case "j":
        e.preventDefault();
        if (videoElement) skipTime(videoElement, -10);
        break;

      case "l":
        e.preventDefault();
        if (videoElement) skipTime(videoElement, 10);
        break;

      // Playback speed control
      case "<":
      case ",":
        e.preventDefault();
        if (videoElement) {
          const newRate = adjustPlaybackRate(videoElement.playbackRate, -0.25);
          videoElement.playbackRate = newRate;
          handlers.onPlaybackRateChange?.(newRate);
        }
        break;

      case ">":
      case ".":
        e.preventDefault();
        if (videoElement) {
          const newRate = adjustPlaybackRate(videoElement.playbackRate, 0.25);
          videoElement.playbackRate = newRate;
          handlers.onPlaybackRateChange?.(newRate);
        }
        break;

      // Volume control
      case "ArrowUp":
        e.preventDefault();
        if (videoElement) {
          const newVolume = Math.min(videoElement.volume + 0.1, 1);
          videoElement.volume = newVolume;
          handlers.onVolumeChange?.(newVolume);
        }
        break;

      case "ArrowDown":
        e.preventDefault();
        if (videoElement) {
          const newVolume = Math.max(videoElement.volume - 0.1, 0);
          videoElement.volume = newVolume;
          handlers.onVolumeChange?.(newVolume);
        }
        break;

      // Number keys for seeking (0-9 for 0%-90% of video)
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        e.preventDefault();
        if (videoElement && videoElement.duration) {
          const percent = parseInt(e.key) / 10;
          videoElement.currentTime = videoElement.duration * percent;
        }
        break;

      // Home key - go to beginning
      case "Home":
        e.preventDefault();
        if (videoElement) {
          videoElement.currentTime = 0;
        }
        break;

      // End key - go to end
      case "End":
        e.preventDefault();
        if (videoElement && videoElement.duration) {
          videoElement.currentTime = videoElement.duration - 1;
        }
        break;

      default:
        break;
    }
  };
};

/**
 * Get keyboard shortcuts help text
 * @returns Array of shortcut objects
 */
export const getKeyboardShortcuts = (): KeyboardShortcut[] => {
  return [
    { key: 'Space / K', description: 'Play/Pause' },
    { key: 'F', description: 'Toggle Fullscreen' },
    { key: 'T', description: 'Toggle Theater Mode' },
    { key: 'I', description: 'Toggle Mini Player' },
    { key: 'M', description: 'Toggle Mute' },
    { key: 'C', description: 'Toggle Captions' },
    { key: 'J / ←', description: 'Skip Backward 10s' },
    { key: 'L / →', description: 'Skip Forward 10s' },
    { key: '< / ,', description: 'Decrease Speed' },
    { key: '> / .', description: 'Increase Speed' },
    { key: '↑', description: 'Volume Up' },
    { key: '↓', description: 'Volume Down' },
    { key: '0-9', description: 'Seek to 0%-90%' },
    { key: 'Home', description: 'Go to Beginning' },
    { key: 'End', description: 'Go to End' }
  ];
};