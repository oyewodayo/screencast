import { describe, expect, it } from "vitest";
import { folderMatchesQuery, orderFolders, pinRank } from "./sidebarFolders";

const entries = (...folders: string[]): [string, number][] => folders.map((f) => [f, 0]);
const names = (e: [string, number][]) => e.map(([f]) => f);

describe("orderFolders", () => {
  it("keeps path order when nothing is pinned", () => {
    expect(names(orderFolders(entries("B", "", "A/Sub", "A"), []))).toEqual(["", "A", "A/Sub", "B"]);
  });

  it("puts pinned folders (with their subfolders) above everything, root included", () => {
    expect(names(orderFolders(entries("", "A", "B", "B/Raw", "C"), ["B"]))).toEqual(["B", "B/Raw", "", "A", "C"]);
  });

  it("orders pinned groups newest pin first", () => {
    expect(names(orderFolders(entries("A", "B", "C"), ["C", "A"]))).toEqual(["C", "A", "B"]);
  });

  it("does not treat a name prefix as a subfolder", () => {
    expect(pinRank("Project2", ["Project"])).toBe(-1);
    expect(pinRank("Project/Raw", ["Project"])).toBe(0);
  });
});

describe("folderMatchesQuery", () => {
  it("matches anywhere in the folder path, case-insensitively via the normalized query", () => {
    expect(folderMatchesQuery("Workshops/Papers", "paper")).toBe(true);
    expect(folderMatchesQuery("Workshops/Papers", "zzz")).toBe(false);
  });

  it("matches the root by its display name and never on an empty query", () => {
    expect(folderMatchesQuery("", "briefc")).toBe(true);
    expect(folderMatchesQuery("A", "")).toBe(false);
  });
});

import { canMoveFolder, movedFolderKey, repathFolderKey } from "./sidebarFolders";

describe("moving folders", () => {
  it("lands a folder under its destination, or at the root", () => {
    expect(movedFolderKey("A/Raw", "")).toBe("Raw");
    expect(movedFolderKey("Raw", "B/C")).toBe("B/C/Raw");
  });

  it("refuses the root, itself, its own subtree and a no-op", () => {
    expect(canMoveFolder("", "A")).toBe(false);
    expect(canMoveFolder("A", "A")).toBe(false);
    expect(canMoveFolder("A", "A/B")).toBe(false);
    expect(canMoveFolder("A/Raw", "A")).toBe(false);
    expect(canMoveFolder("Raw", "")).toBe(false);
    expect(canMoveFolder("A", "AB")).toBe(true);
    expect(canMoveFolder("A/Raw", "")).toBe(true);
  });

  it("repaths a folder and what's inside it, not name-prefix lookalikes", () => {
    expect(repathFolderKey("A", "A", "X/A")).toBe("X/A");
    expect(repathFolderKey("A/B", "A", "X/A")).toBe("X/A/B");
    expect(repathFolderKey("AB", "A", "X/A")).toBe("AB");
  });
});
