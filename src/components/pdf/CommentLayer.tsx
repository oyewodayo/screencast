// components/pdf/CommentLayer.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PageViewport } from "pdfjs-dist";
import { IoChatbubbleEllipses, IoCopyOutline, IoCheckmark, IoPencil, IoTrashOutline } from "react-icons/io5";
import { CommentObject } from "../../utils/pdfAnnotationTypes";
import type { LocalRect } from "../../hooks/usePdfTextSelection";
import { CommentField, PendingTint, QuoteSnippet, copyText } from "./TextSelectionActions";

const PIN_SIZE_PX = 24;
const PIN_GAP_PX = 4;
const PIN_RIGHT_INSET_PX = 10;
const CARD_WIDTH_PX = 280;
const EDGE_MARGIN_PX = 8;

interface PlacedComment {
  comment: CommentObject;
  rects: LocalRect[];
  pinTop: number;
}

function toLocalRects(comment: CommentObject, viewport: PageViewport): LocalRect[] {
  return comment.rects.map((r) => {
    const [ax, ay] = viewport.convertToViewportPoint(r.x1, r.y1);
    const [bx, by] = viewport.convertToViewportPoint(r.x2, r.y2);
    return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  });
}

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

interface CommentLayerProps {
  comments: CommentObject[];
  viewport: PageViewport;
  interactive: boolean;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onEdit: (before: CommentObject, after: CommentObject) => void;
  onDelete: (comment: CommentObject) => void;
  // Set when a comment was picked from the Comments panel: its pin is scrolled into view and
  // pulses once. `nonce` re-triggers the arrival even when the same comment is picked twice.
  arrival?: { id: string; nonce: number } | null;
}

