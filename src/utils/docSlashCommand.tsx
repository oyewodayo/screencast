// utils/docSlashCommand.tsx
//
// A "/" command palette for fast block insertion - interaction-only (contributes no schema), so
// like Placeholder and docImagePaste.ts's paste extension, this is added directly in DocsEditor.tsx's
// extensions array rather than docSchemaExtensions.ts. Built on @tiptap/suggestion, the same
// official utility Tiptap's own mention/emoji examples use, but rendered without `tippy.js` - this
// codebase already has a manual-popover convention (see DocsEditor.tsx's link/color pickers), so the
// menu here is a plain `position: fixed` div mounted with ReactDOM.createRoot and positioned from
// the suggestion's own clientRect(), rather than adding a new positioning-library dependency.
import { Extension } from "@tiptap/core";
import Suggestion, { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { createRoot, Root } from "react-dom/client";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  MdTitle,
  MdFormatListBulleted,
  MdFormatListNumbered,
  MdFormatQuote,
  MdDataObject,
  MdTableChart,
  MdImage,
  MdHorizontalRule,
  MdShortText,
  MdInsertPageBreak,
} from "react-icons/md";
import SlashCommandMenu, { SlashCommandItem } from "../components/docs/SlashCommandMenu";
import { uploadImageFromPath } from "./docImagePaste";

function buildItems(docId: string): SlashCommandItem[] {
  return [
    {
      title: "Text",
      keywords: ["paragraph", "text", "plain"],
      icon: MdShortText,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
    },
    {
      title: "Heading 1",
      keywords: ["h1", "heading", "title"],
      icon: MdTitle,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
    },
    {
      title: "Heading 2",
      keywords: ["h2", "heading", "subtitle"],
      icon: MdTitle,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
    },
    {
      title: "Heading 3",
      keywords: ["h3", "heading"],
      icon: MdTitle,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run(),
    },
    {
      title: "Bullet list",
      keywords: ["bullet", "list", "unordered", "ul"],
      icon: MdFormatListBulleted,
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      title: "Numbered list",
      keywords: ["numbered", "list", "ordered", "ol"],
      icon: MdFormatListNumbered,
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      title: "Blockquote",
      keywords: ["quote", "blockquote"],
      icon: MdFormatQuote,
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      title: "Code block",
      keywords: ["code", "codeblock", "snippet"],
      icon: MdDataObject,
      run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      title: "Table",
      keywords: ["table", "grid"],
      icon: MdTableChart,
      run: (editor, range) =>
        editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: "Divider",
      keywords: ["divider", "hr", "line", "separator"],
      icon: MdHorizontalRule,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      title: "Page break",
      keywords: ["page", "break", "pagebreak"],
      icon: MdInsertPageBreak,
      run: (editor, range) => editor.chain().focus().deleteRange(range).setPageBreak().run(),
    },
    {
      title: "Image",
      keywords: ["image", "picture", "photo"],
      icon: MdImage,
      run: async (editor, range) => {
        editor.chain().focus().deleteRange(range).run();
        try {
          const selected = await openFileDialog({
            multiple: false,
            filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
          });
          if (!selected || Array.isArray(selected)) return; // cancelled
          const src = await uploadImageFromPath(docId, selected);
          editor.chain().focus().setImage({ src }).run();
        } catch (err) {
          console.error("Failed to insert image from slash command:", err);
        }
      },
    },
  ];
}

function filterItems(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.includes(q)));
}

const MENU_WIDTH = 224; // matches SlashCommandMenu.tsx's w-56

function positionMenu(container: HTMLDivElement, clientRect: (() => DOMRect | null) | null | undefined): void {
  const rect = clientRect?.();
  if (!rect) return;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8);
  // Flip above the cursor line if there isn't roughly a menu's worth of room below - keeps the
  // list from running off the bottom of the window when "/" is typed near the page's end.
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow < 280 ? Math.max(8, rect.top - 280) : rect.bottom + 4;
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;
}

export function createSlashCommandExtension(docId: string) {
  return Extension.create({
    name: "docSlashCommand",
    addProseMirrorPlugins() {
      const items = buildItems(docId);

      return [
        Suggestion<SlashCommandItem>({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          items: ({ query }) => filterItems(items, query),
          command: ({ editor, range, props }) => {
            void props.run(editor, range);
          },
          render: () => {
            let container: HTMLDivElement | null = null;
            let root: Root | null = null;
            let selectedIndex = 0;
            let currentProps: SuggestionProps<SlashCommandItem> | null = null;

            const draw = () => {
              if (!root || !currentProps) return;
              root.render(
                <SlashCommandMenu
                  items={currentProps.items}
                  selectedIndex={selectedIndex}
                  onHover={(index) => {
                    selectedIndex = index;
                    draw();
                  }}
                  onSelect={(item) => currentProps?.command(item)}
                />
              );
            };

            return {
              onStart: (props) => {
                currentProps = props;
                selectedIndex = 0;
                container = document.createElement("div");
                container.style.position = "fixed";
                container.style.zIndex = "50";
                document.body.appendChild(container);
                root = createRoot(container);
                draw();
                positionMenu(container, props.clientRect);
              },
              onUpdate: (props) => {
                currentProps = props;
                selectedIndex = 0;
                draw();
                if (container) positionMenu(container, props.clientRect);
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (!currentProps) return false;
                const count = currentProps.items.length;
                if (props.event.key === "ArrowDown") {
                  selectedIndex = count === 0 ? 0 : (selectedIndex + 1) % count;
                  draw();
                  return true;
                }
                if (props.event.key === "ArrowUp") {
                  selectedIndex = count === 0 ? 0 : (selectedIndex - 1 + count) % count;
                  draw();
                  return true;
                }
                if (props.event.key === "Enter") {
                  const item = currentProps.items[selectedIndex];
                  if (item) currentProps.command(item);
                  return true;
                }
                if (props.event.key === "Escape") {
                  // Removing the "/query" text (rather than just hiding the menu) makes the
                  // suggestion match disappear too, so the plugin's own onExit fires naturally -
                  // no need to reach into its internal state to force-close it.
                  currentProps.editor.chain().focus().deleteRange(props.range).run();
                  return true;
                }
                return false;
              },
              onExit: () => {
                root?.unmount();
                container?.remove();
                root = null;
                container = null;
                currentProps = null;
              },
            };
          },
        }),
      ];
    },
  });
}
