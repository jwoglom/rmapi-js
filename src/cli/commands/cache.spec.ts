import { describe, expect, test } from "bun:test";
import type { RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { fileStore } from "../config.js";
import { UsageError } from "../error.js";
import {
  captureDiagnostics,
  captureOutput,
  memStore,
  testContext,
} from "../test-utils.js";
import { cacheCommands } from "./cache.js";

function command(name: string): Command {
  const cmd = cacheCommands[name];
  if (cmd === undefined) {
    throw new Error(`no command ${name}`);
  }
  return cmd;
}

const noArgs: CommandArgs = { values: {}, positionals: [] };

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

/** a fake api whose cache is a plain map, with the calls recorded */
interface FakeApi {
  /** the api commands get */
  readonly api: RemarkableApi;
  /** the cache contents, mutated by the fake */
  readonly cache: Map<string, string | null>;
  /** whether `pruneCache` was called, and with what */
  readonly prunes: readonly boolean[];
  /** how many times `clearCache` was called */
  readonly clears: () => number;
}

function fakeApi(initial: Iterable<[string, string | null]> = []): FakeApi {
  const cache = new Map(initial);
  const prunes: boolean[] = [];
  let clears = 0;
  const api = {
    dumpCache(): string {
      return JSON.stringify(Object.fromEntries(cache));
    },
    pruneCache(refresh?: boolean): Promise<void> {
      prunes.push(refresh === true);
      // pretend everything but the first entry became unreachable
      const [first] = [...cache];
      cache.clear();
      if (first !== undefined) {
        cache.set(first[0], first[1]);
      }
      return Promise.resolve();
    },
    clearCache(): void {
      ++clears;
      cache.clear();
    },
  } as unknown as RemarkableApi;
  return { api, cache, prunes, clears: () => clears };
}

describe("cache dump", () => {
  test("prints the dump to stdout", async () => {
    const out = captureOutput();
    const { api } = fakeApi([[repHash("ab"), "text"]]);
    await command("cache dump").run(testContext({ api, out: out.out }), noArgs);
    expect(out.text()).toBe(`{"${repHash("ab")}":"text"}\n`);
  });

  test("emits the parsed cache as json", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi([[repHash("cd"), null]]);
    await command("cache dump").run(testContext({ api, out: out.out }), noArgs);
    expect(out.json()).toEqual({ cache: { [repHash("cd")]: null } });
  });
});

describe("cache prune", () => {
  test("prunes and persists the result", async () => {
    const out = captureOutput({ json: true });
    const config = memStore({}, "{}");
    const fake = fakeApi([
      [repHash("11"), "kept"],
      [repHash("22"), "dropped"],
      [repHash("33"), null],
    ]);
    const ctx = testContext({
      api: fake.api,
      out: out.out,
      config,
      refresh: true,
    });
    await command("cache prune").run(ctx, noArgs);
    expect(fake.prunes).toEqual([true]);
    expect(config.cache).toBe(`{"${repHash("11")}":"kept"}`);
    expect(out.json()).toEqual({
      before: { entries: 3, cached: 2, textLength: 11, bytes: 224 },
      after: { entries: 1, cached: 1, textLength: 4, bytes: 75 },
    });
  });

  test("reports the change for humans", async () => {
    const out = captureOutput();
    const fake = fakeApi([
      [repHash("11"), "kept"],
      [repHash("22"), "dropped"],
    ]);
    await command("cache prune").run(
      testContext({ api: fake.api, out: out.out }),
      noArgs,
    );
    expect(fake.prunes).toEqual([false]);
    expect(out.text()).toContain("entries");
    expect(out.text()).toContain("2 -> 1");
  });
});

describe("cache clear", () => {
  test("clears memory and the persisted cache", async () => {
    const out = captureOutput();
    const config = memStore({}, `{"${repHash("11")}":"text"}`);
    const fake = fakeApi([[repHash("11"), "text"]]);
    await command("cache clear").run(
      testContext({ api: fake.api, out: out.out, config }),
      noArgs,
    );
    expect(fake.clears()).toBe(1);
    expect(fake.cache.size).toBe(0);
    // the persisted cache is removed, not emptied
    expect(config.cache).toBeUndefined();
    expect(out.text()).toContain("cleared");
  });

  test("reports an already empty cache", async () => {
    const out = captureOutput();
    const fake = fakeApi();
    await command("cache clear").run(
      testContext({ api: fake.api, out: out.out, config: memStore() }),
      noArgs,
    );
    expect(out.text()).toContain("already empty");
  });
});

