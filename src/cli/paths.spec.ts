import { describe, expect, test } from "bun:test";
import type { CollectionEntry, DocumentType, Entry } from "../index.js";
import { AmbiguousTargetError, TargetNotFoundError } from "./error.js";
import {
  buildTree,
  children,
  cyclePath,
  entryPaths,
  escapeSegment,
  orphanPath,
  parsePath,
  resolveMany,
  resolveTarget,
  rootEntry,
  trashEntry,
} from "./paths.js";

function repHash(hash: string): string {
  const mult = 64 / hash.length;
  return new Array(mult).fill(hash).join("");
}

function uuid(lead: string): string {
  const padded = lead.padStart(8, "0");
  return `${padded}-0000-4000-8000-000000000000`;
}

function folder(
  id: string,
  visibleName: string,
  parent?: string,
): CollectionEntry {
  return {
    id: uuid(id),
    hash: repHash(id.length === 1 ? id : "0"),
    visibleName,
    lastModified: "",
    pinned: false,
    parent,
    type: "CollectionType",
  };
}

function doc(
  id: string,
  visibleName: string,
  parent?: string,
  hash = repHash(id.length === 1 ? id : "0"),
): DocumentType {
  return {
    id: uuid(id),
    hash,
    visibleName,
    lastModified: "",
    lastOpened: "",
    pinned: false,
    parent,
    fileType: "pdf",
    type: "DocumentType",
  };
}

describe("escapeSegment()", () => {
  test("escapes slashes and backslashes", () => {
    expect(escapeSegment("a/b")).toBe("a\\/b");
    expect(escapeSegment("a\\b")).toBe("a\\\\b");
    expect(escapeSegment("plain")).toBe("plain");
  });
});

describe("parsePath()", () => {
  test("splits and ignores empty segments", () => {
    expect(parsePath("/")).toEqual([]);
    expect(parsePath("")).toEqual([]);
    expect(parsePath("//a///b/")).toEqual(["a", "b"]);
  });

  test("unescapes", () => {
    expect(parsePath("/a\\/b/c")).toEqual(["a/b", "c"]);
    expect(parsePath("/a\\\\b")).toEqual(["a\\b"]);
    expect(parsePath("/a\\")).toEqual(["a"]);
  });

  test("round trips escaped names", () => {
    expect(parsePath(`/${escapeSegment("a/b")}`)).toEqual(["a/b"]);
  });
});

describe("entryPaths()", () => {
  test("empty", () => {
    expect([...entryPaths([])]).toEqual([]);
  });

  test("root, trash, and nested folders", () => {
    const books = folder("1", "Books");
    const scifi = folder("2", "SciFi", books.id);
    const novel = doc("3", "Novel.pdf", scifi.id);
    const loose = doc("4", "Loose.pdf");
    const rooted = doc("5", "Rooted.pdf", "");
    const binned = doc("6", "Binned.pdf", "trash");
    const paths = entryPaths([books, scifi, novel, loose, rooted, binned]);

    expect(paths.get(books.id)).toBe("/Books");
    expect(paths.get(scifi.id)).toBe("/Books/SciFi");
    expect(paths.get(novel.id)).toBe("/Books/SciFi/Novel.pdf");
    expect(paths.get(loose.id)).toBe("/Loose.pdf");
    expect(paths.get(rooted.id)).toBe("/Rooted.pdf");
    expect(paths.get(binned.id)).toBe("/trash/Binned.pdf");
    expect(paths.size).toBe(6);
  });

  test("child listed before parent", () => {
    const inner = doc("2", "Inner.pdf", uuid("1"));
    const outer = folder("1", "Outer");
    const paths = entryPaths([inner, outer]);

    expect(paths.get(inner.id)).toBe("/Outer/Inner.pdf");
    expect(paths.get(outer.id)).toBe("/Outer");
  });

  test("escapes slashes in visibleName", () => {
    const weird = doc("1", "a/b.pdf");
    expect(entryPaths([weird]).get(weird.id)).toBe("/a\\/b.pdf");
  });

  test("orphans go under the synthetic orphan folder", () => {
    const orphan = folder("1", "Orphan", uuid("ff"));
    const child = doc("2", "Child.pdf", orphan.id);
    const paths = entryPaths([orphan, child]);

    expect(paths.get(orphan.id)).toBe(`${orphanPath}/Orphan`);
    expect(paths.get(child.id)).toBe(`${orphanPath}/Orphan/Child.pdf`);
  });

  test("cycles are broken under the synthetic cycle folder", () => {
    const first = folder("1", "First", uuid("2"));
    const second = folder("2", "Second", uuid("1"));
    const child = doc("3", "Child.pdf", second.id);
    const paths = entryPaths([first, second, child]);

    expect(paths.get(first.id)).toBe(`${cyclePath}/First`);
    expect(paths.get(second.id)).toBe(`${cyclePath}/Second`);
    expect(paths.get(child.id)).toBe(`${cyclePath}/Second/Child.pdf`);
  });

  test("self parent is a cycle", () => {
    const self = folder("1", "Self", uuid("1"));
    expect(entryPaths([self]).get(self.id)).toBe(`${cyclePath}/Self`);
  });

  test("duplicate sibling names share a path", () => {
    const one = doc("1", "Dup.pdf");
    const two = doc("2", "Dup.pdf");
    const paths = entryPaths([one, two]);

    expect(paths.get(one.id)).toBe("/Dup.pdf");
    expect(paths.get(two.id)).toBe("/Dup.pdf");
  });
});

