// components/docs/DocSignaturePlacer.tsx
//
// Placing a signature made in DocSignatureStudio: it follows the pointer over the page like a pen
// held above the paper, snapping to the margins and centre line, and settling onto any signing
// line it nears ("________", a dotted leader, a bordered paragraph or cell - docImagePlacement.ts)
// with the line lighting up. Click drops it there as a free picture in front of the text, anchored
// to the paragraph under it; it then writes itself on (DocImageView's ink-in). The wheel still
// scrolls the document; Esc or right-click cancels.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { collectInkLines, commitFreeImage, pageFrame, snapBox, type Guide, type InkLine, type SnapResult } from "../../utils/docImagePlacement";
import { markJustPlaced } from "./signatureStore";
import "./docSignature.css";

export interface PendingSignature {
  src: string;
  width: number;
  height: number;
  signer: string | null;
}

interface Props {
  editor: Editor;
  signature: PendingSignature;
  onDone: () => void;
}

const DocSignaturePlacer: React.FC<Props> = ({ editor, signature, onDone }) => {
  const { view } = editor;
  const overlayRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<InkLine[] | null>(null);
  const pointer = useRef<{ x: number; y: number; alt: boolean } | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const rafRef = useRef<number | null>(null);
  const { width: w, height: h } = signature;

  const ensureInk = useCallback(() => {
    if (inkRef.current) return inkRef.current;
    const frame = pageFrame(view);
    inkRef.current = frame ? collectInkLines(view, frame) : [];
    return inkRef.current;
  }, [view]);

  const update = useCallback(() => {
    const p = pointer.current;
    if (!p) return;
    const frame = pageFrame(view);
    // The pointer is the pen tip: it sits near the signature's baseline, left of centre.
    const raw = { left: p.x - w * 0.42, top: p.y - h * 0.78, width: w, height: h };
    setSnap(frame ? snapBox(raw, frame, ensureInk(), p.alt) : { left: raw.left, top: raw.top, guides: [], ink: null });
  }, [view, w, h, ensureInk]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      update();
    });
  }, [update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
      }
      if (e.key === "Alt" && pointer.current) {
        pointer.current.alt = e.type === "keydown";
        schedule();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [onDone, schedule]);

  const place = () => {
    const s = snap;
    if (!s) return;
    // The overlay would hide the page from ProseMirror's hit-testing (posAtCoords).
    if (overlayRef.current) overlayRef.current.style.pointerEvents = "none";
    const signedAt = new Date().toISOString();
    markJustPlaced(signature.src);
    const pos = commitFreeImage(view, {
      attrs: {
        src: signature.src,
        width: w,
        height: h,
        layout: "front",
        kind: "signature",
        signer: signature.signer,
        signedAt,
        alt: signature.signer ? `Signature of ${signature.signer}` : "Signature",
      },
      left: s.left,
      top: s.top,
      anchorAt: s.ink ? { x: (s.ink.left + s.ink.right) / 2, y: s.ink.y - 3 } : undefined,
    });
    if (pos !== null) view.focus();
    onDone();
  };

  const frame = snap ? pageFrame(view) : null;
  const overPage = !!(frame && snap && snap.left + w > frame.card.left && snap.left < frame.card.right && snap.top + h > frame.card.top && snap.top < frame.card.bottom);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[84]"
      style={{ cursor: overPage ? "none" : "default" }}
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
        schedule();
      }}
      onPointerLeave={() => setSnap(null)}
      onPointerDown={(e) => {
        if (e.button === 2) return onDone();
        if (e.button !== 0) return;
        e.preventDefault();
        pointer.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
        update();
        if (overPage) place();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        // Keep scrolling the document underneath while placing.
        const scroller = view.dom.closest(".overflow-y-auto") as HTMLElement | null;
        scroller?.scrollBy({ top: e.deltaY, left: e.deltaX });
        schedule();
      }}
    >
      <div className="doc-sig-placer-hint">
        {snap?.ink ? "Click to sign on the line" : "Click where you want to sign"}
        <kbd>Esc</kbd>
        <span className="opacity-70">cancel</span>
        <kbd>Alt</kbd>
        <span className="opacity-70">no snapping</span>
      </div>
      {snap && overPage && (
        <>
          {snap.guides.map((g: Guide, i: number) =>
            g.axis === "x" ? (
              <div key={i} className="doc-snap-guide fixed pointer-events-none" style={{ left: g.at - 0.5, top: g.from, width: 1, height: g.to - g.from, zIndex: 85 }} />
            ) : (
              <div key={i} className="doc-snap-guide fixed pointer-events-none" style={{ top: g.at - 0.5, left: g.from, height: 1, width: g.to - g.from, zIndex: 85 }} />
            )
          )}
          {snap.ink && <div className="doc-ink-line fixed pointer-events-none" style={{ left: snap.ink.left - 6, top: snap.ink.y - 1.5, width: snap.ink.right - snap.ink.left + 12, zIndex: 85 }} />}
          <img src={signature.src} alt="" draggable={false} className={`doc-sig-ghost ${snap.ink ? "is-settled" : ""}`} style={{ left: snap.left, top: snap.top, width: w, height: h }} />
        </>
      )}
    </div>,
    document.body
  );
};

export default DocSignaturePlacer;
