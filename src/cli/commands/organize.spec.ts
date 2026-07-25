import { describe, expect, test } from "bun:test";
import {
  type Entry,
  GenerationError,
  type HashEntry,
  type HashesEntry,
  type RemarkableApi,
} from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { AmbiguousTargetError, UsageError } from "../error.js";
import { captureOutput, testContext } from "../test-utils.js";
import { organizeCommands } from "./organize.js";

function command(name: string): Command {
  const cmd = organizeCommands[name];
  if (cmd === undefined) {
    throw new Error(`no command ${name}`);
  }
  return cmd;
}

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

const entries: readonly Entry[] = [
  collection("books-id", "books"),
  document("one-id", "one"),
  document("two-id", "two"),
  document("three-id", "three"),
];

/** two root siblings sharing a name, which `/dup` matches ambiguously */
const dups: readonly Entry[] = [
  document("dup-one-id", "dup"),
  document("dup-two-id", "dup"),
];

/** one recorded api call */
interface Call {
  method: string;
  hashes: readonly string[];
  parent?: string;
  visibleName?: string;
  stared?: boolean;
  refresh: boolean | undefined;
}

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly Call[];
  readonly lists: () => number;
}

function fakeApi({
  items = entries,
  failures = 0,
}: {
  items?: readonly Entry[];
  failures?: number;
} = {}): FakeApi {
  const calls: Call[] = [];
  let left = failures;
  let lists = 0;
  const stale = (): boolean => {
    if (left > 0) {
      left -= 1;
      return true;
    }
    return false;
  };
  const one = (call: Call): Promise<HashEntry> => {
    calls.push(call);
    return stale()
      ? Promise.reject(new GenerationError())
      : Promise.resolve({ hash: `new-${call.hashes[0]}` });
  };
  const many = (call: Call): Promise<HashesEntry> => {
    calls.push(call);
    return stale()
      ? Promise.reject(new GenerationError())
      : Promise.resolve({
          hashes: Object.fromEntries(
            call.hashes.map((hash) => [hash, `new-${hash}`]),
          ),
        });
  };
  const api = {
    listItems(): Promise<Entry[]> {
      lists += 1;
      return Promise.resolve([...items]);
    },
    move(hash: string, parent: string, refresh?: boolean) {
      return one({ method: "move", hashes: [hash], parent, refresh });
    },
    bulkMove(hashes: readonly string[], parent: string, refresh?: boolean) {
      return many({ method: "bulkMove", hashes, parent, refresh });
    },
    delete(hash: string, refresh?: boolean) {
      return one({ method: "delete", hashes: [hash], refresh });
    },
    bulkDelete(hashes: readonly string[], refresh?: boolean) {
      return many({ method: "bulkDelete", hashes, refresh });
    },
    rename(hash: string, visibleName: string, refresh?: boolean) {
      return one({ method: "rename", hashes: [hash], visibleName, refresh });
    },
    stared(hash: string, stared: boolean, refresh?: boolean) {
      return one({ method: "stared", hashes: [hash], stared, refresh });
    },
  } as unknown as RemarkableApi;
  return { api, calls, lists: () => lists };
}

function args(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): CommandArgs {
  return { values, positionals };
}

describe("mv", () => {
  test("one target uses move", async () => {
    const { api, calls, lists } = fakeApi();
    const out = captureOutput();
    await command("mv").run(
      testContext({ api, out: out.out }),
      args({}, ["one", "books"]),
    );
    expect(calls).toEqual([
      {
        method: "move",
        hashes: ["hash-one-id"],
        parent: "books-id",
        refresh: false,
      },
    ]);
    expect(lists()).toBe(1);
    expect(out.text()).toMatch(/^moved\s+'one'/);
  });

  test("several targets use bulkMove and report old to new hashes", async () => {
    const { api, calls, lists } = fakeApi();
    const out = captureOutput({ json: true });
    await command("mv").run(
      testContext({ api, out: out.out }),
      args({}, ["one", "two", "books"]),
    );
    expect(calls).toEqual([
      {
        method: "bulkMove",
        hashes: ["hash-one-id", "hash-two-id"],
        parent: "books-id",
        refresh: false,
      },
    ]);
    expect(lists()).toBe(1);
    expect(out.json()).toEqual({
      action: "moved",
      dest: { id: "books-id", visibleName: "books" },
      changes: [
        {
          id: "one-id",
          visibleName: "one",
          hash: "hash-one-id",
          newHash: "new-hash-one-id",
        },
        {
          id: "two-id",
          visibleName: "two",
          hash: "hash-two-id",
          newHash: "new-hash-two-id",
        },
      ],
    });
  });

  test("moves to the root and the trash", async () => {
    const root = fakeApi();
    await command("mv").run(
      testContext({ api: root.api }),
      args({}, ["one", "/"]),
    );
    expect(root.calls[0]?.parent).toBe("");

    const trash = fakeApi();
    await command("mv").run(
      testContext({ api: trash.api }),
      args({}, ["one", "/trash"]),
    );
    expect(trash.calls[0]?.parent).toBe("trash");
  });

  test("expands - from stdin, keeping the destination last", async () => {
    const { api, calls, lists } = fakeApi();
    await command("mv").run(
      testContext({ api, stdin: "two\nthree\n\n" }),
      args({}, ["one", "-", "books"]),
    );
    expect(calls[0]?.method).toBe("bulkMove");
    expect(calls[0]?.hashes).toEqual([
      "hash-one-id",
      "hash-two-id",
      "hash-three-id",
    ]);
    expect(lists()).toBe(1);
  });

  test("requires a target and a destination", async () => {
    const { api } = fakeApi();
    expect(
      command("mv").run(testContext({ api }), args({}, ["one"])),
    ).rejects.toThrow(UsageError);
  });

  test("refuses a destination that isn't a collection", async () => {
    const { api } = fakeApi();
    expect(
      command("mv").run(testContext({ api }), args({}, ["one", "two"])),
    ).rejects.toThrow("isn't a collection");
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await command("mv").run(testContext({ api }), args({}, ["one", "books"]));
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
  });
});

