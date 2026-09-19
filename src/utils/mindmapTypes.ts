// utils/mindmapTypes.ts
//
// The Mindmap feature's object model - a structured learning-roadmap builder in the shape of
// roadmap.sh: a canvas of TYPED nodes (topics, subtopics, headings, notes, checklists) wired
// together by connectors, where each topic can carry its own curated list of resource links.
//
// Deliberately its own feature rather than another whiteboard shapeType, despite both being
// "boxes on a canvas". The two answer different questions and that shows up in the data model:
//
//   - A whiteboard node is a DRAWING - its shape is the content, it has arbitrary geometry, fill,
//     stroke, rotation, flips. Style is per-node and freeform.
//   - A mindmap node is a CURRICULUM ENTRY - it has a semantic type ("this is a topic", "this is a
//     sub-topic"), a slot in a hierarchy, attached learning resources, and a progress state a
//     reader marks off. Its appearance comes from that type plus a palette key, not from per-node
//     styling, precisely so a hundred-node roadmap stays visually coherent without anyone
//     maintaining it.
//
// That semantic layer is what makes the published view useful (a reader clicks a topic and gets its
// resources, and their own progress is tracked per topic) - none of which a freeform shape can
// express. See MindmapNode.resources/progress.

export type MindmapNodeType =
  // The three structural levels, drawn as filled boxes and the only types that participate in the
  // topic hierarchy (see MindmapEdge). "title" is the roadmap's own section heading; "topic" is a
  // major area; "subtopic" is a leaf under one.
  | "title"
  | "topic"
  | "subtopic"
  // Free-standing annotation types - they sit on the canvas and can be connected, but carry no
  // resources and no progress state, because "read this paragraph" isn't something a learner ticks
  // off the way a topic is.
  | "paragraph"
  | "label"
  | "button"
  // A checklist of short items - the "prerequisites" / "you should know" block roadmap.sh uses
  // above a section. Items live in MindmapNode.items.
  | "checklist"
  // A picture, addressed by URL rather than imported as a file. A roadmap's images are almost always
  // something already on the web (a diagram, a logo, a screenshot from the docs it is pointing at),
  // and a URL keeps the document portable - it stays a single JSON file with no sidecar assets to
  // carry around. Optionally clickable via MindmapNode.linkUrl.
  | "image"
  // A titled container drawn BEHIND everything else - the way a roadmap groups a run of related
  // topics under one heading ("Fundamentals", "Tooling") without connecting them. Purely visual: it
  // has no parent/child relationship to whatever sits on top of it, so moving a section does not
  // move its contents. That is a deliberate scope choice - real containment would mean a parent link
  // on every node and hit-testing that respects it, for a feature whose whole job is a labelled
  // backdrop.
  | "section"
  // A titled list of links rendered inline on the canvas (as opposed to MindmapNode.resources,
  // which are hidden behind a topic and only shown when it's opened). Also uses `items`, with each
  // item carrying a url.
  | "linksGroup"
  // Pure visual dividers - no label, no content, just a rule. Their node box's width/height is the
  // line's own length and thickness.
  | "horizontalLine"
  | "verticalLine";

// The structural types, which are the only ones that can own resources, carry progress, or be the
// endpoint of a hierarchy connector. Shared here so every reader (the canvas, the panels, the
// published view) agrees rather than each repeating the list.
export const TOPIC_NODE_TYPES: ReadonlySet<MindmapNodeType> = new Set<MindmapNodeType>(["title", "topic", "subtopic"]);

// ---- Palette ------------------------------------------------------------------------------------
//
// Node color is a PALETTE KEY ("A".."H"), never a raw hex value. That indirection is the whole
// reason a roadmap with a hundred nodes stays coherent: the palette can be retuned (or a dark
// variant introduced) in one place and every existing document follows, whereas stored hex would
// freeze each node at whatever looked right the day it was made. It also keeps the color control a
// row of eight swatches rather than a color picker offering 16 million ways to look inconsistent.
export type MindmapColorKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

export const MINDMAP_COLOR_KEYS: MindmapColorKey[] = ["A", "B", "C", "D", "E", "F", "G", "H"];

export interface MindmapPaletteEntry {
  name: string;
  background: string;
  border: string;
  text: string;
}

