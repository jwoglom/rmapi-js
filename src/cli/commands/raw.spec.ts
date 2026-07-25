import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Content,
  Entries,
  Metadata,
  RawEntry,
  RemarkableApi,
} from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { UsageError } from "../error.js";
import { type Output, output } from "../format.js";
import { captureOutput, testContext } from "../test-utils.js";
import { rawCommands } from "./raw.js";

function command(name: string): Command {
  const cmd = rawCommands[name];
  if (cmd === undefined) {
    throw new Error(`no command ${name}`);
  }
  return cmd;
}

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const entryHash = repHash("ab");
const rootHash = repHash("11");
const newRootHash = repHash("22");

const metadata: Metadata = {
  lastModified: "1700000000000",
  parent: "",
  pinned: false,
  type: "DocumentType",
  visibleName: "a document",
};

const content: Content = { tags: [{ name: "tag", timestamp: 1 }] };

const entries: Entries = {
  entries: [
    {
      hash: repHash("33"),
      type: 0,
      id: "first-id",
      subfiles: 0,
      size: 12,
    },
    {
      hash: repHash("44"),
      type: 80000000,
      id: "second-id",
      subfiles: 2,
      size: 34,
    },
  ],
  id: "list-id",
  size: 46,
};

/** a fake low-level api that records what it was asked to do */
interface FakeApi {
  /** the api commands get */
  readonly api: RemarkableApi;
  /** every call, as `[method, ...args]` */
  readonly calls: readonly (readonly unknown[])[];
  /** every interesting event, in the order it happened */
  readonly events: readonly string[];
}

/**
 * a fake whose upload promises record when they settle
 *
 * The upload promise a `put*` method returns is the actual request, so a
 * command that doesn't await it can write its result before the upload lands,
 * or never at all. Every put test asserts `"upload settled"` comes before
 * `"output"`.
 */
function fakeApi(events: string[] = []): FakeApi {
  const calls: (readonly unknown[])[] = [];
  const entry: RawEntry = {
    id: "entry-id",
    hash: entryHash,
    type: 0,
    subfiles: 0,
    size: 3,
  };
  function put(
    method: string,
    ...args: unknown[]
  ): Promise<[RawEntry, Promise<void>]> {
    calls.push([method, ...args]);
    const upload = new Promise<void>((res) => {
      setTimeout(() => {
        events.push("upload settled");
        res();
      }, 1);
    });
    return Promise.resolve([entry, upload]);
  }
  const raw = {
    getRootHash(): Promise<[string, number, number]> {
      calls.push(["getRootHash"]);
      return Promise.resolve([rootHash, 7, 4]);
    },
    getHash(fileName: string, hash: string): Promise<Uint8Array> {
      calls.push(["getHash", fileName, hash]);
      return Promise.resolve(new TextEncoder().encode("hi"));
    },
    getText(fileName: string, hash: string): Promise<string> {
      calls.push(["getText", fileName, hash]);
      return Promise.resolve("some text");
    },
    getEntries(fileName: string, hash: string): Promise<Entries> {
      calls.push(["getEntries", fileName, hash]);
      return Promise.resolve(entries);
    },
    getContent(fileName: string, hash: string): Promise<Content> {
      calls.push(["getContent", fileName, hash]);
      return Promise.resolve(content);
    },
    getMetadata(fileName: string, hash: string): Promise<Metadata> {
      calls.push(["getMetadata", fileName, hash]);
      return Promise.resolve(metadata);
    },
    putRootHash(
      hash: string,
      generation: number,
      broadcast?: boolean,
    ): Promise<[string, number]> {
      calls.push(["putRootHash", hash, generation, broadcast]);
      return Promise.resolve([newRootHash, generation + 1]);
    },
    putFile(id: string, bytes: Uint8Array): Promise<[RawEntry, Promise<void>]> {
      return put("putFile", id, new TextDecoder().decode(bytes));
    },
    putText(id: string, text: string): Promise<[RawEntry, Promise<void>]> {
      return put("putText", id, text);
    },
    putContent(id: string, value: Content): Promise<[RawEntry, Promise<void>]> {
      return put("putContent", id, value);
    },
    putMetadata(
      id: string,
      value: Metadata,
    ): Promise<[RawEntry, Promise<void>]> {
      return put("putMetadata", id, value);
    },
    putEntries(
      id: string,
      value: readonly RawEntry[],
      schemaVersion: number,
    ): Promise<[RawEntry, Promise<void>]> {
      return put("putEntries", id, value, schemaVersion);
    },
    uploadFile(
      visibleName: string,
      bytes: Uint8Array,
      mime: string,
    ): Promise<{ id: string; hash: string }> {
      calls.push(["uploadFile", visibleName, bytes.length, mime]);
      return Promise.resolve({ id: "uploaded-id", hash: repHash("55") });
    },
  };
  return { api: { raw } as unknown as RemarkableApi, calls, events };
}

