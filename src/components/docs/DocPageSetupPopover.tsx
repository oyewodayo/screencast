// components/docs/DocPageSetupPopover.tsx
//
// Toolbar popover for page size + repeating header/footer text - see DocsEditor.tsx's own comment
// on the CSS `@page` / position:fixed tricks that actually make these show up correctly at print
// time. Local draft state so typing in the header/footer fields doesn't fire a save_doc_page_setup
// invoke on every keystroke; committed on blur/close, same "commit on blur, not on every change"
// treatment DocFolderSidebar.tsx's inline rename/create rows already use.
import React, { useEffect, useState } from "react";
import { DocPageSize } from "../../utils/docTypes";

interface DocPageSetupPopoverProps {
  pageSize: DocPageSize | null;
  headerText: string | null;
  footerText: string | null;
  onApply: (pageSize: DocPageSize | null, headerText: string | null, footerText: string | null) => void;
  onClose: () => void;
}

const PAGE_SIZE_LABELS: Record<DocPageSize, string> = {
  letter: "Letter (8.5 × 11 in)",
  a4: "A4 (210 × 297 mm)",
  legal: "Legal (8.5 × 14 in)",
};

const DocPageSetupPopover: React.FC<DocPageSetupPopoverProps> = ({ pageSize, headerText, footerText, onApply, onClose }) => {
  const [draftSize, setDraftSize] = useState<DocPageSize>(pageSize ?? "letter");
  const [draftHeader, setDraftHeader] = useState(headerText ?? "");
  const [draftFooter, setDraftFooter] = useState(footerText ?? "");

  // Re-syncs the draft if the popover is reopened after the doc's own page setup changed
  // elsewhere (e.g. a version restore) while it was closed.
  useEffect(() => {
    setDraftSize(pageSize ?? "letter");
    setDraftHeader(headerText ?? "");
    setDraftFooter(footerText ?? "");
  }, [pageSize, headerText, footerText]);

  const commit = () => {
    onApply(draftSize, draftHeader.trim() || null, draftFooter.trim() || null);
    onClose();
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full mt-1 z-10 w-72 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-lg p-3 space-y-2.5"
    >
      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Page size</label>
        <select
          value={draftSize}
          onChange={(e) => setDraftSize(e.target.value as DocPageSize)}
          className="w-full px-2 py-1.5 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
        >
          {(Object.keys(PAGE_SIZE_LABELS) as DocPageSize[]).map((size) => (
            <option key={size} value={size}>
              {PAGE_SIZE_LABELS[size]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Header (repeats on every printed page)</label>
        <input
          value={draftHeader}
          onChange={(e) => setDraftHeader(e.target.value)}
          placeholder="e.g. document title"
          className="w-full px-2 py-1.5 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
        />
      </div>
      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">Footer (repeats on every printed page)</label>
        <input
          value={draftFooter}
          onChange={(e) => setDraftFooter(e.target.value)}
          placeholder="e.g. confidential"
          className="w-full px-2 py-1.5 text-sm rounded border border-neutral-200 dark:border-neutral-700 bg-transparent outline-none text-neutral-800 dark:text-neutral-100"
        />
      </div>
      <div className="flex justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="px-2.5 py-1 text-xs rounded text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700"
        >
          Cancel
        </button>
        <button type="button" onClick={commit} className="px-2.5 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700">
          Apply
        </button>
      </div>
    </div>
  );
};

export default DocPageSetupPopover;
