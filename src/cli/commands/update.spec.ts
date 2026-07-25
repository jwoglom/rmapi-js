import { describe, expect, test } from "bun:test";
import {
  type Entry,
  GenerationError,
  type HashEntry,
  type RemarkableApi,
} from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { UsageError } from "../error.js";
import { captureOutput, testContext } from "../test-utils.js";
import { parseSet, updateCommands } from "./update.js";

const { update: updateCommand } = updateCommands;
const update: Command = updateCommand!;

const doc: Entry = {
  id: "doc-id",
  hash: "hash-doc-id",
  visibleName: "doc",
  lastModified: "1700000000000",
  lastOpened: "0",
  pinned: false,
  type: "DocumentType",
  fileType: "pdf",
};

const folder: Entry = {
  id: "books-id",
  hash: "hash-books-id",
  visibleName: "books",
  lastModified: "1700000000000",
  pinned: false,
  type: "CollectionType",
};

const template: Entry = {
  id: "tmpl-id",
  hash: "hash-tmpl-id",
  visibleName: "grid",
  lastModified: "1700000000000",
  pinned: false,
  type: "TemplateType",
};

/** one recorded update call */
interface Call {
  method: string;
  hash: string;
  content: unknown;
  refresh: boolean | undefined;
}

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly Call[];
}

function fakeApi({
  items = [doc, folder, template],
  failures = 0,
}: {
  items?: readonly Entry[];
  failures?: number;
} = {}): FakeApi {
  const calls: Call[] = [];
  let left = failures;
  const record = (
    method: string,
    hash: string,
    content: unknown,
    refresh: boolean | undefined,
  ): Promise<HashEntry> => {
    calls.push({ method, hash, content, refresh });
    if (left > 0) {
      left -= 1;
      return Promise.reject(new GenerationError());
    }
    return Promise.resolve({ hash: "new-hash" });
  };
  const api = {
    listItems(): Promise<Entry[]> {
      return Promise.resolve([...items]);
    },
    updateDocument(hash: string, content: unknown, refresh?: boolean) {
      return record("updateDocument", hash, content, refresh);
    },
    updateCollection(hash: string, content: unknown, refresh?: boolean) {
      return record("updateCollection", hash, content, refresh);
    },
    updateTemplate(hash: string, content: unknown, refresh?: boolean) {
      return record("updateTemplate", hash, content, refresh);
    },
  } as unknown as RemarkableApi;
  return { api, calls };
}

function args(
  values: CommandArgs["values"] = {},
  positionals: readonly string[] = [],
): CommandArgs {
  return { values, positionals };
}

describe("parseSet()", () => {
  test("coerces booleans, numbers, and strings", () => {
    expect(parseSet("dummyDocument=true")).toEqual({
      key: "dummyDocument",
      value: true,
    });
    expect(parseSet("dummyDocument=false")).toEqual({
      key: "dummyDocument",
      value: false,
    });
    expect(parseSet("textScale=1.5")).toEqual({ key: "textScale", value: 1.5 });
    expect(parseSet("coverPageNumber=-1")).toEqual({
      key: "coverPageNumber",
      value: -1,
    });
    expect(parseSet("fontName=EB Garamond")).toEqual({
      key: "fontName",
      value: "EB Garamond",
    });
    // values that only look numeric stay strings
    expect(parseSet("templateVersion=1.0.0")).toEqual({
      key: "templateVersion",
      value: "1.0.0",
    });
  });

  test("coerces list valued keys", () => {
    expect(parseSet("labels=one, two")).toEqual({
      key: "labels",
      value: ["one", "two"],
    });
    expect(parseSet("labels=only")).toEqual({ key: "labels", value: ["only"] });
  });

  test("keeps everything after the first equals", () => {
    expect(parseSet("title=a=b")).toEqual({ key: "title", value: "a=b" });
  });

  test("throws without a key", () => {
    expect(() => parseSet("nope")).toThrow(UsageError);
    expect(() => parseSet("=value")).toThrow(UsageError);
  });
});

describe("update", () => {
  test("dispatches on the item type", async () => {
    for (const [target, method, hash] of [
      ["doc", "updateDocument", "hash-doc-id"],
      ["books", "updateCollection", "hash-books-id"],
      ["grid", "updateTemplate", "hash-tmpl-id"],
    ] as const) {
      const { api, calls } = fakeApi();
      await update.run(
        testContext({ api }),
        args({ set: ["textScale=1"] }, [target]),
      );
      expect(calls[0]?.method).toBe(method);
      // mutations take the entry's hash, never its id
      expect(calls[0]?.hash).toBe(hash);
    }
  });

  test("--type overrides the item type", async () => {
    const { api, calls } = fakeApi();
    await update.run(
      testContext({ api }),
      args({ set: ["tags=one"], type: "collection" }, ["doc"]),
    );
    expect(calls[0]?.method).toBe("updateCollection");
  });

  test("rejects an unknown --type", async () => {
    const { api } = fakeApi();
    expect(
      update.run(
        testContext({ api }),
        args({ set: ["tags=one"], type: "folder" }, ["doc"]),
      ),
    ).rejects.toThrow("--type must be one of");
  });

  test("merges repeated --set flags", async () => {
    const { api, calls } = fakeApi();
    await update.run(
      testContext({ api }),
      args({ set: ["textScale=2", "fontName=Noto Mono", "margins=100"] }, [
        "doc",
      ]),
    );
    expect(calls[0]?.content).toEqual({
      textScale: 2,
      fontName: "Noto Mono",
      margins: 100,
    });
  });

  test("requires a target", async () => {
    const { api } = fakeApi();
    expect(
      update.run(testContext({ api }), args({ set: ["textScale=1"] })),
    ).rejects.toThrow(UsageError);
  });

  test("rejects extra positionals", async () => {
    const { api } = fakeApi();
    expect(
      update.run(
        testContext({ api }),
        args({ set: ["textScale=1"] }, ["doc", "extra"]),
      ),
    ).rejects.toThrow("unexpected argument 'extra'");
  });

  test("requires at least one --set", async () => {
    const { api, calls } = fakeApi();
    expect(update.run(testContext({ api }), args({}, ["doc"]))).rejects.toThrow(
      "at least one --set",
    );
    expect(calls).toHaveLength(0);
  });

  test("reports what it wrote as json", async () => {
    const { api } = fakeApi();
    const out = captureOutput({ json: true });
    await update.run(
      testContext({ api, out: out.out }),
      args({ set: ["textScale=1"] }, ["doc"]),
    );
    expect(out.json()).toEqual({
      id: "doc-id",
      visibleName: "doc",
      kind: "document",
      hash: "hash-doc-id",
      newHash: "new-hash",
      set: { textScale: 1 },
    });
  });

  test("reports what it wrote as text", async () => {
    const { api } = fakeApi();
    const out = captureOutput();
    await update.run(
      testContext({ api, out: out.out }),
      args({ set: ["textScale=1"] }, ["doc"]),
    );
    expect(out.text()).toBe("updated document 'doc' (textScale)\n");
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await update.run(
      testContext({ api }),
      args({ set: ["textScale=1"] }, ["doc"]),
    );
    expect(calls.map((call) => call.refresh)).toEqual([false, true]);
  });

  test("honors the global --refresh on the first try", async () => {
    const { api, calls } = fakeApi();
    await update.run(
      testContext({ api, refresh: true }),
      args({ set: ["textScale=1"] }, ["doc"]),
    );
    expect(calls[0]?.refresh).toBe(true);
  });
});
