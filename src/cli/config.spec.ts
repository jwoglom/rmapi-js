import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfigDir, fileStore } from "./config.js";
import { memStore } from "./test-utils.js";

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "rmapi-cli-"));
}

describe("defaultConfigDir()", () => {
  test("prefers RMAPI_CONFIG_DIR", () => {
    expect(
      defaultConfigDir({
        RMAPI_CONFIG_DIR: "/explicit",
        XDG_CONFIG_HOME: "/xdg",
      }),
    ).toBe("/explicit");
  });

  test("falls back to XDG_CONFIG_HOME", () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "rmapi-js"),
    );
  });

  test("falls back to the home directory", () => {
    expect(defaultConfigDir({})).toContain(join(".config", "rmapi-js"));
  });
});

describe("fileStore()", () => {
  test("missing files read as empty", async () => {
    const store = fileStore(join(await tempDir(), "nested"));
    expect(await store.read()).toEqual({});
    expect(await store.readCache()).toBeUndefined();
  });

  test("round trips the config", async () => {
    const dir = await tempDir();
    const store = fileStore(dir);
    await store.write({ deviceToken: "device", sessionToken: "session" });
    expect(await store.read()).toEqual({
      deviceToken: "device",
      sessionToken: "session",
    });

    // merges, and an explicit undefined forgets
    await store.write({ rawHost: "https://raw", sessionToken: undefined });
    expect(await store.read()).toEqual({
      deviceToken: "device",
      rawHost: "https://raw",
    });
  });

  test("round trips the cache", async () => {
    const dir = await tempDir();
    const store = fileStore(dir);
    await store.writeCache('{"hash":null}');
    expect(await store.readCache()).toBe('{"hash":null}');
  });

  test("honors an explicit cache file", async () => {
    const dir = await tempDir();
    const cacheFile = join(dir, "elsewhere.json");
    const store = fileStore(dir, { cacheFile });
    await store.writeCache("{}");
    expect(await fileStore(dir).readCache()).toBeUndefined();
    expect(await store.readCache()).toBe("{}");
  });

  test("writes credentials with mode 0600", async () => {
    const dir = await tempDir();
    const store = fileStore(dir);
    await store.write({ deviceToken: "device" });
    await store.writeCache("{}");
    for (const file of ["config.json", "cache.json"]) {
      const { mode } = await stat(join(dir, file));
      expect(mode & 0o777).toBe(0o600);
    }
  });

  test("uses the environment when no directory is given", async () => {
    const dir = await tempDir();
    const store = fileStore(undefined, { env: { RMAPI_CONFIG_DIR: dir } });
    await store.write({ deviceToken: "device" });
    expect(await fileStore(dir).read()).toEqual({ deviceToken: "device" });
  });

  test("corrupt json is actionable", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "config.json"), "not json");
    expect(fileStore(dir).read()).rejects.toThrow("was not valid json");
  });

  test("valid json with the wrong shape is actionable", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "config.json"), '{"deviceToken": 42}');
    expect(fileStore(dir).read()).rejects.toThrow(
      "was not a valid rmapi config",
    );
  });
});

describe("memStore()", () => {
  test("behaves like the file store", async () => {
    const store = memStore({ deviceToken: "device" });
    expect(await store.read()).toEqual({ deviceToken: "device" });
    await store.write({ sessionToken: "session" });
    expect(store.state).toEqual({
      deviceToken: "device",
      sessionToken: "session",
    });
    await store.write({ sessionToken: undefined });
    expect(store.state).toEqual({ deviceToken: "device" });
    expect(store.cache).toBeUndefined();
    await store.writeCache("{}");
    expect(await store.readCache()).toBe("{}");
  });
});
