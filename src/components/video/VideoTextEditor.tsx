// components/video/VideoTextEditor.tsx
//
// In-place editor for a video text overlay when its controls live in the sidebar (the docked
// Text panel, OverlayDockedPanels.tsx). Adapted from TextNoteEditor (pdf/) - same transparent
// textarea over a formatted "backdrop", same staged-content contract with the parent
// (onContentChange after every change, onCommit on blur/Ctrl+Enter, onCancel on Escape) - but:
//
//  - no formatting bar on the box: colour, highlight, bold/italic and alignment come from the
//    sidebar through the imperative handle below, so the box on the video is just the text;
//  - the backdrop is drawn exactly like the finished overlay (VideoOverlayLayer's read-only
//    render): live font size, padding, outline, corner shape, background and shadow, so every
//    sidebar change shows on the text immediately instead of only after the edit ends.
//
// What's left on the box itself is the minimum to place it: a small grip to drag it, a corner
// handle for text size, and the right edge for wrap width.
//
// Focus can go from the textarea into the sidebar panel (a typed slider value, the blend <select>)
// without ending the edit: the panel is marked with TEXT_EDIT_PANEL_ATTR, and while focus is in
// there the session ends instead on a click anywhere outside the panel and the box, or focus
// moving somewhere else.
//
// Everything the sidebar changes shows on the box as it's changed, the way the finished overlay
// will look: rotation and blend mode included, size/padding/colour/corner changes easing in
// rather than snapping, and picking an animation (or changing a reveal's settings) plays its
// entrance on the box once - previewAnimation below.
import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { IoMove } from "react-icons/io5";
import { applyColorRun, shiftColorRunsForEdit, shiftTextRangesForEdit, toggleTextRange } from "../../handlers/pdfAnnotationHandlers";
import { TextAlign, TextColorRun, TextRange } from "../../utils/pdfAnnotationTypes";
import { renderFormattedSegments } from "../../utils/textFormatting";
import { OverlayAnimation, TextOverlay, TextOverlayCornerStyle } from "../../utils/videoEditTypes";
import { caseText, textBoxBackgroundCss, textBoxBorderCss, textCornerRadiusPx, textLineHeight, usesCanvasText } from "../../utils/videoOverlayRender";
import { overlayAnimationStyle } from "../../utils/overlayAnimation";
import { TextReveal, isTextReveal, textRevealSeconds } from "../../utils/textReveal";
import { cssBlendMode } from "../../utils/blendModes";
import CanvasTextOverlay from "./CanvasTextOverlay";
import RevealText from "./RevealText";
import { titleFontStyle } from "../../utils/titleFonts";

const MIN_FONT_SIZE_PX = 8;
const MAX_FONT_SIZE_PX = 400;
const MIN_WIDTH_PX = 40;
// Move snapping: how close (screen px) catches, and the frame margin it also snaps to (the position
// pad's own margin).
const SNAP_PX = 6;
const SNAP_MARGIN = 0.04;

// How sidebar changes ease in on the box (a drag or a held slider just keeps retargeting it).
const LOOK_EASE = "180ms cubic-bezier(0.2, 0.8, 0.2, 1)";
// An animation preview: a whole-box entrance plays as on a title this long, held a beat once in;
// a reveal plays until its text is all in (capped).
const PREVIEW_LIFE_SEC = 2.4;
const PREVIEW_BOX_SEC = 1.0;
const PREVIEW_REVEAL_MAX_SEC = 4;
// The box itself glides to a new spot (the position pad) - not its width, which the textarea's
// height is measured against straight away.
const BOX_EASE = `left ${LOOK_EASE}, top ${LOOK_EASE}`;

// Marks the sidebar panel that drives this editor - focus may go there without committing.
export const TEXT_EDIT_PANEL_ATTR = "data-text-edit-panel";
const inPanel = (node: EventTarget | null): boolean => node instanceof Element && !!node.closest(`[${TEXT_EDIT_PANEL_ATTR}]`);

export interface VideoTextFormat {
  color: string;
  backgroundColor: string | undefined;
  textAlign: TextAlign;
}

