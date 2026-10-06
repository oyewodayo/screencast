// components/docs/DocBibliographyView.tsx
//
// NodeView for the reference list (docStructureNodes.ts's `bibliography`). Shows every cited work,
// formatted in the document's citation style and ordered the way that style orders it - by first
// citation for numbered styles, alphabetically for APA. Re-renders only when the formatted list
// itself changes (the structure plugin's data-rev decoration).
import React from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { getDocStructure } from "../../utils/docStructure";
import { styleInfo } from "../../utils/docCitationStyles";
import DocReferenceText from "./DocReferenceText";

const DocBibliographyView: React.FC<NodeViewProps> = ({ editor, selected }) => {
  const structure = getDocStructure(editor.state);
  const refs = structure?.bibliography ?? [];
  const info = styleInfo(structure?.style ?? "nature");

  return (
    <NodeViewWrapper
      as="div"
      contentEditable={false}
      data-style={info.id}
      className={`doc-bibliography ${info.numeric ? "doc-bibliography-numeric" : "doc-bibliography-hanging"} ${selected ? "doc-block-selected" : ""}`}
    >
      {refs.length === 0 ? (
        <div className="doc-generated-empty">
          <span className="doc-generated-empty-title">Reference list</span>
          Works you cite appear here automatically, formatted in {info.name} style. Use <b>Cite</b> in the toolbar to add one.
        </div>
      ) : (
        <ol className="doc-bib-list">
          {refs.map((ref) => (
            <li key={ref.id} className="doc-bib-item" data-ref-id={ref.id}>
              {ref.label && <span className="doc-bib-label">{ref.label}</span>}
              <span className="doc-bib-body">
                <DocReferenceText segments={ref.segments} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </NodeViewWrapper>
  );
};

export default DocBibliographyView;
