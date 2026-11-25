// components/whiteboard/WhiteboardShortcutsModal.tsx
//
// Compact 2-column keyboard shortcuts cheatsheet opened via `?` or the Command Palette.

import React, { memo } from "react";
import { IoClose } from "react-icons/io5";

interface WhiteboardShortcutsModalProps {
  onClose: () => void;
}

const SECTIONS: { title: string; items: [string, string][] }[] = [
  {
    title: "Tools",
    items: [
      ["V", "Select tool"],
      ["R / O / D", "Rectangle / Ellipse / Diamond"],
      ["T / S", "Text / Sticky Note"],
      ["F / M", "Containment Frame / Mind Map Topic"],
      ["P / L", "Pen (freehand) / Connector arrow"],
    ],
  },
  {
    title: "Mind Map & Diagrams",
    items: [
      ["Tab", "Add child branch"],
      ["Enter", "Add sibling branch / Edit edge label"],
      ["Ctrl+Shift+L", "Auto-layout Mind Map tree"],
      ["Drag port → empty", "Quick-spawn connected shape"],
      ["Ctrl+Alt+C / V", "Format Painter copy / paste style"],
    ],
  },
  {
    title: "Navigate & View",
    items: [
      ["Ctrl+K", "Command Palette"],
      ["Ctrl+F", "Search text across all pages"],
      ["0 / 1", "Fit to content / Reset zoom 100%"],
      ["Shift+2", "Zoom to selection"],
      ["Space + Drag", "Pan canvas"],
    ],
  },
  {
    title: "Presentation & Edit",
    items: [
      ["← / → / Space", "Previous / Next frame (Present mode)"],
      ["L / P (Present)", "Toggle Laser pointer / Draw ink"],
      ["Ctrl+G / Shift+G", "Group / Ungroup selection"],
      ["Ctrl+D", "Duplicate selection"],
      ["?", "Toggle this shortcuts guide"],
    ],
  },
];

const WhiteboardShortcutsModal: React.FC<WhiteboardShortcutsModalProps> = memo(({ onClose }) => (
  <div
    onPointerDown={(e) => {
      e.stopPropagation();
      onClose();
    }}
    className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
  >
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="w-[620px] max-w-[94vw] rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-2xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Whiteboard Keyboard Shortcuts</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
        >
          <IoClose size={16} />
        </button>
      </div>
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[70vh] overflow-y-auto">
        {SECTIONS.map((sec) => (
          <div key={sec.title} className="flex flex-col gap-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">{sec.title}</p>
            <div className="flex flex-col gap-1">
              {sec.items.map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between gap-2 text-xs py-0.5">
                  <span className="text-neutral-600 dark:text-neutral-300">{desc}</span>
                  <kbd className="shrink-0 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 font-mono text-[10px] text-neutral-700 dark:text-neutral-200">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
));

WhiteboardShortcutsModal.displayName = "WhiteboardShortcutsModal";

export default WhiteboardShortcutsModal;
