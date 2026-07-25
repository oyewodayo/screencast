// components/video/VideoOverlayLayer.tsx
//
// Mounted via VideoPlayer's `overlay` render-prop, sized/positioned to exactly the letterboxed
// picture (frameRect). Two overlay kinds live here, deliberately NOT sharing one editing model:
// text overlays reuse TextNoteEditor (see below) for the part that genuinely overlaps with PDF
// notes - typing, per-character formatting, box position/size - but everything about their video-
// specific *look* (stroke, background shape, fade animation) is owned entirely by this file and
// TextOverlay's own type, never touching TextNoteEditor or TextObject/PDF. Image overlays have no
// PDF equivalent at all and are driven end-to-end by this file's own drag/resize handlers - a
// video caption calls for different creative tools than a static PDF margin note, and trying to
// force both through one shared editor would mean either compromising one or bloating both.
//
// Text session model mirrors PdfPage.tsx's (see its EditingTextState/liveTextRef/
// commitEditingText/cancelEditingText) - nothing is written to the store while typing/dragging,
// only once a session resolves - but is DOM-only (no canvas, no scratch-layer drag preview) since
// there's no page bitmap to composite against here, and one deliberate difference: a freshly-
// placed overlay is created in the store immediately (so TextNoteEditor has a real id to attach to
// right away) rather than staged purely in refs - cancelling/emptying it just deletes that row
// instead of it never having existed.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import { FrameRect } from "../../utils/videoFrameRect";
import { ImageOverlay, TextOverlay, TextOverlayAnimation, TextOverlayCornerStyle } from "../../utils/videoEditTypes";
import { overlaysActiveAt } from "../../handlers/videoEditHandlers";
import { renderFormattedSegments } from "../../utils/textFormatting";
import { TEXT_FONT_FAMILY, measureTextBlock } from "../../handlers/pdfAnnotationHandlers";
import { TextAlign, TextColorRun, TextRange } from "../../utils/pdfAnnotationTypes";
import { FILE_CATEGORY_EXTENSIONS } from "../../utils/fileCategory";
import TextNoteEditor from "../pdf/TextNoteEditor";
import ColorSwatchPicker from "../pdf/ColorSwatchPicker";

export const DEFAULT_OVERLAY_WIDTH_FRACTION = 0.4;
export const DEFAULT_OVERLAY_FONT_FRACTION = 0.06;
export const DEFAULT_OVERLAY_DURATION_SEC = 5;
const DEFAULT_IMAGE_WIDTH_FRACTION = 0.25;
const MIN_IMAGE_WIDTH_PX = 24;
// First/last this many seconds of an overlay's time range ramp opacity for the "fade" animation -
// clamped against the overlay's own duration so a very short overlay still fades fully in before
// fading back out rather than the two ramps overlapping oddly.
const TEXT_FADE_DURATION_SEC = 0.4;

const TEXT_STYLE_PRESETS: { name: string; patch: TextOverlayContentPatch }[] = [
  { name: "Clean", patch: { backgroundColor: undefined, strokeColor: undefined, strokeWidth: undefined, cornerStyle: "square" } },
  { name: "Caption", patch: { backgroundColor: "rgba(0,0,0,0.65)", strokeColor: undefined, strokeWidth: undefined, cornerStyle: "pill" } },
  { name: "Outline", patch: { backgroundColor: undefined, strokeColor: "#000000", strokeWidth: 3, cornerStyle: "square" } },
];
const CORNER_OPTIONS: TextOverlayCornerStyle[] = ["square", "rounded", "pill"];

type TextOverlayContentPatch = Partial<
  Pick<
    TextOverlay,
    | "text"
    | "color"
    | "backgroundColor"
    | "colorRuns"
    | "boldRuns"
    | "italicRuns"
    | "textAlign"
    | "strokeColor"
    | "strokeWidth"
    | "cornerStyle"
    | "animation"
    | "x"
    | "y"
    | "width"
    | "height"
    | "fontSize"
  >
>;
type ImageOverlayContentPatch = Partial<Pick<ImageOverlay, "x" | "y" | "width" | "height" | "opacity" | "cornerRadius" | "rotation" | "borderColor" | "shadow">>;
// "rounded" is a flat px amount (converted to a frameRect.height fraction at click time) rather
// than scaling with the image's own size - same known simplification as the text overlay's own
// "rounded" corner option (see CORNER_OPTIONS above), simpler than keeping a radius visually
// consistent across a later resize. "round" computes true 50% of the image's current shorter side
// so it reads as a circle/stadium shape - also frozen at click time, so a later resize can throw
// it off proportionally; acceptable for what's meant to be a quick decorative toggle, not a
// tracked corner-shape mode.
const IMAGE_ROUNDED_CORNER_PX = 12;

// Local, not-yet-persisted position/size for whichever text overlay is currently open for editing
// - same reasoning as PdfPage's EditingTextState: position/size come from drag/resize handles and
// only need to be reactive (for the live editor's own position), not on every keystroke, so they
// stay separate from the plain-ref-staged text/formatting below.
interface EditingOverlayState {
  id: string;
  isNew: boolean;
  x: number;
  y: number;
  width: number;
  fontSize: number;
}

