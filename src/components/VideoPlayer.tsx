import './player.css';
import React, { useState, useRef, useEffect, ChangeEvent, MouseEvent } from 'react';
import { IoPause, IoPlay } from 'react-icons/io5';
import { IoIosArrowBack, IoIosArrowForward } from 'react-icons/io';
import { FaClosedCaptioning, FaCog } from 'react-icons/fa';
import { BsFullscreen, BsFullscreenExit } from 'react-icons/bs';
import { RxDoubleArrowLeft, RxDoubleArrowRight } from 'react-icons/rx';
import Alert from './custom/Alert';
import PlaytimeSettings from './custom/PlaytimeSettings';
import useAutoHideControls from '../hooks/useAutoHideControls';
import { MediaFile } from '../utils/videoUtils';

// Import utility functions
import {
  formatDuration,
  getVolumeLevel,
  adjustPlaybackRate,
  skipTime,
  setVolume,
  toggleFullscreen,
  togglePictureInPicture,
  updateTimelineProgress
} from '../utils/videoUtils';

import { handleAutoPlay } from '../handlers/mediaHandlers';

import { createKeyboardHandler } from '../handlers/keyboardHandlers';
import Dropdown from './custom/Dropdown';




interface PlayerState {
  isPlaying?: boolean;
  isPaused?: boolean;
  currentlyPlayingFile?: string | null;
  currentFileTitle?: string;
}

interface TimelineProgress {
  currentTime: string;
  totalTime: string;
}

type VolumeLevel = 'low' | 'high' | 'muted';
// PDFs are handled by the dedicated PdfAnnotator component (see Dashboard.tsx routing) —
// they never reach this component, so 'pdf' is intentionally not a MediaType here.
type MediaType = 'video' | 'audio' | 'image';