// Matched to roadmap.sh's own node palette: a warm yellow for primary topics, a lighter tan for
// subtopics, and a spread of muted accents for grouping. Borders are a darker step of the same hue
// rather than a shared gray, so a node reads as one object at small zoom.
export const MINDMAP_PALETTE: Record<MindmapColorKey, MindmapPaletteEntry> = {
  A: { name: "Slate", background: "#ffffff", border: "#111827", text: "#111827" },
  B: { name: "Yellow", background: "#fbe25c", border: "#b59a00", text: "#20211f" },
  C: { name: "Tan", background: "#fcdfa5", border: "#c9973c", text: "#20211f" },
  D: { name: "Green", background: "#c9f0d3", border: "#3f9e5c", text: "#14321f" },
  E: { name: "Blue", background: "#c7ddfa", border: "#3b74c4", text: "#10243d" },
  F: { name: "Grey", background: "#dcdcdc", border: "#7d7d7d", text: "#1f1f1f" },
  G: { name: "Pink", background: "#fbd0dd", border: "#cc5f85", text: "#3a1220" },
  H: { name: "Purple", background: "#ddd3f7", border: "#7a5cc4", text: "#241a3d" },
};

// ---- Font sizes ---------------------------------------------------------------------------------
//
// Same "key, not a number" reasoning as the palette - five named steps rather than a free numeric
// field, so headings and topics stay on a consistent scale across a document instead of drifting to
// 15px here and 17px there.
export type MindmapFontSize = "S" | "M" | "L" | "XL" | "XXL";

export const MINDMAP_FONT_SIZES: MindmapFontSize[] = ["S", "M", "L", "XL", "XXL"];

export const MINDMAP_FONT_PX: Record<MindmapFontSize, number> = { S: 12, M: 14, L: 17, XL: 22, XXL: 28 };

// ---- Resources ("Content & Links") --------------------------------------------------------------

// What a linked resource IS, which drives the little badge shown beside it in the published view.
// roadmap.sh leads with this distinction because "watch a 40 minute video" and "read a 2 minute
// reference page" are very different asks of a learner's time, and a flat list of blue links hides
// that entirely.
export type MindmapResourceType = "article" | "video" | "course" | "docs" | "book" | "tool" | "feed" | "opensource";

export interface MindmapResource {
  id: string;
  type: MindmapResourceType;
  label: string;
  url: string;
  // Marks an officially-recommended resource - roadmap.sh's own "official" badge. Purely a display
  // hint; it doesn't reorder or filter anything.
  official?: boolean;
}

// How far a reader has got with one topic. Lives on the node (not in a separate per-reader store)
// because a mindmap document here is a single user's own working roadmap, not a shared publication
// with many readers - the same reason the whiteboard keeps its own view state per document.
export type MindmapProgress = "pending" | "done" | "in-progress" | "skipped";

// ---- Nodes --------------------------------------------------------------------------------------

// How a ticked checklist row is marked. "tick" is the ordinary done/not-done checkbox; "cross" reads
// as "explicitly not this" (useful for a "what this roadmap does NOT cover" list); "dot" and
// "square" are neutral fills for a list that is being used as a progress tally rather than a
// yes/no.
export type MindmapCheckStyle = "tick" | "cross" | "dot" | "square";

export const MINDMAP_CHECK_STYLES: MindmapCheckStyle[] = ["tick", "cross", "dot", "square"];

// The glyph drawn inside a ticked box, per style - shared by the canvas and the published view so
// the two can't disagree about what a ticked row looks like.
export const MINDMAP_CHECK_GLYPH: Record<MindmapCheckStyle, string> = { tick: "✓", cross: "✕", dot: "●", square: "■" };

// Green because a checkmark's near-universal meaning is "done" - a checklist that ticks in the
// node's own border colour reads as decoration rather than as progress.
export const DEFAULT_CHECK_COLOR = "#16a34a";
export const DEFAULT_CHECK_STYLE: MindmapCheckStyle = "tick";

// One item inside a "checklist" or "linksGroup" node.
export interface MindmapListItem {
  id: string;
  text: string;
  // "linksGroup" only - the destination. A checklist item has no url.
  url?: string;
  // "checklist" only.
  checked?: boolean;
}

