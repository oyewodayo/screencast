// components/whiteboard/WhiteboardStylePanel.tsx
//
// The Whiteboard feature's property-editing surface for whatever's currently selected - mirrors
// BoardStylePanel.tsx's role for Board, but over WhiteboardNode/WhiteboardEdge instead of
// BoardItem. Node edits apply to every selected node at once via batchEditNodes when more than one
// is selected (so multi-selecting three boxes and picking a fill color is one undo step, not
// three) - single-selection edits still go through editNode so BoardStylePanel's "just the one
// item" case isn't paying for a batch array it doesn't need.
import React from "react";
import { IoCopyOutline, IoTrashOutline } from "react-icons/io5";
import {
  TbItalic,
  TbLayoutAlignBottom,
  TbLayoutAlignCenter,
  TbLayoutAlignLeft,
  TbLayoutAlignMiddle,
  TbLayoutAlignRight,
  TbLayoutAlignTop,
  TbStackBack,
  TbStackFront,
  TbUnderline,
} from "react-icons/tb";
import { ArrowheadType, WhiteboardEdge, WhiteboardNode } from "../../utils/whiteboardTypes";

const FONT_FAMILY_OPTIONS: { label: string; value: string }[] = [
  { label: "Sans", value: "system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Monospace", value: "'Courier New', monospace" },
  { label: "Rounded", value: "'Trebuchet MS', sans-serif" },
  { label: "Casual", value: "'Comic Sans MS', cursive" },
];

const ARROWHEAD_OPTIONS: { value: ArrowheadType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "triangle", label: "Triangle" },
  { value: "triangleOpen", label: "Open" },
  { value: "block", label: "Block" },
  { value: "diamond", label: "Diamond" },
  { value: "circle", label: "Circle" },
];

const LINE_STYLE_OPTIONS: { value: WhiteboardEdge["strokeStyle"]; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
  { value: "dotted", label: "Dotted" },
];

const ROUTING_OPTIONS: { value: WhiteboardEdge["routing"]; label: string }[] = [
  { value: "straight", label: "Straight" },
  { value: "orthogonal", label: "Orthogonal" },
  { value: "curved", label: "Curved" },
];

interface WhiteboardStylePanelProps {
  selectedNodes: WhiteboardNode[];
  selectedEdges: WhiteboardEdge[];
  onBatchEditNodes: (before: WhiteboardNode[], after: WhiteboardNode[]) => void;
  onEditEdge: (before: WhiteboardEdge, after: WhiteboardEdge) => void;
  onDeleteNode: (node: WhiteboardNode) => void;
  onDeleteEdge: (edge: WhiteboardEdge) => void;
  onDuplicateNode: (node: WhiteboardNode) => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-neutral-300">
      <span>{label}</span>
      {children}
    </label>
  );
}