/** an output that records that it was written to, for ordering assertions */
function eventOutput(events: string[]): Output {
  return output(
    { json: false, color: false },
    () => void events.push("output"),
  );
}

function args(
  positionals: readonly string[] = [],
  values: CommandArgs["values"] = {},
): CommandArgs {
  return { values, positionals };
}

/** the flags that let a raw write run */
const allow = { yes: true };

async function tempFile(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rmapi-raw-"));
  const file = join(dir, name);
  await writeFile(file, contents);
  return file;
}

describe("raw get-root-hash", () => {
  test("reports the hash, generation, and schema version", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await command("raw get-root-hash").run(
      testContext({ api, out: out.out }),
      args(),
    );
    expect(out.json()).toEqual({
      hash: rootHash,
      generation: 7,
      schemaVersion: 4,
    });
  });

  test("rejects extra arguments", () => {
    const { api } = fakeApi();
    expect(
      command("raw get-root-hash").run(testContext({ api }), args(["extra"])),
    ).rejects.toThrow(UsageError);
  });
});

describe("raw get-hash", () => {
  test("prints the bytes base64 encoded", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await command("raw get-hash").run(
      testContext({ api, out: out.out }),
      args(["doc.pdf", rootHash]),
    );
    expect(calls).toEqual([["getHash", "doc.pdf", rootHash]]);
    expect(out.text().trim()).toBe(new TextEncoder().encode("hi").toBase64());
  });

  test("writes the bytes to a file", async () => {
    const out = captureOutput();
    const { api } = fakeApi();
    const dir = await mkdtemp(join(tmpdir(), "rmapi-raw-"));
    const file = join(dir, "out.bin");
    await command("raw get-hash").run(
      testContext({ api, out: out.out }),
      args(["doc.pdf", rootHash], { output: file }),
    );
    expect(await readFile(file, "utf8")).toBe("hi");
    expect(out.text()).toContain("wrote 2 bytes");
  });

  test("requires a file name and a hash", () => {
    const { api } = fakeApi();
    expect(
      command("raw get-hash").run(testContext({ api }), args()),
    ).rejects.toThrow("a file name is required");
    expect(
      command("raw get-hash").run(testContext({ api }), args(["doc.pdf"])),
    ).rejects.toThrow("a hash is required");
  });
});

describe("raw get-text", () => {
  test("prints the text", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await command("raw get-text").run(
      testContext({ api, out: out.out }),
      args(["doc.content", rootHash]),
    );
    expect(calls).toEqual([["getText", "doc.content", rootHash]]);
    expect(out.text()).toBe("some text\n");
  });
});

describe("raw get-entries", () => {
  test("renders the entries as aligned columns", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await command("raw get-entries").run(
      testContext({ api, out: out.out }),
      args(["root.docSchema", rootHash]),
    );
    expect(calls).toEqual([["getEntries", "root.docSchema", rootHash]]);
    const lines = out.text().trimEnd().split("\n");
    expect(lines[0]).toContain("hash");
    expect(lines[0]).toContain("subfiles");
    // the id column starts at the same offset on every row
    const [, first, second] = lines;
    expect(first?.indexOf("first-id")).toBe(second?.indexOf("second-id"));
    expect(lines[3]).toContain("# id list-id size 46");
  });

  test("emits the raw entries as json", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await command("raw get-entries").run(
      testContext({ api, out: out.out }),
      args(["root.docSchema", rootHash]),
    );
    expect(out.json()).toEqual(entries);
  });
});

