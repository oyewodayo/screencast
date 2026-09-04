// utils/docMarkdown.ts
//
// Converts a Tiptap document (editor.getJSON()) to Markdown for DocsEditor's export feature. Hand-
// rolled rather than pulling in an HTML-to-Markdown library (e.g. turndown) - the doc schema is
// fully bounded (StarterKit + Underline + Link, nothing else), so walking the known JSONContent
// tree directly is simpler and more predictable than round-tripping through HTML.
import type { JSONContent } from "@tiptap/core";
import type { DocComment } from "./docTypes";

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

// CommonMark has no concept of an anchored comment - unlike the marks applyMarks handles, there's
// no syntax to *wrap* commented text in without either changing what it visually renders as or
// inventing non-standard syntax. Instead, an HTML comment (already tolerated inline by virtually
// every Markdown renderer, and invisible in rendered output) is appended right after the commented
// range, so the information survives the export instead of silently vanishing the way it used to.
// "-->" is defanged in the body so a comment whose own text happens to contain that sequence can't
// prematurely close the HTML comment and leak raw text into the rendered document.
function commentAnnotation(comments: DocComment[], commentId: string): string {
  const comment = comments.find((c) => c.mark_id === commentId);
  if (!comment) return "";
  return `<!-- comment: ${comment.text.replace(/-->/g, "-- >")} -->`;
}

function renderInline(content: JSONContent[] | undefined, comments: DocComment[]): string {
  if (!content) return "";
  let result = "";
  let activeCommentId: string | null = null;
  const closeComment = () => {
    if (activeCommentId) {
      result += commentAnnotation(comments, activeCommentId);
      activeCommentId = null;
    }
  };
  for (const node of content) {
    const commentId = (node.marks?.find((m) => m.type === "comment")?.attrs?.commentId as string | undefined) ?? null;
    if (commentId !== activeCommentId) {
      closeComment();
      activeCommentId = commentId;
    }
    if (node.type === "text") result += applyMarks(node.text ?? "", node.marks);
    else if (node.type === "hardBreak") result += "\n";
    // Images are an inline node (docSchemaExtensions.ts's DocImage.configure({ inline: true, ... }))
    // - one can appear anywhere inside a paragraph/heading/list item's own content array, not just
    // as its own top-level block (see renderBlock's "image" case below for that path).
    else if (node.type === "image") result += imageMarkdown(node);
  }
  closeComment();
  return result;
}

function renderListItem(node: JSONContent, prefix: string, comments: DocComment[]): string {
  const children = node.content ?? [];
  const text = children
    .filter((c) => c.type === "paragraph")
    .map((p) => renderInline(p.content, comments))
    .join(" ");
  let result = prefix + text;
  const nestedLists = children.filter((c) => c.type === "bulletList" || c.type === "orderedList");
  for (const nested of nestedLists) {
    const indented = renderBlock(nested, comments)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    result += `\n${indented}`;
  }
  return result;
}

function renderBlock(node: JSONContent, comments: DocComment[]): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content, comments);
    case "heading": {
      const level = (node.attrs?.level as number) ?? 1;
      return `${"#".repeat(level)} ${renderInline(node.content, comments)}`;
    }
    case "bulletList":
      return (node.content ?? []).map((li) => renderListItem(li, "- ", comments)).join("\n");
    case "orderedList": {
      const start = (node.attrs?.start as number) ?? 1;
      return (node.content ?? []).map((li, i) => renderListItem(li, `${start + i}. `, comments)).join("\n");
    }
    case "blockquote":
      return renderBlocks(node.content ?? [], comments)
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
    // No CommonMark syntax for a page break either - "\n\n---\n\n" would be indistinguishable from
    // a real horizontal rule if this schema had one, so this uses the same defanged HTML-comment
    // convention as commentAnnotation above instead of overloading `---`.
    case "pageBreak":
      return "<!-- page break -->";
    // tableRow/tableCell/tableHeader are only ever children of "table" - handled inline below
    // rather than as their own switch cases, since a bare row/cell has no meaningful standalone
    // Markdown rendering outside a table's header+separator structure.
    case "table": {
      const rows = node.content ?? [];
      if (rows.length === 0) return "";
      const renderRow = (row: JSONContent): string[] =>
        (row.content ?? []).map((cell) => renderBlocks(cell.content ?? [], comments).replace(/\n/g, " "));
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
      return renderInline(node.content, comments);
  }
}

function renderBlocks(nodes: JSONContent[], comments: DocComment[]): string {
  return nodes.map((node) => renderBlock(node, comments)).join("\n\n");
}

export function docJsonToMarkdown(json: JSONContent, comments: DocComment[] = []): string {
  return renderBlocks(json.content ?? [], comments);
}
