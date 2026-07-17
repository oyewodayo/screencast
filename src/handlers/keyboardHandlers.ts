
// handlers/keyboardHandlers.ts

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

