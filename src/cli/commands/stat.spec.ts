import { describe, expect, test } from "bun:test";
import type { Content, Entry, Metadata, RemarkableApi } from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { captureOutput, testContext, watchListItems } from "../test-utils.js";
import { statCommands } from "./stat.js";

const {
  stat: statCommand,
  meta: metaCommand,
  content: contentCommand,
} = statCommands;
const stat: Command = statCommand!;
const meta: Command = metaCommand!;
const content: Command = contentCommand!;

/** a 64 character hash built by repeating a short string */
function repHash(hash: string): string {
  return new Array(64 / hash.length).fill(hash).join("");
}

const bookHash = repHash("ab");
const noteHash = repHash("cd");

const entries: readonly Entry[] = [
  {
    id: "books-id",
    hash: bookHash,
    visibleName: "books",
    lastModified: "1700000000000",
    pinned: false,
    type: "CollectionType",
  },
  {
    id: "note-id",
    hash: noteHash,
    visibleName: "notes",
    lastModified: "1700000000000",
    lastOpened: "1700000600000",
    pinned: true,
    parent: "books-id",
    type: "DocumentType",
    fileType: "pdf",
    tags: [{ name: "work", timestamp: 5 }],
  },
];

const metadata: Metadata = {
  visibleName: "notes",
  createdTime: "1600000000000",
  lastModified: "1700000000000",
  lastOpened: "1700000600000",
  parent: "books-id",
  pinned: true,
  type: "DocumentType",
};

const docContent = {
  coverPageNumber: 0,
  documentMetadata: {},
  extraMetadata: {},
  fileType: "pdf",
  fontName: "",
  lineHeight: 100,
  orientation: "portrait",
  pageCount: 3,
  textAlignment: "left",
  textScale: 1,
  tags: [{ name: "work", timestamp: 5 }],
} as unknown as Content;

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly (readonly string[])[];
}

function fakeApi(items: readonly Entry[] = entries): FakeApi {
  const calls: string[][] = [];
  const api = {
    listItems(): Promise<Entry[]> {
      return Promise.resolve([...items]);
    },
    getMetadata(id: string, hash: string): Promise<Metadata> {
      calls.push(["getMetadata", id, hash]);
      return Promise.resolve(metadata);
    },
    getContent(id: string, hash: string): Promise<Content> {
      calls.push(["getContent", id, hash]);
      return Promise.resolve(docContent);
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

describe("meta", () => {
  test("renders the metadata as key values", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await meta.run(testContext({ api, out: out.out }), args(["/books/notes"]));
    expect(calls).toEqual([["getMetadata", "note-id", noteHash]]);
    const text = out.text();
    expect(text).toContain("parent:");
    expect(text).toContain("books-id");
    expect(text).toContain("type:");
  });

  test("--json emits the metadata verbatim", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await meta.run(testContext({ api, out: out.out }), args(["/books/notes"]));
    expect(out.json()).toEqual(metadata);
  });

  test("requires a target", async () => {
    const { api } = fakeApi();
    expect(meta.run(testContext({ api }), args())).rejects.toThrow(UsageError);
  });

  test("rejects extra arguments", async () => {
    const { api } = fakeApi();
    expect(
      meta.run(testContext({ api }), args(["/books", "extra"])),
    ).rejects.toThrow("unexpected argument 'extra'");
  });

  test("throws for a missing target", async () => {
    const { api } = fakeApi();
    expect(meta.run(testContext({ api }), args(["/nope"]))).rejects.toThrow(
      TargetNotFoundError,
    );
  });

  test("refuses the synthetic root and trash", async () => {
    const { api } = fakeApi();
    expect(meta.run(testContext({ api }), args(["/"]))).rejects.toThrow(
      UsageError,
    );
    expect(meta.run(testContext({ api }), args(["/trash"]))).rejects.toThrow(
      UsageError,
    );
  });
});

describe("content", () => {
  test("renders the content as json", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await content.run(testContext({ api, out: out.out }), args(["id:note-id"]));
    expect(calls).toEqual([["getContent", "note-id", noteHash]]);
    expect(JSON.parse(out.text()) as unknown).toEqual(docContent);
  });

  test("--json emits the content verbatim", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await content.run(testContext({ api, out: out.out }), args(["id:note-id"]));
    expect(out.json()).toEqual(docContent);
  });
});

describe("stat", () => {
  test("fetches both and renders a summary", async () => {
    const out = captureOutput();
    const { api, calls } = fakeApi();
    await stat.run(testContext({ api, out: out.out }), args(["/books/notes"]));
    expect(calls).toHaveLength(2);
    expect(calls.map(([name]) => name).sort()).toEqual([
      "getContent",
      "getMetadata",
    ]);
    const text = out.text();
    expect(text).toContain("/books/notes");
    expect(text).toContain("DocumentType");
    expect(text).toContain("pdf");
    expect(text).toContain("yes");
    expect(text).toContain("2023-11-14T");
    expect(text).toContain("work");
    expect(text).toContain("note-id");
    expect(text).toContain(noteHash);
  });

  test("says when there are no tags", async () => {
    const out = captureOutput();
    const { api } = fakeApi();
    await stat.run(testContext({ api, out: out.out }), args(["/books"]));
    expect(out.text()).toContain("none");
  });

  test("--json emits the entry, metadata, and content", async () => {
    const out = captureOutput({ json: true });
    const { api } = fakeApi();
    await stat.run(testContext({ api, out: out.out }), args(["/books/notes"]));
    expect(out.json()).toEqual({
      entry: entries[1],
      metadata,
      content: docContent,
    });
  });

  test("throws for a missing target", async () => {
    const { api } = fakeApi();
    expect(stat.run(testContext({ api }), args(["/nope"]))).rejects.toThrow(
      TargetNotFoundError,
    );
  });
});

/** the `includeContent` argument of every `listItems` call a run made */
async function contents(
  cmd: Command,
  positionals: readonly string[] = ["/books/notes"],
): Promise<(boolean | undefined)[]> {
  const { api } = fakeApi();
  const watched = watchListItems(api);
  await cmd.run(
    testContext({ api: watched.api, out: captureOutput().out }),
    args(positionals),
  );
  return watched.calls.map(({ includeContent }) => includeContent);
}

describe("stat content", () => {
  test("meta resolves its target without any content", async () => {
    expect(await contents(meta)).toEqual([false]);
  });

  test("content fetches only its own target's content", async () => {
    expect(await contents(content)).toEqual([false]);
  });

  test("stat lists content, for the entry's tags", async () => {
    expect(await contents(stat)).toEqual([true]);
  });
});
