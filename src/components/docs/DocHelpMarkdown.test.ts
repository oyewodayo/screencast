import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { parseBlocks, slugify } from "./DocHelpMarkdown";

const guide = fs.readFileSync(path.resolve(__dirname, "../../../docs/two-column-papers.md"), "utf-8");

describe("in-app guide", () => {
  const blocks = parseBlocks(guide);

  it("parses the two-column paper guide into sections, tables, lists and tips", () => {
    const sections = blocks.filter((b) => b.kind === "heading" && b.level === 2).map((b) => (b as { text: string }).text);
    expect(sections[0]).toBe("1. Choose the document style");
    expect(sections).toContain("5. Tables");
    expect(blocks.some((b) => b.kind === "quote")).toBe(true);
    const tables = blocks.filter((b) => b.kind === "table") as { header: string[]; rows: string[][] }[];
    expect(tables.length).toBeGreaterThanOrEqual(4);
    // Every row has as many cells as its header.
    for (const t of tables) for (const r of t.rows) expect(r.length).toBe(t.header.length);
  });

  it("resolves every in-guide link to a section", () => {
    const anchors = new Set(blocks.filter((b) => b.kind === "heading").map((b) => slugify((b as { text: string }).text)));
    const links = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    for (const l of links) expect(anchors.has(l)).toBe(true);
  });
});
