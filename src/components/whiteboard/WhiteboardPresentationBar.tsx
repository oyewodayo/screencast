// components/whiteboard/WhiteboardPresentationBar.tsx
//
// Broadcast-ready clean-feed control bar for Whiteboard Presentation Mode.
// Docked cleanly below `canvasHostRef` (outside the captured stage rectangle) so presenters have
// instant access to slide navigation, Laser Pointer, Pen annotation, microphone picker, and native
// GPU recording controls while ZERO pixels of UI chrome ever appear in the recorded `.mp4`.

import React, { memo, useState } from "react";
import {
  IoChevronBack,
  IoChevronForward,
  IoChevronUp,
  IoClose,
  IoMicOffOutline,
  IoMicOutline,
  IoPause,
  IoPencilOutline,
  IoPlay,
  IoRadioButtonOn,
  IoStop,
  IoVolumeHighOutline,
} from "react-icons/io5";
import type { PresentationRecordStatus } from "../../hooks/useWhiteboardPresentationRecorder";
import { formatRecordingTimer } from "../../utils/whiteboardRecording";

export interface PresentationSlide {
  id: string;
  label: string;
}

export interface WhiteboardPresentationRecorderControls {
  status: PresentationRecordStatus;
  externalRecordingActive?: boolean;
  onStopExternalRecording?: () => void;
  elapsedMs: number;
  micDevices: string[];
  selectedMic: string;
  onSelectMic: (mic: string) => void;
  includeSystemAudio: boolean;
  onIncludeSystemAudioChange: (on: boolean) => void;
  chapterCount: number;
  error: string | null;
  onClearError: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

interface WhiteboardPresentationBarProps {
  slides: PresentationSlide[];
  activeIndex: number;
  laserArmed: boolean;
  penArmed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (index: number) => void;
  onToggleLaser: () => void;
  onTogglePen: () => void;
  onExit: () => void;
  recorder?: WhiteboardPresentationRecorderControls;
}

const WhiteboardPresentationBar: React.FC<WhiteboardPresentationBarProps> = memo(
  ({
    slides,
    activeIndex,
    laserArmed,
    penArmed,
    onPrev,
    onNext,
    onJump,
    onToggleLaser,
    onTogglePen,
    onExit,
    recorder,
  }) => {
    const [jumpOpen, setJumpOpen] = useState(false);
    const [audioOpen, setAudioOpen] = useState(false);
    const current = slides[activeIndex];

    const recStatus = recorder?.status ?? "idle";
    const isRecording = recStatus === "recording";
    const isPaused = recStatus === "paused";
    const isBusy = recStatus === "starting" || recStatus === "stopping";
    const isActive = isRecording || isPaused;

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="relative z-30 shrink-0 flex items-center justify-center px-3 py-1.5 bg-neutral-950 border-t border-neutral-800/90 text-white select-none"
      >
        {recorder?.error && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 max-w-md flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/95 border border-red-700/80 text-red-100 text-xs shadow-2xl">
            <span className="truncate">{recorder.error}</span>
            <button
              type="button"
              onClick={recorder.onClearError}
              className="p-0.5 rounded hover:bg-white/10 text-red-200"
              title="Dismiss"
            >
              <IoClose size={13} />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-neutral-900 border border-neutral-700/80 shadow-lg">
          {/* Slide navigation */}
          <button
            type="button"
            onClick={onPrev}
            disabled={slides.length <= 1 || activeIndex <= 0}
            title="Previous frame (←)"
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-35 transition-colors"
          >
            <IoChevronBack size={15} />
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setAudioOpen(false);
                setJumpOpen((v) => !v);
              }}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-full hover:bg-white/10 text-xs font-medium transition-colors max-w-[220px]"
              title="Jump to slide"
            >
              <span className="tabular-nums text-neutral-400">
                {slides.length > 0 ? `${activeIndex + 1}/${slides.length}` : "1/1"}
              </span>
              <span className="truncate">{current?.label || "Full Canvas"}</span>
              {slides.length > 1 && <IoChevronUp size={11} className="opacity-60 shrink-0" />}
            </button>

            {jumpOpen && slides.length > 1 && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 max-h-64 overflow-y-auto rounded-xl bg-neutral-900 border border-neutral-700 shadow-2xl py-1 text-xs">
                {slides.map((s, idx) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      onJump(idx);
                      setJumpOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                      idx === activeIndex ? "bg-blue-600 text-white" : "text-neutral-200 hover:bg-white/10"
                    }`}
                  >
                    <span className="tabular-nums text-[10px] opacity-65 w-4">{idx + 1}</span>
                    <span className="truncate">{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onNext}
            disabled={slides.length <= 1 || activeIndex >= slides.length - 1}
            title="Next frame (→ or Space)"
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/10 disabled:opacity-35 transition-colors"
          >
            <IoChevronForward size={15} />
          </button>

          <div className="w-px h-4 bg-neutral-700 mx-1" />

          {/* Presenter annotation tools */}
          <button
            type="button"
            onClick={onToggleLaser}
            title="Laser pointer (L)"
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${
              laserArmed ? "bg-red-500 text-white" : "text-neutral-300 hover:bg-white/10"
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <span>Laser</span>
          </button>

          <button
            type="button"
            onClick={onTogglePen}
            title="Annotate with Pen (P)"
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${
              penArmed ? "bg-blue-600 text-white" : "text-neutral-300 hover:bg-white/10"
            }`}
          >
            <IoPencilOutline size={13} />
            <span>Draw</span>
          </button>

          {/* Clean-feed GPU recording controls */}
          {recorder && (
            <>
              <div className="w-px h-4 bg-neutral-700 mx-1" />

              {!isActive && recorder.externalRecordingActive ? (
                <div className="flex items-center gap-1.5">
                  <div
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-medium"
                    title="Another Briefcast recording is currently running"
                  >
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span>Recording active</span>
                  </div>
                  {recorder.onStopExternalRecording && (
                    <button
                      type="button"
                      onClick={recorder.onStopExternalRecording}
                      title="Stop the active recording"
                      className="flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
                    >
                      <IoStop size={12} />
                      <span>Stop</span>
                    </button>
                  )}
                </div>
              ) : !isActive ? (
                <div className="relative flex items-center gap-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setJumpOpen(false);
                      setAudioOpen((v) => !v);
                    }}
                    title={recorder.selectedMic ? `Microphone: ${recorder.selectedMic}` : "Audio settings (currently silent)"}
                    className={`flex items-center gap-1 h-7 px-2 rounded-full text-xs transition-colors disabled:opacity-40 ${
                      recorder.selectedMic
                        ? "text-neutral-200 hover:bg-white/10"
                        : "text-neutral-400 hover:bg-white/10"
                    }`}
                  >
                    {recorder.selectedMic ? <IoMicOutline size={14} /> : <IoMicOffOutline size={14} />}
                    <IoChevronUp size={10} className="opacity-60" />
                  </button>

                  {audioOpen && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-xl bg-neutral-900 border border-neutral-700 shadow-2xl p-2 text-xs flex flex-col gap-1.5">
                      <div className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                        Narration microphone
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          recorder.onSelectMic("");
                          setAudioOpen(false);
                        }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                          !recorder.selectedMic ? "bg-blue-600 text-white" : "text-neutral-200 hover:bg-white/10"
                        }`}
                      >
                        <IoMicOffOutline size={13} className="shrink-0" />
                        <span>Silent (no mic)</span>
                      </button>
                      {recorder.micDevices.map((mic) => (
                        <button
                          key={mic}
                          type="button"
                          onClick={() => {
                            recorder.onSelectMic(mic);
                            setAudioOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${
                            recorder.selectedMic === mic ? "bg-blue-600 text-white" : "text-neutral-200 hover:bg-white/10"
                          }`}
                        >
                          <IoMicOutline size={13} className="shrink-0" />
                          <span className="truncate">{mic}</span>
                        </button>
                      ))}
                      <div className="my-0.5 border-t border-neutral-800" />
                      <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/5 cursor-pointer text-neutral-200">
                        <input
                          type="checkbox"
                          checked={recorder.includeSystemAudio}
                          onChange={(e) => recorder.onIncludeSystemAudioChange(e.target.checked)}
                          className="accent-red-500"
                        />
                        <IoVolumeHighOutline size={13} className="shrink-0 opacity-75" />
                        <span>Include system audio</span>
                      </label>
                    </div>
                  )}

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setAudioOpen(false);
                      recorder.onStart();
                    }}
                    title="Record clean whiteboard presentation (this bar is excluded from the video and slides auto-create chapters)"
                    className="flex items-center gap-1.5 h-7 px-3 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 transition-colors"
                  >
                    {isBusy ? (
                      <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    ) : (
                      <IoRadioButtonOn size={13} />
                    )}
                    <span>{recStatus === "starting" ? "Starting…" : recStatus === "stopping" ? "Saving…" : "Record"}</span>
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <div
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-red-500/15 border border-red-500/40 text-red-200 text-xs font-medium tabular-nums"
                    title="Recording clean whiteboard stage — this control bar is not captured"
                  >
                    <span className={`w-2 h-2 rounded-full ${isPaused ? "bg-amber-400" : "bg-red-500 animate-pulse"}`} />
                    <span>{isPaused ? "PAUSED" : "REC"}</span>
                    <span>{formatRecordingTimer(recorder.elapsedMs)}</span>
                    {recorder.chapterCount > 0 && (
                      <span className="text-[10px] text-red-300/75 pl-1 border-l border-red-500/30">
                        {recorder.chapterCount} ch
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={isPaused ? recorder.onResume : recorder.onPause}
                    title={isPaused ? "Resume recording" : "Pause recording"}
                    className="w-7 h-7 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white transition-colors"
                  >
                    {isPaused ? <IoPlay size={13} /> : <IoPause size={13} />}
                  </button>
                  <button
                    type="button"
                    onClick={recorder.onStop}
                    title="Stop recording, save auto-chapters & open post-recording actions"
                    className="flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
                  >
                    <IoStop size={12} />
                    <span>Stop</span>
                  </button>
                </div>
              )}
            </>
          )}

          <div className="w-px h-4 bg-neutral-700 mx-1" />

          <button
            type="button"
            disabled={isBusy}
            onClick={onExit}
            title={isActive ? "Stop recording & exit presentation (Esc)" : "Exit presentation (Esc)"}
            className="flex items-center gap-1 h-7 px-2.5 rounded-full text-xs font-medium text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-40 transition-colors"
          >
            <IoClose size={14} />
            <span>Exit</span>
          </button>
        </div>
      </div>
    );
  }
);

WhiteboardPresentationBar.displayName = "WhiteboardPresentationBar";

export default WhiteboardPresentationBar;
