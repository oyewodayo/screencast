// components/docker/ImageCollageDocker.tsx
//
// The image category's counterpart to VideoTimelineDocker - shown in the same bottom panel slot
// (via FileToolsDocker) once collage mode is toggled on (the sidebar's tools button, same one
// that opens video's timeline). A "timeline" of the images placed on the current photo: a
// thumbnail strip (select/jump to one on the canvas, drag to reorder its stacking position,
// delete), plus the "Arrange as grid" action that used to live in a toolbar popover - it fits
// more naturally down here now that this panel exists, alongside every other collage-specific
// control.
import React, { useCallback, useRef, useState } from "react";
import { IoCloseCircle, IoGridOutline } from "react-icons/io5";
import { UseImageEditStoreResult } from "../../hooks/useImageEditStore";
import { arrangeImagesInGrid } from "../../handlers/imageEditHandlers";
import { ImageAnnotationObject } from "../../utils/imageEditTypes";

type PlacedImage = Extract<ImageAnnotationObject, { type: "placed-image" }>;

const THUMB_SIZE = 64;
const MAX_COLUMNS = 8;

// Reassigns just the placed-images' own slots in `allObjects` to `newOrder`'s sequence, leaving
// every other object (and every placed-image's absolute array position) untouched - see this
// file's own module comment for why that's the right semantics for "reorder the images relative
// to each other" rather than a full-array replace.
function applyPlacedImageOrder(allObjects: ImageAnnotationObject[], newOrder: PlacedImage[]): ImageAnnotationObject[] {
  const queue = [...newOrder];
  return allObjects.map((o) => (o.type === "placed-image" ? queue.shift()! : o));
}

interface ImageCollageDockerProps {
  store: UseImageEditStoreResult;
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
}

const ImageCollageDocker: React.FC<ImageCollageDockerProps> = ({ store, selectedObjectId, onSelectObject }) => {
  const placedImages = (store.doc?.objects.filter((o) => o.type === "placed-image") ?? []) as PlacedImage[];

  // Non-null only while an actual drag gesture is in progress - the live-reordered array rendered
  // in place of `placedImages` for immediate feedback, committed to the store only on release
  // (same "stage locally, commit once" shape ImageOverlayCropPanel.tsx's own drag session uses).
  const [liveOrder, setLiveOrder] = useState<PlacedImage[] | null>(null);
  const draggingIdRef = useRef<string | null>(null);
  const thumbRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const stripRef = useRef<HTMLDivElement>(null);

  const displayImages = liveOrder ?? placedImages;

  const beginDrag = (id: string) => (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingIdRef.current = id;
    setLiveOrder(placedImages);
  };

  const handleDragMove = (e: React.PointerEvent): void => {
    const draggingId = draggingIdRef.current;
    if (!draggingId || !liveOrder) return;

    // Finds whichever thumbnail's horizontal midpoint the pointer is currently closest to, and
    // moves the dragged item to that slot - a simple, robust "nearest slot" reorder rather than
    // precise drop-zone math, since thumbnails are all the same fixed size.
    let closestIndex = 0;
    let closestDistance = Infinity;
    liveOrder.forEach((img, index) => {
      const el = thumbRefs.current.get(img.id);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const distance = Math.abs(e.clientX - midX);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    const currentIndex = liveOrder.findIndex((img) => img.id === draggingId);
    if (currentIndex === -1 || currentIndex === closestIndex) return;
    const next = [...liveOrder];
    const [moved] = next.splice(currentIndex, 1);
    next.splice(closestIndex, 0, moved);
    setLiveOrder(next);
  };

  const endDrag = (): void => {
    const draggingId = draggingIdRef.current;
    draggingIdRef.current = null;
    if (!draggingId || !liveOrder || !store.doc) {
      setLiveOrder(null);
      return;
    }
    const orderChanged = liveOrder.some((img, i) => img.id !== placedImages[i]?.id);
    if (orderChanged) store.reorderObjects(applyPlacedImageOrder(store.doc.objects, liveOrder));
    setLiveOrder(null);
  };

  const handleDelete = (object: PlacedImage) => (e: React.MouseEvent): void => {
    e.stopPropagation();
    store.deleteObject(object);
    if (selectedObjectId === object.id) onSelectObject(null);
  };

  const [columns, setColumns] = useState(2);
  const [gap, setGap] = useState(16);
  const [margin, setMargin] = useState(24);

  const handleArrangeGrid = useCallback((): void => {
    if (!store.doc || placedImages.length === 0) return;
    const after = arrangeImagesInGrid(placedImages, columns, gap, margin, store.doc.baseWidth, store.doc.baseHeight);
    store.batchEditObjects(placedImages, after);
  }, [store, placedImages, columns, gap, margin]);

  return (
    <div className="docker-panel w-full flex flex-wrap items-center gap-4 overflow-auto">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="docker-field-label p-1 text-sm">Collage images ({placedImages.length})</div>
        {placedImages.length === 0 ? (
          <div className="px-2.5 py-3.5 rounded-md text-xs italic text-neutral-400 dark:text-neutral-500 border border-dashed border-neutral-300 dark:border-neutral-700 min-w-[280px]">
            Insert images from the toolbar above to start a collage.
          </div>
        ) : (
          <div ref={stripRef} className="flex items-center gap-2 overflow-x-auto pb-1 max-w-[60vw]" onPointerMove={handleDragMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
            {displayImages.map((object) => (
              <div
                key={object.id}
                ref={(el) => {
                  if (el) thumbRefs.current.set(object.id, el);
                  else thumbRefs.current.delete(object.id);
                }}
                onPointerDown={beginDrag(object.id)}
                onClick={() => onSelectObject(object.id)}
                title="Drag to reorder - click to select on the canvas"
                className={`relative shrink-0 rounded-md overflow-hidden cursor-grab active:cursor-grabbing ring-2 transition-shadow ${
                  object.id === selectedObjectId ? "ring-blue-500" : "ring-transparent hover:ring-neutral-300 dark:hover:ring-neutral-600"
                }`}
                style={{ width: THUMB_SIZE, height: THUMB_SIZE }}
              >
                <img src={object.src} alt="" draggable={false} className="w-full h-full object-cover pointer-events-none select-none" />
                <button
                  type="button"
                  title="Remove from collage"
                  onClick={handleDelete(object)}
                  className="absolute -top-1 -right-1 text-neutral-500 hover:text-red-600 bg-white dark:bg-neutral-800 rounded-full"
                >
                  <IoCloseCircle size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="docker-field-label p-1 text-sm flex items-center gap-1.5">
          <IoGridOutline size={14} /> Arrange as grid
        </div>
        <div className="flex items-end gap-3 p-2.5 rounded-md bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            Columns
            <input
              type="number"
              min={1}
              max={Math.min(MAX_COLUMNS, placedImages.length) || 1}
              value={columns}
              onChange={(e) => setColumns(Math.max(1, Math.min(MAX_COLUMNS, Number(e.target.value) || 1)))}
              className="w-14 px-1.5 py-0.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            Gap ({gap}px)
            <input type="range" min={0} max={64} step={2} value={gap} onChange={(e) => setGap(Number(e.target.value))} className="w-20 accent-blue-500" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
            Margin ({margin}px)
            <input type="range" min={0} max={128} step={2} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="w-20 accent-blue-500" />
          </label>
          <button
            type="button"
            disabled={placedImages.length < 2}
            onClick={handleArrangeGrid}
            className="px-3 py-1.5 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:pointer-events-none"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImageCollageDocker;