export interface VideoTextEditorHandle {
  // Colour/bold/italic act on the selected characters - or on all of the text when nothing is
  // selected, so the sidebar buttons always do something visible.
  applyColor: (color: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  setBackground: (color: string | undefined) => void;
  setAlign: (align: TextAlign) => void;
  // Plays an animation's entrance on the box once (the one just picked, or the current one).
  previewAnimation: (animation: OverlayAnimation | undefined) => void;
}

interface VideoTextEditorProps {
  // Set when the overlay is keyframed: the box then moves, scales and fades along its keyframes
  // with the playhead (VideoOverlayLayer's keyframe loop drives every [data-kf-overlay] element).
  keyframedId?: string;
  left: number;
  top: number;
  width: number;
  fontSize: number;
  paddingPx: number;
  // Left/right padding (TextOverlay.paddingX) - defaults to paddingPx.
  paddingXPx?: number;
  strokeColor?: string;
  // Pixels on screen (VideoOverlayLayer scales the overlay's own strokeWidth to the frame).
  strokeWidth?: number;
  cornerStyle?: TextOverlayCornerStyle;
  // The title's face (titleFonts.ts) and tracking (fraction of the font size).
  fontFamily?: string;
  letterSpacing?: number;
  // The rest of its look (gradient, glow, shadow...) and the frame's size on screen: a title drawn
  // on canvas (usesCanvasText) is drawn the same way under the caret while it's typed.
  look?: Partial<TextOverlay>;
  frameWidth?: number;
  frameHeight?: number;
  initialText: string;
  initialColor: string;
  initialBackgroundColor: string | undefined;
  initialColorRuns: TextColorRun[];
  initialBoldRuns: TextRange[];
  initialItalicRuns: TextRange[];
  initialTextAlign: TextAlign;
  onContentChange: (
    text: string,
    color: string,
    backgroundColor: string | undefined,
    colorRuns: TextColorRun[],
    boldRuns: TextRange[],
    italicRuns: TextRange[],
    textAlign: TextAlign
  ) => void;
  // The whole-box formatting the sidebar displays as "current" (fires only when one changes).
  onFormatChange?: (format: VideoTextFormat) => void;
  onCommit: () => void;
  onCancel: () => void;
  onMoveEnd: (newLeft: number, newTop: number) => void;
  onResizeEnd: (newFontSize: number) => void;
  onResizeWidthEnd: (newWidth: number) => void;
  // Alt+arrow keys while typing: move the box by (dx, dy) frame pixels (1080-tall basis).
  onNudge?: (dx: number, dy: number) => void;
}

const VideoTextEditor = forwardRef<VideoTextEditorHandle, VideoTextEditorProps>(
  (
    {
      keyframedId,
      left,
      top,
      width: propWidth,
      fontSize: propFontSize,
      paddingPx,
      paddingXPx = paddingPx,
      strokeColor,
      strokeWidth,
      fontFamily,
      letterSpacing,
      look,
      frameWidth,
      frameHeight,
      cornerStyle,
      initialText,
      initialColor,
      initialBackgroundColor,
      initialColorRuns,
      initialBoldRuns,
      initialItalicRuns,
      initialTextAlign,
      onContentChange,
      onFormatChange,
      onCommit,
      onCancel,
      onMoveEnd,
      onResizeEnd,
      onResizeWidthEnd,
      onNudge,
    },
    ref
  ) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [liveSize, setLiveSize] = useState<{ width?: number; fontSize?: number } | null>(null);
    // What's drawn: a size drag in progress, else the props.
    const width = liveSize?.width ?? propWidth;
    const fontSize = liveSize?.fontSize ?? propFontSize;
    const lineHeight = textLineHeight(look ?? {});
    // Capitals (TextOverlay.textCase) are drawn letter for letter; the textarea keeps what was
    // typed and shows it uppercased by CSS, so the caret walks the same letters.
    const textCase = look?.textCase;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);
    // Guards against commit AND cancel both firing for one session (see TextNoteEditor).
    const resolvedRef = useRef(false);

    const [text, setText] = useState(initialText);
    const [color, setColor] = useState(initialColor);
    const [backgroundColor, setBackgroundColor] = useState<string | undefined>(initialBackgroundColor);
    const [colorRuns, setColorRuns] = useState<TextColorRun[]>(initialColorRuns);
    const [boldRuns, setBoldRuns] = useState<TextRange[]>(initialBoldRuns);
    const [italicRuns, setItalicRuns] = useState<TextRange[]>(initialItalicRuns);
    const [textAlign, setTextAlign] = useState<TextAlign>(initialTextAlign);

