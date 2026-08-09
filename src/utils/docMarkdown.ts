// utils/docMarkdown.ts
//
// Converts a Tiptap document (editor.getJSON()) to Markdown for DocsEditor's export feature. Hand-
// rolled rather than pulling in an HTML-to-Markdown library (e.g. turndown) - the doc schema is
// fully bounded (StarterKit + Underline + Link, nothing else), so walking the known JSONContent
// tree directly is simpler and more predictable than round-tripping through HTML.
import type { JSONContent } from "@tiptap/core";

function applyMarks(text: string, marks: JSONContent["marks"]): string {
  let result = text;
  const has = (type: string) => marks?.some((m) => m.type === type) ?? false;
  // Fixed precedence (innermost -> outermost) since marks[] order isn't guaranteed by Tiptap -
  // without this, "**_bold italic_**" vs "_**bold italic**_" could vary edit to edit for no reason.
  if (has("code")) result = `\`${result}\``;
  if (has("bold")) result = `**${result}**`;
  if (has("italic")) result = `*${result}*`;
  // No CommonMark syntax for underline - literal inline HTML, same convention most Markdown
  // renderers already tolerate.
  if (has("underline")) result = `<u>${result}</u>`;
  if (has("strike")) result = `~~${result}~~`;
  const link = marks?.find((m) => m.type === "link");
  if (link) result = `[${result}](${(link.attrs?.href as string) ?? ""})`;
  return result;
}

function renderInline(content: JSONContent[] | undefined): string {
  if (!content) return "";
  return content
    .map((node) => {
      if (node.type === "text") return applyMarks(node.text ?? "", node.marks);
      if (node.type === "hardBreak") return "\n";
      return "";
    })
    .join("");
}

function renderListItem(node: JSONContent, prefix: string): string {
  const children = node.content ?? [];
  const text = children
    .filter((c) => c.type === "paragraph")
    .map((p) => renderInline(p.content))
    .join(" ");
  let result = prefix + text;
  const nestedLists = children.filter((c) => c.type === "bulletList" || c.type === "orderedList");
  for (const nested of nestedLists) {
    const indented = renderBlock(nested)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    result += `\n${indented}`;
  }
  return result;
}

function renderBlock(node: JSONContent): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      return `${"#".repeat(level)} ${renderInline(node.content)}`;
    }
    case "bulletList":
      return (node.content ?? []).map((li) => renderListItem(li, "- ")).join("\n");
    case "orderedList": {
      const start = (node.attrs?.start as number) ?? 1;
      return (node.content ?? []).map((li, i) => renderListItem(li, `${start + i}. `)).join("\n");
    }
    case "blockquote":
      return renderBlocks(node.content ?? [])
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "codeBlock": {
      const language = (node.attrs?.language as string) ?? "";
      // Marks are ignored inside code blocks - CodeBlock's schema doesn't carry them anyway.
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${language}\n${text}\n\`\`\``;
    }
    default:
      return renderInline(node.content);
  }
}

function renderBlocks(nodes: JSONContent[]): string {
  return nodes.map(renderBlock).join("\n\n");
}

export function docJsonToMarkdown(json: JSONContent): string {
  return renderBlocks(json.content ?? []);
}
