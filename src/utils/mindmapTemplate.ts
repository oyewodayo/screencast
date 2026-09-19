// utils/mindmapTemplate.ts
//
// The scaffold a new mindmap starts from. A blank canvas is the worst possible first screen for this
// tool: the interactions that make it worth using (the directional add arrows, Content & Links, the
// connector dots, Live View) are all invisible until there's a node to try them on, so a new user
// has to discover the whole feature before they can use any of it.
//
// So the template does two jobs at once. It shows the SHAPE of a roadmap - a spine of topics with
// subtopics hanging off it - which is the thing that's hard to picture from an empty grid. And its
// instruction panel documents this app's own gestures, so reading it teaches the editor. Everything
// in it is ordinary, fully editable nodes; nothing here is special-cased anywhere else in the code.
//
// Deliberately generic ("Foundations", "Core concepts") rather than tied to a subject: a template
// about learning Python would have to be deleted by anyone mapping something else, whereas these
// headings are a usable skeleton whatever the topic, and still read as placeholders to replace.

import {
  MindmapDocument,
  MindmapEdge,
  MindmapNode,
  MindmapSide,
  MINDMAP_SCHEMA_VERSION,
  createMindmapEdge,
  createMindmapNode,
} from "./mindmapTypes";

// Layout columns, in document coordinates. Kept as named constants rather than inline numbers so the
// composition can be re-tuned without hunting through forty literals - the gaps between these are
// what stop the instruction panel and the left-hand subtopics from colliding.
const COL_NOTES = 200; // instruction panel / checklist / links, down the left
const COL_SPINE = 800; // the main topic spine
const COL_LEFT_BRANCH = 480; // subtopics that hang to the LEFT of the spine
const COL_RIGHT_BRANCH = 1180; // subtopics that hang to the RIGHT

const INSTRUCTIONS = [
  "This is a starting template - edit it, or delete everything and start from scratch.",
  "",
  "Double-click any node to edit its text.",
  "",
  "Drag a component from the left sidebar onto the canvas, or just click it to drop one into the middle of the view.",
  "",
  "Select a topic and use the ↑ ↓ ← → arrows around it to add a connected topic in that direction. That is the fastest way to grow a roadmap.",
  "",
  "To attach reading material to a topic, select it and open the \"Content & Links\" tab on the right.",
  "",
  "To connect two nodes by hand, hover a node and drag one of the blue dots on its edge.",
  "",
  "Press \"Live View\" to see the roadmap the way a reader will - clicking a topic there opens its resources.",
].join("\n");

// Builds the starter document. Every id is generated fresh per call, so two mindmaps created from
// this template never share node ids.
export function createStarterMindmapDocument(id: string, name: string): MindmapDocument {
  const now = new Date().toISOString();
  const nodes: MindmapNode[] = [];
  const edges: MindmapEdge[] = [];

  const add = (node: MindmapNode): MindmapNode => {
    nodes.push(node);
    return node;
  };
  const connect = (from: MindmapNode, fromSide: MindmapSide, to: MindmapNode, toSide: MindmapSide, style: MindmapEdge["style"]) => {
    edges.push(createMindmapEdge(crypto.randomUUID(), from.id, fromSide, to.id, toSide, style));
  };

  // ---- Left column: what the tool is and how to drive it ----------------------------------------
  add(
    createMindmapNode(crypto.randomUUID(), "label", COL_NOTES, 150, {
      label: "Usage instructions",
      bold: true,
    })
  );
  add(
    createMindmapNode(crypto.randomUUID(), "paragraph", COL_NOTES, 400, {
      label: INSTRUCTIONS,
      width: 340,
      height: 400,
      fontSize: "S",
    })
  );
  add(
    createMindmapNode(crypto.randomUUID(), "checklist", COL_NOTES, 700, {
      label: "Before you start",
      items: [
        { id: crypto.randomUUID(), text: "Name this roadmap (top left)", checked: false },
        { id: crypto.randomUUID(), text: "Write a one-line description", checked: false },
        { id: crypto.randomUUID(), text: "Replace the topics on the right", checked: false },
      ],
    })
  );
  add(
    createMindmapNode(crypto.randomUUID(), "linksGroup", COL_NOTES, 870, {
      label: "Reference material",
      items: [
        { id: crypto.randomUUID(), text: "Add a link to the docs", url: "" },
        { id: crypto.randomUUID(), text: "Add a community or forum", url: "" },
      ],
    })
  );

  // ---- The spine: a title, then topics in sequence -----------------------------------------------
  const title = add(
    createMindmapNode(crypto.randomUUID(), "title", COL_SPINE, 90, {
      label: "Your learning path",
      // Sized for XXL text on one line - a heading that wraps out of its own box is the first thing
      // a new user sees, and it reads as the tool being broken rather than as placeholder text.
      width: 460,
      height: 52,
    })
  );

  const foundations = add(
    createMindmapNode(crypto.randomUUID(), "topic", COL_SPINE, 250, {
      label: "Foundations",
      // Seeded so the Content & Links tab has something in it the first time it's opened - an empty
      // panel makes the feature look like it does nothing.
      description: "The groundwork everything else builds on. Replace this with what a beginner has to understand before anything else makes sense.",
      resources: [
        { id: crypto.randomUUID(), type: "article", label: "An introductory overview", url: "", official: true },
        { id: crypto.randomUUID(), type: "video", label: "A short explainer video", url: "" },
      ],
      // One topic starts marked so the progress feature is visible on the map from the first look,
      // rather than being something you only find by opening the panel.
      progress: "in-progress",
    })
  );

  const core = add(createMindmapNode(crypto.randomUUID(), "topic", COL_SPINE, 470, { label: "Core concepts" }));
  const practice = add(createMindmapNode(crypto.randomUUID(), "topic", COL_SPINE, 690, { label: "Practice & projects" }));
  const deeper = add(createMindmapNode(crypto.randomUUID(), "topic", COL_SPINE, 910, { label: "Going deeper" }));

  connect(title, "bottom", foundations, "top", "solid");
  connect(foundations, "bottom", core, "top", "solid");
  connect(core, "bottom", practice, "top", "solid");
  connect(practice, "bottom", deeper, "top", "solid");

  // ---- Branches: subtopics, dashed to read as "belongs to" rather than "comes next" --------------
  const branch = (parent: MindmapNode, column: number, side: MindmapSide, entries: { label: string; y: number }[]) => {
    const opposite: MindmapSide = side === "right" ? "left" : "right";
    for (const entry of entries) {
      const child = add(createMindmapNode(crypto.randomUUID(), "subtopic", column, entry.y, { label: entry.label }));
      connect(parent, side, child, opposite, "dashed");
    }
  };

  branch(foundations, COL_RIGHT_BRANCH, "right", [
    { label: "Key terms", y: 170 },
    { label: "The mental model", y: 230 },
    { label: "Set up your tools", y: 290 },
  ]);
  branch(core, COL_LEFT_BRANCH, "left", [
    { label: "First core idea", y: 440 },
    { label: "Second core idea", y: 500 },
  ]);
  branch(practice, COL_RIGHT_BRANCH, "right", [
    { label: "A small project", y: 650 },
    { label: "A harder project", y: 710 },
  ]);
  branch(deeper, COL_RIGHT_BRANCH, "right", [
    { label: "Advanced topic", y: 880 },
    { label: "Where to go next", y: 940 },
  ]);

  return {
    version: MINDMAP_SCHEMA_VERSION,
    id,
    name,
    description: "What is this roadmap for?",
    nodes,
    edges,
    showGrid: true,
    snapToGrid: true,
    createdAt: now,
    updatedAt: now,
  };
}
