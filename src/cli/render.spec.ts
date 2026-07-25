import { describe, expect, test } from "bun:test";
import type { CollectionEntry, DocumentType, Entry } from "../index.js";
import { type Output, styler } from "./format.js";
import { buildTree } from "./paths.js";
import {
  entryLabel,
  type Listing,
  locateNode,
  longList,
  renderNodes,
  shortList,
  tagNames,
  timestamp,
} from "./render.js";

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
  lastModified = "",
): DocumentType {
  return {
    id: uuid(id),
    hash: repHash(id.length === 1 ? id : "0"),
    visibleName,
    lastModified,
    lastOpened: "",
    pinned: false,
    parent,
    fileType: "pdf",
    type: "DocumentType",
  };
}

/** an output that records nothing, only used for its styles */
function testOutput(color = false): Output {
  return { style: styler(color), write: (): void => {} };
}

const plain = testOutput();

function listings(...entries: readonly Entry[]): Listing[] {
  return entries.map((entry) => ({ entry, name: entry.visibleName }));
}

describe("timestamp()", () => {
  test("formats epoch millis", () => {
    expect(timestamp("1700000000000")).toBe("2023-11-14T22:13:20.000Z");
  });

  test("passes non positive numbers through", () => {
    expect(timestamp("0")).toBe("0");
    expect(timestamp("-5")).toBe("-5");
    expect(timestamp("")).toBe("");
    expect(timestamp("nonsense")).toBe("nonsense");
  });
});

describe("entryLabel()", () => {
  test("collections get a trailing slash", () => {
    expect(entryLabel(folder("1", "Books"), plain)).toBe("Books/");
    expect(entryLabel(doc("2", "Novel.pdf"), plain)).toBe("Novel.pdf");
  });

  test("pinned entries get an asterisk", () => {
    const pinned = { ...doc("1", "Novel.pdf"), pinned: true };
    expect(entryLabel(pinned, plain)).toBe("Novel.pdf *");
  });

  test("the name defaults to the visibleName", () => {
    const entry = doc("1", "Novel.pdf");
    expect(entryLabel(entry, plain, "/Books/Novel.pdf")).toBe(
      "/Books/Novel.pdf",
    );
  });

  test("styles are applied when color is on", () => {
    const styled = entryLabel(folder("1", "Books"), testOutput(true));
    expect(styled).toContain("Books/");
    expect(styled).not.toBe("Books/");
  });
});

describe("shortList()", () => {
  test("one entry per line", () => {
    const rows = listings(folder("1", "Books"), doc("2", "Novel.pdf"));
    expect(shortList(rows, plain)).toBe("Books/\nNovel.pdf");
  });

  test("empty", () => {
    expect(shortList([], plain)).toBe("");
  });
});

describe("longList()", () => {
  test("renders aligned metadata columns", () => {
    const rows = listings(
      folder("1", "Books"),
      doc("2", "Novel.pdf", undefined, "1700000000000"),
    );
    const lines = longList(rows, plain).split("\n");
    expect(lines).toHaveLength(2);

    const [first, second] = lines;
    expect(first?.startsWith("d ")).toBe(true);
    expect(first).toContain(repHash("1"));
    expect(first).toContain(uuid("1"));
    expect(first?.endsWith("Books/")).toBe(true);

    expect(second?.startsWith("- ")).toBe(true);
    expect(second).toContain("pdf");
    expect(second).toContain("2023-11-14T22:13:20.000Z");
    expect(second?.endsWith("Novel.pdf")).toBe(true);
  });

  test("marks templates and pinned entries", () => {
    const template: Entry = {
      id: uuid("3"),
      hash: repHash("3"),
      visibleName: "Grid",
      lastModified: "",
      pinned: true,
      type: "TemplateType",
    };
    const line = longList(listings(template), plain);
    expect(line.startsWith("t ")).toBe(true);
    expect(line).toContain("pinned");
    expect(line).toContain("Grid *");
  });

  test("empty", () => {
    expect(longList([], plain)).toBe("");
  });
});