export interface MindmapNode {
  id: string;
  type: MindmapNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  // The node's own visible text. For "linksGroup"/"checklist" this is the group's heading, with the
  // entries themselves in `items`; for the two line types it's unused.
  label: string;
  colorKey: MindmapColorKey;
  fontSize: MindmapFontSize;
  // Absent - resolves to the type's own default weight (see MINDMAP_TYPE_DEFAULTS): topics read
  // bold, paragraphs don't.
  bold?: boolean;
  italic?: boolean;
  // TOPIC_NODE_TYPES only. Absent/empty - no attached resources, which is the normal state for a
  // node whose content hasn't been filled in yet.
  resources?: MindmapResource[];
  // TOPIC_NODE_TYPES only. Absent - "pending".
  progress?: MindmapProgress;
  // A longer description shown when the topic is opened, above its resource list. Markdown is NOT
  // parsed - this renders as plain text with line breaks preserved, since a roadmap description is
  // a paragraph or two of orientation, not a document.
  description?: string;
  // "checklist"/"linksGroup" only.
  items?: MindmapListItem[];
  // "image" only. `assetFileName` is a picture imported into this mindmap's own assets/ folder and
  // is the normal case; `imageUrl` is a raw URL for the rare one. They are two fields rather than
  // one because an imported asset has to be resolved against the library root at render time, while
  // a URL is used verbatim - collapsing them would mean guessing which kind a string is.
  //
  // Note the app's content-security policy only permits images from `asset:` and `data:`, so a
  // remote https:// URL is blocked by the webview and renders as nothing. That is why importing is
  // the primary path here, and why the panel says so rather than letting it fail silently.
  assetFileName?: string;
  imageUrl?: string;
  // Opened when the image is clicked in the reader view. A plain hyperlink, so no CSP involvement.
  linkUrl?: string;
  // "checklist" only - which glyph a ticked row shows, and in what colour. Per-node rather than
  // global because a roadmap often has several checklists meaning different things (prerequisites
  // you must have vs. optional extras vs. things to avoid), and the glyph is what distinguishes
  // them at a glance without reading every row. Absent - resolve to DEFAULT_CHECK_STYLE/COLOR.
  checkStyle?: MindmapCheckStyle;
  checkColor?: string;
  // Prevents this node being moved or resized - same "pin it while working around it" affordance
  // the whiteboard's own locked flag provides.
  locked?: boolean;
}

// Per-type defaults: the starting box size and text treatment that make a freshly dropped node look
// immediately right for what it is, rather than every type arriving as the same neutral rectangle
// the user then has to restyle. Kept as one table (rather than branches inside the factory) so the
// full set of type appearances can be read and adjusted in one place.
export const MINDMAP_TYPE_DEFAULTS: Record<
  MindmapNodeType,
  { width: number; height: number; fontSize: MindmapFontSize; colorKey: MindmapColorKey; bold: boolean; label: string }
> = {
  title: { width: 420, height: 48, fontSize: "XXL", colorKey: "A", bold: true, label: "Section title" },
  topic: { width: 220, height: 50, fontSize: "L", colorKey: "B", bold: true, label: "Topic" },
  subtopic: { width: 200, height: 42, fontSize: "M", colorKey: "C", bold: false, label: "Sub-topic" },
  paragraph: { width: 280, height: 90, fontSize: "M", colorKey: "A", bold: false, label: "Some descriptive text explaining this part of the roadmap." },
  label: { width: 160, height: 32, fontSize: "M", colorKey: "A", bold: false, label: "Label" },
  button: { width: 170, height: 40, fontSize: "M", colorKey: "E", bold: true, label: "Visit resource" },
  checklist: { width: 240, height: 130, fontSize: "M", colorKey: "A", bold: false, label: "Before you start" },
  linksGroup: { width: 240, height: 130, fontSize: "M", colorKey: "A", bold: false, label: "Useful links" },
  image: { width: 240, height: 180, fontSize: "S", colorKey: "A", bold: false, label: "Image" },
  // Large by default - a section is a backdrop several topics sit inside, so a small one would have
  // to be resized before it could do its job.
  section: { width: 460, height: 320, fontSize: "L", colorKey: "F", bold: true, label: "Section" },
  horizontalLine: { width: 220, height: 2, fontSize: "M", colorKey: "A", bold: false, label: "" },
  verticalLine: { width: 2, height: 200, fontSize: "M", colorKey: "A", bold: false, label: "" },
};

// The palette entries offered in the editor's drag-and-drop component list, in the order roadmap.sh
// itself presents them (structure first, then content blocks, then dividers).
export const MINDMAP_COMPONENT_ORDER: MindmapNodeType[] = [
  "title",
  "topic",
  "subtopic",
  "paragraph",
  "label",
  "button",
  "image",
  "checklist",
  "linksGroup",
  "section",
  "horizontalLine",
  "verticalLine",
];

export const MINDMAP_TYPE_LABEL: Record<MindmapNodeType, string> = {
  title: "Title",
  topic: "Topic",
  subtopic: "Sub Topic",
  paragraph: "Paragraph",
  label: "Label",
  button: "Button",
  image: "Image",
  checklist: "Checklist",
  linksGroup: "Links Group",
  section: "Section",
  horizontalLine: "Horizontal Line",
  verticalLine: "Vertical Line",
};

// ---- Edges --------------------------------------------------------------------------------------

// Which side of a node a connector leaves from / arrives at. Unlike the whiteboard's connectors
// there is no "auto" mode: a roadmap's lines are part of its composition (the reader follows them
// as a path), so a line silently re-routing itself to the other side of a box when something moves
// would change the diagram's meaning, not just tidy it.
export type MindmapSide = "top" | "right" | "bottom" | "left";

