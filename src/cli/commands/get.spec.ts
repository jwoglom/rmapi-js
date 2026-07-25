import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry, RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { getCommands } from "./get.js";

const { get: getCommand } = getCommands;
const get: Command = getCommand!;

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const pdfHash = repHash("a1");
const epubHash = repHash("b2");
const noteHash = repHash("c3");

const entries: readonly Entry[] = [
  {
    id: "pdf-id",
    hash: pdfHash,
    visibleName: "paper",
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    type: "DocumentType",
    fileType: "pdf",
  },
  {
    id: "epub-id",
    hash: epubHash,
    visibleName: "novel.epub",
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    type: "DocumentType",
    fileType: "epub",
  },
  {
    id: "note-id",
    hash: noteHash,
    visibleName: "scratch",
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    type: "DocumentType",
    fileType: "notebook",
  },
  {
    id: "coll-id",
    hash: repHash("d4"),
    visibleName: "books",
    lastModified: "1700000000000",
    pinned: false,
    type: "CollectionType",
  },
];

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly (readonly string[])[];
}

function fakeApi(): FakeApi {
  const calls: string[][] = [];
  const api = {
    listItems(): Promise<Entry[]> {
      return Promise.resolve([...entries]);
    },
    getPdf(id: string, hash: string): Promise<Uint8Array> {
      calls.push(["getPdf", id, hash]);
      return Promise.resolve(bytes("pdf!"));
    },
    getEpub(id: string, hash: string): Promise<Uint8Array> {
      calls.push(["getEpub", id, hash]);
      return Promise.resolve(bytes("epub!"));
    },
    getDocument(id: string, hash: string): Promise<Uint8Array> {
      calls.push(["getDocument", id, hash]);
      return Promise.resolve(bytes("zip!"));
    },
  } as unknown as RemarkableApi;
  return { api, calls };
}

function args(
  positionals: readonly string[] = [],
  values: CommandArgs["values"] = {},
): CommandArgs {
  return { values, positionals };
}

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rmapi-get-"));
  return join(dir, name);
}

