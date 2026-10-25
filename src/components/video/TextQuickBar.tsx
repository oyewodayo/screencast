// components/video/TextQuickBar.tsx
//
// The text box's toolbar on the video when the sidebar is closed - one tidy bar riding just above
// the box (below it near the top of the frame), the way a design tool's contextual bar sits on a
// selected text box. It carries what's reached for while typing: the face, size, colour and
// highlight, bold / italic / capitals, alignment, a ready-made style and an animation. Each deeper
// pick opens a small popover built from the sidebar panel's own parts (OverlayDockedPanels.tsx),
// so both places behave identically; "All settings" opens the sidebar with the full panel, where
// this bar hands over.
//
// Nothing here takes focus from the text being typed (buttons keep it; the bar and its popovers
// count as part of the text panel - TEXT_EDIT_PANEL_ATTR), so using it never ends the edit.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoArrowDown, IoArrowUp, IoChevronDown, IoCopyOutline, IoEllipsisHorizontal, IoOptionsOutline, IoSparklesOutline, IoTrashOutline } from "react-icons/io5";
import { MdFormatAlignCenter, MdFormatAlignJustify, MdFormatAlignLeft, MdFormatAlignRight } from "react-icons/md";
import { AnimationSection, FontSection, HIGHLIGHTS, SliderRow, Swatches, TEXT_COLORS, TextDockedPanelProps, TitleLookGallery, ValueField } from "./OverlayDockedPanels";
import { TEXT_EDIT_PANEL_ATTR } from "./VideoTextEditor";
import { titleFont, titleFontStyle } from "../../utils/titleFonts";
import { alphaOf, withAlpha } from "../../utils/cssColor";
import { TextAlign } from "../../utils/pdfAnnotationTypes";

const panelAttr = { [TEXT_EDIT_PANEL_ATTR]: "" };
// Buttons never take focus; inputs (the size field, a hex code) may - the text panel allows that.
const keepFocusUnlessInput = (e: React.MouseEvent) => {
  if (!(e.target instanceof Element && e.target.closest("input, select, textarea"))) e.preventDefault();
};

const GAP = 10; // bar to box
const EDGE = 4; // bar to frame edge

type PopoverKind = "font" | "colour" | "style" | "animate" | "more";

const ALIGNS: { value: TextAlign; icon: React.ReactNode; title: string }[] = [
  { value: "left", icon: <MdFormatAlignLeft size={16} />, title: "Aligned left" },
  { value: "center", icon: <MdFormatAlignCenter size={16} />, title: "Centred" },
  { value: "right", icon: <MdFormatAlignRight size={16} />, title: "Aligned right" },
  { value: "justify", icon: <MdFormatAlignJustify size={16} />, title: "Justified" },
];

export interface TextQuickBarProps extends TextDockedPanelProps {
  // The box and the frame, in the overlay layer's px - where the bar places itself.
  boxLeftPx: number;
  boxTopPx: number;
  boxWidthPx: number;
  boxHeightPx: number;
  frameWidthPx: number;
  frameHeightPx: number;
  // Opens the sidebar on the full text panel (ToolPanelOpenContext); absent where there's none.
  onOpenSettings?: () => void;
}

// A popover under (or above) its button, kept on screen, closing on a click elsewhere or Escape.
const Popover: React.FC<{ anchor: HTMLElement; width: number; onClose: () => void; children: React.ReactNode }> = ({ anchor, width, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const below = a.bottom + 8;
    const top = below + h > window.innerHeight - 8 && a.top - 8 - h > 8 ? a.top - 8 - h : Math.min(below, window.innerHeight - 8 - h);
    const left = Math.max(8, Math.min(a.left + a.width / 2 - width / 2, window.innerWidth - 8 - width));
    setPos({ left, top: Math.max(8, top) });
  }, [anchor, width]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && (ref.current?.contains(e.target) || anchor.contains(e.target))) return;
      onClose();
    };
    // Escape closes the popover - and stops there, so it doesn't also cancel the text edit.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      {...panelAttr}
      onMouseDown={keepFocusUnlessInput}
      className="fixed z-[10000] flex flex-col gap-3 p-3 rounded-xl bg-neutral-900/95 backdrop-blur-md text-white/90 shadow-2xl ring-1 ring-white/10 max-h-[70vh] overflow-y-auto overscroll-contain"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body
  );
};

