// components/docs/DocTemplateVariantPicker.tsx
//
// The style picker a template family opens (Resume / CV): every variant as a full page preview,
// filterable by its group ("Technology", "Healthcare", ...). Picking one creates the document.
import React, { useEffect, useMemo, useState } from "react";
import { IoClose } from "react-icons/io5";
import { templatePreview, type DocTemplate } from "../../utils/docTemplates";
import DocPagePreview from "./DocPagePreview";
import DocTemplateCard from "./DocTemplateCard";

interface DocTemplateVariantPickerProps {
  family: DocTemplate;
  creatingId: string | null;
  onPick: (variant: DocTemplate) => void;
  onClose: () => void;
}

const DocTemplateVariantPicker: React.FC<DocTemplateVariantPickerProps> = ({ family, creatingId, onPick, onClose }) => {
  const variants = family.variants ?? [];
  const groups = useMemo(() => Array.from(new Set(variants.map((v) => v.group).filter((g): g is string => !!g))), [variants]);
  const [group, setGroup] = useState<string | null>(null);
  const shown = group ? variants.filter((v) => v.group === group) : variants;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chip = (label: string, value: string | null) => (
    <button
      key={label}
      type="button"
      onClick={() => setGroup(value)}
      className={`px-3 py-1 rounded-full text-sm border transition-colors ${
        group === value
          ? "bg-blue-600 border-blue-600 text-white"
          : "border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a ${family.name} style`}
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col w-full max-w-6xl max-h-full rounded-xl bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-800 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-200 dark:border-neutral-800">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-neutral-100">{family.name} — choose a style</h2>
            <p className="text-sm text-gray-500 dark:text-neutral-400">
              Each style follows the conventions of its field and comes filled with sample content to replace with your own.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <IoClose size={20} />
          </button>
        </div>
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-2 px-6 pt-4">
            {chip("All", null)}
            {groups.map((g) => chip(g, g))}
          </div>
        )}
        <div className="overflow-y-auto px-6 py-5">
          <div className="grid gap-5 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
            {shown.map((variant) => (
              <DocTemplateCard
                key={variant.id}
                name={variant.name}
                description={variant.description}
                disabled={creatingId !== null}
                isBusy={creatingId === variant.id}
                onClick={() => onPick(variant)}
              >
                <DocPagePreview preview={templatePreview(variant)} />
              </DocTemplateCard>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DocTemplateVariantPicker;
