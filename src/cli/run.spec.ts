import { describe, expect, test } from "bun:test";
import type { RemarkableApi } from "../index.js";
import { runCommand } from "./run.js";

/** an api whose cache dump is a fixed string */
function fakeApi(dump: string): RemarkableApi {
  return { dumpCache: () => dump } as unknown as RemarkableApi;
}

describe("runCommand()", () => {
  test("persists the cache after a successful command", async () => {
    const written: string[] = [];
    await runCommand(() => Promise.resolve(), {
      api: () => fakeApi("cached"),
      cache: true,
      writeCache: (dump) => {
        written.push(dump);
        return Promise.resolve();
      },
    });
    expect(written).toEqual(["cached"]);
  });

  test("persists the cache even when the command throws", async () => {
    const written: string[] = [];
    const failing = runCommand(() => Promise.reject(new Error("nope")), {
      api: () => fakeApi("partial"),
      cache: true,
      writeCache: (dump) => {
        written.push(dump);
        return Promise.resolve();
      },
    });
    expect(failing).rejects.toThrow("nope");
    await failing.catch(() => {});
    // the work done before the failure is kept, so a retry doesn't repeat it
    expect(written).toEqual(["partial"]);
  });

  test("writes nothing when the command never built an api", async () => {
    const written: string[] = [];
    await runCommand(() => Promise.resolve(), {
      api: () => undefined,
      cache: true,
      writeCache: (dump) => {
        written.push(dump);
        return Promise.resolve();
      },
    });
    expect(written).toEqual([]);
  });

  test("writes nothing with the cache disabled", async () => {
    const written: string[] = [];
    await runCommand(() => Promise.resolve(), {
      api: () => fakeApi("cached"),
      cache: false,
      writeCache: (dump) => {
        written.push(dump);
        return Promise.resolve();
      },
    });
    expect(written).toEqual([]);
  });

  test("reads the api lazily, after the command ran", async () => {
    const written: string[] = [];
    let api: RemarkableApi | undefined;
    await runCommand(
      () => {
        api = fakeApi("built during the run");
        return Promise.resolve();
      },
      {
        api: () => api,
        cache: true,
        writeCache: (dump) => {
          written.push(dump);
          return Promise.resolve();
        },
      },
    );
    expect(written).toEqual(["built during the run"]);
  });
});
