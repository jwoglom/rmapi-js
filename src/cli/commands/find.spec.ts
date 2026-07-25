import { describe, expect, test } from "bun:test";
import type { Entry, RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { findCommands } from "./find.js";

const { find: findCommand } = findCommands;
const find: Command = findCommand!;

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

function collection(
  id: string,
  visibleName: string,
  parent?: string,
  extra: Partial<Entry> = {},
): Entry {
  return {
    id,
    hash: hashFor(id),
    visibleName,
    lastModified: "1700000000000",
    pinned: false,
    parent,
    type: "CollectionType",
    ...extra,
  } as Entry;
}

function document(
  id: string,
  visibleName: string,
  parent?: string,
  extra: Partial<Entry> = {},
): Entry {
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
    ...extra,
  } as Entry;
}

const entries: readonly Entry[] = [
  collection("books-id", "books", undefined, {
    tags: [{ name: "shelf", timestamp: 0 }],
  }),
  document("chap1-id", "chapter 1", "books-id", { pinned: true }),
  document("chap2-id", "chapter 2", "books-id", {
    fileType: "epub",
    tags: ["shelf"],
  }),
  document("note-id", "scratch", undefined, { fileType: "notebook" }),
  document("trsh-id", "chapter 3", "trash"),
  {
    id: "tmpl-id",
    hash: hashFor("tmpl-id"),
    visibleName: "grid",
    lastModified: "1700000000000",
    pinned: false,
    type: "TemplateType",
  },
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

async function paths(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): Promise<string[]> {
  const out = captureOutput({ json: true });
  await find.run(
    testContext({ api: fakeApi(), out: out.out }),
    args(values, positionals),
  );
  return (out.json() as { path: string }[]).map(({ path }) => path);
}

describe("find", () => {
  test("lists every path with no filter", async () => {
    const out = captureOutput();
    await find.run(testContext({ api: fakeApi(), out: out.out }), args());
    expect(out.text()).toBe(
      [
        "/books/",
        "/books/chapter 1 *",
        "/books/chapter 2",
        "/grid",
        "/scratch",
        "/trash/chapter 3",
        "",
      ].join("\n"),
    );
  });

  test("--name matches a substring", async () => {
    expect(await paths({ name: "chapter" })).toEqual([
      "/books/chapter 1",
      "/books/chapter 2",
      "/trash/chapter 3",
    ]);
  });

  test("--name matches a regex", async () => {
    expect(await paths({ name: "/^chapter [12]$/" })).toEqual([
      "/books/chapter 1",
      "/books/chapter 2",
    ]);
    expect(await paths({ name: "/GRID/i" })).toEqual(["/grid"]);
  });

  test("--name rejects a bad regex", async () => {
    expect(
      find.run(testContext({ api: fakeApi() }), args({ name: "/(/" })),
    ).rejects.toThrow(UsageError);
  });

  test("--type filters on the entry type", async () => {
    expect(await paths({ type: "collection" })).toEqual(["/books"]);
    expect(await paths({ type: "template" })).toEqual(["/grid"]);
    expect(await paths({ type: "document" })).toHaveLength(4);
  });

  test("--type rejects an unknown type", async () => {
    expect(
      find.run(testContext({ api: fakeApi() }), args({ type: "folder" })),
    ).rejects.toThrow(UsageError);
  });

  test("--file-type filters documents", async () => {
    expect(await paths({ "file-type": "epub" })).toEqual(["/books/chapter 2"]);
    expect(await paths({ "file-type": "notebook" })).toEqual(["/scratch"]);
  });

  test("--file-type rejects an unknown type", async () => {
    expect(
      find.run(testContext({ api: fakeApi() }), args({ "file-type": "docx" })),
    ).rejects.toThrow(UsageError);
  });

  test("--tag handles object and string tags", async () => {
    expect(await paths({ tag: "shelf" })).toEqual([
      "/books",
      "/books/chapter 2",
    ]);
    expect(await paths({ tag: "missing" })).toEqual([]);
  });

  test("--pinned only keeps pinned entries", async () => {
    expect(await paths({ pinned: true })).toEqual(["/books/chapter 1"]);
  });

  test("filters combine", async () => {
    expect(await paths({ name: "chapter", "file-type": "pdf" })).toEqual([
      "/books/chapter 1",
      "/trash/chapter 3",
    ]);
  });

  test("a path restricts the search to that subtree", async () => {
    expect(await paths({}, ["/books"])).toEqual([
      "/books",
      "/books/chapter 1",
      "/books/chapter 2",
    ]);
    expect(await paths({}, ["/trash"])).toEqual(["/trash/chapter 3"]);
  });

  test("throws for a missing target", async () => {
    expect(
      find.run(testContext({ api: fakeApi() }), args({}, ["nope"])),
    ).rejects.toThrow(TargetNotFoundError);
  });

  test("-l shows metadata", async () => {
    const out = captureOutput();
    await find.run(
      testContext({ api: fakeApi(), out: out.out }),
      args({ long: true, name: "chapter 2" }),
    );
    const text = out.text();
    expect(text).toContain("chap2-id");
    expect(text).toContain("epub");
    expect(text).toContain("/books/chapter 2");
  });

  test("--json emits entries with their path", async () => {
    const out = captureOutput({ json: true });
    await find.run(
      testContext({ api: fakeApi(), out: out.out }),
      args({ pinned: true }),
    );
    expect(out.json()).toEqual([
      {
        id: "chap1-id",
        hash: hashFor("chap1-id"),
        visibleName: "chapter 1",
        lastModified: "1700000000000",
        lastOpened: "0",
        pinned: true,
        parent: "books-id",
        type: "DocumentType",
        fileType: "pdf",
        path: "/books/chapter 1",
      },
    ]);
  });
});

/** the `includeContent` argument of every `listItems` call a run made */
async function contents(
  values: CommandArgs["values"] = {},
): Promise<(boolean | undefined)[]> {
  const watched = watchListItems(fakeApi());
  await find.run(
    testContext({ api: watched.api, out: captureOutput().out }),
    args(values),
  );
  return watched.calls.map(({ includeContent }) => includeContent);
}

describe("find content", () => {
  test("name, type, and pinned filters stay on the fast path", async () => {
    expect(await contents()).toEqual([false]);
    expect(await contents({ name: "chapter" })).toEqual([false]);
    expect(await contents({ type: "document" })).toEqual([false]);
    expect(await contents({ pinned: true })).toEqual([false]);
  });

  test("--file-type, --tag, and --long need content", async () => {
    expect(await contents({ "file-type": "pdf" })).toEqual([true]);
    expect(await contents({ tag: "shelf" })).toEqual([true]);
    expect(await contents({ long: true })).toEqual([true]);
  });
});
