
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

interface KeyboardHandlerOptions {
  // Off for audio, where Dashboard's own keydown listener owns ArrowLeft/Right/Up/Down to
  // switch tracks instead — "j"/"l" remain available for speed either way.
  enableArrowSeek?: boolean;
}

/**
 * Create keyboard event handler for video player
 * @param handlers - Object containing handler functions
 * @param options - Behavior toggles; see KeyboardHandlerOptions
 * @returns Keyboard event handler function
 */
export const createKeyboardHandler = (
  handlers: KeyboardHandlers,
  options?: KeyboardHandlerOptions
): (e: KeyboardEvent) => void => {
  const enableArrowSeek = options?.enableArrowSeek ?? true;

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
        if (!enableArrowSeek) break;
        e.preventDefault();
        handlers.playbackSpeedReduce?.();
        break;
      case "j":
        e.preventDefault();
        handlers.playbackSpeedReduce?.();
        break;
      case "ArrowRight":
        if (!enableArrowSeek) break;
        e.preventDefault();
        handlers.playbackSpeedIncrease?.();
        break;
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