describe("rm", () => {
  test("one target uses delete", async () => {
    const { api, calls } = fakeApi();
    const out = captureOutput();
    await command("rm").run(
      testContext({ api, out: out.out }),
      args({}, ["one"]),
    );
    expect(calls).toEqual([
      { method: "delete", hashes: ["hash-one-id"], refresh: false },
    ]);
    expect(out.text()).toMatch(/^trashed\s+'one'/);
  });

  test("several targets use bulkDelete", async () => {
    const { api, calls, lists } = fakeApi();
    await command("rm").run(testContext({ api }), args({}, ["one", "two"]));
    expect(calls).toEqual([
      {
        method: "bulkDelete",
        hashes: ["hash-one-id", "hash-two-id"],
        refresh: false,
      },
    ]);
    expect(lists()).toBe(1);
  });

  test("expands - from stdin", async () => {
    const { api, calls, lists } = fakeApi();
    await command("rm").run(
      testContext({ api, stdin: "one\ntwo\n" }),
      args({}, ["-"]),
    );
    expect(calls[0]?.hashes).toEqual(["hash-one-id", "hash-two-id"]);
    expect(lists()).toBe(1);
  });

  test("requires a target", async () => {
    const { api } = fakeApi();
    expect(command("rm").run(testContext({ api }), args())).rejects.toThrow(
      UsageError,
    );
  });

  test("says it only moves items to the trash", () => {
    expect(command("rm").summary).toContain("trash");
    expect(command("rm").details).toContain("no way to erase");
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await command("rm").run(testContext({ api }), args({}, ["one", "two"]));
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
  });
});

describe("rename", () => {
  test("renames a single item", async () => {
    const { api, calls } = fakeApi();
    const out = captureOutput({ json: true });
    await command("rename").run(
      testContext({ api, out: out.out }),
      args({}, ["one", "the first"]),
    );
    expect(calls).toEqual([
      {
        method: "rename",
        hashes: ["hash-one-id"],
        visibleName: "the first",
        refresh: false,
      },
    ]);
    expect(out.json()).toEqual({
      action: "renamed to 'the first'",
      changes: [
        {
          id: "one-id",
          visibleName: "one",
          hash: "hash-one-id",
          newHash: "new-hash-one-id",
        },
      ],
    });
  });

  test("requires a target and a name", async () => {
    const { api } = fakeApi();
    expect(
      command("rename").run(testContext({ api }), args({}, ["one"])),
    ).rejects.toThrow(UsageError);
  });

  test("rejects extra positionals", async () => {
    const { api } = fakeApi();
    expect(
      command("rename").run(
        testContext({ api }),
        args({}, ["one", "new", "extra"]),
      ),
    ).rejects.toThrow("unexpected argument 'extra'");
  });

  test("throws for an ambiguous target", async () => {
    const { api } = fakeApi({ items: dups });
    expect(
      command("rename").run(testContext({ api }), args({}, ["dup", "new"])),
    ).rejects.toThrow(AmbiguousTargetError);
  });

  test("--first renames the first match of an ambiguous target", async () => {
    const { api, calls } = fakeApi({ items: dups });
    await command("rename").run(
      testContext({ api, first: true }),
      args({}, ["dup", "new"]),
    );
    expect(calls).toEqual([
      {
        method: "rename",
        hashes: ["hash-dup-one-id"],
        visibleName: "new",
        refresh: false,
      },
    ]);
  });
});

describe("star", () => {
  test("stars every target, one at a time", async () => {
    const { api, calls, lists } = fakeApi();
    const out = captureOutput();
    await command("star").run(
      testContext({ api, out: out.out }),
      args({}, ["one", "two"]),
    );
    expect(calls).toEqual([
      {
        method: "stared",
        hashes: ["hash-one-id"],
        stared: true,
        refresh: false,
      },
      {
        method: "stared",
        hashes: ["hash-two-id"],
        stared: true,
        refresh: false,
      },
    ]);
    expect(lists()).toBe(1);
    expect(out.text()).toMatch(/^starred\s+'one'/);
  });

  test("unstar passes false", async () => {
    const { api, calls } = fakeApi();
    await command("unstar").run(testContext({ api }), args({}, ["one"]));
    expect(calls[0]?.stared).toBe(false);
  });

  test("expands - from stdin", async () => {
    const { api, calls } = fakeApi();
    await command("star").run(
      testContext({ api, stdin: "two\n" }),
      args({}, ["-"]),
    );
    expect(calls.map((call) => call.hashes[0])).toEqual(["hash-two-id"]);
  });

  test("requires a target", async () => {
    const { api } = fakeApi();
    expect(command("star").run(testContext({ api }), args())).rejects.toThrow(
      UsageError,
    );
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await command("star").run(testContext({ api }), args({}, ["one"]));
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
  });
});
