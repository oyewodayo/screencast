// utils/videoUtils.ts

type VolumeLevel = 'muted' | 'low' | 'high';
type MediaType = 'video' | 'audio' | null;

export interface MediaFile {
  file: File;
  name: string;
  url: string;
  type: 'video' | 'audio' | 'image';  // Make this a union type
  relativePath: string;
}


export interface ProcessedFilesResult {
  files: MediaFile[];
  selectedFiles: MediaFile[];  // Changed from File[] to MediaFile[]
  fileCount: number;
  folderName: string;
  alertData: {
    title: string;
    message: string;
  };
}

interface TimeInfo {
  currentTime: string;
  totalTime: string;
  progress: number;
}

/**
 * Format duration in seconds to human readable format (MM:SS or H:MM:SS)
 * @param time - Time in seconds
 * @returns Formatted time string
 */
export const formatDuration = (time: number): string => {
  const leadingZeroFormatter = new Intl.NumberFormat(undefined, { 
    minimumIntegerDigits: 2 
  });
  
  const seconds = Math.floor(time % 60);
  const minutes = Math.floor(time / 60) % 60;
  const hours = Math.floor(time / 3600);

  if (hours === 0) {
    return `${minutes}:${leadingZeroFormatter.format(seconds)}`;
  } else {
    return `${hours}:${leadingZeroFormatter.format(minutes)}:${leadingZeroFormatter.format(seconds)}`;
  }
};

/**
 * Get volume level based on current volume
 * @param volume - Volume level (0-1)
 * @param muted - Whether audio is muted
 * @returns Volume level ('muted', 'low', 'high')
 */
export const getVolumeLevel = (volume: number, muted: boolean): VolumeLevel => {
  if (muted || volume === 0) {
    return 'muted';
  } else if (volume >= 0.5) {
    return 'high';
  } else {
    return 'low';
  }
};

/**
 * Get file extension from filename
 * @param filename - Name of the file
 * @returns File extension in lowercase
 */
export const getFileExtension = (filename: string): string => {
  return filename.split('.').pop()?.toLowerCase() || '';
};

/**
 * Check if file is a video file
 * @param filename - Name of the file
 * @returns True if file is video
 */
export const isVideoFile = (filename: string): boolean => {
  const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.wmv'];
  const ext = `.${getFileExtension(filename)}`;
  return videoExtensions.includes(ext);
};

/**
 * Check if file is an audio file
 * @param filename - Name of the file
 * @returns True if file is audio
 */
export const isAudioFile = (filename: string): boolean => {
  const audioExtensions = ['.mp3', '.wav', '.aac', '.flac', '.ogg'];
  const ext = `.${getFileExtension(filename)}`;
  return audioExtensions.includes(ext);
};

/**
 * Check if file is a supported media file
 * @param filename - Name of the file
 * @returns True if file is supported media
 */
export const isSupportedMediaFile = (filename: string): boolean => {
  return isVideoFile(filename) || isAudioFile(filename);
};

/**
 * Get media type from filename
 * @param filename - Name of the file
 * @returns Media type or null if not supported
 */
export const getMediaType = (filename: string): MediaType => {
  if (isVideoFile(filename)) return 'video';
  if (isAudioFile(filename)) return 'audio';
  return null;
};

/**
 * Create media file object from File
 * @param file - File object
 * @param folderPath - Folder path for relative path calculation
 * @returns Media file object or null if not supported
 */
export const createMediaFile = (file: File, folderPath: string = ''): MediaFile | null => {
  const mediaType = getMediaType(file.name);
  if (!mediaType) return null;

  return {
    file,
    url: URL.createObjectURL(file),
    name: file.name,
    type: mediaType,
    relativePath: folderPath ? 
      file.webkitRelativePath.substring(folderPath.length + 1) : 
      file.name
  };
};

/**
 * Process file list and return supported media files
 * @param fileList - List of files
 * @param folderPath - Optional folder path
 * @returns Array of media file objects
 */
export const processFileList = (fileList: FileList, folderPath: string = ''): MediaFile[] => {
  return Array.from(fileList)
    .map(file => createMediaFile(file, folderPath))
    .filter((file): file is MediaFile => file !== null);
};

/**
 * Get filename from URL
 * @param url - URL string
 * @returns Filename or "Unknown File"
 */
export const getFilenameFromUrl = (url: string): string => {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname?.split('/').pop() || "Unknown File";
  } catch {
    return "Unknown File";
  }
};

/**
 * Clamp value between min and max
 * @param value - Value to clamp
 * @param min - Minimum value
 * @param max - Maximum value
 * @returns Clamped value
 */
export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

/**
 * Adjust playback rate within reasonable bounds
 * @param currentRate - Current playback rate
 * @param adjustment - Adjustment amount
 * @returns New playback rate
 */
export const adjustPlaybackRate = (currentRate: number, adjustment: number): number => {
  const newRate = currentRate + adjustment;
  return clamp(newRate, 0.25, 4); // Common video player limits
};

/**
 * Skip time in video by specified seconds
 * @param videoElement - Video element
 * @param seconds - Seconds to skip (positive for forward, negative for backward)
 */
export const skipTime = (videoElement: HTMLVideoElement | null, seconds: number): void => {
  if (!videoElement) return;
  
  const newTime = videoElement.currentTime + seconds;
  videoElement.currentTime = clamp(newTime, 0, videoElement.duration || 0);
};

/**
 * Set volume with bounds checking
 * @param videoElement - Video element
 * @param volume - Volume level (0-1)
 */
export const setVolume = (videoElement: HTMLVideoElement | null, volume: number): void => {
  if (!videoElement) return;
  
  videoElement.volume = clamp(volume, 0, 1);
};

/**
 * Toggle fullscreen mode
 * @param element - Element to make fullscreen
 * @returns Promise that resolves when fullscreen state changes
 */
export const toggleFullscreen = async (element: HTMLElement | null): Promise<boolean> => {
  if (!element) return false;

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    } else {
      await element.requestFullscreen();
      return true;
    }
  } catch (error) {
    console.error('Fullscreen toggle failed:', error);
    return document.fullscreenElement !== null;
  }
};

/**
 * Toggle picture-in-picture mode
 * @param videoElement - Video element
 * @returns Promise that resolves when PiP state changes
 */
export const togglePictureInPicture = async (videoElement: HTMLVideoElement | null): Promise<boolean> => {
  if (!videoElement) return false;

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return false;
    } else {
      await videoElement.requestPictureInPicture();
      return true;
    }
  } catch (error) {
    console.error('Picture-in-picture toggle failed:', error);
    return document.pictureInPictureElement !== null;
  }
};

/**
 * Update timeline progress
 * @param videoElement - Video element
 * @param timelineElement - Timeline container element
 * @returns Current time info or null if elements are invalid
 */
export const updateTimelineProgress = (videoElement: HTMLVideoElement | null, timelineElement: HTMLElement | null): TimeInfo | null => {
  if (!videoElement || !timelineElement) return null;

  const currentTime = videoElement.currentTime;
  const duration = videoElement.duration;
  const percent = duration ? currentTime / duration : 0;

  timelineElement.style.setProperty("--progress-position", percent.toString());

  return {
    currentTime: formatDuration(currentTime),
    totalTime: formatDuration(duration),
    progress: percent
  };
};