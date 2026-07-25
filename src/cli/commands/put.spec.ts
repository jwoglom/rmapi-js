import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Entry,
  GenerationError,
  type PutOptions,
  type RemarkableApi,
  type SimpleEntry,
} from "../../index.js";
import type { Command, CommandArgs } from "../args.js";
import { UsageError } from "../error.js";
import { captureOutput, testContext } from "../test-utils.js";
import { putCommands } from "./put.js";

const { put: putCommand } = putCommands;
const put: Command = putCommand!;

function collection(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: `hash-${id}`,
    visibleName,
    lastModified: "1700000000000",
    pinned: false,
    parent,
    type: "CollectionType",
  };
}

function document(id: string, visibleName: string, parent?: string): Entry {
  return {
    id,
    hash: `hash-${id}`,
    visibleName,
    lastModified: "1700000000000",
    lastOpened: "0",
    pinned: false,
    parent,
    type: "DocumentType",
    fileType: "pdf",
  };
}

const entries: readonly Entry[] = [
  collection("books-id", "books"),
  document("doc-id", "doc"),
];

/** one recorded api call */
interface Call {
  method: string;
  visibleName: string;
  size: number;
  opts: PutOptions | undefined;
}

interface FakeApi {
  readonly api: RemarkableApi;
  readonly calls: readonly Call[];
}

function fakeApi({
  items = entries,
  failures = 0,
}: {
  items?: readonly Entry[];
  failures?: number;
} = {}): FakeApi {
  const calls: Call[] = [];
  let left = failures;
  const result = (): Promise<SimpleEntry> =>
    Promise.resolve({ id: "new-id", hash: "new-hash" });
  const record = (
    method: string,
    visibleName: string,
    buffer: Uint8Array,
    opts?: PutOptions,
  ): Promise<SimpleEntry> => {
    calls.push({ method, visibleName, size: buffer.length, opts });
    if (left > 0) {
      left -= 1;
      return Promise.reject(new GenerationError());
    }
    return result();
  };
  const api = {
    listItems(): Promise<Entry[]> {
      return Promise.resolve([...items]);
    },
    putPdf(name: string, buffer: Uint8Array, opts?: PutOptions) {
      return record("putPdf", name, buffer, opts);
    },
    putEpub(name: string, buffer: Uint8Array, opts?: PutOptions) {
      return record("putEpub", name, buffer, opts);
    },
    uploadPdf(name: string, buffer: Uint8Array) {
      return record("uploadPdf", name, buffer);
    },
    uploadEpub(name: string, buffer: Uint8Array) {
      return record("uploadEpub", name, buffer);
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

let pdf = "";
let epub = "";
let unknown = "";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "rmapi-put-"));
  pdf = join(dir, "my doc.pdf");
  epub = join(dir, "book.EPUB");
  unknown = join(dir, "notes.txt");
  await writeFile(pdf, "pdf bytes");
  await writeFile(epub, "epub bytes");
  await writeFile(unknown, "who knows");
});

