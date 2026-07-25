import { describe, expect, test } from "bun:test";
import type { Entry, RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { treeCommands } from "./tree.js";

const { tree: treeCommand } = treeCommands;
const tree: Command = treeCommand!;

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const seeds = new Map<string, string>();

function hashFor(id: string): string {
  const existing = seeds.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const hash = repHash((seeds.size + 1).toString(16).padStart(4, "0"));
  seeds.set(id, hash);
  return hash;
}

function collection(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: hashFor(id),
    visibleName,
    lastModified: "1700000000000",
    pinned: false,
    parent,
    type: "CollectionType",
  };
}

function document(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: hashFor(id),
    visibleName,
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    parent,
    type: "DocumentType",
    fileType: "pdf",
  };
}

const entries: readonly Entry[] = [
  collection("books-id", "books"),
  document("nest-id", "nested", "books-id"),
  document("top-id", "top level"),
  document("trsh-id", "trashed", "trash"),
  document("lost-id", "lost", "gone-id"),
  collection("cyc1-id", "left", "cyc2-id"),
  collection("cyc2-id", "right", "cyc1-id"),
];

function fakeApi(items: readonly Entry[] = entries): RemarkableApi {
  return {
    listItems(): Promise<Entry[]> {
      return Promise.resolve([...items]);
    },
  } as unknown as RemarkableApi;
}

function args(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): CommandArgs {
  return { values, positionals };
}

async function run(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
  {
    json = false,
    items = entries,
  }: { json?: boolean; items?: readonly Entry[] } = {},
): Promise<ReturnType<typeof captureOutput>> {
  const out = captureOutput({ json });
  await tree.run(
    testContext({ api: fakeApi(items), out: out.out }),
    args(values, positionals),
  );
  return out;
}

interface JsonNode {
  id: string;
  name: string;
  path: string;
  children: JsonNode[];
}

describe("tree", () => {
  test("renders the root", async () => {
    const out = await run();
    expect(out.text()).toBe(
      ["/", "├── books/", "│   └── nested", "└── top level", ""].join("\n"),
    );
  });

  test("--depth limits the levels shown", async () => {
    const out = await run({ depth: "1" });
    expect(out.text()).toBe(
      ["/", "├── books/", "└── top level", ""].join("\n"),
    );
  });

  test("--depth rejects nonsense", async () => {
    expect(
      tree.run(testContext({ api: fakeApi() }), args({ depth: "0" })),
    ).rejects.toThrow(UsageError);
    expect(
      tree.run(testContext({ api: fakeApi() }), args({ depth: "half" })),
    ).rejects.toThrow(UsageError);
  });

  test("--trash renders the trash", async () => {
    const out = await run({ trash: true });
    expect(out.text()).toBe(["/trash", "└── trashed", ""].join("\n"));
  });

  test("--all adds the synthetic containers", async () => {
    const out = await run({ all: true });
    const text = out.text();
    expect(text).toContain("/.orphans");
    expect(text).toContain("└── lost");
    expect(text).toContain("/.cycles");
    expect(text).toContain("├── left/");
  });

  test("hides the synthetic containers by default", async () => {
    const text = (await run()).text();
    expect(text).not.toContain("/.orphans");
    expect(text).not.toContain("/.cycles");
  });

  test("renders a subtree named by a path", async () => {
    const out = await run({}, ["/books"]);
    expect(out.text()).toBe(["/books", "└── nested", ""].join("\n"));
  });

  test("throws for a missing target", async () => {
    expect(
      tree.run(testContext({ api: fakeApi() }), args({}, ["nope"])),
    ).rejects.toThrow(TargetNotFoundError);
  });

  test("--json emits the node structure", async () => {
    const out = await run({}, [], { json: true });
    const [root, ...extra] = out.json() as JsonNode[];
    expect(extra).toEqual([]);
    expect(root?.path).toBe("/");
    expect(root?.children.map(({ name }) => name)).toEqual([
      "books",
      "top level",
    ]);
    expect(root?.children[0]?.children[0]?.path).toBe("/books/nested");
    // the drawn tree never appears in json
    expect(out.text()).not.toContain("──");
  });

  test("--json honors --depth", async () => {
    const out = await run({ depth: "1" }, [], { json: true });
    const [root] = out.json() as JsonNode[];
    expect(root?.children[0]?.children).toEqual([]);
  });
});

describe("tree content", () => {
  test("never fetches content", async () => {
    const watched = watchListItems(fakeApi());
    await tree.run(
      testContext({ api: watched.api, out: captureOutput().out }),
      args(),
    );
    expect(watched.calls.map(({ includeContent }) => includeContent)).toEqual([
      false,
    ]);
  });
});
