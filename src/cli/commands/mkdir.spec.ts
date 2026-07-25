import { describe, expect, test } from "bun:test";
import {
  type Entry,
  type FolderOptions,
  GenerationError,
  type RemarkableApi,
  type SimpleEntry,
} from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { mkdirCommands } from "./mkdir.js";

const { mkdir: mkdirCommand } = mkdirCommands;
const mkdir: Command = mkdirCommand!;

function collection(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: `hash-${id}`,
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
    hash: `hash-${id}`,
    visibleName,
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    parent,
    type: "DocumentType",
    fileType: "pdf",
  };
}

/** one recorded folder creation */
interface Call {
  method: string;
  visibleName: string;
  parent: string | undefined;
  refresh: boolean | undefined;
}

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly Call[];
  /** `start`/`end` markers, to prove creations don't overlap */
  readonly events: readonly string[];
  readonly lists: () => number;
}

function fakeApi({
  items = [],
  failures = 0,
}: {
  items?: readonly Entry[];
  failures?: number;
} = {}): FakeApi {
  const calls: Call[] = [];
  const events: string[] = [];
  let left = failures;
  let made = 0;
  let lists = 0;
  const create = (
    method: string,
    visibleName: string,
    parent: string | undefined,
    refresh: boolean | undefined,
  ): Promise<SimpleEntry> => {
    calls.push({ method, visibleName, parent, refresh });
    if (left > 0) {
      left -= 1;
      return Promise.reject(new GenerationError());
    }
    events.push(`start ${visibleName}`);
    made += 1;
    const id = `made-${made}`;
    return new Promise((res) =>
      setTimeout(() => {
        events.push(`end ${visibleName}`);
        res({ id, hash: `hash-${id}` });
      }, 1),
    );
  };
  const api = {
    listItems(): Promise<Entry[]> {
      lists += 1;
      return Promise.resolve([...items]);
    },
    putFolder(
      visibleName: string,
      opts?: FolderOptions,
      refresh?: boolean,
    ): Promise<SimpleEntry> {
      return create("putFolder", visibleName, opts?.parent, refresh);
    },
    uploadFolder(visibleName: string): Promise<SimpleEntry> {
      return create("uploadFolder", visibleName, undefined, undefined);
    },
  } as unknown as RemarkableApi;
  return { api, calls, events, lists: () => lists };
}

function args(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): CommandArgs {
  return { values, positionals };
}