describe("children()", () => {
  const books = folder("1", "Books");
  const novel = doc("2", "Novel.pdf", books.id);
  const binned = doc("3", "Binned.pdf", "trash");
  const orphan = doc("4", "Orphan.pdf", uuid("ff"));
  const entries: Entry[] = [books, novel, binned, orphan];

  test("root", () => {
    expect(children(entries, "").map((entry) => entry.id)).toEqual([books.id]);
  });

  test("folder", () => {
    expect(children(entries, books.id).map((entry) => entry.id)).toEqual([
      novel.id,
    ]);
  });

  test("trash", () => {
    expect(children(entries, "trash").map((entry) => entry.id)).toEqual([
      binned.id,
    ]);
  });

  test("orphans", () => {
    expect(children(entries, orphanPath).map((entry) => entry.id)).toEqual([
      orphan.id,
    ]);
  });

  test("leaf and unknown", () => {
    expect(children(entries, novel.id)).toEqual([]);
    expect(children(entries, uuid("aa"))).toEqual([]);
    expect(children([], "")).toEqual([]);
  });
});

describe("buildTree()", () => {
  test("empty", () => {
    const tree = buildTree([]);
    expect(tree.root.path).toBe("/");
    expect(tree.root.entry).toBe(rootEntry);
    expect(tree.root.children).toEqual([]);
    expect(tree.trash.path).toBe("/trash");
    expect(tree.trash.entry).toBe(trashEntry);
    expect(tree.orphans).toBeUndefined();
    expect(tree.cycles).toBeUndefined();
  });

  test("nesting, trash, orphans, and cycles", () => {
    const books = folder("1", "Books");
    const novel = doc("2", "Novel.pdf", books.id);
    const binned = doc("3", "Binned.pdf", "trash");
    const orphan = doc("4", "Orphan.pdf", uuid("ff"));
    const cycleA = folder("5", "A", uuid("6"));
    const cycleB = folder("6", "B", uuid("5"));
    const tree = buildTree([books, novel, binned, orphan, cycleA, cycleB]);

    expect(tree.root.children.map((node) => node.name)).toEqual(["Books"]);
    const [booksNode] = tree.root.children;
    expect(booksNode?.children.map((node) => node.path)).toEqual([
      "/Books/Novel.pdf",
    ]);
    expect(booksNode?.children[0]?.entry).toBe(novel);
    expect(tree.trash.children.map((node) => node.name)).toEqual([
      "Binned.pdf",
    ]);
    expect(tree.orphans?.path).toBe(orphanPath);
    expect(tree.orphans?.entry).toBeUndefined();
    expect(tree.orphans?.children.map((node) => node.name)).toEqual([
      "Orphan.pdf",
    ]);
    expect(tree.cycles?.children.map((node) => node.name)).toEqual(["A", "B"]);
  });
});