export interface MindmapEdge {
  id: string;
  sourceId: string;
  sourceSide: MindmapSide;
  targetId: string;
  targetSide: MindmapSide;
  // Dashed is roadmap.sh's convention for "this subtopic belongs to that topic" (a containment
  // hint), solid for "follow this path next" (a sequence). Two visual weights carrying two
  // different meanings, which is why the style is per-edge rather than a document-wide setting.
  style: "solid" | "dashed";
}

export interface MindmapDocument {
  version: typeof MINDMAP_SCHEMA_VERSION;
  id: string;
  name: string;
  // Shown under the title in the editor and in the published view - the one-line "what is this
  // roadmap for" a reader needs before committing to it.
  description: string;
  nodes: MindmapNode[];
  edges: MindmapEdge[];
  showGrid: boolean;
  snapToGrid: boolean;
  createdAt: string;
  updatedAt: string;
}

export const MINDMAP_SCHEMA_VERSION = 1 as const;

// Frontend mirror of mindmaps.rs's MindmapSummary - snake_case to match the Rust struct's serde
// output exactly, same convention as WhiteboardSummary.
export interface MindmapSummary {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  thumbnail_path: string | null;
  node_count: number;
}

export function createEmptyMindmapDocument(id: string, name: string): MindmapDocument {
  const now = new Date().toISOString();
  return {
    version: MINDMAP_SCHEMA_VERSION,
    id,
    name,
    description: "",
    nodes: [],
    edges: [],
    showGrid: true,
    snapToGrid: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createMindmapNode(id: string, type: MindmapNodeType, centerX: number, centerY: number, overrides?: Partial<MindmapNode>): MindmapNode {
  const d = MINDMAP_TYPE_DEFAULTS[type];
  // Size is resolved BEFORE the centering maths, not after. Spreading `overrides` over an x/y that
  // was derived from the type's DEFAULT size would leave any node given a custom width or height
  // visibly off-centre from the point it was asked to sit on - which is not what a function taking
  // a centre point should do, and is silently wrong rather than obviously wrong.
  const width = overrides?.width ?? d.width;
  const height = overrides?.height ?? d.height;
  return {
    id,
    type,
    x: Math.round(centerX - width / 2),
    y: Math.round(centerY - height / 2),
    width,
    height,
    label: d.label,
    colorKey: d.colorKey,
    fontSize: d.fontSize,
    bold: d.bold,
    // A checklist/links group with no rows is an empty box with a heading - seeding two placeholder
    // rows makes the type's purpose legible the moment it lands, the same reasoning behind every
    // other type arriving with real default text rather than blank.
    items:
      type === "checklist"
        ? [
            { id: crypto.randomUUID(), text: "First prerequisite", checked: false },
            { id: crypto.randomUUID(), text: "Second prerequisite", checked: false },
          ]
        : type === "linksGroup"
          ? [
              { id: crypto.randomUUID(), text: "Official documentation", url: "" },
              { id: crypto.randomUUID(), text: "Getting started guide", url: "" },
            ]
          : undefined,
    ...overrides,
  };
}

export function createMindmapEdge(id: string, sourceId: string, sourceSide: MindmapSide, targetId: string, targetSide: MindmapSide, style: MindmapEdge["style"] = "dashed"): MindmapEdge {
  return { id, sourceId, sourceSide, targetId, targetSide, style };
}

// Progress only means something for a topic-ish node; everything else resolves to "pending" and is
// never drawn with a progress treatment. One accessor so the canvas, the panel and the published
// view can't disagree about which nodes are trackable.
export function resolveProgress(node: MindmapNode): MindmapProgress {
  return TOPIC_NODE_TYPES.has(node.type) ? node.progress ?? "pending" : "pending";
}

export function resolveCheckStyle(node: MindmapNode): MindmapCheckStyle {
  return node.checkStyle ?? DEFAULT_CHECK_STYLE;
}

export function resolveCheckColor(node: MindmapNode): string {
  return node.checkColor ?? DEFAULT_CHECK_COLOR;
}

// The list rows a node actually has. One accessor so the canvas, the panel and the export agree -
// and so a type that has no business owning rows can never accidentally render some left behind by
// an earlier type change.
export function nodeItems(node: MindmapNode): MindmapListItem[] {
  return node.type === "checklist" || node.type === "linksGroup" ? node.items ?? [] : [];
}

export function nodeResources(node: MindmapNode): MindmapResource[] {
  return TOPIC_NODE_TYPES.has(node.type) ? node.resources ?? [] : [];
}
