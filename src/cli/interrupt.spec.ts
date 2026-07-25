import { describe, expect, test } from "bun:test";
import type { RemarkableApi } from "../index.js";
import { interruptHandler } from "./interrupt.js";
import { captureDiagnostics } from "./test-utils.js";

/** an api whose only interesting behavior is its cache dump */
function fakeApi(dump: string = '{"hash":"text"}'): RemarkableApi {
  return { dumpCache: () => dump } as unknown as RemarkableApi;
}

/** a `writeCache` that records dumps, optionally never settling */
function writer({ hang = false }: { hang?: boolean } = {}): {
  dumps: string[];
  writeCache: (dump: string) => Promise<void>;
} {
  const dumps: string[] = [];
  return {
    dumps,
    writeCache(dump: string): Promise<void> {
      dumps.push(dump);
      return hang ? new Promise<void>(() => {}) : Promise.resolve();
    },
  };
}

describe("interruptHandler", () => {
  test("persists the cache and exits 130 on sigint", async () => {
    const { dumps, writeCache } = writer();
    const codes: number[] = [];
    const handler = interruptHandler({
      api: () => fakeApi(),
      cache: true,
      writeCache,
      exit: (code) => void codes.push(code),
    });
    handler("SIGINT");
    expect(dumps).toEqual(['{"hash":"text"}']);
    // the write is awaited before exiting
    expect(codes).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(codes).toEqual([130]);
  });

  test("exits 143 on sigterm", async () => {
    const { writeCache } = writer();
    const codes: number[] = [];
    interruptHandler({
      api: () => fakeApi(),
      cache: true,
      writeCache,
      exit: (code) => void codes.push(code),
    })("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(codes).toEqual([143]);
  });

  test("exits immediately when no api was built", () => {
    const { dumps, writeCache } = writer();
    const codes: number[] = [];
    interruptHandler({
      api: () => undefined,
      cache: true,
      writeCache,
      exit: (code) => void codes.push(code),
    })("SIGINT");
    expect(dumps).toEqual([]);
    expect(codes).toEqual([130]);
  });

  test("writes nothing when the cache is disabled", () => {
    const { dumps, writeCache } = writer();
    const codes: number[] = [];
    interruptHandler({
      api: () => fakeApi(),
      cache: false,
      writeCache,
      exit: (code) => void codes.push(code),
    })("SIGINT");
    expect(dumps).toEqual([]);
    expect(codes).toEqual([130]);
  });

  test("a second signal exits without waiting for the write", () => {
    const { dumps, writeCache } = writer({ hang: true });
    const codes: number[] = [];
    const handler = interruptHandler({
      api: () => fakeApi(),
      cache: true,
      writeCache,
      exit: (code) => void codes.push(code),
    });
    handler("SIGINT");
    expect(codes).toEqual([]);
    handler("SIGINT");
    expect(codes).toEqual([130]);
    // still only the one write, the second signal started nothing
    expect(dumps).toEqual(['{"hash":"text"}']);
  });

  test("exits even when persisting fails", async () => {
    const codes: number[] = [];
    interruptHandler({
      api: () => fakeApi(),
      cache: true,
      writeCache: () => Promise.reject(new Error("disk full")),
      exit: (code) => void codes.push(code),
    })("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(codes).toEqual([130]);
  });

  test("reports what it's doing under verbose", () => {
    const captured = captureDiagnostics({ verbose: true });
    const { writeCache } = writer({ hang: true });
    const handler = interruptHandler({
      api: () => fakeApi(),
      cache: true,
      writeCache,
      exit: () => {},
      diagnostic: captured.diagnostic,
    });
    handler("SIGINT");
    handler("SIGINT");
    expect(captured.messages).toEqual([
      "caught SIGINT, saving the hash cache before exiting",
      "caught a second SIGINT, exiting without saving",
    ]);
  });
});