describe("cache path", () => {
  test("works with no api at all", async () => {
    const out = captureOutput({ json: true });
    // testContext without an api rejects if api() is called
    const ctx = testContext({
      out: out.out,
      config: fileStore("/tmp/rmapi-test"),
    });
    await command("cache path").run(ctx, noArgs);
    expect(out.json()).toEqual({
      configDir: "/tmp/rmapi-test",
      configFile: "/tmp/rmapi-test/config.json",
      cacheFile: "/tmp/rmapi-test/cache.json",
    });
  });

  test("reports the files the store actually uses", async () => {
    const out = captureOutput({ json: true });
    // resolution itself is the store's job, covered by config.spec.ts; this
    // only proves the command reports what the store says
    const ctx = testContext({
      out: out.out,
      config: fileStore("/tmp/explicit", {
        cacheFile: "/tmp/elsewhere/hashes.json",
      }),
    });
    await command("cache path").run(ctx, noArgs);
    expect(out.json()).toEqual({
      configDir: "/tmp/explicit",
      configFile: "/tmp/explicit/config.json",
      cacheFile: "/tmp/elsewhere/hashes.json",
    });
  });
});

describe("cache info", () => {
  test("summarizes the persisted cache with no api at all", async () => {
    const out = captureOutput({ json: true });
    const dump = JSON.stringify({
      [repHash("11")]: "hello",
      [repHash("22")]: null,
      [repHash("33")]: "worlds",
    });
    // testContext without an api rejects if api() is called
    const ctx = testContext({ out: out.out, config: memStore({}, dump) });
    await command("cache info").run(ctx, noArgs);
    expect(out.json()).toEqual({
      persisted: true,
      entries: 3,
      cached: 2,
      textLength: 11,
      bytes: dump.length,
    });
  });

  test("reports an empty cache", async () => {
    const out = captureOutput();
    await command("cache info").run(
      testContext({ out: out.out, config: memStore() }),
      noArgs,
    );
    expect(out.text()).toBe("nothing cached yet\n");
  });

  test("renders columns for humans", async () => {
    const out = captureOutput();
    const ctx = testContext({
      out: out.out,
      config: memStore({}, `{"${repHash("11")}":"hello"}`),
    });
    await command("cache info").run(ctx, noArgs);
    expect(out.text()).toContain("entries");
    expect(out.text()).toContain("text length  5");
  });

  test("rejects a corrupt cache", () => {
    const ctx = testContext({ config: memStore({}, "not json") });
    expect(command("cache info").run(ctx, noArgs)).rejects.toThrow(
      "not valid json",
    );
  });

  test("rejects a cache that isn't an object", () => {
    const ctx = testContext({ config: memStore({}, "[1, 2]") });
    expect(command("cache info").run(ctx, noArgs)).rejects.toThrow(
      "not a json object",
    );
  });

  test("rejects extra arguments", () => {
    const ctx = testContext();
    expect(
      command("cache info").run(ctx, { values: {}, positionals: ["extra"] }),
    ).rejects.toThrow(UsageError);
  });
});

/** an api that fills a cache as it reads, the way the real one does */
interface FakeLoader {
  /** the api commands get */
  readonly api: RemarkableApi;
  /** the arguments of every `listItems` call */
  readonly lists: readonly (boolean | undefined)[][];
  /** the `refresh` argument of every `listIds` call */
  readonly idLists: readonly (boolean | undefined)[];
  /** every raw call, by method name */
  readonly rawCalls: readonly string[];
}

