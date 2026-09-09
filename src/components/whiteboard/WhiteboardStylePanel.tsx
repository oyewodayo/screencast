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
import { TbLayoutAlignCenter, TbLayoutAlignLeft, TbLayoutAlignRight, TbStackBack, TbStackFront } from "react-icons/tb";
import { WhiteboardEdge, WhiteboardNode } from "../../utils/whiteboardTypes";

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

          {selectedNodes.some((n) => n.shapeType !== "text") && (
            <Field label="Fill">
              <input
                type="color"
                value={selectedNodes[0].fillColor ?? "#ffffff"}
                onChange={(e) => updateNodes({ fillColor: e.target.value })}
                className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent"
              />
            </Field>
          )}
          <Field label="Stroke color">
            <input type="color" value={selectedNodes[0].strokeColor} onChange={(e) => updateNodes({ strokeColor: e.target.value })} className="w-8 h-6 rounded border border-gray-300 dark:border-neutral-600 bg-transparent" />
          </Field>
          <Field label="Stroke width">
            <input
              type="range"
              min={0}
              max={12}
              value={selectedNodes[0].strokeWidth}
              onChange={(e) => updateNodes({ strokeWidth: Number(e.target.value) })}
              className="w-28"
            />
          </Field>

          <div className="border-t border-gray-100 dark:border-neutral-700/70 pt-2 flex flex-col gap-2">
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
            <Field label="Bold">
              <input
                type="checkbox"
                checked={selectedNodes[0].fontWeight === "bold"}
                onChange={(e) => updateNodes({ fontWeight: e.target.checked ? "bold" : "normal" })}
              />
            </Field>
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
              </div>
            </div>
          </div>

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
          <Field label="Dashed">
            <input type="checkbox" checked={edge.strokeStyle === "dashed"} onChange={(e) => updateEdge({ strokeStyle: e.target.checked ? "dashed" : "solid" })} />
          </Field>
          <Field label="Orthogonal">
            <input type="checkbox" checked={edge.routing === "orthogonal"} onChange={(e) => updateEdge({ routing: e.target.checked ? "orthogonal" : "straight" })} />
          </Field>
          <Field label="Start arrow">
            <input type="checkbox" checked={edge.startArrow} onChange={(e) => updateEdge({ startArrow: e.target.checked })} />
          </Field>
          <Field label="End arrow">
            <input type="checkbox" checked={edge.endArrow} onChange={(e) => updateEdge({ endArrow: e.target.checked })} />
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