describe("resolveTarget()", () => {
  const books = folder("1", "Books");
  const novel = doc("2", "Novel.pdf", books.id);
  const binned = doc("3", "Binned.pdf", "trash");
  const slashed = doc("4", "a/b.pdf");
  const dupOne = doc("5", "Dup.pdf", books.id);
  const dupTwo = doc("6", "Dup.pdf", books.id);
  const hashy = doc("7", "hashy", "", repHash("ab"));
  const entries: Entry[] = [
    books,
    novel,
    binned,
    slashed,
    dupOne,
    dupTwo,
    hashy,
  ];

  test("root and trash paths", () => {
    expect(resolveTarget(entries, "/")).toBe(rootEntry);
    expect(resolveTarget(entries, "")).toBe(rootEntry);
    expect(resolveTarget(entries, "/trash")).toBe(trashEntry);
    expect(resolveTarget(entries, "trash")).toBe(trashEntry);
    expect(resolveTarget([], "/")).toBe(rootEntry);
  });

  test("nested path", () => {
    expect(resolveTarget(entries, "/Books")).toBe(books);
    expect(resolveTarget(entries, "/Books/Novel.pdf")).toBe(novel);
    expect(resolveTarget(entries, "Books/Novel.pdf")).toBe(novel);
    expect(resolveTarget(entries, "/trash/Binned.pdf")).toBe(binned);
  });

  test("escaped slash in a name", () => {
    expect(resolveTarget(entries, "/a\\/b.pdf")).toBe(slashed);
    expect(() => resolveTarget(entries, "/a/b.pdf")).toThrow(
      TargetNotFoundError,
    );
  });

  test("auto detects a uuid", () => {
    expect(resolveTarget(entries, novel.id)).toBe(novel);
  });

  test("auto detects a hash", () => {
    expect(resolveTarget(entries, hashy.hash)).toBe(hashy);
    expect(hashy.hash).toHaveLength(64);
  });

  test("explicit id:", () => {
    expect(resolveTarget(entries, `id:${books.id}`)).toBe(books);
    expect(resolveTarget(entries, "id:")).toBe(rootEntry);
    expect(resolveTarget(entries, "id:trash")).toBe(trashEntry);
    expect(() => resolveTarget(entries, `id:${uuid("ff")}`)).toThrow(
      TargetNotFoundError,
    );
  });

  test("explicit hash:", () => {
    expect(resolveTarget(entries, `hash:${novel.hash}`)).toBe(novel);
    expect(() => resolveTarget(entries, `hash:${repHash("f")}`)).toThrow(
      TargetNotFoundError,
    );
  });

  test("explicit path: forces a path interpretation", () => {
    const idNamed = doc("8", novel.id);
    const all = [...entries, idNamed];
    expect(resolveTarget(all, `path:/${novel.id}`)).toBe(idNamed);
    expect(resolveTarget(all, novel.id)).toBe(novel);
    expect(resolveTarget(all, "path:/Books")).toBe(books);
  });

  test("ambiguous siblings throw", () => {
    let caught: unknown;
    try {
      resolveTarget(entries, "/Books/Dup.pdf");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AmbiguousTargetError);
    const err = caught as AmbiguousTargetError;
    expect(err.target).toBe("/Books/Dup.pdf");
    expect(err.matches).toEqual([dupOne, dupTwo]);
  });

  test("ambiguous siblings resolve with first", () => {
    expect(resolveTarget(entries, "/Books/Dup.pdf", { first: true })).toBe(
      dupOne,
    );
  });

  test("ambiguous intermediate segment", () => {
    const dirOne = folder("8", "Dir");
    const dirTwo = folder("9", "Dir");
    const inner = doc("10", "Inner.pdf", dirTwo.id);
    const all = [dirOne, dirTwo, inner];
    expect(() => resolveTarget(all, "/Dir/Inner.pdf")).toThrow(
      AmbiguousTargetError,
    );
    // the first Dir has no children, so first: true finds nothing
    expect(() => resolveTarget(all, "/Dir/Inner.pdf", { first: true })).toThrow(
      TargetNotFoundError,
    );
  });

  test("unknown targets", () => {
    let caught: unknown;
    try {
      resolveTarget(entries, "/Missing.pdf");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TargetNotFoundError);
    expect((caught as TargetNotFoundError).target).toBe("/Missing.pdf");

    expect(() => resolveTarget([], "/Books")).toThrow(TargetNotFoundError);
    expect(() => resolveTarget(entries, "/Books/Missing/Deep")).toThrow(
      TargetNotFoundError,
    );
    expect(() => resolveTarget(entries, "/.orphans")).toThrow(
      TargetNotFoundError,
    );
  });

  test("synthetic containers are navigable", () => {
    const orphan = doc("1", "Orphan.pdf", uuid("ff"));
    const cycleA = folder("2", "A", uuid("3"));
    const cycleB = folder("3", "B", uuid("2"));
    const all = [orphan, cycleA, cycleB];
    expect(resolveTarget(all, `${orphanPath}/Orphan.pdf`)).toBe(orphan);
    expect(resolveTarget(all, `${cyclePath}/A`)).toBe(cycleA);
    expect(resolveTarget(all, `${cyclePath}/B`)).toBe(cycleB);
  });
});

describe("resolveMany()", () => {
  const books = folder("1", "Books");
  const novel = doc("2", "Novel.pdf", books.id);
  const dupOne = doc("3", "Dup.pdf");
  const dupTwo = doc("4", "Dup.pdf");
  const entries: Entry[] = [books, novel, dupOne, dupTwo];

  test("resolves in order", () => {
    expect(resolveMany(entries, ["/Books", novel.id, "id:trash"])).toEqual([
      books,
      novel,
      trashEntry,
    ]);
  });

  test("empty", () => {
    expect(resolveMany(entries, [])).toEqual([]);
  });

  test("propagates errors", () => {
    expect(() => resolveMany(entries, ["/Books", "/Nope"])).toThrow(
      TargetNotFoundError,
    );
    expect(() => resolveMany(entries, ["/Dup.pdf"])).toThrow(
      AmbiguousTargetError,
    );
    expect(resolveMany(entries, ["/Dup.pdf"], { first: true })).toEqual([
      dupOne,
    ]);
  });
});
