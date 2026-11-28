// Image crop/aspect/replace and connector-rotation inspector controls extracted from WhiteboardStylePanel.tsx.
import React from "react";
import { IoSwapHorizontalOutline } from "react-icons/io5";
import { TbScissors } from "react-icons/tb";
import {
  hasImageCrop,
  naturalImageSize,
  resolveImageCrop,
  type WhiteboardEdge,
  type WhiteboardNode,
} from "../../utils/whiteboardTypes";
import { detectShapeCorners } from "../../handlers/whiteboardHandlers";
import {
  Card,
  CHECKBOX_CLASS,
  ClampedNumberField,
  Field,
  FIELD_INPUT_CLASS,
  INPUT_SURFACE_CLASS,
  MINI_BUTTON_CLASS,
  NUMBER_INPUT_CLASS,
  SliderField,
} from "./WhiteboardStylePrimitives";

export function ImageFields({
  node,
  updateNodes,
  onReplace,
  onRemoveBackground,
  isRemovingBackground,
  cropping,
  onToggleCrop,
  previewField,
  onPreviewNodes,
}: {
  node: WhiteboardNode;
  updateNodes: (patch: Partial<WhiteboardNode>) => void;
  onReplace: () => void;
  onRemoveBackground?: () => void;
  isRemovingBackground?: boolean;
  cropping: boolean;
  onToggleCrop?: () => void;
  previewField: (key: keyof WhiteboardNode) => (n: number | null) => void;
  onPreviewNodes?: (patch: Partial<WhiteboardNode> | null) => void;
}) {
  const crop = resolveImageCrop(node);
  const natural = naturalImageSize(node);
  // Percent, because a crop reads far more naturally as "trim 10% off the left" than as 0.1 - and
  // the four values are stored as fractions precisely so they survive a source swap (see
  // WhiteboardNode.imageCropX's own doc comment).
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const setCrop = (patch: Partial<{ x: number; y: number; w: number; h: number }>) => {
    const next = { ...crop, ...patch };
    updateNodes({ imageCropX: next.x, imageCropY: next.y, imageCropW: next.w, imageCropH: next.h });
  };
  return (
    <>
      <Field label="Fit">
        <select
          value={node.imageFit ?? "cover"}
          onChange={(e) => updateNodes({ imageFit: e.target.value as NonNullable<WhiteboardNode["imageFit"]> })}
          className={FIELD_INPUT_CLASS}
          title="Cover fills the box and crops the overflow; Contain fits the whole image inside, showing Fill in the margin; Stretch ignores aspect ratio"
        >
          <option value="cover">Cover (crop to fill)</option>
          <option value="contain">Contain (fit inside)</option>
          <option value="fill">Stretch</option>
        </select>
      </Field>
      <Field label="Shape">
        <select
          value={node.imageMask ?? (node.cornerRadius && node.cornerRadius > 0 ? "rounded" : "rect")}
          onChange={(e) => {
            const next = e.target.value as NonNullable<WhiteboardNode["imageMask"]>;
            if (next === "rounded") {
              const r = node.cornerRadius && node.cornerRadius > 0 ? node.cornerRadius : 16;
              updateNodes({ imageMask: "rounded", cornerRadius: r });
            } else if (next === "rect") {
              updateNodes({ imageMask: "rect", cornerRadius: 0, cornerRadii: undefined });
            } else {
              updateNodes({ imageMask: "ellipse" });
            }
          }}
          className={FIELD_INPUT_CLASS}
          title="The silhouette the photo is cut to - the Stroke controls above then draw a ring following that same edge"
        >
          <option value="rect">Rectangle</option>
          <option value="rounded">Rounded</option>
          <option value="ellipse">Circle / ellipse</option>
        </select>
      </Field>
      {node.imageMask !== "ellipse" && (() => {
        const maxRadius = Math.max(1, Math.round(Math.min(node.width, node.height) / 2));
        const corners = detectShapeCorners(node);
        const buildCornerRadii = (cornerIndex: number, nextRadius: number): (number | null)[] => {
          const len = Math.max(corners.length, cornerIndex + 1);
          return Array.from({ length: len }, (_, i) => (i === cornerIndex ? nextRadius : (node.cornerRadii?.[i] ?? null)));
        };
        return (
          <>
            <SliderField
              label="Corner radius"
              resetKey={`cr-${node.id}`}
              value={node.cornerRadius ?? 0}
              min={0}
              max={maxRadius}
              step={1}
              onCommit={(n) => updateNodes({ cornerRadius: n, cornerRadii: undefined, imageMask: n > 0 ? "rounded" : node.imageMask })}
              onPreview={(n) => {
                previewField("cornerRadius")(n);
                if (n !== null && n > 0 && node.imageMask !== "rounded") {
                  onPreviewNodes?.({ cornerRadius: n, cornerRadii: undefined, imageMask: "rounded" });
                }
              }}
            />
            {corners.map((corner) => {
              const val = node.cornerRadii?.[corner.index] ?? node.cornerRadius ?? 0;
              return (
                <SliderField
                  key={`img-cr-${corner.index}-${corner.label}`}
                  label={corner.label}
                  resetKey={`cr-${node.id}-${corner.index}-${node.cornerRadius ?? 0}`}
                  value={val}
                  min={0}
                  max={maxRadius}
                  step={1}
                  onCommit={(n) => {
                    const nextRadii = buildCornerRadii(corner.index, n);
                    const hasR = nextRadii.some((r) => r !== null && r > 0);
                    updateNodes({ cornerRadii: nextRadii, imageMask: hasR ? "rounded" : node.imageMask });
                  }}
                  onPreview={(n) => {
                    const nextRadii = buildCornerRadii(corner.index, n ?? 0);
                    const hasR = nextRadii.some((r) => r !== null && r > 0);
                    onPreviewNodes?.(n === null ? null : { cornerRadii: nextRadii, imageMask: hasR ? "rounded" : node.imageMask });
                  }}
                />
              );
            })}
          </>
        );
      })()}
      <SliderField
        label="Opacity"
        resetKey={`op-${node.id}`}
        value={node.imageOpacity ?? 1}
        min={0}
        max={1}
        step={0.05}
        onCommit={(n) => updateNodes({ imageOpacity: n })}
        onPreview={previewField("imageOpacity")}
      />
      <Field label="Grayscale">
        <input
          type="checkbox"
          checked={node.imageGrayscale ?? false}
          onChange={(e) => updateNodes({ imageGrayscale: e.target.checked })}
          className={CHECKBOX_CLASS}
          title="Desaturates the photo - keeps a reference figure from competing with annotation drawn over it"
        />
      </Field>

      <Card>
        <div className="flex items-center justify-between text-[12px] text-neutral-500 dark:text-neutral-400">
          <span className="font-medium">Crop (%)</span>
          <button
            type="button"
            onClick={() => updateNodes({ imageCropX: undefined, imageCropY: undefined, imageCropW: undefined, imageCropH: undefined })}
            disabled={!hasImageCrop(node)}
            className={MINI_BUTTON_CLASS}
            title="Show the whole image again"
          >
            Reset
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleCrop}
          disabled={!onToggleCrop || node.locked}
          className={`${MINI_BUTTON_CLASS} ${cropping ? "ring-1 ring-blue-500 bg-blue-50 dark:bg-blue-500/20" : ""}`}
          title="Shows the whole picture with a draggable crop rectangle - drag its corners to crop at any angle, or drag inside it to reframe"
        >
          {cropping ? "Done cropping" : "Crop image"}
        </button>
        <span className="text-[10px] text-gray-400 dark:text-neutral-500">Drag the corners to crop freely, or inside the box to reframe. Double-clicking the image does the same.</span>
        <div className="grid grid-cols-2 gap-1">
          {([
            ["Left", crop.x, (v: number) => setCrop({ x: Math.min(v, crop.x + crop.w - 0.01), w: crop.w + (crop.x - Math.min(v, crop.x + crop.w - 0.01)) })],
            ["Top", crop.y, (v: number) => setCrop({ y: Math.min(v, crop.y + crop.h - 0.01), h: crop.h + (crop.y - Math.min(v, crop.y + crop.h - 0.01)) })],
            ["Width", crop.w, (v: number) => setCrop({ w: Math.max(0.01, Math.min(v, 1 - crop.x)) })],
            ["Height", crop.h, (v: number) => setCrop({ h: Math.max(0.01, Math.min(v, 1 - crop.y)) })],
          ] as [string, number, (v: number) => void][]).map(([label, value, apply]) => (
            <label key={label} className="flex items-center gap-1 text-[10px] text-gray-600 dark:text-neutral-300">
              {label}
              <ClampedNumberField
                key={`${label}-${node.id}-${Math.round(value * 1000)}`}
                initialValue={pct(value)}
                min={0}
                max={100}
                step={1}
                integer={false}
                onCommit={(n) => apply(n / 100)}
                className={`w-12 h-6 px-1.5 ${INPUT_SURFACE_CLASS} text-[11px] tabular-nums`}
              />
            </label>
          ))}
        </div>
      </Card>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (natural) updateNodes({ width: natural.width, height: natural.height });
          }}
          disabled={!natural}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title={natural ? `Resize the box to ${natural.width} x ${natural.height} px - the cropped image's own pixel size` : "Source size unknown"}
        >
          Natural size
        </button>
        <button
          type="button"
          onClick={() => {
            // Height follows width, so the box matches the cropped source's aspect ratio without
            // changing how big the node currently is on the canvas.
            if (!natural) return;
            updateNodes({ height: Math.max(1, Math.round((node.width * natural.height) / natural.width)) });
          }}
          disabled={!natural}
          className={`flex-1 ${MINI_BUTTON_CLASS}`}
          title="Adjust the height so the box matches the image's aspect ratio, keeping the current width"
        >
          Fix aspect
        </button>
      </div>
      {/* Full-width with an icon rather than another plain text button: this is the one action in
          the image section that opens a file dialog and swaps the underlying asset, so it should
          read as a distinct, deliberate action rather than another small toggle in the row above. */}
      <div className="flex flex-col gap-1.5 pt-1">
        <button
          type="button"
          onClick={onReplace}
          title="Swap in a different picture, keeping this node's size, crop and styling"
          className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-gray-300 dark:border-neutral-600 text-xs font-medium text-gray-600 dark:text-neutral-300 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-500/10 active:scale-[0.99] transition"
        >
          <IoSwapHorizontalOutline size={14} />
          Replace image
        </button>
        {onRemoveBackground && (
          <button
            type="button"
            onClick={onRemoveBackground}
            disabled={isRemovingBackground || node.locked}
            title="Remove the background of this image"
            className="w-full h-8 flex items-center justify-center gap-1.5 rounded-md border border-blue-200 dark:border-blue-500/30 bg-blue-50/60 dark:bg-blue-500/10 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-100/70 active:scale-[0.99] transition disabled:opacity-50"
          >
            <TbScissors size={14} />
            {isRemovingBackground ? "Removing background…" : "Remove background"}
          </button>
        )}
      </div>
    </>
  );
}

