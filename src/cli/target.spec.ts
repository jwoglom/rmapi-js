import { describe, expect, test } from "bun:test";
import type {
  Entry,
  Metadata,
  RawRemarkableApi,
  RemarkableApi,
  SimpleEntry,
} from "../index.js";
import { AmbiguousTargetError, TargetNotFoundError } from "./error.js";
import { entries as allEntries, target, targets } from "./target.js";
import { captureDiagnostics, testContext } from "./test-utils.js";

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

function document(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: repHash(id.slice(0, 2).padEnd(2, "0")),
    visibleName,
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    parent,
    type: "DocumentType",
    fileType: "pdf",
  };
}

const items: readonly Entry[] = [
  document("ab", "first"),
  document("cd", "second"),
  document("ef", "second"),
];

/** how the fake api was called */
interface FakeApi {
  readonly api: RemarkableApi;
  /** the arguments of every `listItems` call */
  readonly lists: readonly (boolean | undefined)[][];
  /** the `refresh` argument of every `listIds` call */
  readonly idLists: readonly (boolean | undefined)[];
  /** every raw call, as a name and file name */
  readonly rawCalls: readonly string[];
}

function fakeApi(): FakeApi {
  const lists: (boolean | undefined)[][] = [];
  const idLists: (boolean | undefined)[] = [];
  const rawCalls: string[] = [];
  const raw = {
    getEntries(fileName: string, hash: string) {
      rawCalls.push(`getEntries ${fileName}`);
      const id = fileName.replace(/\.docSchema$/, "");
      return Promise.resolve({
        entries: [
          { id: `${id}.metadata`, hash, type: "0", size: 1, subfiles: 0 },
          { id: `${id}.content`, hash, type: "0", size: 1, subfiles: 0 },
        ],
      });
    },
    getMetadata(fileName: string) {
      rawCalls.push(`getMetadata ${fileName}`);
      return Promise.resolve({
        type: "DocumentType",
        visibleName: "doc",
        parent: "",
        lastModified: "1700000000000",
        pinned: false,
      } satisfies Metadata);
    },
    getContent(fileName: string) {
      rawCalls.push(`getContent ${fileName}`);
      return Promise.resolve({ fileType: "pdf" });
    },
  } as unknown as RawRemarkableApi;
  const api = {
    raw,
    listItems(refresh?: boolean, includeContent?: boolean): Promise<Entry[]> {
      lists.push([refresh, includeContent]);
      return Promise.resolve([...items]);
    },
    listIds(refresh?: boolean): Promise<SimpleEntry[]> {
      idLists.push(refresh);
      return Promise.resolve(items.map(({ id, hash }) => ({ id, hash })));
    },
  } as unknown as RemarkableApi;
  return { api, lists, idLists, rawCalls };
}

describe("entries", () => {
  test("skips content by default", async () => {
    const { api, lists } = fakeApi();
    expect(await allEntries(testContext({ api }))).toHaveLength(3);
    expect(lists).toEqual([[false, false]]);
  });

  test("fetches content when a command asks for it", async () => {
    const { api, lists } = fakeApi();
    await allEntries(testContext({ api }), { content: true });
    expect(lists).toEqual([[false, true]]);
  });

  test("passes the refresh global through", async () => {
    const { api, lists } = fakeApi();
    await allEntries(testContext({ api, refresh: true }));
    expect(lists).toEqual([[true, false]]);
  });

  test("makes no requests of its own without verbose", async () => {
    const { api, rawCalls, idLists } = fakeApi();
    await allEntries(testContext({ api }));
    expect(rawCalls).toEqual([]);
    expect(idLists).toEqual([]);
  });

  test("reports progress under verbose without re-refreshing", async () => {
    const { api, lists, idLists, rawCalls } = fakeApi();
    const captured = captureDiagnostics({ verbose: true });
    const found = await allEntries(
      testContext({
        api,
        verbose: true,
        refresh: true,
        diagnostic: captured.diagnostic,
      }),
    );
    expect(found).toHaveLength(3);
    // the root hash is refreshed once, by listIds, and the listing itself is
    // then served from the warmed cache
    expect(idLists).toEqual([true]);
    expect(lists).toEqual([[false, false]]);
    expect(rawCalls).toContain("getEntries ab.docSchema");
    expect(rawCalls).not.toContain("getContent ab.content");
    expect(captured.messages[0]).toBe("resolving 3 items (metadata only)");
    expect(captured.messages).toContain("resolved 3/3 items");
  });

  test("warms content under verbose when content was asked for", async () => {
    const { api, lists, rawCalls } = fakeApi();
    const captured = captureDiagnostics({ verbose: true });
    await allEntries(
      testContext({ api, verbose: true, diagnostic: captured.diagnostic }),
      { content: true },
    );
    expect(lists).toEqual([[false, true]]);
    expect(rawCalls).toContain("getContent ab.content");
    expect(captured.messages[0]).toBe(
      "resolving 3 items (metadata and content)",
    );
  });
});

describe("target", () => {
  test("resolves without content by default", async () => {
    const { api, lists } = fakeApi();
    const found = await target(testContext({ api }), "first");
    expect(found.id).toBe("ab");
    expect(lists).toEqual([[false, false]]);
  });

  test("asks for content when told to", async () => {
    const { api, lists } = fakeApi();
    await target(testContext({ api }), "first", { content: true });
    expect(lists).toEqual([[false, true]]);
  });

  test("throws for an unknown target", async () => {
    const { api } = fakeApi();
    await expect(target(testContext({ api }), "nope")).rejects.toThrow(
      TargetNotFoundError,
    );
  });

  test("throws for an ambiguous target unless first", async () => {
    const { api } = fakeApi();
    await expect(target(testContext({ api }), "second")).rejects.toThrow(
      AmbiguousTargetError,
    );
    const found = await target(testContext({ api }), "second", { first: true });
    expect(found.id).toBe("cd");
  });
});

describe("targets", () => {
  test("resolves several without content by default", async () => {
    const { api, lists } = fakeApi();
    const found = await targets(testContext({ api }), ["first", "id:cd"]);
    expect(found.map(({ id }) => id)).toEqual(["ab", "cd"]);
    expect(lists).toEqual([[false, false]]);
  });

  test("asks for content when told to", async () => {
    const { api, lists } = fakeApi();
    await targets(testContext({ api }), ["first"], { content: true });
    expect(lists).toEqual([[false, true]]);
  });

  test("expands a dash to stdin, listing once", async () => {
    const { api, lists } = fakeApi();
    const found = await targets(
      testContext({ api, stdin: "first\n id:cd \n\n" }),
      ["-"],
    );
    expect(found.map(({ id }) => id)).toEqual(["ab", "cd"]);
    expect(lists).toHaveLength(1);
  });
});