describe("raw get-content", () => {
  test("prints the validated content", async () => {
    const out = captureOutput();
    const { api } = fakeApi();
    await command("raw get-content").run(
      testContext({ api, out: out.out }),
      args(["doc.content", rootHash]),
    );
    expect(JSON.parse(out.text()) as unknown).toEqual(content);
  });
});

describe("raw get-metadata", () => {
  test("prints the validated metadata", async () => {
    const out = captureOutput();
    const { api } = fakeApi();
    await command("raw get-metadata").run(
      testContext({ api, out: out.out }),
      args(["doc.metadata", rootHash]),
    );
    expect(JSON.parse(out.text()) as unknown).toEqual(metadata);
  });
});

describe("the raw write gate", () => {
  const writes: readonly [string, readonly string[]][] = [
    ["raw put-root-hash", [rootHash, "7"]],
    ["raw put-file", ["doc.pdf", "/nonexistent"]],
    ["raw put-text", ["doc.pagedata", "lines"]],
    ["raw put-content", ["doc.content", "{}"]],
    ["raw put-metadata", ["doc.metadata", "{}"]],
    ["raw put-entries", ["root", "[]", "4"]],
    ["raw upload-file", ["a doc", "-", "folder"]],
  ];

  for (const [name, positionals] of writes) {
    test(`${name} refuses without --yes`, async () => {
      const { api, calls } = fakeApi();
      const ctx = testContext({ api });
      expect(command(name).run(ctx, args(positionals))).rejects.toBeInstanceOf(
        UsageError,
      );
      expect(command(name).run(ctx, args(positionals))).rejects.toThrow(
        "RMAPI_ALLOW_RAW_WRITE=1",
      );
      // nothing was even attempted
      expect(calls).toEqual([]);
    });
  }

  test("passes with RMAPI_ALLOW_RAW_WRITE=1 instead of --yes", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    const ctx = testContext({
      api,
      out: out.out,
      env: { RMAPI_ALLOW_RAW_WRITE: "1" },
    });
    await command("raw put-text").run(ctx, args(["doc.pagedata", "lines"]));
    expect(calls).toEqual([["putText", "doc.pagedata", "lines"]]);
  });

  test("rejects any other value of RMAPI_ALLOW_RAW_WRITE", () => {
    const { api } = fakeApi();
    const ctx = testContext({ api, env: { RMAPI_ALLOW_RAW_WRITE: "yes" } });
    expect(
      command("raw put-text").run(ctx, args(["doc.pagedata", "lines"])),
    ).rejects.toThrow(UsageError);
  });
});

describe("raw put-root-hash", () => {
  test("reports the new hash and generation", async () => {
    const out = captureOutput({ json: true });
    const { api, calls } = fakeApi();
    await command("raw put-root-hash").run(
      testContext({ api, out: out.out, ...allow }),
      args([rootHash, "7"]),
    );
    expect(calls).toEqual([["putRootHash", rootHash, 7, true]]);
    expect(out.json()).toEqual({ hash: newRootHash, generation: 8 });
  });

  test("passes --no-broadcast through", async () => {
    const { api, calls } = fakeApi();
    await command("raw put-root-hash").run(
      testContext({ api, ...allow }),
      args([rootHash, "7"], { "no-broadcast": true }),
    );
    expect(calls).toEqual([["putRootHash", rootHash, 7, false]]);
  });

  test("requires a safe integer generation", async () => {
    const { api, calls } = fakeApi();
    const ctx = testContext({ api, ...allow });
    for (const generation of ["", "seven", "1.5", "1e30", "NaN"]) {
      expect(
        command("raw put-root-hash").run(ctx, args([rootHash, generation])),
      ).rejects.toThrow("must be a safe integer");
    }
    expect(
      command("raw put-root-hash").run(ctx, args([rootHash])),
    ).rejects.toThrow("a generation is required");
    expect(calls).toEqual([]);
  });
});

