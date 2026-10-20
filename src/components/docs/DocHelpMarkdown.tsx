// components/docs/DocHelpMarkdown.tsx
//
// Renders the user guides in docs/*.md inside the app (DocHelpPanel.tsx), so the in-app help and
// the website are one text. Covers the Markdown the guides use - headings, paragraphs, bulleted
// and numbered lists (with indented continuation lines), tables, "> " tips, **bold**, *italic*,
// `code` and links - and builds React elements, never HTML strings.
import React from "react";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*`]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const header = cells(line);
      i += 2; // header and separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (line.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) parts.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: parts.join(" ") });
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li && li[1].length === 0) {
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^([-*]|\d+\.)\s+(.*)$/);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(m[2]);
          i++;
        } else if (lines[i].startsWith("  ") && lines[i].trim() && items.length) {
          // Continuation of the last item (a wrapped line or an indented sub-paragraph).
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        } else if (!lines[i].trim() && lines[i + 1]?.startsWith("  ") && items.length) {
          items[items.length - 1] += "\n";
          i++;
        } else break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||>|([-*]|\d+\.)\s)/.test(lines[i])) parts.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: parts.join(" ") });
  }
  return blocks;
}

function inline(text: string, onLink: (href: string) => void, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${k++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{inline(m[1], onLink, key)}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key}>{m[3]}</code>);
    else {
      const href = m[5];
      out.push(
        <a
          key={key}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            onLink(href);
          }}
        >
          {inline(m[4], onLink, key)}
        </a>
      );
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const DocHelpMarkdown: React.FC<{ source: string; onLink: (href: string) => void }> = ({ source, onLink }) => {
  // A guide's title (its one "# " heading) is the panel's own title.
  const blocks = React.useMemo(() => parseBlocks(source).filter((b) => !(b.kind === "heading" && b.level === 1)), [source]);
  return (
    <div className="doc-help-md">
      {blocks.map((b, n) => {
        const key = `b${n}`;
        switch (b.kind) {
          case "heading": {
            const Tag = `h${b.level}` as "h1" | "h2" | "h3" | "h4";
            return (
              <Tag key={key} id={`help-${slugify(b.text)}`}>
                {inline(b.text, onLink, key)}
              </Tag>
            );
          }
          case "paragraph":
            return <p key={key}>{inline(b.text, onLink, key)}</p>;
          case "quote":
            return <blockquote key={key}>{inline(b.text, onLink, key)}</blockquote>;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    {item.split("\n").filter(Boolean).map((part, p) => (
                      <p key={p}>{inline(part, onLink, `${key}-${j}-${p}`)}</p>
                    ))}
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div key={key} className="doc-help-table">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((c, j) => (
                        <th key={j}>{inline(c, onLink, `${key}-h${j}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, j) => (
                          <td key={j}>{inline(c, onLink, `${key}-${r}-${j}`)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
};

export default DocHelpMarkdown;
