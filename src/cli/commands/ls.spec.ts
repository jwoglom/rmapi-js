import { describe, expect, test } from "bun:test";
import type { Entry, RemarkableApi, SimpleEntry } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { AmbiguousTargetError, TargetNotFoundError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { lsCommands } from "./ls.js";

const { ls: lsCommand } = lsCommands;
const ls: Command = lsCommand!;

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const seeds = new Map<string, string>();

/** a stable fake hash for an id, unique per fixture */
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
  document("top-id", "top level"),
  document("nest-id", "nested", "books-id"),
  collection("subs-id", "sub", "books-id"),
  document("deep-id", "deep", "subs-id"),
  document("trsh-id", "trashed", "trash"),
];

interface FakeApi {
  readonly api: RemarkableApi;
  readonly refreshes: readonly boolean[];
}

function fakeApi(items: readonly Entry[] = entries): FakeApi {
  const refreshes: boolean[] = [];
  const api = {
    listItems(refresh?: boolean): Promise<Entry[]> {
      refreshes.push(refresh === true);
      return Promise.resolve([...items]);
    },
    listIds(refresh?: boolean): Promise<SimpleEntry[]> {
      refreshes.push(refresh === true);
      return Promise.resolve(items.map(({ id, hash }) => ({ id, hash })));
    },
  } as unknown as RemarkableApi;
  return { api, refreshes };
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
  const { api } = fakeApi(items);
  await ls.run(testContext({ api, out: out.out }), args(values, positionals));
  return out;
}

describe("ls", () => {
  test("lists the root", async () => {
    const out = await run();
    expect(out.text()).toBe("books/\ntop level\n");
  });

  test("lists the root for an explicit slash", async () => {
    const out = await run({}, ["/"]);
    expect(out.text()).toBe("books/\ntop level\n");
  });

  test("lists a nested collection by path", async () => {
    expect((await run({}, ["books"])).text()).toBe("nested\nsub/\n");
    expect((await run({}, ["/books"])).text()).toBe("nested\nsub/\n");
    expect((await run({}, ["/books/sub"])).text()).toBe("deep\n");
  });

  test("lists the trash", async () => {
    expect((await run({}, ["/trash"])).text()).toBe("trashed\n");
  });

  test("lists a collection by id", async () => {
    expect((await run({}, ["id:books-id"])).text()).toBe("nested\nsub/\n");
  });

  test("lists a collection by hash", async () => {
    const [books] = entries;
    expect((await run({}, [books!.hash])).text()).toBe("nested\nsub/\n");
  });

  test("escapes separators in names", async () => {
    const items = [collection("a-id", "a/b"), document("b-id", "in", "a-id")];
    expect((await run({}, ["a\\/b"], { items })).text()).toBe("in\n");
  });

  test("throws for a missing target", async () => {
    const { api } = fakeApi();
    expect(ls.run(testContext({ api }), args({}, ["nope"]))).rejects.toThrow(
      TargetNotFoundError,
    );
  });

  test("throws for an ambiguous target", async () => {
    const { api } = fakeApi([
      collection("one-id", "dup"),
      collection("two-id", "dup"),
    ]);
    expect(ls.run(testContext({ api }), args({}, ["dup"]))).rejects.toThrow(
      AmbiguousTargetError,
    );
  });

  test("--first resolves an ambiguous target to the first match", async () => {
    const items = [
      collection("one-id", "dup"),
      collection("two-id", "dup"),
      document("in-one-id", "in one", "one-id"),
      document("in-two-id", "in two", "two-id"),
    ];
    const out = captureOutput();
    const { api } = fakeApi(items);
    await ls.run(
      testContext({ api, out: out.out, first: true }),
      args({}, ["dup"]),
    );
    expect(out.text()).toBe("in one\n");
  });

  test("rejects extra positionals", async () => {
    const { api } = fakeApi();
    expect(
      ls.run(testContext({ api }), args({}, ["/books", "/top level"])),
    ).rejects.toThrow("unexpected argument '/top level'");
  });

  test("--all lists every path flat", async () => {
    const out = await run({ all: true });
    expect(out.text()).toBe(
      [
        "/books/",
        "/books/nested",
        "/books/sub/",
        "/books/sub/deep",
        "/top level",
        "/trash/trashed",
        "",
      ].join("\n"),
    );
  });

  test("--all --json includes the path", async () => {
    const out = await run({ all: true }, [], { json: true });
    const parsed = out.json() as (Entry & { path: string })[];
    expect(parsed.map(({ path }) => path)).toEqual([
      "/books",
      "/books/nested",
      "/books/sub",
      "/books/sub/deep",
      "/top level",
      "/trash/trashed",
    ]);
  });

  test("-l shows metadata", async () => {
    const out = await run({ long: true });
    const lines = out.text().trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("books-id");
    expect(lines[0]).toContain(hashFor("books-id"));
    expect(lines[0]).toContain("2023-11-14T");
    expect(lines[0]?.startsWith("d")).toBe(true);
    expect(lines[1]).toContain("pdf");
  });

  test("-R renders a tree", async () => {
    const out = await run({ recursive: true });
    expect(out.text()).toBe(
      [
        "books/",
        "├── nested",
        "└── sub/",
        "    └── deep",
        "top level",
        "",
      ].join("\n"),
    );
  });

  test("-R renders a subtree", async () => {
    const out = await run({ recursive: true }, ["/books/sub"]);
    expect(out.text()).toBe("deep\n");
  });

  test("--ids uses listIds", async () => {
    const out = await run({ ids: true }, [], {
      items: [document("only-id", "only")],
    });
    expect(out.text()).toBe(`only-id  ${hashFor("only-id")}\n`);
  });

  test("--json emits entries", async () => {
    const out = await run({}, [], { json: true });
    const parsed = out.json() as Entry[];
    expect(parsed.map((entry) => entry.id)).toEqual(["books-id", "top-id"]);
  });

  test("passes the global refresh through", async () => {
    const { api, refreshes } = fakeApi();
    await ls.run(testContext({ api, refresh: true }), args());
    expect(refreshes).toEqual([true]);
  });
});

/** the `includeContent` argument of every `listItems` call a run made */
async function contents(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): Promise<(boolean | undefined)[]> {
  const { api } = fakeApi();
  const watched = watchListItems(api);
  await ls.run(
    testContext({ api: watched.api, out: captureOutput().out }),
    args(values, positionals),
  );
  return watched.calls.map(({ includeContent }) => includeContent);
}

describe("ls content", () => {
  test("a plain listing never fetches content", async () => {
    expect(await contents()).toEqual([false]);
    expect(await contents({}, ["books"])).toEqual([false]);
    expect(await contents({ all: true })).toEqual([false]);
    expect(await contents({ recursive: true })).toEqual([false]);
  });

  test("--long fetches content for its file type column", async () => {
    expect(await contents({ long: true })).toEqual([true]);
    expect(await contents({ long: true, all: true })).toEqual([true]);
  });

  test("--ids doesn't list items at all", async () => {
    expect(await contents({ ids: true })).toEqual([]);
  });
});
