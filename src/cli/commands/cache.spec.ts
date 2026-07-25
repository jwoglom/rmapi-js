import { describe, expect, test } from "bun:test";
import type { RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { fileStore } from "../config.js";
import { UsageError } from "../error.js";
import { captureOutput, memStore, testContext } from "../test-utils.js";
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
