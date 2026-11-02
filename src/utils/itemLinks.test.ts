import { describe, expect, it } from "vitest";
import { edgesFor, fileRef, type ItemLinkRecord } from "./itemLinks";

const link = (id: string, a: ItemLinkRecord["a"], b: ItemLinkRecord["b"]): ItemLinkRecord => ({ id, a, b, createdAt: "0" });
const winPath = (p: string) => p.split("/").join(String.fromCharCode(92));

describe("edgesFor", () => {
  it("lists a link from both ends", () => {
    const links = [link("1", fileRef("C:/x/a.pdf"), fileRef("C:/x/b.mp4"))];
    expect(edgesFor(fileRef("C:/x/a.pdf"), links, []).map((e) => e.other.id)).toEqual(["C:/x/b.mp4"]);
    expect(edgesFor(fileRef("C:/x/b.mp4"), links, []).map((e) => e.other.id)).toEqual(["C:/x/a.pdf"]);
  });

  it("matches file paths regardless of slash style and case", () => {
    const links = [link("1", fileRef(winPath("C:/x/a.pdf")), { kind: "whiteboard", id: "w" })];
    expect(edgesFor(fileRef("c:/x/A.pdf"), links, [])).toHaveLength(1);
  });

  it("folds in a doc's own linked_to and de-duplicates the same pair", () => {
    const docs = [{ id: "d", linked_to: "C:/x/a.pdf" }];
    expect(edgesFor(fileRef("C:/x/a.pdf"), [], docs)[0]).toMatchObject({ other: { kind: "doc", id: "d" }, legacyDocId: "d" });
    expect(edgesFor({ kind: "doc", id: "d" }, [], docs)[0].other.id).toBe("C:/x/a.pdf");
    const both = [link("1", { kind: "doc", id: "d" }, fileRef("C:/x/a.pdf"))];
    expect(edgesFor(fileRef("C:/x/a.pdf"), both, docs)).toHaveLength(1);
  });
});