describe("put", () => {
  test("picks putPdf from the extension", async () => {
    const { api, calls } = fakeApi();
    const out = captureOutput();
    await put.run(testContext({ api, out: out.out }), args({}, [pdf]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("putPdf");
    // the visible name defaults to the basename without its extension
    expect(calls[0]?.visibleName).toBe("my doc");
    expect(calls[0]?.size).toBe(9);
    expect(calls[0]?.opts?.parent).toBe("");
    expect(out.text()).toContain("put 'my doc'");
  });

  test("picks putEpub from the extension, ignoring case", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({}, [epub]));
    expect(calls[0]?.method).toBe("putEpub");
    expect(calls[0]?.visibleName).toBe("book");
  });

  test("--type overrides the extension", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({ type: "epub" }, [pdf]));
    expect(calls[0]?.method).toBe("putEpub");
  });

  test("--name overrides the visible name", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({ name: "Renamed" }, [pdf]));
    expect(calls[0]?.visibleName).toBe("Renamed");
  });

  test("throws for an unknown extension", async () => {
    const { api } = fakeApi();
    expect(put.run(testContext({ api }), args({}, [unknown]))).rejects.toThrow(
      UsageError,
    );
  });

  test("throws for an unknown --type", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ type: "docx" }, [pdf])),
    ).rejects.toThrow("--type must be one of");
  });

  test("requires a file", async () => {
    const { api } = fakeApi();
    expect(put.run(testContext({ api }), args())).rejects.toThrow(UsageError);
  });

  test("rejects extra positionals", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({}, [pdf, "/", "extra"])),
    ).rejects.toThrow("unexpected argument 'extra'");
  });

  test("resolves a destination collection to a parent id", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({}, [pdf, "books"]));
    expect(calls[0]?.opts?.parent).toBe("books-id");
  });

  test("refuses a destination that isn't a collection", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({}, [pdf, "doc"])),
    ).rejects.toThrow("isn't a collection");
  });

  test("--parent conflicts with a destination", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ parent: "books-id" }, [pdf, "/"])),
    ).rejects.toThrow("pass either a destination or --parent");
  });

  test("passes put options through to the api", async () => {
    const { api, calls } = fakeApi();
    await put.run(
      testContext({ api }),
      args(
        {
          pinned: true,
          "cover-page-number": "-1",
          authors: ["Ada,Grace"],
          title: "A Title",
          "extra-metadata": ["pen=fineliner", "size=2"],
          "line-height": "150",
          margins: "125",
          orientation: "landscape",
          tags: ["one", "two,three"],
          "text-alignment": "left",
          "text-scale": "1.5",
          "zoom-mode": "customFit",
          "view-background-filter": "fullpage",
          "custom-zoom-scale": "2",
          "custom-zoom-center-x": "-10",
          "custom-zoom-center-y": "300",
          "custom-zoom-page-width": "1404",
          "custom-zoom-page-height": "1872",
          "custom-zoom-orientation": "portrait",
          publisher: "Nobody",
          "publication-date": "2020-01-01",
          "font-name": "EB Garamond",
        },
        [pdf],
      ),
    );
    expect(calls[0]?.opts).toEqual({
      parent: "",
      pinned: true,
      coverPageNumber: -1,
      authors: ["Ada", "Grace"],
      title: "A Title",
      publicationDate: "2020-01-01",
      publisher: "Nobody",
      extraMetadata: { pen: "fineliner", size: "2" },
      fontName: "EB Garamond",
      lineHeight: 150,
      margins: 125,
      orientation: "landscape",
      tags: ["one", "two", "three"],
      textAlignment: "left",
      textScale: 1.5,
      zoomMode: "customFit",
      viewBackgroundFilter: "fullpage",
      customZoomScale: 2,
      customZoomCenterX: -10,
      customZoomCenterY: 300,
      customZoomPageWidth: 1404,
      customZoomPageHeight: 1872,
      customZoomOrientation: "portrait",
      refresh: false,
    });
  });

  test("omits options that weren't given", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({ pinned: true }, [pdf]));
    expect(calls[0]?.opts).toEqual({
      parent: "",
      pinned: true,
      refresh: false,
    });
  });

  test("rejects a non-numeric number", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ "text-scale": "big" }, [pdf])),
    ).rejects.toThrow("--text-scale must be a number, but was 'big'");
  });

  test("rejects a fractional integer", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ margins: "1.5" }, [pdf])),
    ).rejects.toThrow("--margins must be an integer");
  });

  test("rejects an unknown enum value", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ orientation: "sideways" }, [pdf])),
    ).rejects.toThrow("--orientation must be one of");
  });

  test("rejects malformed extra metadata", async () => {
    const { api } = fakeApi();
    expect(
      put.run(
        testContext({ api }),
        args({ "extra-metadata": ["nope"] }, [pdf]),
      ),
    ).rejects.toThrow("--extra-metadata must be 'key=value'");
  });

  test("--simple uses the upload api", async () => {
    const { api, calls } = fakeApi();
    const out = captureOutput({ json: true });
    await put.run(
      testContext({ api, out: out.out }),
      args({ simple: true }, [pdf]),
    );
    expect(calls[0]?.method).toBe("uploadPdf");
    expect(calls[0]?.opts).toBeUndefined();
    expect(out.json()).toEqual({
      id: "new-id",
      hash: "new-hash",
      visibleName: "my doc",
      fileType: "pdf",
      parent: "",
      simple: true,
    });
  });

  test("--simple uses uploadEpub for epubs", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({ simple: true }, [epub]));
    expect(calls[0]?.method).toBe("uploadEpub");
  });

  test("--simple names the option it can't honor", async () => {
    const { api, calls } = fakeApi();
    expect(
      put.run(
        testContext({ api }),
        args({ simple: true, pinned: true }, [pdf]),
      ),
    ).rejects.toThrow("--simple can't honor --pinned");
    expect(calls).toHaveLength(0);
  });

  test("--simple rejects a nested destination", async () => {
    const { api } = fakeApi();
    expect(
      put.run(testContext({ api }), args({ simple: true }, [pdf, "books"])),
    ).rejects.toThrow("--simple can only put into the root");
  });

  test("--simple tolerates an explicit root destination", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api }), args({ simple: true }, [pdf, "/"]));
    expect(calls[0]?.method).toBe("uploadPdf");
  });

  test("retries a stale generation, refreshing only after the first try", async () => {
    const { api, calls } = fakeApi({ failures: 1 });
    await put.run(testContext({ api }), args({}, [pdf]));
    expect(calls.map((call) => call.opts?.refresh)).toEqual([false, true]);
  });

  test("gives up after the last retry", async () => {
    const { api, calls } = fakeApi({ failures: 3 });
    expect(
      put.run(testContext({ api, retries: 1 }), args({}, [pdf])),
    ).rejects.toThrow(GenerationError);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  test("honors the global --refresh on the first try", async () => {
    const { api, calls } = fakeApi();
    await put.run(testContext({ api, refresh: true }), args({}, [pdf]));
    expect(calls[0]?.opts?.refresh).toBe(true);
  });
});