function fakeLoader(items: number = 3): FakeLoader {
  const cache = new Map<string, string>();
  const lists: (boolean | undefined)[][] = [];
  const idLists: (boolean | undefined)[] = [];
  const rawCalls: string[] = [];
  const ids = Array.from({ length: items }, (_, i) => ({
    id: `item-${String(i)}`,
    hash: repHash((i + 1).toString(16).padStart(4, "0")),
  }));
  const raw = {
    getEntries(fileName: string, hash: string) {
      rawCalls.push("getEntries");
      cache.set(`${hash}-entries`, "entries");
      const id = fileName.replace(/\.docSchema$/, "");
      return Promise.resolve({
        entries: [
          { id: `${id}.metadata`, hash, type: "0", size: 1, subfiles: 0 },
          { id: `${id}.content`, hash, type: "0", size: 1, subfiles: 0 },
        ],
      });
    },
    getMetadata(_fileName: string, hash: string) {
      rawCalls.push("getMetadata");
      cache.set(`${hash}-meta`, "metadata");
      return Promise.resolve({});
    },
    getContent(_fileName: string, hash: string) {
      rawCalls.push("getContent");
      cache.set(`${hash}-content`, "content");
      return Promise.resolve({});
    },
  };
  const api = {
    raw,
    dumpCache(): string {
      return JSON.stringify(Object.fromEntries(cache));
    },
    listIds(refresh?: boolean) {
      idLists.push(refresh);
      cache.set("root", "entries");
      return Promise.resolve(ids.map(({ id, hash }) => ({ id, hash })));
    },
    listItems(refresh?: boolean, includeContent?: boolean) {
      lists.push([refresh, includeContent]);
      for (const { hash } of ids) {
        cache.set(`${hash}-entries`, "entries");
        cache.set(`${hash}-meta`, "metadata");
        if (includeContent === true) {
          cache.set(`${hash}-content`, "content");
        }
      }
      return Promise.resolve(ids.map(({ id, hash }) => ({ id, hash })));
    },
  } as unknown as RemarkableApi;
  return { api, lists, idLists, rawCalls };
}

/** what `cache load` reported, under --json */
interface LoadJson {
  level: string;
  listed: number;
  warmed: number;
  requests?: number;
  newlyCached: number;
  persisted: boolean;
  before: { cached: number; bytes: number };
  after: { cached: number; bytes: number };
  elapsedMs: number;
}

