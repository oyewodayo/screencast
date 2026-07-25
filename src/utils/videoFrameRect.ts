// utils/videoFrameRect.ts
//
// Pure geometry, no DOM dependency - mirrors measureTextBlock (pdfAnnotationHandlers.ts) in
// being a plain "given these numbers, return these numbers" helper the caller feeds real
// measurements into. Computes where the actual (letterboxed) picture sits inside its container
// under object-fit: contain - the container itself is rarely the same aspect ratio as the video
// (window resizing, different recordings), so the visible frame is usually inset from one axis.

export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeLetterboxRect(containerWidth: number, containerHeight: number, videoWidth: number, videoHeight: number): FrameRect {
  if (containerWidth <= 0 || containerHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }

  const containerAspect = containerWidth / containerHeight;
  const videoAspect = videoWidth / videoHeight;

  if (videoAspect > containerAspect) {
    // Video is relatively wider than its container - full width, letterboxed top/bottom.
    const width = containerWidth;
    const height = width / videoAspect;
    return { left: 0, top: (containerHeight - height) / 2, width, height };
  }

  // Video is relatively taller (or exactly matches) - full height, letterboxed left/right.
  const height = containerHeight;
  const width = height * videoAspect;
  return { left: (containerWidth - width) / 2, top: 0, width, height };
}
