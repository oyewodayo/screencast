// utils/docTypes.ts
//
// Frontend mirror of docs.rs's DocSummary. No document-shape type exists here (unlike
// boardTypes.ts's BoardDocument) because a doc's actual content lives entirely inside its Y.Doc -
// it's never serialized to a plain TS interface, only to/from the opaque doc.bin bytes.
export interface DocSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
