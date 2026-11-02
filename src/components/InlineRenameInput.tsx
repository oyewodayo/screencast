import React, { useRef, useState } from "react";

// The inline rename field for the sidebar's file rows and every folder gallery's tiles.
//
// Holds its own draft: the draft used to live in Dashboard.tsx, so each keystroke re-rendered the
// whole dashboard and every gallery tile under it, and typing visibly lagged in a big folder.
//
// Swallows the pointer/mouse/key events it handles itself - a double-click to select a word, or a
// click to place the caret, used to reach the tile underneath and open or select the file.
//
// Commits once: Enter unmounts the field, and the blur that follows must not commit again.

interface InlineRenameInputProps {
  fileName: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

const stemOf = (name: string) => {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(0, dotIndex) : name;
};

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const InlineRenameInput: React.FC<InlineRenameInputProps> = ({ fileName, onCommit, onCancel, className }) => {
  const [value, setValue] = useState(() => stemOf(fileName));
  const doneRef = useRef(false);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };

  return (
    <input
      autoFocus
      spellCheck={false}
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onMouseDown={stop}
      onContextMenu={stop}
      onDragStart={(e) => e.preventDefault()}
      className={className}
    />
  );
};

export default InlineRenameInput;