interface VideoOverlayLayerProps {
  frameRect: FrameRect;
  overlays: TextOverlay[];
  imageOverlays: ImageOverlay[];
  currentOutputTime: number;
  totalOutputDuration: number;
  selectedOverlayId: string | null;
  onSelectOverlay: (id: string | null) => void;
  selectedImageOverlayId: string | null;
  onSelectImageOverlay: (id: string | null) => void;
  // Text tool armed from VideoTimelineDocker's toolbar (lifted to Dashboard since that button and
  // this click surface live in separate subtrees) - the next click on the video places a new
  // overlay there and disarms itself via onPlacementConsumed.
  isPlacingText: boolean;
  onPlacementConsumed: () => void;
  onAddTextOverlay: (x: number, y: number, width: number, fontSize: number, startTime: number, endTime: number) => string;
  onUpdateTextOverlayContent: (id: string, patch: TextOverlayContentPatch) => void;
  onDeleteTextOverlay: (id: string) => void;
  onDuplicateTextOverlay: (id: string) => void;
  // Image tool armed the same way, but consumed immediately (opens the file picker as soon as
  // it's armed - no click-on-video step, unlike text, since an image's aspect ratio isn't known
  // until a file's actually picked, so there's nothing useful a pre-pick click position would add).
  isPlacingImage: boolean;
  onPlacementImageConsumed: () => void;
  onAddImageOverlay: (src: string, x: number, y: number, width: number, height: number, startTime: number, endTime: number) => string;
  onUpdateImageOverlayContent: (id: string, patch: ImageOverlayContentPatch) => void;
  // The keyboard shortcut still deletes directly via VideoTimelineDocker's own editStore access -
  // these exist for the right-click menu/Duplicate button this layer now has its own delete/
  // duplicate UI for.
  onDeleteImageOverlay: (id: string) => void;
  onDuplicateImageOverlay: (id: string) => void;
}