describe("raw put-file", () => {
  test("sends the bytes and waits for the upload", async () => {
    const events: string[] = [];
    const { api, calls } = fakeApi(events);
    const file = await tempFile("doc.pdf", "pdf bytes");
    const ctx = testContext({ api, out: eventOutput(events), ...allow });
    await command("raw put-file").run(ctx, args(["doc.pdf", file]));
    expect(calls).toEqual([["putFile", "doc.pdf", "pdf bytes"]]);
    // the upload is the request, so it has to land before we report success
    expect(events).toEqual(["upload settled", "output"]);
  });

  test("reports the entry", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    const file = await tempFile("doc.pdf", "pdf bytes");
    await command("raw put-file").run(
      testContext({ api, out: out.out, ...allow }),
      args(["doc.pdf", file]),
    );
    expect(out.json()).toEqual({
      entry: {
        id: "entry-id",
        hash: entryHash,
        type: 0,
        subfiles: 0,
        size: 3,
      },
      uploaded: true,
    });
  });
});

describe("raw put-text", () => {
  test("waits for the upload", async () => {
    const events: string[] = [];
    const { api, calls } = fakeApi(events);
    const ctx = testContext({ api, out: eventOutput(events), ...allow });
    await command("raw put-text").run(ctx, args(["doc.pagedata", "Blank\n"]));
    expect(calls).toEqual([["putText", "doc.pagedata", "Blank\n"]]);
    expect(events).toEqual(["upload settled", "output"]);
  });

  test("reads text from a file with @", async () => {
    const { api, calls } = fakeApi();
    const file = await tempFile("pagedata", "Blank\n");
    await command("raw put-text").run(
      testContext({ api, ...allow }),
      args(["doc.pagedata", `@${file}`]),
    );
    expect(calls).toEqual([["putText", "doc.pagedata", "Blank\n"]]);
  });

  test("reads text from stdin with -", async () => {
    const { api, calls } = fakeApi();
    await command("raw put-text").run(
      testContext({ api, stdin: "from stdin", ...allow }),
      args(["doc.pagedata", "-"]),
    );
    expect(calls).toEqual([["putText", "doc.pagedata", "from stdin"]]);
  });
});

describe("raw put-content", () => {
  test("parses inline json and waits for the upload", async () => {
    const events: string[] = [];
    const { api, calls } = fakeApi(events);
    const ctx = testContext({ api, out: eventOutput(events), ...allow });
    await command("raw put-content").run(
      ctx,
      args(["doc.content", '{"fileType":"pdf"}']),
    );
    expect(calls).toEqual([["putContent", "doc.content", { fileType: "pdf" }]]);
    expect(events).toEqual(["upload settled", "output"]);
  });

  test("reads json from stdin with -", async () => {
    const { api, calls } = fakeApi();
    await command("raw put-content").run(
      testContext({ api, stdin: '{"tags":[]}', ...allow }),
      args(["doc.content", "-"]),
    );
    expect(calls).toEqual([["putContent", "doc.content", { tags: [] }]]);
  });

  test("reads json from a file with @", async () => {
    const { api, calls } = fakeApi();
    const file = await tempFile("doc.content", '{"tags":[]}');
    await command("raw put-content").run(
      testContext({ api, ...allow }),
      args(["doc.content", `@${file}`]),
    );
    expect(calls).toEqual([["putContent", "doc.content", { tags: [] }]]);
  });

  test("passes objects through without validating them", async () => {
    const { api, calls } = fakeApi();
    await command("raw put-content").run(
      testContext({ api, ...allow }),
      args(["doc.content", '{"nonsense":true}']),
    );
    expect(calls).toEqual([["putContent", "doc.content", { nonsense: true }]]);
  });

  test("rejects malformed json", () => {
    const { api } = fakeApi();
    expect(
      command("raw put-content").run(
        testContext({ api, ...allow }),
        args(["doc.content", "{"]),
      ),
    ).rejects.toThrow("couldn't parse json");
  });
});

