// components/docs/DocReferenceText.tsx
//
// Renders a formatted reference (docCitationStyles.ts segments) as React - italic journal, bold
// volume, live DOI/arXiv links. Links open in the system browser: a plain href would navigate the
// app's own webview away from the document.
import React from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { Segment } from "../../utils/docCitationStyles";

export function openLink(url: string): void {
  openExternal(url).catch((err) => console.error("Failed to open link:", err));
}

const DocReferenceText: React.FC<{ segments: Segment[]; linkClassName?: string }> = ({ segments, linkClassName = "doc-bib-link" }) => (
  <>
    {segments.map((s, i) => {
      let node: React.ReactNode = s.text;
      if (s.bold) node = <b>{node}</b>;
      if (s.italic) node = <i>{node}</i>;
      if (s.link) {
        const url = s.link;
        node = (
          <a
            href={url}
            className={linkClassName}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openLink(url);
            }}
          >
            {node}
          </a>
        );
      }
      return <React.Fragment key={i}>{node}</React.Fragment>;
    })}
  </>
);

export default DocReferenceText;