const VideoOverlayLayer: React.FC<VideoOverlayLayerProps> = ({
  frameRect,
  overlays,
  imageOverlays,
  currentOutputTime,
  totalOutputDuration,
  selectedOverlayId,
  onSelectOverlay,
  selectedImageOverlayId,
  onSelectImageOverlay,
  isPlacingText,
  onPlacementConsumed,
  onAddTextOverlay,
  onUpdateTextOverlayContent,
  onDeleteTextOverlay,
  onDuplicateTextOverlay,
  isPlacingImage,
  onPlacementImageConsumed,
  onAddImageOverlay,
  onUpdateImageOverlayContent,
  onDeleteImageOverlay,
  onDuplicateImageOverlay,
}) => {
  const [editingOverlay, setEditingOverlay] = useState<EditingOverlayState | null>(null);
  const editingOverlayRef = useRef(editingOverlay);
  useEffect(() => {
    editingOverlayRef.current = editingOverlay;
  }, [editingOverlay]);

  const overlaysRef = useRef(overlays);
  useEffect(() => {
    overlaysRef.current = overlays;
  }, [overlays]);

  // Staged live content, reported up by TextNoteEditor after every keystroke/format change - only
  // read back out at commit time, same "not React state up here" reasoning as PdfPage's own refs.
  // The video-only style fields below (stroke/corner/animation) are NOT staged here - see the
  // style panel further down, which writes them straight to the store on click instead, since
  // they're discrete one-click choices rather than continuous typing.
  const liveTextRef = useRef<string>("");
  const liveColorRef = useRef<string>("#ffffff");
  const liveBackgroundColorRef = useRef<string | undefined>(undefined);
  const liveColorRunsRef = useRef<TextColorRun[]>([]);
  const liveBoldRunsRef = useRef<TextRange[]>([]);
  const liveItalicRunsRef = useRef<TextRange[]>([]);
  const liveTextAlignRef = useRef<TextAlign>("left");

  const commitEditingOverlay = useCallback((): void => {
    const session = editingOverlayRef.current;
    if (!session) return;
    editingOverlayRef.current = null;
    setEditingOverlay(null);
    onSelectOverlay(null);

    const text = liveTextRef.current;
    if (text.trim().length === 0) {
      // Empty on commit deletes it either way - for a brand-new overlay that's "abandoned before
      // typing anything", for an existing one that's "cleared it out", matching PdfPage's own
      // isEmpty handling for both branches.
      onDeleteTextOverlay(session.id);
      return;
    }

    // measureTextBlock needs a single common px space for width and fontSize (see
    // videoEditTypes.ts's TextOverlay doc comment on why x/width and y/fontSize are fractions of
    // different bases) - device px via frameRect is that common space; the resulting height is
    // converted back to a frameRect.height fraction to store alongside the rest.
    const widthPx = session.width * frameRect.width;
    const fontSizePx = session.fontSize * frameRect.height;
    const { height: heightPx } = measureTextBlock(text, fontSizePx, widthPx);

    onUpdateTextOverlayContent(session.id, {
      text,
      color: liveColorRef.current,
      backgroundColor: liveBackgroundColorRef.current,
      colorRuns: liveColorRunsRef.current.length > 0 ? liveColorRunsRef.current : undefined,
      boldRuns: liveBoldRunsRef.current.length > 0 ? liveBoldRunsRef.current : undefined,
      italicRuns: liveItalicRunsRef.current.length > 0 ? liveItalicRunsRef.current : undefined,
      textAlign: liveTextAlignRef.current !== "left" ? liveTextAlignRef.current : undefined,
      x: session.x,
      y: session.y,
      width: session.width,
      fontSize: session.fontSize,
      height: frameRect.height > 0 ? heightPx / frameRect.height : session.fontSize * 1.3,
    });
  }, [frameRect, onSelectOverlay, onUpdateTextOverlayContent, onDeleteTextOverlay]);

  const cancelEditingOverlay = useCallback((): void => {
    const session = editingOverlayRef.current;
    editingOverlayRef.current = null;
    setEditingOverlay(null);
    onSelectOverlay(null);
    // A brand-new overlay was already created in the store (see handlePlaceText) purely so
    // TextNoteEditor had a real id to attach to - cancelling before committing anything means it
    // never really existed from the user's point of view, so it's deleted here, not kept empty.
    if (session?.isNew) onDeleteTextOverlay(session.id);
  }, [onSelectOverlay, onDeleteTextOverlay]);

  // Seeds local editing state whenever the lifted selection changes to an overlay this component
  // didn't just create itself (that path - handlePlaceText below - already seeds it directly with
  // isNew:true; skipped here so it isn't immediately overwritten with isNew:false in the same
  // render pass).
  useEffect(() => {
    if (!selectedOverlayId) {
      setEditingOverlay(null);
      return;
    }
    if (editingOverlayRef.current?.id === selectedOverlayId) return;
    const existing = overlaysRef.current.find((o) => o.id === selectedOverlayId);
    if (!existing) {
      setEditingOverlay(null);
      return;
    }
    liveTextRef.current = existing.text;
    liveColorRef.current = existing.color;
    liveBackgroundColorRef.current = existing.backgroundColor;
    liveColorRunsRef.current = existing.colorRuns ?? [];
    liveBoldRunsRef.current = existing.boldRuns ?? [];
    liveItalicRunsRef.current = existing.italicRuns ?? [];
    liveTextAlignRef.current = existing.textAlign ?? "left";
    setEditingOverlay({ id: existing.id, isNew: false, x: existing.x, y: existing.y, width: existing.width, fontSize: existing.fontSize });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOverlayId]);

  const handleNoteContentChange = useCallback(
    (
      text: string,
      color: string,
      backgroundColor: string | undefined,
      colorRuns: TextColorRun[],
      boldRuns: TextRange[],
      italicRuns: TextRange[],
      textAlign: TextAlign
    ): void => {
      liveTextRef.current = text;
      liveColorRef.current = color;
      liveBackgroundColorRef.current = backgroundColor;
      liveColorRunsRef.current = colorRuns;
      liveBoldRunsRef.current = boldRuns;
      liveItalicRunsRef.current = italicRuns;
      liveTextAlignRef.current = textAlign;
    },
    []
  );

  const handleNoteMoveEnd = useCallback(
    (newLeftDevicePx: number, newTopDevicePx: number): void => {
      if (frameRect.width <= 0 || frameRect.height <= 0) return;
      setEditingOverlay((prev) => (prev ? { ...prev, x: newLeftDevicePx / frameRect.width, y: newTopDevicePx / frameRect.height } : prev));
    },
    [frameRect]
  );
  const handleNoteResizeEnd = useCallback(
    (newFontSizeDevicePx: number): void => {
      if (frameRect.height <= 0) return;
      setEditingOverlay((prev) => (prev ? { ...prev, fontSize: newFontSizeDevicePx / frameRect.height } : prev));
    },
    [frameRect]
  );
  const handleNoteWidthResizeEnd = useCallback(
    (newWidthDevicePx: number): void => {
      if (frameRect.width <= 0) return;
      setEditingOverlay((prev) => (prev ? { ...prev, width: newWidthDevicePx / frameRect.width } : prev));
    },
    [frameRect]
  );

  // Click-to-place: creates the overlay eagerly (so there's a real id/row for TextNoteEditor to
  // attach to and for the timeline lane to show immediately) at sensible defaults centered under
  // the click, then opens it for editing right away - same "isNew" flow PdfPage's text tool uses.
  const handlePlaceText = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      const rect = e.currentTarget.getBoundingClientRect();
      const width = DEFAULT_OVERLAY_WIDTH_FRACTION;
      const fontSize = DEFAULT_OVERLAY_FONT_FRACTION;
      const nx = Math.max(0, Math.min((e.clientX - rect.left) / rect.width - width / 2, 1 - width));
      const ny = Math.max(0, Math.min((e.clientY - rect.top) / rect.height, 1 - fontSize * 1.3));
      const startTime = currentOutputTime;
      const endTime = Math.min(totalOutputDuration, startTime + DEFAULT_OVERLAY_DURATION_SEC);

      const id = onAddTextOverlay(nx, ny, width, fontSize, startTime, endTime > startTime ? endTime : startTime + DEFAULT_OVERLAY_DURATION_SEC);
      liveTextRef.current = "";
      liveColorRef.current = "#ffffff";
      liveBackgroundColorRef.current = undefined;
      liveColorRunsRef.current = [];
      liveBoldRunsRef.current = [];
      liveItalicRunsRef.current = [];
      liveTextAlignRef.current = "left";
      setEditingOverlay({ id, isNew: true, x: nx, y: ny, width, fontSize });
      onSelectOverlay(id);
      onPlacementConsumed();
    },
    [currentOutputTime, totalOutputDuration, onAddTextOverlay, onSelectOverlay, onPlacementConsumed]
  );

  // Everything the image-placement effect below needs, refreshed every render but read through a
  // ref rather than the effect's own dependency array - onPlacementImageConsumed in particular is
  // a fresh inline closure from Dashboard on every render (it's a plain `() => setIsPlacingImage
  // (false)`, not useCallback'd), and currentOutputTime changes continuously during playback. Both
  // of those cycling through the dependency array while the file dialog's own promise was still
  // pending was tearing the effect down and immediately re-running it - each re-run called
  // openFileDialog() again, stacking up native OS dialog windows faster than they could be
  // dismissed. Depending on isPlacingImage alone (see below) means the effect only ever runs once
  // per arm, however many times everything else re-renders while the dialog is still open.
  const placeImageContextRef = useRef({
    frameRect,
    currentOutputTime,
    totalOutputDuration,
    onAddImageOverlay,
    onSelectImageOverlay,
    onPlacementImageConsumed,
  });
  useEffect(() => {
    placeImageContextRef.current = { frameRect, currentOutputTime, totalOutputDuration, onAddImageOverlay, onSelectImageOverlay, onPlacementImageConsumed };
  });

  // Image placement: unlike text, there's no useful "click the video first" step - an image's
  // aspect ratio isn't known until a file's actually picked, so arming the tool goes straight to
  // the file picker. Runs once per isPlacingImage:false->true transition - see placeImageContextRef
  // above for why this depends on isPlacingImage alone rather than everything it actually uses.
  useEffect(() => {
    if (!isPlacingImage) return;
    // Snapshotted once, synchronously, right as placement is armed - not re-read after the
    // (possibly long) await below, so a video that keeps playing while the dialog is open doesn't
    // change where the image ends up landing out from under the user.
    const { frameRect, currentOutputTime, totalOutputDuration, onAddImageOverlay, onSelectImageOverlay, onPlacementImageConsumed } = placeImageContextRef.current;
    let cancelled = false;
    (async () => {
      try {
        const selected = await openFileDialog({ multiple: false, filters: [{ name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image }] });
        if (cancelled || !selected || Array.isArray(selected)) return; // cancelled

        const src = convertFileSrc(selected);
        const naturalSize = await new Promise<{ width: number; height: number } | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => resolve(null);
          img.src = src;
        });
        if (cancelled) return;

        const width = DEFAULT_IMAGE_WIDTH_FRACTION;
        // Preserves the image's real aspect ratio against the frame's actual pixel dimensions
        // (width/height fractions are normalized against *different* bases - frame width vs frame
        // height - so this conversion needs frameRect, not just the image's own pixel ratio).
        const imageAspect = naturalSize && naturalSize.height > 0 ? naturalSize.width / naturalSize.height : 1;
        const height = frameRect.height > 0 ? (width * frameRect.width) / imageAspect / frameRect.height : width;
        const nx = Math.max(0, Math.min(0.5 - width / 2, 1 - width));
        const ny = Math.max(0, Math.min(0.5 - height / 2, 1 - height));
        const startTime = currentOutputTime;
        const endTime = Math.min(totalOutputDuration, startTime + DEFAULT_OVERLAY_DURATION_SEC);

        const id = onAddImageOverlay(selected, nx, ny, width, height, startTime, endTime > startTime ? endTime : startTime + DEFAULT_OVERLAY_DURATION_SEC);
        onSelectImageOverlay(id);
      } catch (err) {
        console.error("Failed to add image overlay:", err);
      } finally {
        if (!cancelled) onPlacementImageConsumed();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlacingImage]);

  // ---- Image overlay drag (move) / resize (aspect-locked, corner handle) / rotate -------------
  //
  // All three follow the same rAF-throttled shape: raw pointermove events can fire far faster
  // than the display can paint (well past 60/sec on some mice/trackpads), and each one used to go
  // straight into setState - flooding React with more re-renders than the frame budget could
  // absorb, which is what read as "lags and freezes" during a drag. Each handler below instead
  // only ever records the *latest* pointer position into a ref (cheap, no re-render) and schedules
  // at most one state update per animation frame via requestAnimationFrame, reading the latest
  // ref value at the point it actually runs - so React never does more work than the screen can
  // actually show. onPointerCancel (alongside onPointerUp) resolves the drag the same way a
  // pointerup would - without it, a cancelled pointer sequence (alt-tab mid-drag, a stray OS
  // gesture, losing window focus) left the drag state permanently "stuck", which is its own way of
  // presenting as a freeze - nothing further would happen until an unrelated click reset it.

  const [imageDrag, setImageDrag] = useState<null | { id: string; startClientX: number; startClientY: number; startX: number; startY: number; liveX: number; liveY: number }>(
    null
  );
  const imageDragRafRef = useRef<number | null>(null);
  const imageDragLatestRef = useRef<{ clientX: number; clientY: number } | null>(null);

  const [imageResizeDrag, setImageResizeDrag] = useState<null | { id: string; startClientX: number; startWidthPx: number; aspect: number; liveWidthPx: number }>(null);
  const imageResizeRafRef = useRef<number | null>(null);
  const imageResizeLatestRef = useRef<number | null>(null);

  const [imageRotateDrag, setImageRotateDrag] = useState<null | { id: string; centerX: number; centerY: number; startAngle: number; startRotation: number; liveRotation: number }>(
    null
  );
  const imageRotateRafRef = useRef<number | null>(null);
  const imageRotateLatestRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Cancels any still-pending animation frame from an interrupted drag on unmount (e.g. switching
  // files mid-drag) - without this a late rAF callback could fire after the component's gone,
  // harmlessly no-op'd by React but worth not scheduling in the first place.
  useEffect(() => {
    return () => {
      if (imageDragRafRef.current != null) cancelAnimationFrame(imageDragRafRef.current);
      if (imageResizeRafRef.current != null) cancelAnimationFrame(imageResizeRafRef.current);
      if (imageRotateRafRef.current != null) cancelAnimationFrame(imageRotateRafRef.current);
    };
  }, []);

  const beginImageDrag = (overlay: ImageOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectImageOverlay(overlay.id);
    setImageDrag({ id: overlay.id, startClientX: e.clientX, startClientY: e.clientY, startX: overlay.x, startY: overlay.y, liveX: overlay.x, liveY: overlay.y });
  };
  const handleImageDragMove = (e: React.PointerEvent) => {
    if (!imageDrag) return;
    e.stopPropagation();
    imageDragLatestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (imageDragRafRef.current != null) return;
    imageDragRafRef.current = requestAnimationFrame(() => {
      imageDragRafRef.current = null;
      const latest = imageDragLatestRef.current;
      if (!latest || frameRect.width <= 0 || frameRect.height <= 0) return;
      setImageDrag((prev) => {
        if (!prev) return prev;
        const dx = (latest.clientX - prev.startClientX) / frameRect.width;
        const dy = (latest.clientY - prev.startClientY) / frameRect.height;
        return { ...prev, liveX: Math.max(0, Math.min(1, prev.startX + dx)), liveY: Math.max(0, Math.min(1, prev.startY + dy)) };
      });
    });
  };
  const endImageDrag = () => {
    if (!imageDrag) return;
    if (imageDragRafRef.current != null) {
      cancelAnimationFrame(imageDragRafRef.current);
      imageDragRafRef.current = null;
    }
    const { id, liveX, liveY } = imageDrag;
    setImageDrag(null);
    onUpdateImageOverlayContent(id, { x: liveX, y: liveY });
  };

  const beginImageResizeDrag = (overlay: ImageOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectImageOverlay(overlay.id);
    const startWidthPx = overlay.width * frameRect.width;
    const startHeightPx = overlay.height * frameRect.height;
    setImageResizeDrag({ id: overlay.id, startClientX: e.clientX, startWidthPx, aspect: startHeightPx > 0 ? startWidthPx / startHeightPx : 1, liveWidthPx: startWidthPx });
  };
  const handleImageResizeDragMove = (e: React.PointerEvent) => {
    if (!imageResizeDrag) return;
    e.stopPropagation();
    imageResizeLatestRef.current = e.clientX;
    if (imageResizeRafRef.current != null) return;
    imageResizeRafRef.current = requestAnimationFrame(() => {
      imageResizeRafRef.current = null;
      const latestClientX = imageResizeLatestRef.current;
      if (latestClientX == null) return;
      setImageResizeDrag((prev) => (prev ? { ...prev, liveWidthPx: Math.max(MIN_IMAGE_WIDTH_PX, prev.startWidthPx + (latestClientX - prev.startClientX)) } : prev));
    });
  };
  const endImageResizeDrag = () => {
    if (!imageResizeDrag) return;
    if (imageResizeRafRef.current != null) {
      cancelAnimationFrame(imageResizeRafRef.current);
      imageResizeRafRef.current = null;
    }
    if (frameRect.width > 0) {
      const { id, liveWidthPx, aspect } = imageResizeDrag;
      onUpdateImageOverlayContent(id, { width: liveWidthPx / frameRect.width, height: liveWidthPx / aspect / frameRect.height });
    }
    setImageResizeDrag(null);
  };

  // Angle is measured from the container's screen-space center (captured once, at drag start, via
  // the handle's own parent element - the image container itself - rather than re-measured every
  // move; rotating around a fixed center is both correct, since rotation never moves its own
  // center, and cheaper, since it avoids a layout read on every frame).
  const beginImageRotateDrag = (overlay: ImageOverlay) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelectImageOverlay(overlay.id);
    const containerRect = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    const centerX = containerRect ? containerRect.left + containerRect.width / 2 : e.clientX;
    const centerY = containerRect ? containerRect.top + containerRect.height / 2 : e.clientY;
    const startAngle = (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;
    const startRotation = overlay.rotation ?? 0;
    setImageRotateDrag({ id: overlay.id, centerX, centerY, startAngle, startRotation, liveRotation: startRotation });
  };
  const handleImageRotateDragMove = (e: React.PointerEvent) => {
    if (!imageRotateDrag) return;
    e.stopPropagation();
    imageRotateLatestRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (imageRotateRafRef.current != null) return;
    imageRotateRafRef.current = requestAnimationFrame(() => {
      imageRotateRafRef.current = null;
      const latest = imageRotateLatestRef.current;
      if (!latest) return;
      setImageRotateDrag((prev) => {
        if (!prev) return prev;
        const angle = (Math.atan2(latest.clientY - prev.centerY, latest.clientX - prev.centerX) * 180) / Math.PI;
        const rotation = (((prev.startRotation + (angle - prev.startAngle)) % 360) + 360) % 360;
        return { ...prev, liveRotation: rotation };
      });
    });
  };
  const endImageRotateDrag = () => {
    if (!imageRotateDrag) return;
    if (imageRotateRafRef.current != null) {
      cancelAnimationFrame(imageRotateRafRef.current);
      imageRotateRafRef.current = null;
    }
    const { id, liveRotation } = imageRotateDrag;
    setImageRotateDrag(null);
    onUpdateImageOverlayContent(id, { rotation: liveRotation });
  };

  const activeOverlays = overlaysActiveAt(overlays, currentOutputTime);
  const editingSession = editingOverlay && activeOverlays.some((o) => o.id === editingOverlay.id) ? editingOverlay : null;
  const editingOverlayData = editingSession ? overlays.find((o) => o.id === editingSession.id) : undefined;

  const activeImageOverlays = overlaysActiveAt(imageOverlays, currentOutputTime).map((o) => {
    if (imageDrag && o.id === imageDrag.id) return { ...o, x: imageDrag.liveX, y: imageDrag.liveY };
    if (imageResizeDrag && o.id === imageResizeDrag.id && frameRect.width > 0) {
      return { ...o, width: imageResizeDrag.liveWidthPx / frameRect.width, height: imageResizeDrag.liveWidthPx / imageResizeDrag.aspect / frameRect.height };
    }
    if (imageRotateDrag && o.id === imageRotateDrag.id) return { ...o, rotation: imageRotateDrag.liveRotation };
    return o;
  });
  const selectedImageOverlayData = selectedImageOverlayId ? activeImageOverlays.find((o) => o.id === selectedImageOverlayId) : undefined;

  // Fade-in/out opacity envelope for text overlays with animation:"fade" - ramps over the first/
  // last TEXT_FADE_DURATION_SEC of the overlay's own time range, clamped to half its duration so a
  // very short overlay still reaches full opacity before starting to fade back out.
  const fadeOpacity = (o: TextOverlay): number => {
    if (o.animation !== "fade") return 1;
    const ramp = Math.min(TEXT_FADE_DURATION_SEC, (o.endTime - o.startTime) / 2);
    if (ramp <= 0) return 1;
    const sinceStart = currentOutputTime - o.startTime;
    const untilEnd = o.endTime - currentOutputTime;
    return Math.max(0, Math.min(1, sinceStart / ramp, untilEnd / ramp));
  };

  const cornerRadiusCss = (style: TextOverlayCornerStyle | undefined, heightPx: number): number => {
    if (style === "pill") return heightPx / 2;
    if (style === "rounded") return 8;
    return 0;
  };

  const PANEL_HEIGHT_PX = 38;
  // Same .video-container overflow:hidden clipping the rotate handle's own comment explains -
  // a style panel anchored purely above a box (topPx - PANEL_HEIGHT_PX) silently disappears once
  // that box sits close enough to the frame's top edge. Flips to sitting just below the box's own
  // bottom edge instead once there isn't room above, rather than letting it clip.
  const panelTopPx = (topPx: number, boxHeightPx: number): number => (topPx >= PANEL_HEIGHT_PX ? topPx - PANEL_HEIGHT_PX : topPx + boxHeightPx + 6);

  const placingAnything = isPlacingText || isPlacingImage;

  // Right-click menu (Duplicate/Delete) for either overlay kind - rendered through a portal to
  // document.body, same reason ColorSwatchPicker's own popover does: .video-container clips with
  // overflow:hidden (see the rotate-handle/style-panel comments above), and a menu is far more
  // likely to land near an edge than either of those already-clipping-prone elements. Positioned
  // directly from the contextmenu event's own clientX/clientY rather than getBoundingClientRect()
  // on some anchor - there isn't a stable anchor element to measure here the way ColorSwatchPicker
  // has its trigger button.
  const [contextMenu, setContextMenu] = useState<{ kind: "text" | "image"; id: string; clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [contextMenu]);

  const openContextMenu = (kind: "text" | "image", id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (kind === "text") onSelectOverlay(id);
    else onSelectImageOverlay(id);
    setContextMenu({ kind, id, clientX: e.clientX, clientY: e.clientY });
  };

  return (
    <>
      {/* Click-elsewhere-to-deselect: only mounted while something's actually selected (so it
          never intercepts a plain click-to-pause/play on the video otherwise), and rendered first
          so it sits behind every real overlay below in stacking order - a click that actually
          lands on an overlay hits that overlay's own element first, never reaches this one, and
          each overlay's own handler already calls onSelectOverlay/onSelectImageOverlay itself. */}
      {(selectedOverlayId || selectedImageOverlayId) && !placingAnything && (
        <div
          className="absolute inset-0"
          style={{ pointerEvents: "auto" }}
          onClick={() => {
            onSelectOverlay(null);
            onSelectImageOverlay(null);
          }}
        />
      )}
      {activeImageOverlays.map((o) => {
        const isSelected = selectedImageOverlayId === o.id;
        const radiusPx = (o.cornerRadius ?? 0) * frameRect.height;
        // .video-container (the ancestor VideoPlayer renders all of this into) clips with
        // overflow:hidden, so a handle positioned purely by a fixed negative offset (e.g. always
        // 32px above the box) silently disappears - invisible, not just visually awkward - once an
        // overlay sits close enough to the top of the frame that the offset pushes it past y=0.
        // Clamping the rise to whatever room is actually available keeps the handle grabbable
        // (even if that means it sits closer to, or slightly over, the image) instead of vanishing.
        const roomAbovePx = o.y * frameRect.height;
        const rotateHandleRise = Math.min(32, Math.max(10, roomAbovePx - 2));
        const showRotateStem = roomAbovePx >= 32;
        return (
          <div
            key={o.id}
            onPointerDown={beginImageDrag(o)}
            onPointerMove={handleImageDragMove}
            onPointerUp={endImageDrag}
            onPointerCancel={endImageDrag}
            onContextMenu={openContextMenu("image", o.id)}
            title="Drag to move"
            className={`absolute cursor-move outline outline-2 transition-colors ${isSelected ? "outline-dashed outline-white" : "outline-transparent hover:outline-white/40"}`}
            style={{
              left: o.x * frameRect.width,
              top: o.y * frameRect.height,
              width: o.width * frameRect.width,
              height: o.height * frameRect.height,
              opacity: o.opacity,
              borderRadius: radiusPx,
              transform: o.rotation ? `rotate(${o.rotation}deg)` : undefined,
              // Border (inset) and drop shadow (outer) combine into one box-shadow rather than a
              // real `border` - a real border adds to the box's layout size unless box-sizing is
              // pinned, and box-shadow already composes multiple layers for free via commas.
              boxShadow: [o.borderColor ? `inset 0 0 0 3px ${o.borderColor}` : null, o.shadow ? "0 6px 16px rgba(0,0,0,0.45)" : null].filter(Boolean).join(", ") || undefined,
              pointerEvents: placingAnything ? "none" : "auto",
            }}
          >
            <img
              src={convertFileSrc(o.src)}
              draggable={false}
              alt=""
              className="w-full h-full object-contain pointer-events-none select-none"
              style={{ borderRadius: radiusPx }}
            />
            {isSelected && (
              <>
                <div
                  onPointerDown={beginImageResizeDrag(o)}
                  onPointerMove={handleImageResizeDragMove}
                  onPointerUp={endImageResizeDrag}
                  onPointerCancel={endImageResizeDrag}
                  title="Drag to resize"
                  className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-full bg-amber-400 hover:bg-amber-300 ring-2 ring-white/80 cursor-nwse-resize"
                />
                {/* Rotate handle - a short stem plus a round grip above top-center, the standard
                    affordance for "drag around the shape's own center" (distinct in both look and
                    cursor from the corner resize handle so the two are never mistaken). Position is
                    computed (rotateHandleRise/showRotateStem above), not a fixed Tailwind offset -
                    see that comment for why. */}
                {showRotateStem && (
                  <div
                    className="absolute left-1/2 -translate-x-1/2 w-px bg-amber-400/80 pointer-events-none"
                    style={{ top: -(rotateHandleRise - 8), height: rotateHandleRise - 8 }}
                  />
                )}
                <div
                  onPointerDown={beginImageRotateDrag(o)}
                  onPointerMove={handleImageRotateDragMove}
                  onPointerUp={endImageRotateDrag}
                  onPointerCancel={endImageRotateDrag}
                  title="Drag to rotate"
                  className="absolute left-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-amber-400 hover:bg-amber-300 ring-2 ring-white/80 cursor-grab active:cursor-grabbing"
                  style={{ top: -rotateHandleRise }}
                />
              </>
            )}
          </div>
        );
      })}

      {activeOverlays
        .filter((o) => o.id !== editingSession?.id)
        .map((o) => {
          const heightPx = o.fontSize * frameRect.height * 1.3;
          return (
            <div
              key={o.id}
              onClick={() => onSelectOverlay(o.id)}
              onContextMenu={openContextMenu("text", o.id)}
              className="absolute whitespace-pre-wrap break-words cursor-text outline outline-2 outline-transparent hover:outline-white/40 transition-colors"
              style={{
                left: o.x * frameRect.width,
                top: o.y * frameRect.height,
                width: o.width * frameRect.width,
                font: `${o.fontSize * frameRect.height}px ${TEXT_FONT_FAMILY}`,
                lineHeight: 1.3,
                padding: 2,
                textAlign: o.textAlign ?? "left",
                pointerEvents: placingAnything ? "none" : "auto",
                opacity: fadeOpacity(o),
                background: o.backgroundColor ?? "transparent",
                borderRadius: cornerRadiusCss(o.cornerStyle, heightPx),
                // -webkit-text-stroke draws centered on the glyph outline by default, which can eat
                // into thin strokes of the fill color on top of it - paint-order puts the stroke
                // fully behind the fill instead, the standard trick for a clean "outlined caption"
                // look (this is a Chromium/WebView2 app, so both properties are safe to rely on).
                WebkitTextStroke: o.strokeColor && o.strokeWidth ? `${o.strokeWidth}px ${o.strokeColor}` : undefined,
                paintOrder: o.strokeColor && o.strokeWidth ? "stroke fill" : undefined,
                // Default text has no backgroundColor and no stroke, so a plain drop-shadow keeps
                // it legible over arbitrary (light or busy) video content instead of only working
                // on dark footage - standard caption/title styling. Skipped once a stroke is set -
                // the two together look muddy, and the stroke alone already solves legibility.
                textShadow: o.backgroundColor || (o.strokeColor && o.strokeWidth) ? undefined : "0 1px 3px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.5)",
              }}
            >
              {renderFormattedSegments(o.text, o.colorRuns ?? [], o.boldRuns ?? [], o.italicRuns ?? [], o.color)}
            </div>
          );
        })}

      {editingSession && editingOverlayData && (
        <>
          {/* VideoPlayer's overlay wrapper is `pointer-events: none` by default (so clicks reach
              the video when there's nothing to interact with) - `pointer-events` is an inherited
              CSS property, and TextNoteEditor (reused as-is, not our code to edit) never opts back
              into `auto` itself the way our own read-only/placement divs already do. Without this
              wrapper every click inside the editor - the drag header, the color picker, the
              textarea itself - silently fell through to the <video> behind it instead of reaching
              the editor. Same reasoning applies to the style panel below. */}
          <div style={{ pointerEvents: "auto" }}>
            <TextNoteEditor
              key={editingSession.id}
              left={editingSession.x * frameRect.width}
              top={editingSession.y * frameRect.height}
              width={editingSession.width * frameRect.width}
              fontSize={editingSession.fontSize * frameRect.height}
              initialText={liveTextRef.current}
              initialColor={liveColorRef.current}
              initialBackgroundColor={liveBackgroundColorRef.current}
              initialColorRuns={liveColorRunsRef.current}
              initialBoldRuns={liveBoldRunsRef.current}
              initialItalicRuns={liveItalicRunsRef.current}
              initialTextAlign={liveTextAlignRef.current}
              onContentChange={handleNoteContentChange}
              onCommit={commitEditingOverlay}
              onCancel={cancelEditingOverlay}
              onMoveEnd={handleNoteMoveEnd}
              onResizeEnd={handleNoteResizeEnd}
              onResizeWidthEnd={handleNoteWidthResizeEnd}
            />
          </div>
          {/* Video-only creative styling - stroke/background-shape/fade animation apply straight
              to the store on click (each becomes its own undo step) rather than staging through
              TextNoteEditor's session, since these are discrete one-click choices, not continuous
              typing. Positioned a fixed offset above the editor's own header bar so the two don't
              overlap regardless of box width. */}
          <div
            style={{
              position: "absolute",
              left: editingSession.x * frameRect.width,
              top: panelTopPx(editingSession.y * frameRect.height, editingOverlayData.height * frameRect.height),
              pointerEvents: "auto",
              zIndex: 21,
            }}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-neutral-900/90 backdrop-blur-md shadow-lg ring-1 ring-white/10 whitespace-nowrap"
          >
            {TEXT_STYLE_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                title={preset.name}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onUpdateTextOverlayContent(editingOverlayData.id, preset.patch)}
                className="px-1.5 h-5 flex items-center rounded text-[10px] text-white/70 hover:text-white hover:bg-white/10 transition-colors"
              >
                {preset.name}
              </button>
            ))}
            <div className="w-px h-4 bg-white/15" />
            <div onMouseDown={(e) => e.preventDefault()} title="Outline color/width">
              <ColorSwatchPicker
                color={editingOverlayData.strokeColor ?? "#000000"}
                onChange={(c) => onUpdateTextOverlayContent(editingOverlayData.id, { strokeColor: c, strokeWidth: editingOverlayData.strokeWidth || 2 })}
                size="sm"
              />
            </div>
            <button
              type="button"
              title={editingOverlayData.strokeWidth ? "Remove outline" : "Add outline"}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                onUpdateTextOverlayContent(editingOverlayData.id, {
                  strokeWidth: editingOverlayData.strokeWidth ? undefined : 2,
                  strokeColor: editingOverlayData.strokeColor ?? "#000000",
                })
              }
              className={`px-1.5 h-5 flex items-center rounded text-[10px] transition-colors ${
                editingOverlayData.strokeWidth ? "text-blue-400 bg-blue-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              Outline
            </button>
            <div className="w-px h-4 bg-white/15" />
            {CORNER_OPTIONS.map((corner) => (
              <button
                key={corner}
                type="button"
                title={corner === "square" ? "Square corners" : corner === "rounded" ? "Rounded corners" : "Pill shape"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onUpdateTextOverlayContent(editingOverlayData.id, { cornerStyle: corner })}
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
                  (editingOverlayData.cornerStyle ?? "square") === corner ? "bg-blue-500/20 ring-1 ring-blue-400" : "hover:bg-white/10"
                }`}
              >
                <span
                  className="block w-2.5 h-2.5 bg-white/80"
                  style={{ borderRadius: corner === "pill" ? 999 : corner === "rounded" ? 3 : 0 }}
                />
              </button>
            ))}
            <div className="w-px h-4 bg-white/15" />
            <button
              type="button"
              title="Fade in/out over the overlay's time range"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                onUpdateTextOverlayContent(editingOverlayData.id, { animation: editingOverlayData.animation === "fade" ? "none" : ("fade" as TextOverlayAnimation) })
              }
              className={`px-1.5 h-5 flex items-center rounded text-[10px] transition-colors ${
                editingOverlayData.animation === "fade" ? "text-blue-400 bg-blue-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
              }`}
            >
              Fade
            </button>
            <div className="w-px h-4 bg-white/15" />
            <button
              type="button"
              title="Duplicate this text overlay"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onDuplicateTextOverlay(editingOverlayData.id)}
              className="px-1.5 h-5 flex items-center rounded text-[10px] text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            >
              Duplicate
            </button>
          </div>
        </>
      )}

      {selectedImageOverlayData && (
        <div
          style={{
            position: "absolute",
            left: selectedImageOverlayData.x * frameRect.width,
            top: panelTopPx(selectedImageOverlayData.y * frameRect.height, selectedImageOverlayData.height * frameRect.height),
            pointerEvents: "auto",
            zIndex: 21,
          }}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-neutral-900/90 backdrop-blur-md shadow-lg ring-1 ring-white/10 whitespace-nowrap"
        >
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={selectedImageOverlayData.opacity}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onUpdateImageOverlayContent(selectedImageOverlayData.id, { opacity: parseFloat(e.target.value) })}
            title="Opacity"
            className="w-16 accent-amber-400"
          />
          <div className="w-px h-4 bg-white/15" />
          {(["square", "rounded", "round"] as const).map((corner) => {
            const radiusFraction =
              corner === "square"
                ? 0
                : corner === "rounded"
                ? frameRect.height > 0
                  ? IMAGE_ROUNDED_CORNER_PX / frameRect.height
                  : 0
                : Math.min(selectedImageOverlayData.width * frameRect.width, selectedImageOverlayData.height * frameRect.height) / 2 / frameRect.height;
            const isActive = Math.abs((selectedImageOverlayData.cornerRadius ?? 0) - radiusFraction) < 0.001;
            return (
              <button
                key={corner}
                type="button"
                title={corner === "square" ? "Square corners" : corner === "rounded" ? "Rounded corners" : "Round"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onUpdateImageOverlayContent(selectedImageOverlayData.id, { cornerRadius: radiusFraction })}
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${isActive ? "bg-blue-500/20 ring-1 ring-blue-400" : "hover:bg-white/10"}`}
              >
                <span className="block w-2.5 h-2.5 bg-white/80" style={{ borderRadius: corner === "round" ? 999 : corner === "rounded" ? 3 : 0 }} />
              </button>
            );
          })}
          <div className="w-px h-4 bg-white/15" />
          <div onMouseDown={(e) => e.preventDefault()} title="Border color">
            <ColorSwatchPicker
              color={selectedImageOverlayData.borderColor ?? "#ffffff"}
              onChange={(c) => onUpdateImageOverlayContent(selectedImageOverlayData.id, { borderColor: c })}
              size="sm"
            />
          </div>
          <button
            type="button"
            title={selectedImageOverlayData.borderColor ? "Remove border" : "Add border"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              onUpdateImageOverlayContent(selectedImageOverlayData.id, { borderColor: selectedImageOverlayData.borderColor ? undefined : "#ffffff" })
            }
            className={`px-1.5 h-5 flex items-center rounded text-[10px] transition-colors ${
              selectedImageOverlayData.borderColor ? "text-blue-400 bg-blue-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            Border
          </button>
          <div className="w-px h-4 bg-white/15" />
          <button
            type="button"
            title="Drop shadow"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onUpdateImageOverlayContent(selectedImageOverlayData.id, { shadow: !selectedImageOverlayData.shadow })}
            className={`px-1.5 h-5 flex items-center rounded text-[10px] transition-colors ${
              selectedImageOverlayData.shadow ? "text-blue-400 bg-blue-500/10" : "text-white/70 hover:text-white hover:bg-white/10"
            }`}
          >
            Shadow
          </button>
          <div className="w-px h-4 bg-white/15" />
          <button
            type="button"
            title="Duplicate this image overlay"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onDuplicateImageOverlay(selectedImageOverlayData.id)}
            className="px-1.5 h-5 flex items-center rounded text-[10px] text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          >
            Duplicate
          </button>
        </div>
      )}

      {isPlacingText && (
        <div
          className="absolute inset-0 cursor-text pointer-events-auto outline outline-2 outline-dashed outline-blue-400/70 -outline-offset-2 flex items-start justify-center"
          onClick={handlePlaceText}
        >
          <span className="mt-2 px-2 py-0.5 rounded bg-blue-500/90 text-white text-xs pointer-events-none">
            Click anywhere on the video to place text
          </span>
        </div>
      )}

      {contextMenu &&
        createPortal(
          <div
            // Stops the document-level pointerdown listener above from closing the menu on the
            // same press that's opening it, and from closing it via a click on its own items
            // before their onClick has a chance to run (pointerdown fires before click).
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", left: contextMenu.clientX, top: contextMenu.clientY, zIndex: 9999 }}
            className="w-36 py-1 rounded-lg bg-neutral-900/95 backdrop-blur-md shadow-lg ring-1 ring-white/10 text-sm text-white/90"
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-white/10 transition-colors"
              onClick={() => {
                if (contextMenu.kind === "text") onDuplicateTextOverlay(contextMenu.id);
                else onDuplicateImageOverlay(contextMenu.id);
                setContextMenu(null);
              }}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-red-400 transition-colors"
              onClick={() => {
                if (contextMenu.kind === "text") {
                  onDeleteTextOverlay(contextMenu.id);
                  onSelectOverlay(null);
                } else {
                  onDeleteImageOverlay(contextMenu.id);
                  onSelectImageOverlay(null);
                }
                setContextMenu(null);
              }}
            >
              Delete
            </button>
          </div>,
          document.body
        )}
    </>
  );
};

export default VideoOverlayLayer;
