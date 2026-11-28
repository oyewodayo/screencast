// components/whiteboard/WhiteboardEmptyState.tsx
//
// Subtle, zero-friction quick-start card centered on an empty canvas page — disappears the
// moment the user drops any shape, sticky note, or template.

import React, { memo } from "react";
import { IoCodeSlashOutline, IoEaselOutline } from "react-icons/io5";
import { WhiteboardTemplateId } from "../../utils/whiteboardTemplates";

interface WhiteboardEmptyStateProps {
  onInsertTemplate: (id: WhiteboardTemplateId) => void;
  onOpenImport: () => void;
  onOpenSlidesImport?: () => void;
  isDarkCanvas?: boolean;
}

const QUICK_STARTS: { id: WhiteboardTemplateId; label: string; dot: string }[] = [
  { id: "mindmap", label: "Mind Map", dot: "#eab308" },
  { id: "roadmap", label: "Learning Roadmap", dot: "#10b981" },
  { id: "flowchart", label: "Flowchart", dot: "#8b5cf6" },
  { id: "architecture", label: "Architecture", dot: "#0ea5e9" },
  { id: "slides", label: "Slide Deck", dot: "#6366f1" },
  { id: "kanban", label: "Kanban", dot: "#f59e0b" },
];

const WhiteboardEmptyState: React.FC<WhiteboardEmptyStateProps> = memo(
  ({ onInsertTemplate, onOpenImport, onOpenSlidesImport, isDarkCanvas = false }) => (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className={`pointer-events-auto max-w-md rounded-2xl border px-5 py-4 shadow-sm flex flex-col items-center gap-3 text-center ${
          isDarkCanvas
            ? "bg-neutral-900/90 border-white/10 text-neutral-200"
            : "bg-white/95 dark:bg-neutral-900/95 border-gray-200/90 dark:border-neutral-800 text-neutral-700 dark:text-neutral-200"
        }`}
      >
        <div>
          <p className="text-sm font-semibold">Start with a template or pick a tool on the left</p>
          <p className="text-xs opacity-65 mt-0.5">
            Press <kbd className="px-1 py-0.5 rounded bg-black/[0.06] dark:bg-white/[0.1] font-mono text-[10px]">Ctrl+K</kbd> anytime for quick commands, or <kbd className="px-1 py-0.5 rounded bg-black/[0.06] dark:bg-white/[0.1] font-mono text-[10px]">?</kbd> for shortcuts
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {QUICK_STARTS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onInsertTemplate(item.id)}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium border transition-colors ${
                isDarkCanvas
                  ? "border-white/15 bg-white/[0.06] hover:bg-white/[0.14] text-neutral-100"
                  : "border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400"
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.dot }} />
              {item.label}
            </button>
          ))}
          {onOpenSlidesImport && (
            <button
              type="button"
              onClick={onOpenSlidesImport}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium border transition-colors ${
                isDarkCanvas
                  ? "border-indigo-400/40 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-100"
                  : "border-indigo-200 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 hover:border-indigo-400"
              }`}
            >
              <IoEaselOutline size={13} />
              PowerPoint / Google Slides / PDF
            </button>
          )}
          <button
            type="button"
            onClick={onOpenImport}
            className={`flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs font-medium border transition-colors ${
              isDarkCanvas
                ? "border-white/15 bg-white/[0.06] hover:bg-white/[0.14] text-neutral-100"
                : "border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400"
            }`}
          >
            <IoCodeSlashOutline size={13} />
            Markdown / Mermaid
          </button>
        </div>
      </div>
    </div>
  )
);

WhiteboardEmptyState.displayName = "WhiteboardEmptyState";

export default WhiteboardEmptyState;