describe("raw put-metadata", () => {
  test("parses inline json and waits for the upload", async () => {
    const events: string[] = [];
    const { api, calls } = fakeApi(events);
    const ctx = testContext({ api, out: eventOutput(events), ...allow });
    await command("raw put-metadata").run(
      ctx,
      args(["doc.metadata", JSON.stringify(metadata)]),
    );
    expect(calls).toEqual([["putMetadata", "doc.metadata", metadata]]);
    expect(events).toEqual(["upload settled", "output"]);
  });
});

describe("raw put-entries", () => {
  test("parses the entries and waits for the upload", async () => {
    const events: string[] = [];
    const { api, calls } = fakeApi(events);
    const ctx = testContext({ api, out: eventOutput(events), ...allow });
    await command("raw put-entries").run(
      ctx,
      args(["root", JSON.stringify(entries.entries), "4"]),
    );
    expect(calls).toEqual([["putEntries", "root", entries.entries, 4]]);
    expect(events).toEqual(["upload settled", "output"]);
  });

  test("accepts schema version 3", async () => {
    const { api, calls } = fakeApi();
    await command("raw put-entries").run(
      testContext({ api, ...allow }),
      args(["some-id", "[]", "3"]),
    );
    expect(calls).toEqual([["putEntries", "some-id", [], 3]]);
  });

  test("rejects any other schema version", async () => {
    const { api, calls } = fakeApi();
    const ctx = testContext({ api, ...allow });
    for (const version of ["2", "5", "four", "4.0", ""]) {
      expect(
        command("raw put-entries").run(ctx, args(["root", "[]", version])),
      ).rejects.toThrow("schema version must be 3 or 4");
    }
    expect(
      command("raw put-entries").run(ctx, args(["root", "[]"])),
    ).rejects.toThrow("a schema version is required");
    expect(calls).toEqual([]);
  });

  test("rejects entries that aren't an array", () => {
    const { api } = fakeApi();
    expect(
      command("raw put-entries").run(
        testContext({ api, ...allow }),
        args(["root", "{}", "4"]),
      ),
    ).rejects.toThrow("must be a json array");
  });
});

describe("raw upload-file", () => {
  test("uploads the bytes of a file", async () => {
    const out = captureOutput({ json: true });
    const { api, calls } = fakeApi();
    const file = await tempFile("doc.pdf", "pdf bytes");
    await command("raw upload-file").run(
      testContext({ api, out: out.out, ...allow }),
      args(["a doc", file, "application/pdf"]),
    );
    expect(calls).toEqual([["uploadFile", "a doc", 9, "application/pdf"]]);
    expect(out.json()).toEqual({ id: "uploaded-id", hash: repHash("55") });
  });

  test("sends no bytes for a folder", async () => {
    const { api, calls } = fakeApi();
    await command("raw upload-file").run(
      testContext({ api, ...allow }),
      args(["a folder", "-", "folder"]),
    );
    expect(calls).toEqual([["uploadFile", "a folder", 0, "folder"]]);
  });

  test("rejects an unknown mime type", () => {
    const { api } = fakeApi();
    expect(
      command("raw upload-file").run(
        testContext({ api, ...allow }),
        args(["a doc", "-", "text/plain"]),
      ),
    ).rejects.toThrow("mime type must be one of");
  });
});

describe("rawCommands", () => {
  test("covers every method of the low-level api", () => {
    expect(Object.keys(rawCommands).sort()).toEqual([
      "raw get-content",
      "raw get-entries",
      "raw get-hash",
      "raw get-metadata",
      "raw get-root-hash",
      "raw get-text",
      "raw put-content",
      "raw put-entries",
      "raw put-file",
      "raw put-metadata",
      "raw put-root-hash",
      "raw put-text",
      "raw upload-file",
    ]);
  });

  test("warns about data loss in every command's help", () => {
    for (const cmd of Object.values(rawCommands)) {
      expect(cmd.details).toContain("data loss");
      expect(cmd.details).toContain("orphan");
    }
  });
});
