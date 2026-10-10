// utils/docMarkdown.ts
//
// Converts a Tiptap document (editor.getJSON()) to Markdown for DocsEditor's export feature. Hand-
// rolled rather than pulling in an HTML-to-Markdown library (e.g. turndown) - the doc schema is
// fully bounded (StarterKit + Underline + Link, nothing else), so walking the known JSONContent
// tree directly is simpler and more predictable than round-tripping through HTML.
import type { JSONContent } from "@tiptap/core";
import type { DocComment } from "./docTypes";
import { captionLabel, crossRefText, type DocStructure } from "./docStructure";
import { DEFAULT_NUMBERING } from "./docNumbering";
import { citationSpaceBefore, formatCitation, lastCharOf, styleInfo, type Segment } from "./docCitationStyles";

// Numbers, citations and the reference list for the export in progress (set by
// docJsonToMarkdown, read by the renderers below - they recurse without a shared context arg).
let structure: DocStructure | null = null;

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
  for (const [index, node] of content.entries()) {
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
    // The `$...$` / `$$...$$` convention Pandoc, Obsidian, GitHub and most KaTeX/MathJax-enabled
    // Markdown renderers read.
    else if (node.type === "mathInline") result += `$${(node.attrs?.latex as string) ?? ""}$`;
    else if (node.type === "citation") {
      const cite = structure ? formatCitation((node.attrs?.refIds as string[]) ?? [], node.attrs?.locator as string | null, structure.lookup, structure.context) : null;
      const text = cite?.text ?? "[?]";
      result += citationSpaceBefore(lastCharOf(content[index - 1]), !!cite?.superscript);
      // Markdown has no superscript; inline HTML is what renderers (and Pandoc) accept.
      result += cite?.superscript ? `<sup>${text}</sup>` : text;
    } else if (node.type === "crossRef") {
      const target = structure?.targets.get(String(node.attrs?.targetId ?? ""));
      result += target ? `[${crossRefText(target, node.attrs?.form)}](#${target.id})` : "??";
    }
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
    // "**Figure 2.** Caption" - with an HTML anchor so cross-references can link to it.
    case "caption": {
      const label = captionLabels.get(node) ?? "";
      const id = node.attrs?.id ? `<a id="${node.attrs.id as string}"></a>` : "";
      return `${id}**${label}** ${renderInline(node.content, comments)}`.trim();
    }
    case "bibliography": {
      if (!structure || structure.bibliography.length === 0) return "";
      const numeric = styleInfo(structure.style).numeric;
      return structure.bibliography
        .map((ref, i) => {
          const body = segmentsMarkdown(ref.segments);
          // Numbered styles as an ordered list; APA as separate paragraphs (hanging indent has no
          // Markdown form).
          return numeric ? `${i + 1}. ${body}` : body;
        })
        .join(numeric ? "\n" : "\n\n");
    }
    case "tableOfContents": {
      const maxLevel = Number(node.attrs?.maxLevel ?? 3);
      const headings = (structure?.headings ?? []).filter((h) => h.text && h.level <= maxLevel);
      const min = headings.reduce((m, h) => Math.min(m, h.level), 6);
      return ["**Contents**", "", ...headings.map((h) => `${"  ".repeat(h.level - min)}- [${h.text}](#${slugify(h.text)})`)].join("\n");
    }
    // 	ag{n} keeps the number the equation has in Docs - KaTeX and MathJax both honour it.
    case "mathBlock": {
      const latex = ((node.attrs?.latex as string) ?? "").trim();
      if (!latex) return "";
      const number = equationNumbers.get(node);
      return `$$\n${latex}${number ? ` \\tag{${number}}` : ""}\n$$`;
    }
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

// Display equations' numbers, in document order - assigned up front because renderBlock recurses
// through lists, quotes and tables without a shared counter.
let equationNumbers = new WeakMap<JSONContent, string>();
let captionLabels = new WeakMap<JSONContent, string>();

// The numbers the document shows (docStructure.ts, chapter-aware) in document order.
function numberEquations(node: JSONContent, next: { n: number; figure: number; table: number }): void {
  if (node.type === "mathBlock" && node.attrs?.numbered !== false && ((node.attrs?.latex as string) ?? "").trim()) {
    const i = next.n++;
    equationNumbers.set(node, structure?.equationLabels[i] ?? String(i + 1));
  }
  if (node.type === "caption") {
    const kind = node.attrs?.kind === "table" ? "table" : "figure";
    const numbering = structure?.numbering ?? DEFAULT_NUMBERING;
    const i = next[kind]++;
    captionLabels.set(node, `${structure?.captionLabels[kind][i] ?? captionLabel(kind, i + 1, numbering)}${numbering.captionSeparator}`);
  }
  for (const child of node.content ?? []) numberEquations(child, next);
}

// GitHub's heading-anchor rule, which most renderers share.
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function segmentsMarkdown(segments: Segment[]): string {
  return segments
    .map((seg) => {
      let t = seg.text;
      if (seg.bold) t = `**${t}**`;
      if (seg.italic) t = `*${t}*`;
      if (seg.link) t = seg.link === seg.text ? `<${seg.link}>` : `[${t}](${seg.link})`;
      return t;
    })
    .join("");
}

function renderBlocks(nodes: JSONContent[], comments: DocComment[]): string {
  return nodes.map((node) => renderBlock(node, comments)).join("\n\n");
}

export function docJsonToMarkdown(json: JSONContent, comments: DocComment[] = [], docStructure: DocStructure | null = null): string {
  equationNumbers = new WeakMap();
  captionLabels = new WeakMap();
  structure = docStructure;
  numberEquations(json, { n: 0, figure: 0, table: 0 });
  return renderBlocks(json.content ?? [], comments);
}
