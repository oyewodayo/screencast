// components/docs/SlashCommandMenu.tsx
//
// The floating list docSlashCommand.tsx mounts (via ReactDOM.createRoot, positioned with plain
// fixed-position CSS) whenever the "/" suggestion is active - purely presentational, all
// filtering/selection-index/keyboard-nav state lives in the extension's render() closure, same
// split as every other manual popover in this feature (see DocsEditor.tsx's link/color pickers).
import React from "react";
import type { IconType } from "react-icons";

export interface SlashCommandItem {
  title: string;
  keywords: string[];
  icon: IconType;
  // Return type is plain `void`, not `void | Promise<void>` - TS's "a void-returning function type
  // accepts any return value" leniency only kicks in for a bare `void` target, not a union, and
  // every command here (including the async Image one, and the ones that end in ProseMirror's own
  // `.run()`, which returns boolean) relies on that leniency rather than every entry needing an
  // explicit `void` cast. Callers never await the result either way.
  run: (editor: import("@tiptap/core").Editor, range: { from: number; to: number }) => void;
}

interface SlashCommandMenuProps {
  items: SlashCommandItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SlashCommandItem) => void;
}

const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({ items, selectedIndex, onHover, onSelect }) => {
  if (items.length === 0) {
    return (
      <div className="w-56 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg py-2 px-3 text-xs text-neutral-400 dark:text-neutral-500">
        No matching blocks
      </div>
    );
  }

  return (
    <div className="w-56 max-h-72 overflow-y-auto bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg py-1">
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={item.title}
            type="button"
            // onMouseDown (not onClick) - the editor keeps focus/selection through mousedown but a
            // click after it would land after the suggestion plugin has already reacted to the
            // intervening blur, same ordering hazard the toolbar's own popovers avoid elsewhere.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(item);
            }}
            onMouseEnter={() => onHover(index)}
            className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm ${
              index === selectedIndex
                ? "bg-blue-50 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300"
                : "text-neutral-700 dark:text-neutral-200"
            }`}
          >
            <Icon size={15} className="shrink-0 opacity-70" />
            {item.title}
          </button>
        );
      })}
    </div>
  );
};

export default SlashCommandMenu;