describe("cache load", () => {
  test("warms every item's metadata by default", async () => {
    const out = captureOutput({ json: true });
    const { api, lists, rawCalls } = fakeLoader();
    const store = memStore();
    await command("cache load").run(
      testContext({ api, out: out.out, config: store }),
      noArgs,
    );
    // the library's listing, without content, and no hand driven requests
    expect(lists).toEqual([[false, false]]);
    expect(rawCalls).toEqual([]);
    const result = out.json() as LoadJson;
    expect(result.level).toBe("metadata");
    expect(result.listed).toBe(3);
    expect(result.warmed).toBe(3);
    expect(result.requests).toBeUndefined();
    // one root entry list plus an entry list and metadata per item
    expect(result.newlyCached).toBe(7);
    expect(result.after.cached).toBeGreaterThan(result.before.cached);
    expect(result.after.bytes).toBeGreaterThan(result.before.bytes);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.persisted).toBe(true);
    // the warmed cache is on disk, whatever main.ts does afterwards
    expect(store.cache).toBeDefined();
    expect(Object.keys(JSON.parse(store.cache!) as object)).toHaveLength(7);
  });

  test("--content also warms every item's content", async () => {
    const out = captureOutput({ json: true });
    const { api, lists } = fakeLoader();
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { content: true },
      positionals: [],
    });
    expect(lists).toEqual([[false, true]]);
    const result = out.json() as LoadJson;
    expect(result.level).toBe("content");
    expect(result.warmed).toBe(3);
    // the root list, plus an entry list, metadata, and content per item
    expect(result.newlyCached).toBe(10);
  });

  test("--entries-only stops after the root entry list", async () => {
    const out = captureOutput({ json: true });
    const { api, lists, rawCalls } = fakeLoader();
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { "entries-only": true },
      positionals: [],
    });
    expect(lists).toEqual([]);
    expect(rawCalls).toEqual([]);
    const result = out.json() as LoadJson;
    expect(result.level).toBe("entries-only");
    expect(result.listed).toBe(3);
    expect(result.warmed).toBe(0);
    expect(result.requests).toBe(2);
    expect(result.newlyCached).toBe(1);
  });

  test("--limit drives only the first n items itself", async () => {
    const out = captureOutput({ json: true });
    const { api, lists, rawCalls } = fakeLoader(5);
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { limit: "2" },
      positionals: [],
    });
    // the library's all-or-nothing listing is never used
    expect(lists).toEqual([]);
    expect(rawCalls).toEqual([
      "getEntries",
      "getEntries",
      "getMetadata",
      "getMetadata",
    ]);
    const result = out.json() as LoadJson;
    expect(result.listed).toBe(5);
    expect(result.warmed).toBe(2);
    // two for the root, then two calls per item
    expect(result.requests).toBe(6);
    expect(result.newlyCached).toBe(5);
  });

  test("--limit with --content warms content too", async () => {
    const out = captureOutput({ json: true });
    const { api, rawCalls } = fakeLoader(5);
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { limit: "1", content: true },
      positionals: [],
    });
    expect(rawCalls).toEqual(["getEntries", "getMetadata", "getContent"]);
    expect((out.json() as LoadJson).requests).toBe(5);
  });

  test("--limit of zero warms nothing", async () => {
    const out = captureOutput({ json: true });
    const { api, rawCalls } = fakeLoader();
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { limit: "0" },
      positionals: [],
    });
    expect(rawCalls).toEqual([]);
    expect((out.json() as LoadJson).warmed).toBe(0);
  });

  test("renders a human readable report", async () => {
    const out = captureOutput();
    const { api } = fakeLoader();
    await command("cache load").run(testContext({ api, out: out.out }), noArgs);
    const text = out.text();
    expect(text).toContain("level           metadata");
    expect(text).toContain("items listed    3");
    expect(text).toContain("items warmed    3");
    expect(text).toContain("hashes fetched");
    expect(text).toContain("elapsed");
    expect(text).toContain("persisted       yes");
    expect(text).not.toContain("raw calls");
  });

  test("reports the raw calls it drove itself", async () => {
    const out = captureOutput();
    const { api } = fakeLoader();
    await command("cache load").run(testContext({ api, out: out.out }), {
      values: { "entries-only": true },
      positionals: [],
    });
    expect(out.text()).toContain("raw calls       2");
  });

  test("honors the global --refresh", async () => {
    const { api, idLists } = fakeLoader();
    await command("cache load").run(
      testContext({ api, refresh: true }),
      noArgs,
    );
    expect(idLists).toEqual([true]);
  });

  test("doesn't persist under --no-cache", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeLoader();
    const store = memStore();
    await command("cache load").run(
      testContext({ api, out: out.out, config: store, cache: false }),
      noArgs,
    );
    expect(store.cache).toBeUndefined();
    expect((out.json() as LoadJson).persisted).toBe(false);
  });

  test("reports progress under --verbose", async () => {
    const captured = captureDiagnostics({ verbose: true });
    const { api } = fakeLoader(4);
    await command("cache load").run(
      testContext({ api, verbose: true, diagnostic: captured.diagnostic }),
      { values: { limit: "4" }, positionals: [] },
    );
    expect(captured.messages).toEqual([
      "the root entry list names 4 items",
      "warming the first 4 items",
      "warmed 4/4 items",
    ]);
  });

  test("is quiet without --verbose", async () => {
    const captured = captureDiagnostics();
    const { api } = fakeLoader();
    await command("cache load").run(
      testContext({ api, diagnostic: captured.diagnostic }),
      noArgs,
    );
    expect(captured.messages).toEqual([]);
  });

  test("rejects contradictory levels", () => {
    const { api } = fakeLoader();
    expect(
      command("cache load").run(testContext({ api }), {
        values: { "entries-only": true, content: true },
        positionals: [],
      }),
    ).rejects.toThrow(UsageError);
  });

  test("rejects --limit with --entries-only", () => {
    const { api } = fakeLoader();
    expect(
      command("cache load").run(testContext({ api }), {
        values: { "entries-only": true, limit: "5" },
        positionals: [],
      }),
    ).rejects.toThrow("--limit doesn't apply to --entries-only");
  });

  test("rejects a limit that isn't a non-negative integer", () => {
    const { api } = fakeLoader();
    for (const limit of ["-1", "1.5", "many"]) {
      expect(
        command("cache load").run(testContext({ api }), {
          values: { limit },
          positionals: [],
        }),
      ).rejects.toThrow(UsageError);
    }
  });

  test("rejects extra arguments", () => {
    expect(
      command("cache load").run(testContext(), {
        values: {},
        positionals: ["extra"],
      }),
    ).rejects.toThrow(UsageError);
  });
});