describe("get", () => {
  test("downloads the pdf source by default", async () => {
    const file = await tempFile("out.pdf");
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await get.run(
      testContext({ api, out: out.out }),
      args(["/paper"], { output: file }),
    );
    expect(calls).toEqual([["getPdf", "pdf-id", pdfHash]]);
    expect(await readFile(file, "utf8")).toBe("pdf!");
    expect(out.text()).toBe(`wrote 4 bytes to ${file}\n`);
  });

  test("downloads the epub source by default", async () => {
    const file = await tempFile("out.epub");
    const { api, calls } = fakeApi();
    await get.run(
      testContext({ api }),
      args(["/novel.epub"], { output: file }),
    );
    expect(calls).toEqual([["getEpub", "epub-id", epubHash]]);
    expect(await readFile(file, "utf8")).toBe("epub!");
  });

  test("--zip downloads the raw archive", async () => {
    const file = await tempFile("out.zip");
    const { api, calls } = fakeApi();
    await get.run(
      testContext({ api }),
      args(["/scratch"], { output: file, zip: true }),
    );
    expect(calls).toEqual([["getDocument", "note-id", noteHash]]);
    expect(await readFile(file, "utf8")).toBe("zip!");
  });

  test("--pdf overrides the file type", async () => {
    const file = await tempFile("out.pdf");
    const { api, calls } = fakeApi();
    await get.run(
      testContext({ api }),
      args(["/novel.epub"], { output: file, pdf: true }),
    );
    expect(calls).toEqual([["getPdf", "epub-id", epubHash]]);
  });

  test("refuses two kind flags at once", async () => {
    const { api } = fakeApi();
    expect(
      get.run(testContext({ api }), args(["/paper"], { pdf: true, zip: true })),
    ).rejects.toThrow(UsageError);
  });

  test("refuses a notebook without --zip", async () => {
    const { api } = fakeApi();
    expect(get.run(testContext({ api }), args(["/scratch"]))).rejects.toThrow(
      "--zip",
    );
  });

  test("refuses a collection", async () => {
    const { api } = fakeApi();
    expect(get.run(testContext({ api }), args(["/books"]))).rejects.toThrow(
      UsageError,
    );
  });

  test("throws for a missing target", async () => {
    const { api } = fakeApi();
    expect(get.run(testContext({ api }), args(["/nope"]))).rejects.toThrow(
      TargetNotFoundError,
    );
  });

  test("requires a target", async () => {
    const { api } = fakeApi();
    expect(get.run(testContext({ api }), args())).rejects.toThrow(UsageError);
  });

  test("refuses to overwrite an existing file", async () => {
    const file = await tempFile("out.pdf");
    await writeFile(file, "keep me");
    const { api, calls } = fakeApi();
    expect(
      get.run(testContext({ api }), args(["/paper"], { output: file })),
    ).rejects.toThrow(UsageError);
    // nothing was fetched and the file is untouched
    expect(calls).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("keep me");
  });

  test("overwrites with --yes", async () => {
    const file = await tempFile("out.pdf");
    await writeFile(file, "replace me");
    const { api } = fakeApi();
    await get.run(
      testContext({ api, yes: true }),
      args(["/paper"], { output: file }),
    );
    expect(await readFile(file, "utf8")).toBe("pdf!");
  });

  test("names the file after the document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rmapi-get-"));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const out = captureOutput();
      const { api } = fakeApi();
      await get.run(testContext({ api, out: out.out }), args(["/paper"]));
      expect(await readFile(join(dir, "paper.pdf"), "utf8")).toBe("pdf!");
      expect(out.text()).toContain("paper.pdf");
      // an extension already present isn't doubled
      await get.run(
        testContext({ api, out: out.out }),
        args(["/novel.epub"], { epub: true }),
      );
      expect(await readFile(join(dir, "novel.epub"), "utf8")).toBe("epub!");
    } finally {
      process.chdir(cwd);
    }
  });

  test("--json reports the path and size instead of bytes", async () => {
    const file = await tempFile("out.pdf");
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await get.run(
      testContext({ api, out: out.out }),
      args(["/paper"], { output: file }),
    );
    expect(out.json()).toEqual({ path: file, bytes: 4 });
  });

  test("-o - writes the bytes to stdout", async () => {
    const out = captureOutput({ json: true });
    const { api, calls } = fakeApi();
    // capture fd 1 so the bytes don't leak into the test runner's own output
    const written: [number, Uint8Array][] = [];
    const spy = spyOn(fs, "writeSync").mockImplementation(((
      fd: number,
      buf: Uint8Array,
    ) => {
      written.push([fd, buf]);
      return buf.length;
    }) as typeof fs.writeSync);
    try {
      await get.run(
        testContext({ api, out: out.out }),
        args(["/paper"], { output: "-" }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual([["getPdf", "pdf-id", pdfHash]]);
    expect(written).toEqual([[1, bytes("pdf!")]]);
    expect(out.json()).toEqual({ path: "-", bytes: 4 });
  });
});

/** the `includeContent` argument of every `listItems` call a run made */
async function contents(
  positionals: readonly string[],
  values: CommandArgs["values"] = {},
): Promise<(boolean | undefined)[]> {
  const { api } = fakeApi();
  const watched = watchListItems(api);
  const file = await tempFile("out.bin");
  await get.run(
    testContext({ api: watched.api, out: captureOutput().out }),
    args(positionals, { ...values, output: file }),
  );
  return watched.calls.map(({ includeContent }) => includeContent);
}

describe("get content", () => {
  test("inferring the file type needs content", async () => {
    expect(await contents(["paper"])).toEqual([true]);
  });

  test("an explicit kind stays on the fast path", async () => {
    expect(await contents(["paper"], { pdf: true })).toEqual([false]);
    expect(await contents(["novel.epub"], { epub: true })).toEqual([false]);
    expect(await contents(["scratch"], { zip: true })).toEqual([false]);
  });
});