const Divider = () => <span className="w-px h-5 mx-0.5 bg-white/10 shrink-0" />;

const BarButton: React.FC<{
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  open?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ title, onClick, active, open, className, children }) => (
  <button
    type="button"
    title={title}
    aria-pressed={active}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`h-7 min-w-7 px-1.5 shrink-0 flex items-center justify-center gap-1 rounded-md text-[12px] transition-colors ${
      active ? "bg-blue-500/25 text-blue-200" : open ? "bg-white/15 text-white" : "text-white/75 hover:text-white hover:bg-white/10"
    } ${className ?? ""}`}
  >
    {children}
  </button>
);

const TextQuickBar: React.FC<TextQuickBarProps> = (props) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [popover, setPopover] = useState<{ kind: PopoverKind; anchor: HTMLElement } | null>(null);
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Above the box; below it when there's no room above; never past the frame's sides.
  const above = props.boxTopPx - GAP - size.h;
  const top = above >= EDGE ? above : props.boxTopPx + props.boxHeightPx + GAP;
  const left = Math.max(EDGE, Math.min(props.boxLeftPx, props.frameWidthPx - size.w - EDGE));

  const toggle = (kind: PopoverKind) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    setPopover((p) => (p?.kind === kind ? null : { kind, anchor }));
  };
  const close = () => setPopover(null);
  const isOpen = (kind: PopoverKind) => popover?.kind === kind;

  const font = titleFont(props.look.fontFamily);
  const align = ALIGNS.find((a) => a.value === (props.textAlign ?? "left")) ?? ALIGNS[0];
  const nextAlign = ALIGNS[(ALIGNS.indexOf(align) + 1) % ALIGNS.length];
  const caps = props.look.textCase === "upper";

  return (
    <>
      <div
        ref={barRef}
        {...panelAttr}
        onMouseDown={keepFocusUnlessInput}
        className="absolute flex items-center gap-0.5 p-1 rounded-xl bg-neutral-900/95 backdrop-blur-md shadow-xl ring-1 ring-white/10 whitespace-nowrap transition-[top,left] duration-150 ease-out"
        style={{ left, top, zIndex: 22, pointerEvents: "auto", visibility: size.w ? "visible" : "hidden" }}
      >
        <BarButton title="Font" onClick={toggle("font")} open={isOpen("font")} className="max-w-[124px]">
          <span className="truncate text-[13px] leading-none" style={titleFontStyle(props.look.fontFamily)}>
            {font ? (font.caps ? font.label.toUpperCase() : font.label) : "System"}
          </span>
          <IoChevronDown size={10} className="shrink-0 text-white/45" />
        </BarButton>
        <ValueField value={props.fontSizePx} min={8} max={400} step={1} scale={1} format={(v) => `${Math.round(v)}`} onChange={props.onFontSizePx} />
        <Divider />
        {props.onTextColor && (
          <BarButton title="Text colour and highlight" onClick={toggle("colour")} open={isOpen("colour")}>
            <span className="flex flex-col items-center leading-none">
              <span className="text-[13px] font-semibold">A</span>
              <span className="mt-0.5 w-3.5 h-[3px] rounded-full ring-1 ring-white/20" style={{ background: props.textColor ?? props.look.color ?? "#ffffff" }} />
            </span>
          </BarButton>
        )}
        {props.onBold && (
          <BarButton title="Bold (Ctrl+B)" onClick={() => props.onBold?.()}>
            <span className="text-[13px] font-bold">B</span>
          </BarButton>
        )}
        {props.onItalic && (
          <BarButton title="Italic (Ctrl+I)" onClick={() => props.onItalic?.()}>
            <span className="text-[13px] italic font-serif">I</span>
          </BarButton>
        )}
        <BarButton title={caps ? "Back to the text as typed" : "ALL CAPITALS - without retyping"} active={caps} onClick={() => props.onLook({ textCase: caps ? undefined : "upper" })}>
          <span className="text-[10.5px] font-semibold tracking-wide">AA</span>
        </BarButton>
        {props.onAlign && (
          <BarButton title={`${align.title} - click for ${nextAlign.title.toLowerCase()}`} onClick={() => props.onAlign?.(nextAlign.value)}>
            {align.icon}
          </BarButton>
        )}
        <Divider />
        <BarButton title="Ready-made styles" onClick={toggle("style")} open={isOpen("style")}>
          <span className="text-[12px] font-semibold bg-gradient-to-br from-amber-200 to-pink-400 bg-clip-text text-transparent">Aa</span>
          <span>Style</span>
        </BarButton>
        <BarButton title="Animation" onClick={toggle("animate")} open={isOpen("animate")} active={!!props.animation && props.animation !== "none" && !isOpen("animate")}>
          <IoSparklesOutline size={14} />
          <span>Animate</span>
        </BarButton>
        <Divider />
        {props.onOpenSettings && (
          <BarButton title="All settings - open the full text panel in the sidebar" onClick={props.onOpenSettings}>
            <IoOptionsOutline size={15} />
          </BarButton>
        )}
        <BarButton title="More" onClick={toggle("more")} open={isOpen("more")}>
          <IoEllipsisHorizontal size={15} />
        </BarButton>
      </div>

      {popover?.kind === "font" && (
        <Popover anchor={popover.anchor} width={300} onClose={close}>
          <FontSection value={props.look.fontFamily} onChange={(fontFamily) => props.onLook({ fontFamily })} />
        </Popover>
      )}
      {popover?.kind === "colour" && (
        <Popover anchor={popover.anchor} width={272} onClose={close}>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-white/60">Text colour</span>
            <Swatches custom colors={TEXT_COLORS} value={props.textColor} onPick={(c) => c && props.onTextColor?.(c)} />
          </div>
          {props.onHighlight && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-white/60">Highlight</span>
              <Swatches
                custom
                matchRgb
                colors={HIGHLIGHTS.map((h) => h.value)}
                titles={HIGHLIGHTS.map((h) => h.title)}
                value={props.backgroundColor}
                onPick={(c) => props.onHighlight?.(!c || HIGHLIGHTS.some((h) => h.value === c) ? c : withAlpha(c, props.backgroundColor ? alphaOf(props.backgroundColor) : 1))}
              />
              {props.backgroundColor && (
                <SliderRow
                  label="Opacity"
                  value={Math.round(alphaOf(props.backgroundColor) * 100)}
                  min={5}
                  max={100}
                  step={1}
                  reset={100}
                  format={(v) => `${Math.round(v)}%`}
                  onChange={(v) => props.onHighlight?.(withAlpha(props.backgroundColor!, v / 100))}
                />
              )}
            </div>
          )}
          <span className="text-[10px] leading-snug text-white/35">Select words on the video to colour just those.</span>
        </Popover>
      )}
      {popover?.kind === "style" && (
        <Popover anchor={popover.anchor} width={300} onClose={close}>
          <TitleLookGallery look={props.look} onApply={props.onApplyLook} />
        </Popover>
      )}
      {popover?.kind === "animate" && (
        <Popover anchor={popover.anchor} width={300} onClose={close}>
          <AnimationSection text value={props.animation} onChange={props.onAnimation} />
        </Popover>
      )}
      {popover?.kind === "more" && (
        <Popover anchor={popover.anchor} width={188} onClose={close}>
          <div className="flex flex-col -m-1.5">
            {[
              { label: "Duplicate", icon: <IoCopyOutline size={14} />, run: props.onDuplicate },
              { label: "Bring to front", icon: <IoArrowUp size={14} />, run: props.onFront },
              { label: "Send to back", icon: <IoArrowDown size={14} />, run: props.onBack },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  item.run();
                  close();
                }}
                className="flex items-center gap-2.5 h-8 px-2 rounded-md text-[12px] text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <span className="text-white/55">{item.icon}</span>
                {item.label}
              </button>
            ))}
            <span className="my-1 h-px bg-white/10" />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onDelete}
              className="flex items-center gap-2.5 h-8 px-2 rounded-md text-[12px] text-red-300/90 hover:text-red-200 hover:bg-red-500/15 transition-colors"
            >
              <IoTrashOutline size={14} />
              Delete
            </button>
          </div>
        </Popover>
      )}
    </>
  );
};

export default TextQuickBar;