describe("locateNode()", () => {
  const books = folder("1", "Books");
  const novel = doc("2", "Novel.pdf", books.id);
  const binned = doc("3", "Binned.pdf", "trash");
  const orphan = doc("4", "Orphan.pdf", uuid("ff"));
  const cycleA = folder("5", "A", uuid("6"));
  const cycleB = folder("6", "B", uuid("5"));
  const built = buildTree([books, novel, binned, orphan, cycleA, cycleB]);

  test("finds the root and nested nodes", () => {
    expect(locateNode(built, "")?.path).toBe("/");
    expect(locateNode(built, books.id)?.path).toBe("/Books");
    expect(locateNode(built, novel.id)?.path).toBe("/Books/Novel.pdf");
  });

  test("searches the trash and the synthetic containers", () => {
    expect(locateNode(built, "trash")?.path).toBe("/trash");
    expect(locateNode(built, binned.id)?.name).toBe("Binned.pdf");
    expect(locateNode(built, orphan.id)?.name).toBe("Orphan.pdf");
    expect(locateNode(built, cycleB.id)?.name).toBe("B");
  });

  test("undefined for an unknown id", () => {
    expect(locateNode(built, uuid("aa"))).toBeUndefined();
    expect(locateNode(buildTree([]), uuid("1"))).toBeUndefined();
  });
});

describe("renderNodes()", () => {
  const books = folder("1", "Books");
  const scifi = folder("2", "SciFi", books.id);
  const novel = doc("3", "Novel.pdf", scifi.id);
  const apple = doc("4", "Apple.pdf", books.id);
  const built = buildTree([books, scifi, novel, apple]);
  const root = locateNode(built, "")!;

  test("sorts children by name and nests them", () => {
    const nodes = renderNodes(root, plain, Number.POSITIVE_INFINITY);
    expect(nodes.map((node) => node.label)).toEqual(["Books/"]);
    const [top] = nodes;
    expect(top?.children?.map((node) => node.label)).toEqual([
      "Apple.pdf",
      "SciFi/",
    ]);
    const nested = top?.children?.[1];
    expect(nested?.children?.map((node) => node.label)).toEqual(["Novel.pdf"]);
  });

  test("depth limits how many levels are included", () => {
    expect(renderNodes(root, plain, 0)).toEqual([]);
    const one = renderNodes(root, plain, 1);
    expect(one.map((node) => node.label)).toEqual(["Books/"]);
    expect(one[0]?.children).toEqual([]);
    const two = renderNodes(root, plain, 2);
    expect(two[0]?.children?.map((node) => node.label)).toEqual([
      "Apple.pdf",
      "SciFi/",
    ]);
    expect(two[0]?.children?.[1]?.children).toEqual([]);
  });

  test("labels a container without an entry by its bare name", () => {
    const orphan = doc("1", "Orphan.pdf", uuid("ff"));
    const withOrphans = buildTree([orphan]);
    expect(withOrphans.orphans?.entry).toBeUndefined();
    const nodes = renderNodes(withOrphans.orphans!, plain, 1);
    expect(nodes.map((node) => node.label)).toEqual(["Orphan.pdf"]);
  });
});

describe("tagNames()", () => {
  test("reads rich tags", () => {
    const entry: Entry = {
      ...doc("1", "Novel.pdf"),
      tags: [
        { name: "work", timestamp: 1 },
        { name: "read", timestamp: 2 },
      ],
    };
    expect(tagNames(entry)).toEqual(["work", "read"]);
  });

  test("reads legacy bare string tags", () => {
    const entry = {
      ...doc("1", "Novel.pdf"),
      tags: ["work", { name: "read", timestamp: 2 }],
    } as unknown as Entry;
    expect(tagNames(entry)).toEqual(["work", "read"]);
  });

  test("no tags", () => {
    expect(tagNames(doc("1", "Novel.pdf"))).toEqual([]);
    expect(tagNames({ ...doc("1", "Novel.pdf"), tags: [] })).toEqual([]);
  });
});
