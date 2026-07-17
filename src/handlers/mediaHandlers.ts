  // handlers/mediaHandlers.ts
  import { processFileList, MediaFile, ProcessedFilesResult } from '../utils/videoUtils';



  interface PlayResult {
    success: boolean;
    alert?: {
      title: string;
      message: string;
    };
  }

  interface PlaylistResult {
    success: boolean;
    alert: {
      title: string;
      message: string;
    };
  }

  interface PlayerState {
    isPlaying?: boolean;
    isPaused?: boolean;
    currentlyPlayingFile?: string;
    currentFileTitle?: string;
  }

  type StateChangeCallback = (state: PlayerState) => void;
  type FilesProcessedCallback = (result: ProcessedFilesResult) => void;
  type PlaylistCreatedCallback = (result: PlaylistResult) => void;

  /**
   * Handle individual file selection
   * @param event - File input change event
   * @param onFilesProcessed - Callback when files are processed
   */
  export const handleFileSelection = (
    event: React.ChangeEvent<HTMLInputElement>,
    onFilesProcessed: (result: ProcessedFilesResult) => void
  ): void => {
    const inputFiles = event.target.files;
    if (!inputFiles || inputFiles.length === 0) return;

    const processedFiles = processFileList(inputFiles);
    
    const result: ProcessedFilesResult = {
      files: processedFiles,
      selectedFiles: processedFiles, // Changed from .map(f => f.file) to just processedFiles
      fileCount: processedFiles.length,
      folderName: "Selected Files",
      alertData: processedFiles.length > 0 ? {
        title: "Files Loaded",
        message: `Successfully loaded ${processedFiles.length} media files`
      } : {
        title: "No Media Files",
        message: "No supported media files found"
      }
    };

    onFilesProcessed(result);
  };

  /**
   * Handle folder/directory selection
   * @param event - File input change event
   * @param onFilesProcessed - Callback when files are processed
   */
  export const handleFolderSelection = (
    event: React.ChangeEvent<HTMLInputElement>,
    onFilesProcessed: FilesProcessedCallback
  ): void => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const folderPath = files[0].webkitRelativePath.split('/')[0];
    const processedFiles = processFileList(files, folderPath);

    const result: ProcessedFilesResult = {
      files: processedFiles,
      selectedFiles: processedFiles, // Changed from .map(f => f.file) to just processedFiles
      fileCount: processedFiles.length,
      folderName: folderPath,
      alertData: processedFiles.length > 0 ? {
        title: "Folder Loaded",
        message: `Successfully loaded ${processedFiles.length} media files from "${folderPath}"`
      } : {
        title: "No Media Files",
        message: `No supported media files found in "${folderPath}"`
      }
    };

    onFilesProcessed(result);
  };

  /**
   * Play a media file
   * @param file - Media file object
   * @param videoElement - Video element reference
   * @param onStateChange - Callback for state changes
   * @returns Promise with success status
   */
  export const playMediaFile = async (
    file: MediaFile,
    videoElement: HTMLVideoElement | null,
    onStateChange: StateChangeCallback
  ): Promise<PlayResult> => {
    if (!file.url || !file.type) return { success: false };

    const audioPlayer = document.getElementById('audioPlayer') as HTMLAudioElement | null;

    // Reset states
    onStateChange({
      isPlaying: false,
      isPaused: true,
      currentlyPlayingFile: file.url,
      currentFileTitle: file.name || "Unknown File"
    });

    try {
      if (file.type === 'video' && videoElement) {
        // Check if same video is already playing
        if (videoElement.src === file.url && !videoElement.paused) {
          return { 
            success: false, 
            alert: {
              title: "Alert",
              message: "This file is currently playing"
            }
          };
        }

        videoElement.src = file.url;
        videoElement.style.display = 'block';
        if (audioPlayer) audioPlayer.style.display = 'none';
        
        await videoElement.play();
        
        onStateChange({
          isPlaying: true,
          isPaused: false
        });
        
        return { success: true };
        
      } else if (file.type === 'audio' && audioPlayer) {
        audioPlayer.src = file.url;
        audioPlayer.style.display = 'block';
        if (videoElement) videoElement.style.display = 'none';

        await audioPlayer.play();
        
        onStateChange({
          isPlaying: true,
          isPaused: false
        });
        
        return { success: true };
      }
    } catch (error) {
      console.error("Playback failed:", error);
      onStateChange({
        isPlaying: false,
        isPaused: true
      });
      
      return { 
        success: false,
        alert: {
          title: "Playback Error",
          message: "Failed to play the selected file"
        }
      };
    }

    return { success: false };
  };

  /**
   * Create playlist from selected files
   * @param selectedFiles - Array of selected files
   * @param onPlaylistCreated - Callback when playlist is created
   */
  export const createPlaylist = (
    selectedFiles: MediaFile[],
    onPlaylistCreated?: PlaylistCreatedCallback
  ): PlaylistResult => {
    if (selectedFiles.length === 0) {
      const result = {
        success: false,
        alert: {
          title: "No Files",
          message: "No media files have been selected to create a playlist"
        }
      };
      onPlaylistCreated?.(result);
      return result;
    }

    // Here you could implement actual playlist functionality
    // For now, we just confirm playlist creation
    const result = {
      success: true,
      alert: {
        title: "Playlist Created",
        message: `Created playlist with ${selectedFiles.length} files`
      }
    };

    onPlaylistCreated?.(result);
    return result;
  };

  /**
   * Get next file in playlist
   * @param files - Array of media files
   * @param currentFileUrl - Currently playing file URL
   * @returns Next file or null if at end
   */
  export const getNextFile = (
    files: MediaFile[],
    currentFileUrl: string
  ): MediaFile | null => {
    const currentIndex = files.findIndex(file => file.url === currentFileUrl);
    if (currentIndex === -1 || currentIndex === files.length - 1) {
      return null;
    }
    return files[currentIndex + 1];
  };

  /**
   * Get previous file in playlist
   * @param files - Array of media files
   * @param currentFileUrl - Currently playing file URL
   * @returns Previous file or null if at beginning
   */
  export const getPreviousFile = (
    files: MediaFile[],
    currentFileUrl: string
  ): MediaFile | null => {
    const currentIndex = files.findIndex(file => file.url === currentFileUrl);
    if (currentIndex <= 0) {
      return null;
    }
    return files[currentIndex - 1];
  };

  /**
   * Auto-play next file when current ends
   * @param files - Array of media files
   * @param currentFileUrl - Currently playing file URL
   * @param videoElement - Video element reference
   * @param onStateChange - State change callback
   * @param autoPlay - Whether auto-play is enabled
   */
  export const handleAutoPlay = async (
    files: MediaFile[],
    currentFileUrl: string | null,  // Update parameter type
    videoElement: HTMLVideoElement | null,
    onStateChange: StateChangeCallback,
    autoPlay: boolean
  ): Promise<PlayResult | void> => {
    if (!autoPlay || !currentFileUrl) return;  // Add null check
    
    const nextFile = getNextFile(files, currentFileUrl);
    if (nextFile) {
      const result = await playMediaFile(nextFile, videoElement, onStateChange);
      return result;
    }
    
    return { success: false };
  };