    const commit = (): void => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onCommit();
    };
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    // Focus went into the sidebar panel: end the session when the user leaves both it and the box.
    // Deferred a tick so a typed value the panel commits on its own blur lands in the session first.
    const watchPanelRef = useRef<(() => void) | null>(null);
    const watchPanel = (): void => {
      if (watchPanelRef.current) return;
      const finish = (): void => {
        stop();
        setTimeout(() => {
          if (resolvedRef.current) return;
          resolvedRef.current = true;
          onCommitRef.current();
        });
      };
      const insideBox = (node: EventTarget | null) => node instanceof Node && !!wrapperRef.current?.contains(node);
      const onPointerDown = (e: PointerEvent): void => {
        if (inPanel(e.target)) return;
        if (insideBox(e.target)) {
          if (e.target === textareaRef.current) stop();
          return;
        }
        (document.activeElement as HTMLElement | null)?.blur();
        finish();
      };
      const onFocusIn = (e: FocusEvent): void => {
        if (e.target === textareaRef.current) stop();
        else if (!inPanel(e.target) && !insideBox(e.target)) finish();
      };
      const stop = (): void => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        watchPanelRef.current = null;
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("focusin", onFocusIn, true);
      watchPanelRef.current = stop;
    };
    useEffect(() => () => watchPanelRef.current?.(), []);
    const cancel = (): void => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onCancel();
    };

    // The range a formatting action applies to: the selection, or everything.
    const targetRange = (): [number, number] => {
      const el = textareaRef.current;
      if (el && el.selectionStart !== el.selectionEnd) return [el.selectionStart, el.selectionEnd];
      return [0, text.length];
    };

    useImperativeHandle(ref, () => ({
      applyColor: (picked) => {
        const el = textareaRef.current;
        if (el && el.selectionStart !== el.selectionEnd) {
          const { selectionStart: start, selectionEnd: end } = el;
          setColorRuns((prev) => applyColorRun(prev, start, end, picked));
        } else {
          setColorRuns([]);
          setColor(picked);
        }
      },
      toggleBold: () => {
        const [start, end] = targetRange();
        if (end > start) setBoldRuns((prev) => toggleTextRange(prev, start, end));
      },
      toggleItalic: () => {
        const [start, end] = targetRange();
        if (end > start) setItalicRuns((prev) => toggleTextRange(prev, start, end));
      },
      setBackground: setBackgroundColor,
      setAlign: setTextAlign,
      previewAnimation: (animation) => {
        previewStartRef.current = performance.now();
        setPreview(animation && animation !== "none" ? { kind: animation, run: previewRunRef.current++ } : null);
      },
    }));

    // An animation playing on the box (previewAnimation). A whole-box entrance is written straight
    // onto animRef each frame; a reveal draws itself (RevealText / CanvasTextOverlay) from
    // previewTime.
    const [preview, setPreview] = useState<{ kind: OverlayAnimation; run: number } | null>(null);
    const previewStartRef = useRef(0);
    const previewRunRef = useRef(0);
    const animRef = useRef<HTMLDivElement>(null);
    const previewTime = () => (performance.now() - previewStartRef.current) / 1000;
    const lifeSec = look?.startTime !== undefined && look?.endTime !== undefined ? Math.max(0.5, look.endTime - look.startTime) : 5;
    useEffect(() => {
      if (!preview) return;
      const { kind } = preview;
      const reveal = isTextReveal(kind);
      const length = reveal
        ? Math.min(PREVIEW_REVEAL_MAX_SEC, textRevealSeconds(text, kind, lifeSec, look?.reveal) + (look?.reveal?.delay ?? 0) + 0.3)
        : PREVIEW_BOX_SEC;
      const el = animRef.current;
      let raf = 0;
      const tick = () => {
        const t = previewTime();
        if (t >= length) {
          setPreview(null);
          return;
        }
        if (!reveal && el && frameWidth && frameHeight) {
          const a = overlayAnimationStyle(kind, 0, PREVIEW_LIFE_SEC, t, frameWidth, frameHeight);
          el.style.opacity = String(a.opacity);
          el.style.transform = `translate(${a.translateXPx}px, ${a.translateYPx}px) scale(${a.scale * (a.scaleX ?? 1)}, ${a.scale})`;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
      return () => {
        cancelAnimationFrame(raf);
        if (el) {
          el.style.opacity = "";
          el.style.transform = "";
        }
      };
      // Plays once per previewAnimation call - text/look edits mid-run don't restart it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preview]);

    useEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.select();
    }, []);

    useEffect(() => {
      onContentChange(text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign);
    }, [text, color, backgroundColor, colorRuns, boldRuns, italicRuns, textAlign, onContentChange]);

    useEffect(() => {
      onFormatChange?.({ color, backgroundColor, textAlign });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [color, backgroundColor, textAlign]);

    // Keeps the textarea exactly as tall as the formatted text it sits over, whatever changed it -
    // typing, a size/width drag, or a size/padding change from the sidebar. Before paint, so the
    // box never shows a frame at the old height.
    useLayoutEffect(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [text, fontSize, paddingPx, paddingXPx, width, boldRuns, italicRuns, lineHeight, textCase]);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const newText = e.target.value;
      setColorRuns((prev) => shiftColorRunsForEdit(prev, text, newText));
      setBoldRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
      setItalicRuns((prev) => shiftTextRangesForEdit(prev, text, newText));
      setText(newText);
    };

    // Drag gestures stay imperative (direct style writes) until release, as in TextNoteEditor -
    // the final value goes up once, through the matching on*End callback.
    const startDrag = (
      e: React.PointerEvent<HTMLElement>,
      onMove: (dx: number, dy: number, ev: PointerEvent) => void,
      onUp: () => void
    ): void => {
      e.stopPropagation();
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      // The box follows the pointer exactly - no easing while it's dragged.
      const wrapper = wrapperRef.current;
      if (wrapper) wrapper.style.transition = "none";
      const move = (ev: PointerEvent) => onMove(ev.clientX - startX, ev.clientY - startY, ev);
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onUp();
        requestAnimationFrame(() => wrapper && (wrapper.style.transition = BOX_EASE));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    // Moving the box snaps it - its edges and centre to the frame's edges, centre lines and the 4%
    // margin the position pad uses - within a few pixels, showing a guide line where it's caught.
    // Hold Alt to place it freely.
    const guideXRef = useRef<HTMLDivElement>(null);
    const guideYRef = useRef<HTMLDivElement>(null);
    const handleMovePointerDown = (e: React.PointerEvent<HTMLElement>): void => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      // The box as it's seen (turned, scaled or keyframe-shifted), in the frame's own px.
      const parent = wrapper.offsetParent as HTMLElement | null;
      const r = wrapper.getBoundingClientRect();
      const pr = parent?.getBoundingClientRect();
      const box = { l: r.left - (pr?.left ?? 0), t: r.top - (pr?.top ?? 0), w: r.width, h: r.height };
      const fw = frameWidth ?? 0;
      const fh = frameHeight ?? 0;
      const snapOn = (start: number, size: number, frame: number, d: number): { d: number; at: number | null } => {
        if (frame <= 0) return { d, at: null };
        const targets = [0, frame * SNAP_MARGIN, frame / 2, frame * (1 - SNAP_MARGIN), frame];
        let best: { d: number; at: number | null; dist: number } = { d, at: null, dist: SNAP_PX + 0.001 };
        for (const anchor of [0, size / 2, size]) {
          for (const t of targets) {
            const dist = Math.abs(start + anchor + d - t);
            if (dist < best.dist) best = { d: t - start - anchor, at: t, dist };
          }
        }
        return best;
      };
      const showGuide = (el: HTMLDivElement | null, at: number | null, vertical: boolean) => {
        if (!el) return;
        el.style.display = at === null ? "none" : "block";
        if (at !== null) el.style[vertical ? "left" : "top"] = `${at}px`;
      };
      startDrag(
        e,
        (dx, dy, ev) => {
          const sx = ev.altKey ? { d: dx, at: null } : snapOn(box.l, box.w, fw, dx);
          const sy = ev.altKey ? { d: dy, at: null } : snapOn(box.t, box.h, fh, dy);
          wrapper.style.left = `${left + sx.d}px`;
          wrapper.style.top = `${top + sy.d}px`;
          showGuide(guideXRef.current, sx.at, true);
          showGuide(guideYRef.current, sy.at, false);
        },
        () => {
          showGuide(guideXRef.current, null, true);
          showGuide(guideYRef.current, null, false);
          onMoveEnd(parseFloat(wrapper.style.left), parseFloat(wrapper.style.top));
        }
      );
    };

    // A width or text-size drag is rendered, not written onto the textarea: the whole look (canvas
    // title, box fill, padding, corners) follows the handle frame by frame. Pointer moves are
    // coalesced to one update per animation frame, so a fast drag never queues up redraws.
    const dragFrameRef = useRef(0);
    useEffect(() => () => cancelAnimationFrame(dragFrameRef.current), []);
    const startLiveDrag = (e: React.PointerEvent<HTMLElement>, valueAt: (dx: number, dy: number) => { width?: number; fontSize?: number }, onEnd: (v: { width?: number; fontSize?: number }) => void): void => {
      let latest = valueAt(0, 0);
      startDrag(
        e,
        (dx, dy) => {
          latest = valueAt(dx, dy);
          if (dragFrameRef.current) return;
          dragFrameRef.current = requestAnimationFrame(() => {
            dragFrameRef.current = 0;
            setLiveSize(latest);
          });
        },
        () => {
          cancelAnimationFrame(dragFrameRef.current);
          dragFrameRef.current = 0;
          // The committed value and the end of the live one land in the same render - no flicker back.
          onEnd(latest);
          setLiveSize(null);
        }
      );
    };

    const handleSizePointerDown = (e: React.PointerEvent<HTMLElement>): void =>
      startLiveDrag(
        e,
        (_dx, dy) => ({ fontSize: Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, propFontSize + dy)) }),
        (v) => onResizeEnd(v.fontSize ?? propFontSize)
      );

    const handleWidthPointerDown = (e: React.PointerEvent<HTMLElement>): void =>
      startLiveDrag(
        e,
        (dx) => ({ width: Math.max(MIN_WIDTH_PX, propWidth + dx) }),
        (v) => onResizeWidthEnd(v.width ?? propWidth)
      );

    const richOverlay: TextOverlay | null =
      look && frameWidth && frameHeight
        ? {
            id: "editing",
            ...look,
            animation: preview && isTextReveal(preview.kind) ? preview.kind : undefined,
            keyframes: undefined,
            text,
            color,
            backgroundColor,
            colorRuns,
            boldRuns,
            italicRuns,
            textAlign,
            x: 0,
            y: 0,
            width: width / frameWidth,
            height: 0,
            fontSize: fontSize / frameHeight,
            padding: paddingPx / frameHeight,
            paddingX: paddingXPx / frameHeight,
            startTime: 0,
            endTime: lifeSec,
            createdAt: 0,
            updatedAt: 0,
          }
        : null;
    const onCanvas = !!richOverlay && usesCanvasText(richOverlay);
    const hasStroke = !onCanvas && !!(strokeColor && strokeWidth);
    // Same look VideoOverlayLayer gives the committed overlay - keep the two in step.
    const shared: React.CSSProperties = {
      ...titleFontStyle(fontFamily),
      fontSize,
      letterSpacing: letterSpacing ? `${letterSpacing}em` : undefined,
      lineHeight,
      padding: `${paddingPx}px ${paddingXPx}px`,
      textAlign,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
    };

    const previewingReveal = !!preview && isTextReveal(preview.kind);
    const rotate: React.CSSProperties = {
      transform: look?.rotation ? `rotate(${look.rotation}deg)` : undefined,
      transition: `transform ${LOOK_EASE}`,
    };

    // Two layers over one box: the look (as the finished overlay draws it - turned, blended,
    // animating), and on top the textarea and handles, turned the same way but never blended, so
    // the caret and the grips stay plain to see. No z-index on the wrapper - that would make it a
    // stacking context of its own and the blend would have no video to mix with.
    const guide = "absolute pointer-events-none bg-[#ff3d9a] shadow-[0_0_0_0.5px_rgba(0,0,0,0.35)]";
    return (
      <>
      <div ref={guideXRef} className={guide} style={{ display: "none", top: 0, height: frameHeight ?? "100%", width: 1, marginLeft: -0.5, zIndex: 21 }} />
      <div ref={guideYRef} className={guide} style={{ display: "none", left: 0, width: frameWidth ?? "100%", height: 1, marginTop: -0.5, zIndex: 21 }} />
      {/* Italic/bold on a face with no such file of its own is synthesised, as export draws it -
          the app turns synthesis off (App.css), which left the Italic button doing nothing here. */}
      <div ref={wrapperRef} data-kf-overlay={keyframedId} className="absolute" style={{ left, top, width, transition: BOX_EASE, fontSynthesis: "style weight" }}>
        {/* A keyframed fade dims the look only - the caret and handles stay solid to work with. */}
        <div className="absolute inset-0 pointer-events-none" style={{ ...rotate, mixBlendMode: cssBlendMode(look?.blendMode), opacity: keyframedId ? "var(--kf-opacity, 1)" : undefined }}>
          <div ref={animRef} className="absolute inset-0">
            {onCanvas && richOverlay && (
              <CanvasTextOverlay overlay={richOverlay} frameWidth={frameWidth!} frameHeight={frameHeight!} getTime={previewingReveal ? previewTime : () => 0} />
            )}
            <div
              ref={backdropRef}
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                ...shared,
                background: onCanvas ? "transparent" : textBoxBackgroundCss({ backgroundColor, boxFill: look?.boxFill }),
                boxShadow: onCanvas || !frameHeight ? undefined : textBoxBorderCss({ boxBorder: look?.boxBorder }, frameHeight),
                // Same radius the finished overlay and export use (CSS clamps a pill to half the box).
                borderRadius: cornerStyle === "pill" ? 9999 : textCornerRadiusPx(cornerStyle, Infinity, fontSize),
                WebkitTextStroke: hasStroke ? `${strokeWidth}px ${strokeColor}` : undefined,
                paintOrder: hasStroke ? "stroke fill" : undefined,
                textShadow: onCanvas || backgroundColor || look?.boxFill || hasStroke ? undefined : "0 1px 3px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.5)",
                transition: `background-color ${LOOK_EASE}, border-radius ${LOOK_EASE}, padding ${LOOK_EASE}`,
              }}
            >
              {onCanvas ? (
                <span style={{ color: "transparent" }}>{caseText(text, textCase)}</span>
              ) : previewingReveal && richOverlay ? (
                <RevealText overlay={{ ...richOverlay, text: caseText(text, textCase) }} kind={preview!.kind as TextReveal} paddingPx={paddingPx} paddingXPx={paddingXPx} getTime={previewTime} />
              ) : (
                renderFormattedSegments(caseText(text, textCase), colorRuns, boldRuns, italicRuns, color)
              )}
              {/* A trailing newline in a textarea adds a line the backdrop wouldn't otherwise have. */}
              {text.endsWith("\n") ?"​" : null}
            </div>
          </div>
        </div>
        <div className="relative" style={rotate}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleChange}
            onBlur={(e) => {
              // The window losing focus (another app, the eyedropper) isn't leaving the text - the
              // browser gives the textarea its focus back when the window returns.
              if (!document.hasFocus()) return;
              if (inPanel(e.relatedTarget)) watchPanel();
              else commit();
            }}
            onKeyDown={(e) => {
              e.stopPropagation(); // keep the timeline's shortcuts out of typing
              if (e.altKey && onNudge && e.key.startsWith("Arrow")) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                onNudge(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              } else if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const [start, end] = targetRange();
                if (end > start) setBoldRuns((prev) => toggleTextRange(prev, start, end));
              } else if (e.key.toLowerCase() === "i" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                const [start, end] = targetRange();
                if (end > start) setItalicRuns((prev) => toggleTextRange(prev, start, end));
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="Type something…"
            rows={1}
            className="relative block w-full placeholder-white/50"
            style={{
              ...shared,
              minHeight: fontSize * lineHeight + paddingPx * 2,
              textTransform: textCase === "upper" ? "uppercase" : undefined,
              color: "transparent",
              caretColor: color,
              background: "transparent",
              border: "none",
              resize: "none",
              overflow: "hidden",
              outline: "1.5px dashed rgba(255,255,255,0.7)",
              outlineOffset: 3,
            }}
          />
          {/* Move grip, just outside the top-left corner. */}
          <button
            type="button"
            title="Drag to move"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={handleMovePointerDown}
            className="absolute -left-3 -top-3 w-6 h-6 flex items-center justify-center rounded-full bg-blue-500 text-white shadow-md ring-2 ring-white/80 hover:bg-blue-400"
            style={{ cursor: "move" }}
          >
            <IoMove size={13} />
          </button>
          {/* Text size: drag the bottom-right handle down to grow, up to shrink. */}
          <div
            title="Drag to resize the text"
            onPointerDown={handleSizePointerDown}
            className="absolute -right-2 -bottom-2 w-3.5 h-3.5 rounded-sm bg-white ring-2 ring-blue-500 shadow"
            style={{ cursor: "nwse-resize" }}
          />
          {/* Wrap width: the right edge. */}
          <div
            title="Drag to change the width"
            onPointerDown={handleWidthPointerDown}
            className="absolute top-2 bottom-4 -right-2 w-2 group"
            style={{ cursor: "ew-resize" }}
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-1 rounded bg-white/40 group-hover:bg-blue-400 transition-colors" />
          </div>
        </div>
      </div>
      </>
    );
  }
);

VideoTextEditor.displayName = "VideoTextEditor";

export default VideoTextEditor;