const WhiteboardStylePanel: React.FC<WhiteboardStylePanelProps> = ({
  selectedNodes,
  selectedEdges,
  onBatchEditNodes,
  onEditEdge,
  onDeleteNode,
  onDeleteEdge,
  onDuplicateNode,
  onBringToFront,
  onSendToBack,
}) => {
  const updateNodes = (patch: Partial<WhiteboardNode>) => {
    if (selectedNodes.length === 0) return;
    onBatchEditNodes(selectedNodes, selectedNodes.map((n) => ({ ...n, ...patch })));
  };

  const edge = selectedEdges.length === 1 ? selectedEdges[0] : null;
  const updateEdge = (patch: Partial<WhiteboardEdge>) => {
    if (!edge) return;
    onEditEdge(edge, { ...edge, ...patch });
  };

  if (selectedNodes.length === 0 && selectedEdges.length === 0) return null;

  return (
    <div className="absolute top-2 right-2 bottom-2 w-60 bg-white/95 dark:bg-neutral-900/95 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-lg p-3 flex flex-col gap-3 overflow-y-auto text-neutral-800 dark:text-neutral-200">
      {selectedNodes.length > 0 && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">
            {selectedNodes.length > 1 ? `${selectedNodes.length} shapes` : "Shape"}
          </p>

          {selectedNodes.some((n) => n.shapeType !== "text" && n.shapeType !== "freehand") && (
            <Field label="Fill">
              <input
                type="color"
                value={selectedNodes[0].fillColor ?? "#ffffff"}
                onChange={(e) => updateNodes({ fillColor: e.target.value })}
                className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent"
              />
            </Field>
          )}
          <Field label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink color" : "Stroke color"}>
            <input type="color" value={selectedNodes[0].strokeColor} onChange={(e) => updateNodes({ strokeColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
          </Field>
          <Field label={selectedNodes.every((n) => n.shapeType === "freehand") ? "Ink width" : "Stroke width"}>
            <input
              type="range"
              min={selectedNodes.every((n) => n.shapeType === "freehand") ? 1 : 0}
              max={12}
              value={selectedNodes[0].strokeWidth}
              onChange={(e) => updateNodes({ strokeWidth: Number(e.target.value) })}
              className="w-28"
            />
          </Field>
          {selectedNodes.every((n) => n.shapeType === "rectangle") && (
            <Field label="Corner radius">
              <input
                type="range"
                min={0}
                max={Math.min(selectedNodes[0].width, selectedNodes[0].height) / 2}
                value={selectedNodes[0].cornerRadius ?? 0}
                onChange={(e) => updateNodes({ cornerRadius: Number(e.target.value) })}
                className="w-28"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "polygon") && (
            <Field label="Sides">
              <input
                type="number"
                min={3}
                max={12}
                value={selectedNodes[0].sides ?? 5}
                onChange={(e) => updateNodes({ sides: Math.max(3, Math.min(12, Number(e.target.value))) })}
                className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
              />
            </Field>
          )}
          {selectedNodes.every((n) => n.shapeType === "star") && (
            <>
              <Field label="Points">
                <input
                  type="number"
                  min={3}
                  max={12}
                  value={selectedNodes[0].starPoints ?? 5}
                  onChange={(e) => updateNodes({ starPoints: Math.max(3, Math.min(12, Number(e.target.value))) })}
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
              <Field label="Spikiness">
                <input
                  type="range"
                  min={0.15}
                  max={0.85}
                  step={0.05}
                  value={selectedNodes[0].starInnerRadiusRatio ?? 0.45}
                  onChange={(e) => updateNodes({ starInnerRadiusRatio: Number(e.target.value) })}
                  className="w-28"
                />
              </Field>
            </>
          )}

          {selectedNodes.some((n) => n.shapeType !== "freehand") && (
            <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex flex-col gap-2">
              <Field label="Font">
                <select
                  value={selectedNodes[0].fontFamily}
                  onChange={(e) => updateNodes({ fontFamily: e.target.value })}
                  className="w-28 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                >
                  {FONT_FAMILY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Font size">
                <input
                  type="number"
                  min={8}
                  max={96}
                  value={selectedNodes[0].fontSize}
                  onChange={(e) => updateNodes({ fontSize: Number(e.target.value) })}
                  className="w-16 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
                />
              </Field>
              <Field label="Font color">
                <input type="color" value={selectedNodes[0].fontColor} onChange={(e) => updateNodes({ fontColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-neutral-300">Style</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => updateNodes({ fontWeight: selectedNodes[0].fontWeight === "bold" ? "normal" : "bold" })}
                    className={`px-2 py-1 rounded font-bold text-xs ${selectedNodes[0].fontWeight === "bold" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                  >
                    B
                  </button>
                  <button
                    type="button"
                    onClick={() => updateNodes({ fontStyle: selectedNodes[0].fontStyle === "italic" ? "normal" : "italic" })}
                    className={`p-1.5 rounded ${selectedNodes[0].fontStyle === "italic" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                  >
                    <TbItalic size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => updateNodes({ textDecoration: selectedNodes[0].textDecoration === "underline" ? "none" : "underline" })}
                    className={`p-1.5 rounded ${selectedNodes[0].textDecoration === "underline" ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                  >
                    <TbUnderline size={14} />
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-neutral-300">Align</span>
                <div className="flex gap-1">
                  {(["left", "center", "right"] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => updateNodes({ textAlign: align })}
                      className={`p-1.5 rounded ${selectedNodes[0].textAlign === align ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      {align === "left" ? <TbLayoutAlignLeft size={14} /> : align === "center" ? <TbLayoutAlignCenter size={14} /> : <TbLayoutAlignRight size={14} />}
                    </button>
                  ))}
                  {(["top", "middle", "bottom"] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => updateNodes({ verticalAlign: align })}
                      className={`p-1.5 rounded ${selectedNodes[0].verticalAlign === align ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
                    >
                      {align === "top" ? <TbLayoutAlignTop size={14} /> : align === "middle" ? <TbLayoutAlignMiddle size={14} /> : <TbLayoutAlignBottom size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex items-center gap-2">
            <button type="button" onClick={onBringToFront} title="Bring to front" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
              <TbStackFront size={16} />
            </button>
            <button type="button" onClick={onSendToBack} title="Send to back" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
              <TbStackBack size={16} />
            </button>
            {selectedNodes.length === 1 && (
              <button type="button" onClick={() => onDuplicateNode(selectedNodes[0])} title="Duplicate" className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-neutral-800">
                <IoCopyOutline size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => selectedNodes.forEach((n) => onDeleteNode(n))}
              title="Delete"
              className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400 ml-auto"
            >
              <IoTrashOutline size={16} />
            </button>
          </div>
        </>
      )}

      {edge && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-neutral-500">Connector</p>
          <Field label="Color">
            <input type="color" value={edge.strokeColor} onChange={(e) => updateEdge({ strokeColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
          </Field>
          <Field label="Width">
            <input type="range" min={1} max={8} value={edge.strokeWidth} onChange={(e) => updateEdge({ strokeWidth: Number(e.target.value) })} className="w-28" />
          </Field>
          <Field label="Line">
            <select
              value={edge.strokeStyle}
              onChange={(e) => updateEdge({ strokeStyle: e.target.value as WhiteboardEdge["strokeStyle"] })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {LINE_STYLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Routing">
            <select
              value={edge.routing}
              onChange={(e) => updateEdge({ routing: e.target.value as WhiteboardEdge["routing"] })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ROUTING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Start arrow">
            <select
              value={edge.startArrowType}
              onChange={(e) => updateEdge({ startArrowType: e.target.value as ArrowheadType })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ARROWHEAD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="End arrow">
            <select
              value={edge.endArrowType}
              onChange={(e) => updateEdge({ endArrowType: e.target.value as ArrowheadType })}
              className="w-24 h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
            >
              {ARROWHEAD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
          <input
            type="text"
            value={edge.label}
            placeholder="Label"
            onChange={(e) => updateEdge({ label: e.target.value })}
            className="w-full h-7 px-1.5 rounded border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs"
          />
          <button
            type="button"
            onClick={() => onDeleteEdge(edge)}
            title="Delete"
            className="self-start p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-500/10 text-red-600 dark:text-red-400"
          >
            <IoTrashOutline size={16} />
          </button>
        </>
      )}
    </div>
  );
};

export default WhiteboardStylePanel;
