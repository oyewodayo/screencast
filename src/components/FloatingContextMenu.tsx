import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// The folder galleries' right-click / kebab menu. Opens at the pointer like a native menu, but
// flips to the left of it near the right edge and upward near the bottom - a tile in the last
// column used to open a menu that ran off the window. Measured before paint, so it never flashes
// in the wrong place; scrolls inside itself if the window is shorter than the menu.
//
// Closes on a press anywhere outside it (pointerdown, so a press that opens another tile's menu
// isn't eaten by this one closing first), on Escape, and when the window resizes or blurs.

const EDGE = 8;

interface FloatingContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}

const FloatingContextMenu: React.FC<FloatingContextMenuProps> = ({ x, y, onClose, className, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x + width > vw - EDGE ? x - width : x;
    let top = y + height > vh - EDGE ? y - height : y;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - width - EDGE));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - height - EDGE));
    setPos({ left, top });
  }, [x, y]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const close = () => onCloseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        visibility: pos ? "visible" : "hidden",
        maxHeight: `calc(100vh - ${EDGE * 2}px)`,
        zIndex: 9999,
      }}
      className={`overflow-y-auto ${className ?? ""}`}
    >
      {children}
    </div>,
    document.body
  );
};

export default FloatingContextMenu;
