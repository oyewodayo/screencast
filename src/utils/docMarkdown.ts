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
  // Not just a convenient-looking choice - this is literally the same syntax
  // @tiptap/extension-highlight's own input/paste rules use to *detect* a highlight while typing,
  // so re-importing this Markdown elsewhere round-trips correctly. Carries no color information
  // (no CommonMark/this-convention way to express *which* color) - same "drop what can't be
  // represented" posture already used for text color below via applyMarks never touching it.
  if (has("highlight")) result = `==${result}==`;
  const link = marks?.find((m) => m.type === "link");
  if (link) result = `[${result}](${(link.attrs?.href as string) ?? ""})`;
  return result;
}

function imageMarkdown(node: JSONContent): string {
  const alt = (node.attrs?.alt as string) ?? "";
  const src = (node.attrs?.src as string) ?? "";
  return `![${alt}](${src})`;
}

function renderInline(content: JSONContent[] | undefined): string {
  if (!content) return "";
  return content
    .map((node) => {
      if (node.type === "text") return applyMarks(node.text ?? "", node.marks);
      if (node.type === "hardBreak") return "\n";
      // Images are an inline node (docSchemaExtensions.ts's DocImage.configure({ inline: true,
      // ... })) - one can appear anywhere inside a paragraph/heading/list item's own content array,
      // not just as its own top-level block (see renderBlock's "image" case below for that path).
      if (node.type === "image") return imageMarkdown(node);
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
    case "image":
      return imageMarkdown(node);
    // tableRow/tableCell/tableHeader are only ever children of "table" - handled inline below
    // rather than as their own switch cases, since a bare row/cell has no meaningful standalone
    // Markdown rendering outside a table's header+separator structure.
    case "table": {
      const rows = node.content ?? [];
      if (rows.length === 0) return "";
      const renderRow = (row: JSONContent): string[] =>
        (row.content ?? []).map((cell) => renderBlocks(cell.content ?? []).replace(/\n/g, " "));
      const firstRowIsHeader = (rows[0].content ?? []).every((c) => c.type === "tableHeader");
      const headerCells = firstRowIsHeader ? renderRow(rows[0]) : (rows[0].content ?? []).map(() => "");
      const bodyRows = firstRowIsHeader ? rows.slice(1) : rows;
      const headerLine = `| ${headerCells.join(" | ")} |`;
      const separatorLine = `| ${headerCells.map(() => "---").join(" | ")} |`;
      const bodyLines = bodyRows.map((row) => `| ${renderRow(row).join(" | ")} |`);
      return [headerLine, separatorLine, ...bodyLines].join("\n");
    }
    default:
      // Text alignment (node.attrs.textAlign) and color (a "textStyle"/"color" mark, handled in
      // applyMarks) have no CommonMark representation - intentionally not special-cased anywhere
      // in this file, so they're silently dropped rather than forcing non-standard syntax.
      return renderInline(node.content);
  }
}

function renderBlocks(nodes: JSONContent[]): string {
  return nodes.map(renderBlock).join("\n\n");
}

export function docJsonToMarkdown(json: JSONContent): string {
  return renderBlocks(json.content ?? []);
}