// Rotates a fully free-floating edge (both ends unattached to any shape - see this field's own
// call site for the `bothFree` gate) around the bounding-box center of its own CURRENT point set -
// an edge has no persisted `rotation` field the way a WhiteboardNode does (nothing else about an
// edge's rendering needs one, and its "shape" IS its point coordinates, not a box with a transform
// layered on top), so this field tracks the angle typed so far in local state and, on every change,
// rotates the LIVE `edge` prop (never a cached gesture-start snapshot) by the DELTA since the last
// commit. Rotating from the live prop every time - rather than a fixed original-geometry snapshot
// captured once at mount - matters because this field stays mounted across unrelated edits to the
// SAME edge (e.g. double-clicking the line to add a bend point while the panel is open): a
// fixed-snapshot version would silently discard any such edit the next time rotation changed,
// overwriting it with a fresh rotation of the now-stale snapshot. The tradeoff is the usual
// incremental-rotation one (many small adjustments can compound tiny floating-point drift) - much
// less costly than losing an edit. `key={edge.id}` at the call site remounts this (resetting the
// angle back to 0) whenever the selection moves to a DIFFERENT edge.
export function EdgeRotateField({ edge, onCommit }: { edge: WhiteboardEdge; onCommit: (patch: Partial<WhiteboardEdge>) => void }) {
  const [angle, setAngle] = React.useState(0);
  const lastAngleRef = React.useRef(0);
  const applyRotation = (deg: number) => {
    const delta = deg - lastAngleRef.current;
    lastAngleRef.current = deg;
    setAngle(deg);
    const waypoints = edge.waypoints ?? [];
    const points = [
      { x: edge.source.x ?? 0, y: edge.source.y ?? 0 },
      ...waypoints,
      { x: edge.target.x ?? 0, y: edge.target.y ?? 0 },
    ];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotate = (p: { x: number; y: number }) => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos });
    const newSource = rotate(points[0]);
    const newTarget = rotate(points[points.length - 1]);
    const newWaypoints = waypoints.map((wp) => rotate(wp));
    onCommit({ source: { x: newSource.x, y: newSource.y }, target: { x: newTarget.x, y: newTarget.y }, waypoints: newWaypoints });
  };
  return (
    <Field label="Rotation (°)">
      <ClampedNumberField
        initialValue={angle}
        min={-360}
        max={360}
        onCommit={applyRotation}
        className={NUMBER_INPUT_CLASS}
        title="Rotates the whole line around its own center - only available while both ends are free-floating"
      />
    </Field>
  );
}

// A colour well plus its hex code - the code is what a researcher matches against a journal's or a
// palette's spec, so it's a real editable field (paste "#1f77b4" straight in), not just a readout.
// The swatch sits on a checkerboard so a translucent or "none" fill reads as such at a glance.

