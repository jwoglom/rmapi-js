import { describe, expect, test } from "bun:test";
import type {
  Content,
  Metadata,
  RawRemarkableApi,
  RemarkableApi,
  SimpleEntry,
} from "../index.js";
import { warmItems } from "./warm.js";

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const metadata: Metadata = {
  type: "DocumentType",
  visibleName: "doc",
  parent: "",
  lastModified: "1700000000000",
  pinned: false,
};

const content = { fileType: "pdf" } as unknown as Content;

/** an api that serves fake entry lists and records every raw call */
interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly string[];
  readonly inFlight: () => number;
}

function fakeApi({
  metadataless = new Set<string>(),
}: {
  metadataless?: ReadonlySet<string>;
} = {}): FakeApi {
  const calls: string[] = [];
  let live = 0;
  let peak = 0;
  const settle = async <T>(value: T): Promise<T> => {
    ++live;
    peak = Math.max(peak, live);
    await Promise.resolve();
    --live;
    return value;
  };
  const raw = {
    getEntries(fileName: string, hash: string) {
      calls.push(`getEntries ${fileName}`);
      const id = fileName.replace(/\.docSchema$/, "");
      const entries = metadataless.has(id)
        ? []
        : [
            { id: `${id}.metadata`, hash, type: "0", size: 1, subfiles: 0 },
            { id: `${id}.content`, hash, type: "0", size: 1, subfiles: 0 },
          ];
      return settle({ entries });
    },
    getMetadata(fileName: string) {
      calls.push(`getMetadata ${fileName}`);
      return settle(metadata);
    },
    getContent(fileName: string) {
      calls.push(`getContent ${fileName}`);
      return settle(content);
    },
  } as unknown as RawRemarkableApi;
  return {
    api: { raw } as unknown as RemarkableApi,
    calls,
    inFlight: () => peak,
  };
}

function ids(count: number): SimpleEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${String(i)}`,
    hash: repHash((i + 1).toString(16).padStart(4, "0")),
  }));
}

describe("warmItems", () => {
  test("fetches entries and metadata, but no content by default", async () => {
    const { api, calls } = fakeApi();
    const result = await warmItems(api, ids(2));
    expect(result).toEqual({ items: 2, rawCalls: 4 });
    expect(calls).toEqual([
      "getEntries item-0.docSchema",
      "getEntries item-1.docSchema",
      "getMetadata item-0.metadata",
      "getMetadata item-1.metadata",
    ]);
  });

  test("fetches content when asked", async () => {
    const { api, calls } = fakeApi();
    const result = await warmItems(api, ids(2), { content: true });
    expect(result).toEqual({ items: 2, rawCalls: 6 });
    expect(calls.filter((call) => call.startsWith("getContent"))).toEqual([
      "getContent item-0.content",
      "getContent item-1.content",
    ]);
  });

  test("skips items whose entry list has no metadata", async () => {
    const { api, calls } = fakeApi({ metadataless: new Set(["item-0"]) });
    const result = await warmItems(api, ids(2));
    expect(result).toEqual({ items: 2, rawCalls: 3 });
    expect(calls).not.toContain("getMetadata item-0.metadata");
  });

  test("bounds how many items are in flight", async () => {
    const { api, inFlight } = fakeApi();
    await warmItems(api, ids(50), { limit: 4 });
    expect(inFlight()).toBeLessThanOrEqual(4);
  });

  test("reports progress every so many items, and at the end", async () => {
    const { api } = fakeApi();
    const seen: string[] = [];
    await warmItems(api, ids(25), {
      every: 10,
      progress: (done, total) =>
        void seen.push(`${String(done)}/${String(total)}`),
    });
    expect(seen).toEqual(["10/25", "20/25", "25/25"]);
  });

  test("does nothing for no items", async () => {
    const { api, calls } = fakeApi();
    expect(await warmItems(api, [])).toEqual({ items: 0, rawCalls: 0 });
    expect(calls).toEqual([]);
  });
});