// Margin pins for every comment on the page (right edge, at the line its text starts on, nudged
// down so neighbors never overlap), a leader line tying the hovered/open pin back to its text, and
// the read/edit card for whichever one is open. The anchor tint itself is baked into the overlay
// canvas (pdfAnnotationHandlers' renderCommentObject) so exports keep it; this layer only adds the
// interactive chrome on top.
const CommentLayer: React.FC<CommentLayerProps> = ({ comments, viewport, interactive, openId, onOpen, onEdit, onDelete, arrival }) => {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const pinRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Waits out PdfAnnotator's own post-navigation scroll reset (two frames after a page change) so
  // the centering here is the one that sticks.
  useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => {
      pinRefs.current.get(arrival.id)?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [arrival]);

  const placed = useMemo<PlacedComment[]>(() => {
    const items = comments
      .map((comment) => {
        const rects = toLocalRects(comment, viewport);
        return { comment, rects, pinTop: Math.min(...rects.map((r) => r.top + r.height / 2)) - PIN_SIZE_PX / 2 };
      })
      .sort((a, b) => a.pinTop - b.pinTop);
    let floor = -Infinity;
    for (const item of items) {
      item.pinTop = Math.max(item.pinTop, floor);
      floor = item.pinTop + PIN_SIZE_PX + PIN_GAP_PX;
    }
    return items;
  }, [comments, viewport]);

  const pinLeft = viewport.width - PIN_SIZE_PX - PIN_RIGHT_INSET_PX;
  const focusId = openId ?? hoverId;
  const focused = placed.find((p) => p.comment.id === focusId) ?? null;
  const open = placed.find((p) => p.comment.id === openId) ?? null;

  return (
    <>
      {focused && <PendingTint rects={focused.rects} strong />}
      {focused && (() => {
        // Leader from the end of the comment's first line to its pin.
        const first = focused.rects.reduce((a, b) => (b.top < a.top ? b : a));
        const x1 = first.left + first.width + 2;
        const y1 = first.top + first.height / 2;
        const x2 = pinLeft;
        const y2 = focused.pinTop + PIN_SIZE_PX / 2;
        if (x2 - x1 < 6) return null;
        return (
          <svg className="absolute inset-0 pointer-events-none" width={viewport.width} height={viewport.height} style={{ zIndex: 16 }}>
            <path d={`M${x1},${y1} C${x1 + (x2 - x1) / 2},${y1} ${x1 + (x2 - x1) / 2},${y2} ${x2},${y2}`} fill="none" stroke="rgb(230,140,0)" strokeWidth={1.25} strokeDasharray="3 3" opacity={0.75} />
          </svg>
        );
      })()}
      {placed.map(({ comment, pinTop }) => {
        const active = comment.id === focusId;
        return (
          <button
            key={comment.id}
            ref={(el) => void (el ? pinRefs.current.set(comment.id, el) : pinRefs.current.delete(comment.id))}
            type="button"
            data-annotation-editor=""
            aria-label="Open comment"
            data-tip={openId === comment.id ? undefined : comment.text.length > 60 ? `${comment.text.slice(0, 60)}…` : comment.text}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpen(openId === comment.id ? null : comment.id)}
            onPointerEnter={() => setHoverId(comment.id)}
            onPointerLeave={() => setHoverId((id) => (id === comment.id ? null : id))}
            className="pdfPopIn absolute flex items-center justify-center rounded-full rounded-br-[4px] bg-amber-400 text-white shadow-[0_2px_8px_rgba(180,110,0,0.35)] ring-2 ring-white transition-transform duration-150 hover:scale-110"
            style={{
              left: pinLeft,
              top: pinTop,
              width: PIN_SIZE_PX,
              height: PIN_SIZE_PX,
              zIndex: 20,
              transform: active ? "scale(1.12)" : undefined,
              pointerEvents: interactive ? "auto" : "none",
            }}
          >
            <IoChatbubbleEllipses className="text-[13px]" />
            {arrival?.id === comment.id && <span key={arrival.nonce} aria-hidden className="pdfPinPulse absolute inset-0 rounded-full pointer-events-none" />}
          </button>
        );
      })}
      {open && interactive && (
        <CommentCard
          key={open.comment.id}
          comment={open.comment}
          left={Math.max(EDGE_MARGIN_PX, pinLeft - CARD_WIDTH_PX - 8)}
          top={Math.max(EDGE_MARGIN_PX, open.pinTop - 6)}
          onClose={() => onOpen(null)}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </>
  );
};

interface CommentCardProps {
  comment: CommentObject;
  left: number;
  top: number;
  onClose: () => void;
  onEdit: (before: CommentObject, after: CommentObject) => void;
  onDelete: (comment: CommentObject) => void;
}

const CommentCard: React.FC<CommentCardProps> = ({ comment, left, top, onClose, onEdit, onDelete }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent): void => {
      if (!ref.current || !(e.target instanceof Node) || ref.current.contains(e.target)) return;
      // A press on another pin is that pin's own toggle — closing here first would make it reopen.
      if (e.target instanceof Element && e.target.closest("[data-annotation-editor]")) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !editing) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose, editing]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1100);
    return () => window.clearTimeout(id);
  }, [copied]);

  const iconButton = "w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-800 transition-colors";

  return (
    <div
      ref={ref}
      data-annotation-editor=""
      onPointerDown={(e) => e.stopPropagation()}
      className="pdfPopIn absolute rounded-xl bg-white p-3 shadow-[0_12px_36px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.08]"
      style={{ left, top, width: CARD_WIDTH_PX, zIndex: 30, transformOrigin: "100% 0" }}
    >
      <QuoteSnippet text={comment.quote} />
      {editing ? (
        <CommentField
          initialText={comment.text}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(text) => {
            if (text !== comment.text) onEdit(comment, { ...comment, text, updatedAt: Date.now() });
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="text-[13px] leading-[1.5] text-neutral-900 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{comment.text}</p>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-neutral-400">
              {relativeTime(comment.createdAt)}
              {comment.updatedAt - comment.createdAt > 1000 ? " · edited" : ""}
            </span>
            <div className="flex items-center gap-0.5">
              <button type="button" aria-label="Edit comment" data-tip="Edit" onClick={() => setEditing(true)} className={iconButton}>
                <IoPencil className="text-[13px]" />
              </button>
              <button
                type="button"
                aria-label="Copy quoted text"
                data-tip={copied ? undefined : "Copy quoted text"}
                onClick={() => {
                  copyText(comment.quote);
                  setCopied(true);
                }}
                className={iconButton}
              >
                {copied ? <IoCheckmark className="text-[14px] text-emerald-500 pdfPopIn" /> : <IoCopyOutline className="text-[13px]" />}
              </button>
              <button
                type="button"
                aria-label="Delete comment"
                data-tip="Delete"
                onClick={() => {
                  onDelete(comment);
                  onClose();
                }}
                className={`${iconButton} hover:text-red-600! hover:bg-red-50!`}
              >
                <IoTrashOutline className="text-[13px]" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CommentLayer;