// Component interfaces for keyboard handler
interface KeyboardHandlerActions {
  togglePauseAndPlay: () => void;
  toggleFullScreenMode: () => Promise<void>;
  toggleTheaterMode: () => void;
  toggleMiniPlayerMode: () => Promise<void>;
  toggleMute: () => void;
  toggleCaptions: () => void;
  playbackSpeedIncrease: () => void;
  playbackSpeedReduce: () => void;
}
interface VideoPlayerProps {
  src?: string;
  title?: string;
  autoPlay?: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, title, autoPlay = true }) => {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  
  // Media type detection
  const [mediaType, setMediaType] = useState<MediaType>('video');
  // Core player state
  const [, setIsPaused] = useState<boolean>(true);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [, setIsMuted] = useState<boolean>(true);
  const [volume, setVolumeState] = useState<number>(1.0);
  const [volumeLevel, setVolumeLevel] = useState<VolumeLevel>('high');
  const [currentPlaySpeed, setCurrentPlaySpeed] = useState<string>("1x");

  // UI state
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isTheatherMode, setIsTheatherMode] = useState<boolean>(true);
  const [captionsVisible, setCaptionsVisible] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showSkipTime, setShowSkipTime] = useState<boolean>(false);

  // File and playlist state
  const [files] = useState<MediaFile[]>([]);
  const [currentlyPlayingFile, setCurrentlyPlayingFile] = useState<string | null>(null);
  const [currentFileTitle, setCurrentFileTitle] = useState<string>("");

  // Time and skip state
  const [currentTimeElement, setCurrentTimeElement] = useState<string>("0:00");
  const [totalTimeElement, setTotalTimeElement] = useState<string | null>(null);
  const [currentSkipTime, setCurrentSkipTime] = useState<number>(30);

  // Settings and preferences
  const [isAutoPlay, setAutoPlay] = useState<boolean>(true);
  const [videoOpacity, setVideoOpacity] = useState<number>(1.0);

  // Alert state
  const [showAlert, setShowAlert] = useState<boolean>(false);
  const [alertTitle] = useState<string>("Alert");
  const [alertMessage] = useState<string>("This is an alert message");

  const { visible, show, hide } = useAutoHideControls();

    // Helper function to detect media type
  const detectMediaType = (fileSrc: string): MediaType => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp', '.svg'];
    const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];

    // Query strings/fragments (e.g. Tauri asset URLs) can trail the real extension.
    const lowerSrc = fileSrc.toLowerCase().split(/[?#]/)[0];

    if (imageExtensions.some(ext => lowerSrc.endsWith(ext))) {
      return 'image';
    } else if (audioExtensions.some(ext => lowerSrc.endsWith(ext))) {
      return 'audio';
    }
    return 'video';
  };

  // Detect the media type and reset playback state whenever a new file is selected.
  useEffect(() => {
    if (!src) return;

    const type = detectMediaType(src);
    setMediaType(type);

    if (type === 'image') {
      setCurrentFileTitle(title || 'Image');
      setIsPaused(true);
      setIsPlaying(false);
    }
  }, [src, title]);

  // Load and play the file once the <video> element for it is actually mounted.
  // (It only mounts for the 'video'/'audio' types, so this can't run in the same
  // effect as media-type detection above without racing the render that swaps
  // the element in.)
  useEffect(() => {
    if ((mediaType === 'video' || mediaType === 'audio') && src && videoRef.current) {
      videoRef.current.src = src;
      if (autoPlay) videoRef.current.play().catch(() => {});
    }
  }, [mediaType, src, autoPlay]);

  // State update helper
  const updatePlayerState = (newState: PlayerState): void => {
    Object.entries(newState).forEach(([key, value]) => {
      switch (key) {
        case 'isPlaying':
          setIsPlaying(value as boolean);
          break;
        case 'isPaused':
          setIsPaused(value as boolean);
          break;
        case 'currentlyPlayingFile':
          setCurrentlyPlayingFile(value as string | null);
          break;
        case 'currentFileTitle':
          setCurrentFileTitle(value as string);
          break;
        default:
          break;
      }
    });
  };

  // Player controls
  const togglePauseAndPlay = (): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play();
      setIsPlaying(true);
      setIsPaused(false);
      requestAnimationFrame(updateTimeline);
    } else {
      video.pause();
      setIsPlaying(false);
      setIsPaused(true);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    }
  };

  const toggleMute = (): void => {
     if (mediaType !== 'video' && mediaType !== 'audio') return;
    const video = videoRef.current;
    if (!video) return;

    video.muted = !video.muted;
    setIsMuted(video.muted);
    setVolumeLevel(getVolumeLevel(video.volume, video.muted));
  };

  const toggleCaptions = (): void => {
    setCaptionsVisible(prev => !prev);
  };

  const toggleTheaterMode = (): void => {
    setIsTheatherMode(!isTheatherMode);
  };

  const toggleFullScreenMode = async (): Promise<void> => {
    const isFullscreenNow = await toggleFullscreen(videoContainerRef.current);
    setIsFullscreen(isFullscreenNow);
  };

  const toggleMiniPlayerMode = async (): Promise<void> => {
     if (mediaType !== 'video' && mediaType !== 'audio') return;
    await togglePictureInPicture(videoRef.current);
  };

  const playbackSpeedIncrease = (): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const video = videoRef.current;
    if (!video) return;

    const newRate = adjustPlaybackRate(video.playbackRate, 0.25);
    video.playbackRate = newRate;
    setCurrentPlaySpeed(`${newRate}x`);
  };

  const playbackSpeedReduce = (): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const video = videoRef.current;
    if (!video) return;

    const newRate = adjustPlaybackRate(video.playbackRate, -0.25);
    video.playbackRate = newRate;
    setCurrentPlaySpeed(`${newRate}x`);
  };

  const playbackSpeedNormal = (): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const video = videoRef.current;
    if (!video) return;

    video.playbackRate = 1;
    setCurrentPlaySpeed("1x");
  };

  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const newVolume = parseFloat(e.target.value);
    setVolumeState(newVolume);
    setVolume(videoRef.current, newVolume);
    setVolumeLevel(getVolumeLevel(newVolume, videoRef.current?.muted ?? false));
  };

  const handleForwardSkip = (): void => {
    setShowSkipTime(!showSkipTime);
  };

  const handleForwardSkipTime = (e: MouseEvent<HTMLButtonElement>): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const seconds = parseInt(e.currentTarget.innerText);
    skipTime(videoRef.current, seconds);
    setCurrentSkipTime(seconds);
    setShowSkipTime(false);
  };

  const handleBackwardSkipTime = (e: MouseEvent<HTMLButtonElement>): void => {
    if (mediaType !== 'video' && mediaType !== 'audio') return;
    const seconds = parseInt(e.currentTarget.innerText);
    skipTime(videoRef.current, -seconds);
    setCurrentSkipTime(seconds);
    setShowSkipTime(false);
  };

  const selectSkipTiming = (value: number): void => {
    setCurrentSkipTime(value);
    setShowSkipTime(false);
  };

  const toggleSettings = (): void => {
    setShowSettings(!showSettings);
  };

  const handleAutoplay = (): void => {
    setAutoPlay(!isAutoPlay);
  };

  const handleScreenControls = (): void => {
    // Implementation for screen controls
  };

  // Timeline and progress updates
  const updateTimeline = (): void => {
    if (videoRef.current && !videoRef.current.paused) {
      const progress: TimelineProgress | null = updateTimelineProgress(
        videoRef.current, 
        timelineContainerRef.current
      );
      
      if (progress) {
        setCurrentTimeElement(progress.currentTime);
        setTotalTimeElement(progress.totalTime);
      }
      
      animationFrameRef.current = requestAnimationFrame(updateTimeline);
    }
  };

  // Effects
  useEffect(() => {
     if (mediaType !== 'video' && mediaType !== 'audio') return; // Skip video event listeners for images
    
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = (): void => {
      setIsPlaying(true);
      setIsPaused(false);
      updateTimeline();
    };

    const handlePause = (): void => {
      setIsPlaying(false);
      setIsPaused(true);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };

    const handleVolumeChange = (): void => {
      setVolumeLevel(getVolumeLevel(video.volume, video.muted));
    };

    const handleEnded = (): void => {
      if (currentlyPlayingFile) { // This checks for both null and empty string
        handleAutoPlay(files, currentlyPlayingFile, video, updatePlayerState, isAutoPlay);
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('volumechange', handleVolumeChange);
    video.addEventListener('ended', handleEnded);

    // Set up keyboard shortcuts
    const keyboardHandler = createKeyboardHandler({
      togglePauseAndPlay,
      toggleFullScreenMode,
      toggleTheaterMode,
      toggleMiniPlayerMode,
      toggleMute,
      toggleCaptions,
      playbackSpeedIncrease,
      playbackSpeedReduce
    } as KeyboardHandlerActions);

    document.addEventListener('keydown', keyboardHandler);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('volumechange', handleVolumeChange);
      video.removeEventListener('ended', handleEnded);
      document.removeEventListener('keydown', keyboardHandler);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [files, currentlyPlayingFile, isAutoPlay, mediaType]);

  // Icons components (could be moved to separate file)
  const MiniPlayerIcon: React.FC = () => (
    <svg viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg" fill="#ffffff" stroke="#ffffff" strokeWidth="1.23">
      <g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
      <g id="SVGRepo_tracerCarrier" strokeLinecap="round" strokeLinejoin="round"></g>
      <g id="SVGRepo_iconCarrier">
        <g fill="none" fillRule="evenodd" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" transform="translate(3 4)">
          <path d="m2.5.5h10c1.1045695 0 2 .8954305 2 2v8c0 1.1045695-.8954305 2-2 2h-10c-1.1045695 0-2-.8954305-2-2v-8c0-1.1045695.8954305-2 2-2z"></path>
          <path d="m9.5 6.5h2c.5522847 0 1 .44771525 1 1v2c0 .5522847-.4477153 1-1 1h-2c-.55228475 0-1-.4477153-1-1v-2c0-.55228475.44771525-1 1-1z" fill="#000000"></path>
        </g>
      </g>
    </svg>
  );
  

  const VolumeLowIcon: React.FC = () => (
    <svg className="volume-low-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g id="SVGRepo_bgCarrier" strokeWidth="0"></g>
      <g id="SVGRepo_tracerCarrier" strokeLinecap="round" strokeLinejoin="round"></g>
      <g id="SVGRepo_iconCarrier">
        <path d="M21.7803 3.53033C22.0732 3.23744 22.0732 2.76256 21.7803 2.46967C21.4874 2.17678 21.0126 2.17678 20.7197 2.46967L16.2705 6.91886C16.2246 6.39532 16.1646 5.93197 16.077 5.52977C15.9052 4.74135 15.6003 4.05581 14.9609 3.60646C14.7259 3.44128 14.4642 3.30809 14.1923 3.21531C13.3741 2.9361 12.5608 3.15928 11.7348 3.56055C10.9212 3.95576 9.93412 4.60663 8.70324 5.41822L8.43647 5.59411C7.98856 5.88944 7.83448 5.98815 7.67513 6.05848C7.50452 6.13378 7.3252 6.18757 7.14132 6.21862C6.96956 6.24762 6.7866 6.25003 6.25008 6.25003L6.08906 6.24998C4.87215 6.24933 4.02659 6.24889 3.27496 6.59664C2.58016 6.9181 1.91141 7.54732 1.54828 8.22128C1.15566 8.94996 1.10959 9.712 1.04409 10.7955L1.03618 10.926C1.01373 11.2943 1 11.6585 1 12C1 12.3416 1.01373 12.7058 1.03618 13.0741L1.04409 13.2045C1.10959 14.2881 1.15566 15.0501 1.54828 15.7788C1.91141 16.4527 2.58016 17.082 3.27496 17.4034C3.88551 17.6859 4.55803 17.7386 5.44121 17.7481L2.71967 20.4697C2.42678 20.7626 2.42678 21.2374 2.71967 21.5303C3.01256 21.8232 3.48744 21.8232 3.78033 21.5303L21.7803 3.53033Z" fill="#ffffff"></path>
        <g opacity="0.4">
          <path d="M16.2382 9.07225L7.61424 17.6963C8.00956 18.1712 9.02592 18.8138 9.33873 19.0002C10.3775 19.6809 11.2373 20.2249 11.9702 20.5491C12.7125 20.8775 13.4501 21.0381 14.1921 20.7849C14.464 20.6921 14.7257 20.5589 14.9607 20.3937C15.6668 19.8975 15.9657 19.1135 16.1276 18.2141C16.2868 17.3297 16.3412 16.1578 16.409 14.6979L16.4117 14.6404C16.4635 13.5254 16.4998 12.5522 16.4998 12.0002C16.4998 11.9729 16.5 11.9363 16.5002 11.8916C16.503 11.3245 16.5122 9.46272 16.2382 9.07225Z" fill="#ffffff"></path>
          <path d="M20.5143 6.31657C20.8918 6.14622 21.336 6.3142 21.5063 6.69176C21.9734 7.7269 22.4998 9.45974 22.4998 12.0002C22.4998 14.1917 22.108 15.783 21.6998 16.8444C21.496 17.3742 21.2892 17.7693 21.1273 18.0392C21.0464 18.174 20.9768 18.2774 20.9246 18.3505C20.8984 18.3871 20.8767 18.4161 20.86 18.4377C20.8516 18.4485 20.8446 18.4574 20.8389 18.4645L20.8314 18.4738L20.8284 18.4774L20.8271 18.4789C20.8271 18.4789 20.826 18.4803 20.2512 18.0013L20.826 18.4803C20.5608 18.7985 20.0879 18.8415 19.7697 18.5763C19.453 18.3124 19.4089 17.8428 19.6698 17.5246L19.6733 17.5202L19.6834 17.5068C19.6888 17.4996 19.6957 17.4902 19.704 17.4787C19.7337 17.437 19.7813 17.3669 19.8411 17.2674C19.9604 17.0685 20.1286 16.7512 20.2998 16.3059C20.6416 15.4173 20.9998 14.0086 20.9998 12.0002C20.9998 9.67383 20.5192 8.15116 20.1391 7.30865C19.9687 6.93109 20.1367 6.48692 20.5143 6.31657Z" fill="#ffffff"></path>
          <path d="M19.3006 9.84771C19.2164 9.44214 18.8194 9.18162 18.4138 9.26583C18.0082 9.35003 17.7477 9.74706 17.8319 10.1526C17.9204 10.5789 17.9998 11.1874 17.9998 12.0002C17.9998 12.99 17.882 13.6773 17.7733 14.1014C17.7189 14.3137 17.6665 14.461 17.6316 14.5482C17.6141 14.5918 17.601 14.6205 17.5941 14.6349L17.5891 14.6452C17.3953 15.0058 17.5266 15.4563 17.8856 15.6558C18.2477 15.8569 18.7043 15.7265 18.9054 15.3644L18.2509 15.0008C18.9054 15.3644 18.9061 15.3631 18.9061 15.3631L18.9069 15.3617L18.9086 15.3586L18.9124 15.3515L18.9221 15.3332C18.9293 15.3191 18.9382 15.3014 18.9484 15.2798C18.9689 15.2368 18.9949 15.1788 19.0243 15.1053C19.0831 14.9581 19.1557 14.7492 19.2263 14.4739C19.3676 13.923 19.4998 13.1103 19.4998 12.0002C19.4998 11.0891 19.4107 10.3782 19.3006 9.84771Z" fill="#ffffff"></path>
        </g>
      </g>
    </svg>
  );

  const VolumeHighIcon: React.FC = () => (
    <svg className="volume-high-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
      <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
      <g id="SVGRepo_iconCarrier">
        <path fill="#ffffff" d="M2.00299 11.7155C2.04033 9.87326 2.059 8.95215 2.67093 8.16363C2.78262 8.0197 2.9465 7.8487 3.08385 7.73274C3.83639 7.09741 4.82995 7.09741 6.81706 7.09741C7.527 7.09741 7.88197 7.09741 8.22035 7.00452C8.29067 6.98522 8.36024 6.96296 8.4289 6.93781C8.75936 6.81674 9.05574 6.60837 9.64851 6.19161C11.9872 4.54738 13.1565 3.72527 14.138 4.08241C14.3261 4.15088 14.5083 4.24972 14.671 4.37162C15.5194 5.00744 15.5839 6.48675 15.7128 9.44537C15.7606 10.5409 15.7931 11.4785 15.7931 12C15.7931 12.5215 15.7606 13.4591 15.7128 14.5546C15.5839 17.5132 15.5194 18.9926 14.671 19.6284C14.5083 19.7503 14.3261 19.8491 14.138 19.9176C13.1565 20.2747 11.9872 19.4526 9.64851 17.8084C9.05574 17.3916 8.75936 17.1833 8.4289 17.0622C8.36024 17.037 8.29067 17.0148 8.22035 16.9955C7.88197 16.9026 7.527 16.9026 6.81706 16.9026C4.82995 16.9026 3.83639 16.9026 3.08385 16.2673C2.9465 16.1513 2.78262 15.9803 2.67093 15.8364C2.059 15.0478 2.04033 14.1267 2.00299 12.2845C2.00103 12.1878 2 12.0928 2 12C2 11.9072 2.00103 11.8122 2.00299 11.7155Z"></path>
        <path fill="#ffffff" fill-rule="evenodd" clip-rule="evenodd" d="M19.4895 5.55219C19.7821 5.29218 20.217 5.33434 20.4608 5.64635L19.931 6.11713C20.4608 5.64635 20.4606 5.64602 20.4608 5.64635L20.4619 5.6477L20.4631 5.64921L20.4658 5.65275L20.4727 5.66184C20.4779 5.6688 20.4844 5.67756 20.4921 5.68814C20.5075 5.70929 20.5275 5.73772 20.5515 5.77358C20.5995 5.84529 20.6635 5.94667 20.7379 6.07889C20.8868 6.34345 21.077 6.73092 21.2644 7.25038C21.6397 8.29107 22 9.85136 22 12.0002C22 14.1491 21.6397 15.7094 21.2644 16.7501C21.077 17.2695 20.8868 17.657 20.7379 17.9216C20.6635 18.0538 20.5995 18.1552 20.5515 18.2269C20.5275 18.2627 20.5075 18.2912 20.4921 18.3123C20.4844 18.3229 20.4779 18.3317 20.4727 18.3386L20.4658 18.3477L20.4631 18.3513L20.4619 18.3528C20.4616 18.3531 20.4608 18.3541 19.931 17.8833L20.4608 18.3541C20.217 18.6661 19.7821 18.7083 19.4895 18.4483C19.1983 18.1895 19.1578 17.729 19.3977 17.417C19.3983 17.4163 19.3994 17.4148 19.4009 17.4127C19.4058 17.406 19.4154 17.3925 19.4291 17.372C19.4565 17.3311 19.5003 17.2625 19.5552 17.1649C19.6649 16.9698 19.8195 16.6587 19.977 16.2221C20.2913 15.3508 20.6207 13.9695 20.6207 12.0002C20.6207 10.0309 20.2913 8.64968 19.977 7.77836C19.8195 7.34181 19.6649 7.03066 19.5552 6.8356C19.5003 6.73802 19.4565 6.66934 19.4291 6.62845C19.4154 6.608 19.4058 6.59449 19.4009 6.58778C19.3994 6.58561 19.3983 6.58416 19.3977 6.5834C19.3977 6.5834 19.3977 6.58341 19.3977 6.5834"></path>
        <path fill="#ffffff" fill-rule="evenodd" clip-rule="evenodd" d="M17.7571 8.41595C18.0901 8.21871 18.51 8.34663 18.6949 8.70166L18.0921 9.0588C18.6949 8.70166 18.6948 8.70134 18.6949 8.70166L18.6956 8.70295L18.6963 8.70432L18.6978 8.7073L18.7014 8.71428L18.7102 8.73227C18.7169 8.74607 18.7251 8.76348 18.7345 8.78457C18.7533 8.82676 18.7772 8.88363 18.8042 8.95574C18.8584 9.10004 18.9251 9.3049 18.99 9.57476C19.1199 10.115 19.2415 10.9119 19.2415 12.0003C19.2415 13.0888 19.1199 13.8857 18.99 14.4259C18.9251 14.6958 18.8584 14.9007 18.8042 15.045C18.7772 15.1171 18.7533 15.1739 18.7345 15.2161C18.7251 15.2372 18.7169 15.2546 18.7102 15.2684L18.7014 15.2864L18.6978 15.2934L18.6963 15.2964L18.6956 15.2978C18.6954 15.2981 18.6949 15.299 18.0921 14.9419L18.6949 15.299C18.51 15.6541 18.0901 15.782 17.7571 15.5847C17.427 15.3892 17.3063 14.9474 17.4846 14.5938L17.4892 14.5838C17.4955 14.5697 17.5075 14.5415 17.5236 14.4987C17.5557 14.4132 17.6039 14.2688 17.6539 14.0606C17.7539 13.6448 17.8622 12.9709 17.8622 12.0003C17.8622 11.0298 17.7539 10.3559 17.6539 9.94007C17.6039 9.73193 17.5557 9.58748 17.5236 9.50197C17.5075 9.45918 17.4955 9.43102 17.4892 9.41691L17.4846 9.40687C17.3063 9.05332 17.427 8.61152 17.7571 8.41595Z"></path>
      </g>
    </svg>
    
  );

  const VolumeMutedIcon: React.FC = () => (
    <svg className="volume-muted-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
      <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
      <g id="SVGRepo_iconCarrier">
        <path d="M22.5314 13.4197L21.0814 11.9697L22.4814 10.5697C22.7714 10.2797 22.7714 9.79969 22.4814 9.50969C22.1914 9.21969 21.7114 9.21969 21.4214 9.50969L20.0214 10.9097L18.5714 9.45969C18.2814 9.16969 17.8014 9.16969 17.5114 9.45969C17.2214 9.74969 17.2214 10.2297 17.5114 10.5197L18.9614 11.9697L17.4714 13.4597C17.1814 13.7497 17.1814 14.2297 17.4714 14.5197C17.6214 14.6697 17.8114 14.7397 18.0014 14.7397C18.1914 14.7397 18.3814 14.6697 18.5314 14.5197L20.0214 13.0297L21.4714 14.4797C21.6214 14.6297 21.8114 14.6997 22.0014 14.6997C22.1914 14.6997 22.3814 14.6297 22.5314 14.4797C22.8214 14.1897 22.8214 13.7197 22.5314 13.4197Z" fill="#ffffff"></path>
        <path d="M14.02 3.78168C12.9 3.16168 11.47 3.32168 10.01 4.23168L7.09 6.06168C6.89 6.18168 6.66 6.25168 6.43 6.25168H5.5H5C2.58 6.25168 1.25 7.58168 1.25 10.0017V14.0017C1.25 16.4217 2.58 17.7517 5 17.7517H5.5H6.43C6.66 17.7517 6.89 17.8217 7.09 17.9417L10.01 19.7717C10.89 20.3217 11.75 20.5917 12.55 20.5917C13.07 20.5917 13.57 20.4717 14.02 20.2217C15.13 19.6017 15.75 18.3117 15.75 16.5917V7.41168C15.75 5.69168 15.13 4.40168 14.02 3.78168Z" fill="#ffffff"></path>
      </g>
    </svg>
  );

  const renderVolumeIcon = (): JSX.Element => {
    switch (volumeLevel) {
      case 'low':
        return <VolumeLowIcon />;
      case 'high':
        return <VolumeHighIcon />;
      case 'muted':
      default:
        return <VolumeMutedIcon />;
    }
  };

  return (

   <div 
		onMouseMove={show}
		onMouseLeave={hide}
		onTouchStart={show}
		onTouchMove={show}
		onClick={handleScreenControls} 
		className="flex flex-row relative w-full h-screen">

		{showAlert && (
			<Alert
			title={alertTitle}
			message={alertMessage}
			labelBg="red"
			buttonLabel='Try again'
			onClose={() => setShowAlert(false)}
			/>
		)}
      
    	<div
        	className={`w-full video-container ${!isPlaying ? 'paused' : ''} ${captionsVisible ? 'captions' : ''} ${visible ? 'controls-visible' : ''} bg-black rounded`}
			ref={videoContainerRef}
			style={{ opacity: videoOpacity }}
			data-volume-level={volumeLevel}>
			{(mediaType === 'video' || mediaType === 'audio') && (
				<div>
					<img className="thumbnail-img" id="thumbnailImg" alt="Video thumbnail" />
					<div className="pointer-events-auto"></div>
					
					<div className="video-controls-container py-2 place-items-center">
					<div className="timeline-container" id="timelineContainer" ref={timelineContainerRef}>
						<div className="timeline">
						<img className="preview-img" id="previewImgSrc" alt="Video preview" />
						<div className="thumb-indicator"></div>
						</div>
					</div>
					
					<div className="controls flex flex-row justify-between mt-2">
						<div className='flex gap-5'>
						<button className="play-pause-btn" onClick={togglePauseAndPlay}>
							{isPlaying ? <IoPause className='text-3xl' /> : <IoPlay className='text-3xl' />}
						</button>
						
						<div className="volume-container">
							<button className="mute-btn z-20 w-7" onClick={toggleMute}>
							{renderVolumeIcon()}  
							</button>
							<input 
							className="volume-slider" 
							type="range" 
							min="0" 
							max="1" 
							value={volume} 
							step="any"
							onChange={handleVolumeChange}
							aria-orientation='vertical' 
							/>
						</div>

						<div className="duration-container">
							{currentFileTitle && (
							<>
								<div className="current-time">{currentTimeElement}</div>
								/
								<div className="total-time">{totalTimeElement}</div>
							</>
							)}
						</div>
						</div>
						
						<div className="flex flex-col place-items-center items-center">
						<div className='flex gap-4'>
							<button 
							className='flex justify-center place-items-center'
							onClick={handleBackwardSkipTime} 
							onDoubleClick={handleForwardSkip}
							>
							<RxDoubleArrowLeft className={`text-[20px]`} />
							<span className='text-[10px]'>{currentSkipTime}</span>
							</button>
							
							<button 
							className='flex justify-center place-items-center'
							onClick={handleForwardSkipTime} 
							onDoubleClick={handleForwardSkip}
							>
							<span className='text-[10px]'>{currentSkipTime}</span>
							<RxDoubleArrowRight className={`text-[20px]`} />
							</button>

							{showSkipTime && (
							<Dropdown onCallback={selectSkipTiming} />
							)}
						</div>
						</div>

						<div className='flex gap-5'>
						<div className='place-items-center flex'>
							<button className="playback-reduce" onClick={playbackSpeedReduce}>
							<IoIosArrowBack className='text-2xl' />
							</button>

							<button className="speed-btn wide-btn" onClick={playbackSpeedNormal}>
							{currentPlaySpeed}
							</button>

							<button className="playback-increase" onClick={playbackSpeedIncrease}>
							<IoIosArrowForward className='text-2xl' />
							</button>
						</div>

						<button className="captions-btn w-7" onClick={toggleCaptions}>
							<FaClosedCaptioning className={`w-[100%] text-2xl ${captionsVisible ? 'text-red-500' : 'text-white'}`} />
						</button>

						<button className="settings-btn w-7" onClick={toggleSettings}>
							<FaCog className='w-[100%] text-2xl' />
						</button>

						{showSettings && (
							<PlaytimeSettings
							onAutoplayChange={handleAutoplay}
							isAutoplay={isAutoPlay}
							playbackSpeed={currentPlaySpeed}
							onPlaybackSpeedChange={(speed: string) => {
								if (videoRef.current) {
								videoRef.current.playbackRate = parseFloat(speed);
								setCurrentPlaySpeed(`${speed}x`);
								}
							}}
							opacity={videoOpacity}
							onOpacityChange={setVideoOpacity}
							/>
						)}

						<button className="mini-player-btn w-7" onClick={toggleMiniPlayerMode}>
							<MiniPlayerIcon />
						</button>

						<button className="full-screen-btn w-7" onClick={toggleFullScreenMode}>
							{isFullscreen ? <BsFullscreenExit className='text-2xl' /> : <BsFullscreen className='text-2xl' />}
						</button>
						</div>
					</div>
					</div>
				</div>
			)}

			{
				mediaType === 'image' ? (
					<div>
						<img
						src={src}
						alt={currentFileTitle}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'contain',
							backgroundColor: '#000'
						}}
						/>
					</div>
				) : (
					<video
						ref={videoRef}
						onClick={togglePauseAndPlay}
						onLoadedMetadata={() => {
							if (videoRef.current) {
							setTotalTimeElement(formatDuration(videoRef.current.duration));
							}
						}}
					>
						<track
							kind="captions"
							src=""
							label="English"
							srcLang="en"
							default={captionsVisible}
						/>
					</video>
				)
			}
    	</div>

    </div>

  );
};

export default VideoPlayer;