describe("mkdir", () => {
  test("creates a folder in the root", async () => {
    const { api, calls } = fakeApi();
    const out = captureOutput();
    await mkdir.run(testContext({ api, out: out.out }), args({}, ["books"]));
    expect(calls).toEqual([
      {
        method: "putFolder",
        visibleName: "books",
        parent: "",
        refresh: false,
      },
    ]);
    expect(out.text()).toBe("created /books\n");
  });

  test("creates a folder in the trash", async () => {
    const { api, calls } = fakeApi();
    await mkdir.run(testContext({ api }), args({}, ["/trash/old"]));
    expect(calls[0]?.parent).toBe("trash");
  });

  test("requires a path", async () => {
    const { api } = fakeApi();
    expect(mkdir.run(testContext({ api }), args())).rejects.toThrow(UsageError);
  });

  test("rejects a path that names no folder", async () => {
    const { api } = fakeApi();
    expect(mkdir.run(testContext({ api }), args({}, ["/"]))).rejects.toThrow(
      "doesn't name a folder to create",
    );
  });

  test("fails on a missing parent without --parents", async () => {
    const { api, calls } = fakeApi();
    expect(
      mkdir.run(testContext({ api }), args({}, ["books/scifi"])),
    ).rejects.toThrow(TargetNotFoundError);
    expect(calls).toHaveLength(0);
  });

  test("fails on an existing target without --parents", async () => {
    const { api, calls } = fakeApi({
      items: [collection("books-id", "books")],
    });
    expect(
      mkdir.run(testContext({ api }), args({}, ["books"])),
    ).rejects.toThrow("already exists");
    expect(calls).toHaveLength(0);
  });

  test("--parents only creates what's missing", async () => {
    const { api, calls, lists } = fakeApi({
      items: [collection("books-id", "books")],
    });
    const out = captureOutput();
    await mkdir.run(
      testContext({ api, out: out.out }),
      args({ parents: true }, ["books/scifi"]),
    );
    expect(calls).toEqual([
      {
        method: "putFolder",
        visibleName: "scifi",
        parent: "books-id",
        refresh: false,
      },
    ]);
    expect(out.text()).toBe("created /books/scifi\n");
    expect(lists()).toBe(1);
  });

  test("--parents makes an existing target a no-op", async () => {
    const { api, calls } = fakeApi({
      items: [collection("books-id", "books")],
    });
    const out = captureOutput({ json: true });
    await mkdir.run(
      testContext({ api, out: out.out }),
      args({ parents: true }, ["books"]),
    );
    expect(calls).toHaveLength(0);
    expect(out.json()).toEqual([
      {
        path: "/books",
        id: "books-id",
        hash: "hash-books-id",
        created: false,
      },
    ]);
  });

  test("--parents creates a whole chain, one folder at a time", async () => {
    const { api, calls, events } = fakeApi();
    await mkdir.run(testContext({ api }), args({ parents: true }, ["a/b/c"]));
    expect(calls.map((call) => [call.visibleName, call.parent])).toEqual([
      ["a", ""],
      ["b", "made-1"],
      ["c", "made-2"],
    ]);
    // never concurrent: every creation finishes before the next one starts
    expect(events).toEqual([
      "start a",
      "end a",
      "start b",
      "end b",
      "start c",
      "end c",
    ]);
  });

  test("reuses folders it created for an earlier path", async () => {
    const { api, calls, lists } = fakeApi();
    await mkdir.run(
      testContext({ api }),
      args({ parents: true }, ["a/b", "a/c"]),
    );
    expect(calls.map((call) => [call.visibleName, call.parent])).toEqual([
      ["a", ""],
      ["b", "made-1"],
      ["c", "made-1"],
    ]);
    expect(lists()).toBe(1);
  });

  test("refuses to descend into a document", async () => {
    const { api } = fakeApi({ items: [document("doc-id", "doc")] });
    expect(
      mkdir.run(testContext({ api }), args({ parents: true }, ["doc/inner"])),
    ).rejects.toThrow("isn't a folder");
  });

  test("--simple uses the upload api", async () => {
    const { api, calls, lists } = fakeApi();
    await mkdir.run(testContext({ api }), args({ simple: true }, ["books"]));
    expect(calls).toEqual([
      {
        method: "uploadFolder",
        visibleName: "books",
        parent: undefined,
        refresh: undefined,
      },
    ]);
    // the simple api can't nest, so there's no reason to list anything
    expect(lists()).toBe(0);
  });

  test("--simple rejects a nested path", async () => {
    const { api } = fakeApi();
    expect(
      mkdir.run(testContext({ api }), args({ simple: true }, ["books/scifi"])),
    ).rejects.toThrow("--simple can only create folders in the root");
  });

  test("--simple rejects --parents", async () => {
    const { api } = fakeApi();
    expect(
      mkdir.run(
        testContext({ api }),
        args({ simple: true, parents: true }, ["books"]),
      ),
    ).rejects.toThrow("--parents can't be used with --simple");
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await mkdir.run(testContext({ api }), args({}, ["books"]));
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
  });

  test("honors the global --refresh on the first try", async () => {
    const { api, calls } = fakeApi();
    await mkdir.run(testContext({ api, refresh: true }), args({}, ["books"]));
    expect(calls[0]?.refresh).toBe(true);
  });
});

describe("mkdir content", () => {
  test("resolving a parent never fetches content", async () => {
    const { api } = fakeApi({ items: [collection("books-id", "books")] });
    const watched = watchListItems(api);
    await mkdir.run(
      testContext({ api: watched.api, out: captureOutput().out }),
      args({ parents: true }, ["books/deep"]),
    );
    expect(
      watched.calls.map(({ includeContent }) => includeContent),
    ).not.toContain(true);
  });
});
