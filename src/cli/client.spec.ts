import { describe, expect, test } from "bun:test";
import { GenerationError, ResponseError } from "../index.js";
import {
  emptyResponse,
  jsonResponse,
  mockFetch,
  textResponse,
} from "../test-utils.js";
import {
  client,
  resolveDeviceToken,
  resolveHosts,
  withGeneration,
} from "./client.js";
import { AuthError } from "./error.js";
import { memStore } from "./test-utils.js";

const hash = new Array(8).fill("deadbeef").join("");

/** never actually wait in tests */
const instant = {
  backoff: () => 0,
  sleep: (): Promise<void> => Promise.resolve(),
};

describe("resolveHosts()", () => {
  test("flags beat the environment beats the config", () => {
    const hosts = resolveHosts(
      { authHost: "https://flag" },
      { RMAPI_AUTH_HOST: "https://env", RMAPI_RAW_HOST: "https://env-raw" },
      { authHost: "https://config", uploadHost: "https://config-upload" },
    );
    expect(hosts).toEqual({
      authHost: "https://flag",
      rawHost: "https://env-raw",
      uploadHost: "https://config-upload",
    });
  });

  test("unset hosts stay undefined", () => {
    expect(resolveHosts({}, {}, {})).toEqual({
      authHost: undefined,
      rawHost: undefined,
      uploadHost: undefined,
    });
  });
});

describe("resolveDeviceToken()", () => {
  test("the environment wins", () => {
    expect(
      resolveDeviceToken({ RMAPI_DEVICE_TOKEN: "env" }, { deviceToken: "cfg" }),
    ).toBe("env");
  });

  test("falls back to the config", () => {
    expect(resolveDeviceToken({}, { deviceToken: "cfg" })).toBe("cfg");
  });

  test("throws without a token", () => {
    expect(() => resolveDeviceToken({}, {})).toThrow(AuthError);
  });
});

describe("client()", () => {
  test("requires a device token", () => {
    mockFetch();
    expect(client(memStore())).rejects.toThrow(AuthError);
  });

  test("reuses a cached session token", async () => {
    const fetch = mockFetch(
      jsonResponse({ hash, generation: 2, schemaVersion: 4 }),
    );
    const store = memStore({
      deviceToken: "device",
      sessionToken: "session",
    });

    const api = await client(store);
    expect(await api.raw.getRootHash()).toEqual([hash, 2, 4]);
    // only the root hash request, no authorization request
    expect(fetch.mock.calls).toHaveLength(1);
    const [, init] = fetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer session",
    );
  });

  test("exchanges the device token when no session is cached", async () => {
    mockFetch(
      textResponse("fresh session"),
      jsonResponse({ hash, generation: 1, schemaVersion: 3 }),
    );
    const store = memStore({ deviceToken: "device" });

    const api = await client(store);
    expect(store.state.sessionToken).toBe("fresh session");
    expect(await api.raw.getRootHash()).toEqual([hash, 1, 3]);
  });

  test("loads the persisted hash cache", async () => {
    mockFetch();
    const store = memStore(
      { deviceToken: "device", sessionToken: "session" },
      `{"${hash}":"cached"}`,
    );
    const api = await client(store);
    expect(JSON.parse(api.dumpCache()) as unknown).toEqual({
      [hash]: "cached",
    });
  });

  test("skips the persisted hash cache when disabled", async () => {
    mockFetch();
    const store = memStore(
      { deviceToken: "device", sessionToken: "session" },
      `{"${hash}":"cached"}`,
    );
    const api = await client(store, { cache: false });
    expect(JSON.parse(api.dumpCache()) as unknown).toEqual({});
  });

  test("refreshes the session once on a 401", async () => {
    const fetch = mockFetch(
      // the stale cached session token
      emptyResponse({ status: 401, statusText: "Unauthorized" }),
      // the new session token
      textResponse("new session"),
      // the retried request
      jsonResponse({ hash, generation: 5, schemaVersion: 4 }),
    );
    const store = memStore({
      deviceToken: "device",
      sessionToken: "stale",
    });

    const api = await client(store);
    expect(await api.raw.getRootHash()).toEqual([hash, 5, 4]);
    expect(store.state.sessionToken).toBe("new session");
    expect(fetch.mock.calls).toHaveLength(3);
    const [, auth] = fetch.mock.calls[1] ?? [];
    expect(new Headers(auth?.headers).get("Authorization")).toBe(
      "Bearer device",
    );
    const [, retried] = fetch.mock.calls[2] ?? [];
    expect(new Headers(retried?.headers).get("Authorization")).toBe(
      "Bearer new session",
    );
  });

  test("refreshes at most once", async () => {
    mockFetch(
      emptyResponse({ status: 401 }),
      textResponse("new session"),
      emptyResponse({ status: 401 }),
    );
    const store = memStore({ deviceToken: "device", sessionToken: "stale" });
    const api = await client(store);
    expect(api.raw.getRootHash()).rejects.toThrow(ResponseError);
  });

  test("doesn't refresh on other errors", async () => {
    const fetch = mockFetch(emptyResponse({ status: 500 }));
    const store = memStore({ deviceToken: "device", sessionToken: "session" });
    const api = await client(store);
    expect(api.raw.getRootHash()).rejects.toThrow(ResponseError);
    expect(fetch.mock.calls).toHaveLength(1);
  });

  test("forwards high level methods", async () => {
    mockFetch(
      jsonResponse({ hash, generation: 1, schemaVersion: 3 }),
      textResponse(`3\n${hash}:80000000:doc:4:3\n`),
    );
    const store = memStore({ deviceToken: "device", sessionToken: "session" });
    const api = await client(store);
    expect(await api.listIds()).toEqual([{ id: "doc", hash }]);
  });
});

describe("withGeneration()", () => {
  test("the first attempt doesn't refresh", async () => {
    const refreshes: boolean[] = [];
    const res = await withGeneration(
      3,
      (refresh) => {
        refreshes.push(refresh);
        return Promise.resolve("done");
      },
      instant,
    );
    expect(res).toBe("done");
    expect(refreshes).toEqual([false]);
  });

  test("retries with refresh", async () => {
    const refreshes: boolean[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const res = await withGeneration(
      3,
      (refresh) => {
        refreshes.push(refresh);
        if (++attempts < 3) {
          return Promise.reject(new GenerationError());
        }
        return Promise.resolve(attempts);
      },
      {
        backoff: (retry) => retry,
        sleep: (millis) => {
          delays.push(millis);
          return Promise.resolve();
        },
      },
    );
    expect(res).toBe(3);
    expect(refreshes).toEqual([false, true, true]);
    expect(delays).toEqual([0, 1]);
  });

  test("gives up after the retries are exhausted", async () => {
    let attempts = 0;
    const res = withGeneration(
      2,
      () => {
        ++attempts;
        return Promise.reject(new GenerationError());
      },
      instant,
    );
    await expect(res).rejects.toThrow(GenerationError);
    expect(attempts).toBe(3);
  });

  test("doesn't retry other errors", async () => {
    let attempts = 0;
    const res = withGeneration(
      5,
      () => {
        ++attempts;
        return Promise.reject(new Error("nope"));
      },
      instant,
    );
    await expect(res).rejects.toThrow("nope");
    expect(attempts).toBe(1);
  });

  test("defaults don't need injection", async () => {
    expect(await withGeneration(0, () => Promise.resolve(1))).toBe(1);
  });
});
