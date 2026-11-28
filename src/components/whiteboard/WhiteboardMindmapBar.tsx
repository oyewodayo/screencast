// components/whiteboard/WhiteboardMindmapBar.tsx
//
// Contextual floating Pro Mind Map toolbar shown whenever a Mind Map topic/subtopic is selected
// on the Whiteboard. Exposes 1-click branching (+Child, +Sibling, +Parent), layout switching
// (Balanced Radial, Right Tree, Top-Down Org), harmonic branch recoloring, collapse/expand all,
// sibling reordering, subtree selection/deletion, and 1-click Export to Briefcast Doc.
import React, { memo, useState } from "react";
import {
  IoAddCircleOutline,
  IoArrowDown,
  IoArrowUp,
  IoChevronDown,
  IoColorPaletteOutline,
  IoContractOutline,
  IoDocumentTextOutline,
  IoExpandOutline,
  IoGitBranchOutline,
  IoGitMergeOutline,
  IoLayersOutline,
  IoTrashOutline,
} from "react-icons/io5";
import { MINDMAP_PALETTE, type MindmapColorKey } from "../../utils/mindmapTypes";
import type { MindmapLayoutMode } from "../../handlers/whiteboardMindmapHandlers";

const COLOR_KEYS: MindmapColorKey[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

interface WhiteboardMindmapBarProps {
  hasChildren: boolean;
  isCollapsed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  activeColorKey?: MindmapColorKey;
  offsetRight?: boolean;
  onAddChild: () => void;
  onAddSibling: () => void;
  onInsertParent: () => void;
  onAutoLayout: (mode: MindmapLayoutMode) => void;
  onRecolorBranch: (colorKey: MindmapColorKey) => void;
  onToggleCollapse: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onReorderSibling: (dir: "up" | "down") => void;
  onSelectSubtree: () => void;
  onDeleteSubtree: () => void;
  onExportToDoc: () => void;
}

const WhiteboardMindmapBar: React.FC<WhiteboardMindmapBarProps> = memo(
  ({
    hasChildren,
    isCollapsed,
    canMoveUp,
    canMoveDown,
    activeColorKey,
    offsetRight,
    onAddChild,
    onAddSibling,
    onInsertParent,
    onAutoLayout,
    onRecolorBranch,
    onToggleCollapse,
    onExpandAll,
    onCollapseAll,
    onReorderSibling,
    onSelectSubtree,
    onDeleteSubtree,
    onExportToDoc,
  }) => {
    const [layoutOpen, setLayoutOpen] = useState(false);
    const [colorOpen, setColorOpen] = useState(false);

    const btn =
      "h-7 px-2 rounded-md inline-flex items-center gap-1 text-[11px] font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/80 disabled:opacity-35 transition-colors whitespace-nowrap";

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        style={offsetRight ? { left: "calc(50% - 140px)" } : undefined}
        className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-white/95 dark:bg-neutral-900/95 backdrop-blur-md border border-neutral-200 dark:border-neutral-700/90 shadow-xl select-none max-w-[calc(100%-24px)]"
      >
        <button type="button" onClick={onAddChild} title="Add child branch (Tab)" className={btn}>
          <IoGitBranchOutline size={13} className="text-blue-600 dark:text-blue-400" />
          <span>Child</span>
        </button>
        <button type="button" onClick={onAddSibling} title="Add sibling topic (Enter)" className={btn}>
          <IoAddCircleOutline size={13} className="text-emerald-600 dark:text-emerald-400" />
          <span>Sibling</span>
        </button>
        <button type="button" onClick={onInsertParent} title="Insert grouping parent topic" className={btn}>
          <IoGitMergeOutline size={13} className="text-violet-600 dark:text-violet-400" />
          <span className="hidden xl:inline">Parent</span>
        </button>

        <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />

        {/* Auto-Layout switcher */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setColorOpen(false);
              setLayoutOpen((v) => !v);
            }}
            title="Auto-layout this Mind Map"
            className={btn}
          >
            <span>Layout</span>
            <IoChevronDown size={11} className="opacity-60" />
          </button>
          {layoutOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-48 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-2xl py-1 text-xs z-30">
              <button
                type="button"
                onClick={() => {
                  onAutoLayout("balanced");
                  setLayoutOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
              >
                Balanced Radial
              </button>
              <button
                type="button"
                onClick={() => {
                  onAutoLayout("right");
                  setLayoutOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
              >
                Right Tree
              </button>
              <button
                type="button"
                onClick={() => {
                  onAutoLayout("topDown");
                  setLayoutOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
              >
                Top-Down Org / Roadmap
              </button>
              <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
              <button
                type="button"
                onClick={() => {
                  onExpandAll();
                  setLayoutOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
              >
                Expand all branches
              </button>
              <button
                type="button"
                onClick={() => {
                  onCollapseAll();
                  setLayoutOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
              >
                Collapse sub-branches
              </button>
            </div>
          )}
        </div>

        {/* Harmonic branch color picker */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setLayoutOpen(false);
              setColorOpen((v) => !v);
            }}
            title="Recolor this whole branch & its connectors"
            className={btn}
          >
            <IoColorPaletteOutline size={14} />
            <span className="hidden lg:inline">Branch</span>
          </button>
          {colorOpen && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1.5 p-2 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 shadow-2xl z-30">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 mb-1.5 px-0.5 whitespace-nowrap">
                Color entire branch
              </div>
              <div className="flex items-center gap-1.5">
                {COLOR_KEYS.map((key) => {
                  const p = MINDMAP_PALETTE[key];
                  const active = activeColorKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      title={`Branch theme ${key}`}
                      onClick={() => {
                        onRecolorBranch(key);
                        setColorOpen(false);
                      }}
                      style={{ backgroundColor: p.background, borderColor: p.border }}
                      className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        active ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-neutral-900" : ""
                      }`}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />

        {/* Sibling reorder */}
        <button
          type="button"
          disabled={!canMoveUp}
          onClick={() => onReorderSibling("up")}
          title="Move branch up (Alt+↑)"
          className="h-7 w-7 rounded-md inline-flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/80 disabled:opacity-30"
        >
          <IoArrowUp size={13} />
        </button>
        <button
          type="button"
          disabled={!canMoveDown}
          onClick={() => onReorderSibling("down")}
          title="Move branch down (Alt+↓)"
          className="h-7 w-7 rounded-md inline-flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/80 disabled:opacity-30"
        >
          <IoArrowDown size={13} />
        </button>

        {/* Subtree collapse / select / delete */}
        {hasChildren && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={isCollapsed ? "Expand branch" : "Collapse branch"}
            className="h-7 w-7 rounded-md inline-flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/80"
          >
            {isCollapsed ? <IoExpandOutline size={14} /> : <IoContractOutline size={14} />}
          </button>
        )}
        <button
          type="button"
          onClick={onSelectSubtree}
          title="Select this topic and all its descendants (tip: hold Alt while dragging to move subtree)"
          className="h-7 w-7 rounded-md inline-flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700/80"
        >
          <IoLayersOutline size={14} />
        </button>
        <button
          type="button"
          onClick={onDeleteSubtree}
          title="Delete this branch and all its descendants (Shift+Delete)"
          className="h-7 w-7 rounded-md inline-flex items-center justify-center text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/15"
        >
          <IoTrashOutline size={13} />
        </button>

        <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />

        <button
          type="button"
          onClick={onExportToDoc}
          title="Turn this Mind Map into a structured, linked Briefcast Doc"
          className="h-7 px-2 rounded-md inline-flex items-center gap-1 text-[11px] font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors whitespace-nowrap"
        >
          <IoDocumentTextOutline size={13} />
          <span className="hidden md:inline">To Doc</span>
        </button>
      </div>
    );
  }
);

WhiteboardMindmapBar.displayName = "WhiteboardMindmapBar";

export default WhiteboardMindmapBar;
