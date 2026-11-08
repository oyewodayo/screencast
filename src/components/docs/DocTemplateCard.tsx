// components/docs/DocTemplateCard.tsx
//
// One template card: a page preview with the template's name (and a short description) under it.
// Shared by DocsHome's "Start a new document" row / gallery and DocTemplateVariantPicker.
import React from "react";

interface DocTemplateCardProps {
  name: string;
  description?: string;
  // Small pill over the preview's corner - e.g. "11 styles" on a template family.
  badge?: string;
  disabled: boolean;
  isBusy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const DocTemplateCard: React.FC<DocTemplateCardProps> = ({ name, description, badge, disabled, isBusy, onClick, children }) => (
  <button type="button" onClick={onClick} disabled={disabled} className="group flex flex-col text-left disabled:cursor-wait">
    <div
      className={`relative w-full rounded-md overflow-hidden border shadow-sm transition ${
        isBusy ? "border-blue-500" : "border-gray-200 dark:border-neutral-700 group-hover:border-blue-400 dark:group-hover:border-blue-500 group-hover:shadow-md"
      }`}
    >
      {children}
      {badge && (
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-semibold shadow-sm">{badge}</span>
      )}
      {isBusy && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-neutral-900/60 text-xs font-medium text-blue-600 dark:text-blue-400">
          Creating…
        </div>
      )}
    </div>
    <p className="mt-2 text-sm font-medium text-gray-800 dark:text-neutral-100 truncate">{name}</p>
    {description && <p className="text-xs text-gray-500 dark:text-neutral-400 line-clamp-2">{description}</p>}
  </button>
);

export default DocTemplateCard;
