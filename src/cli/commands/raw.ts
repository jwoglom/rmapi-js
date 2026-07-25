/**
 * direct access to the low-level reMarkable api
 *
 * Every command here maps one-to-one onto a method of
 * {@link RawRemarkableApi | `RawRemarkableApi`}, with no convenience logic in
 * between. Reads are safe, writes are not: see {@link rawDetails |
 * `rawDetails`}.
 */
import { readFile, writeFile } from "node:fs/promises";
import type {
  Content,
  Entries,
  Metadata,
  RawEntry,
  SchemaVersion,
  UploadMimeType,
} from "../../index.js";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { UsageError } from "../error.js";
import { columns, type Output } from "../format.js";

/**
 * the warning appended to the help of every `raw` command
 *
 * The `raw` commands are the only ones that can leave an account in a state the
 * reMarkable apps can't recover from, so this says so in as many words.
 */
export const rawDetails =
  "These commands manipulate reMarkable's cloud storage directly and can cause\ndata loss. Nothing is checked against the rest of your account: a bad write\ncan leave documents unreadable, and 'raw put-root-hash' in particular can\norphan your entire file tree, making every document disappear. Save the\ncurrent root hash with 'rmapi raw get-root-hash' before writing anything, so\nyou can restore the previous snapshot.\n\nEvery write refuses to run unless you pass --yes or set RMAPI_ALLOW_RAW_WRITE=1.";

function details(extra?: string): string {
  return extra === undefined ? rawDetails : `${extra}\n\n${rawDetails}`;
}

/**
 * refuse to run a write without an explicit opt in
 *
 * @param ctx - the context whose `yes` flag and environment are consulted
 * @param command - the full command name, for the error message
 * @throws UsageError unless `--yes` was passed or `RMAPI_ALLOW_RAW_WRITE` is
 *     `"1"`
 */
export function assertRawWriteAllowed(ctx: Context, command: string): void {
  const { RMAPI_ALLOW_RAW_WRITE: allowed } = ctx.env;
  if (ctx.yes || allowed === "1") {
    return;
  }
  throw new UsageError(
    `'${command}' writes directly to reMarkable's cloud storage, which can cause data loss, including orphaning your entire file tree; pass --yes or set RMAPI_ALLOW_RAW_WRITE=1 to confirm you understand the risk`,
    command,
  );
}

function positional(
  positionals: readonly string[],
  index: number,
  name: string,
  command: string,
): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new UsageError(`${name} is required`, command);
  }
  return value;
}

/** the `(fileName, hash)` pair every read takes */
function readTarget(
  positionals: readonly string[],
  command: string,
): [string, string] {
  const fileName = positional(positionals, 0, "a file name", command);
  const hash = positional(positionals, 1, "a hash", command);
  noExtra(positionals, 2, command);
  return [fileName, hash];
}

/**
 * resolve a text argument
 *
 * `-` reads stdin, `@<file>` reads that file, and anything else is used
 * verbatim.
 *
 * @param ctx - the context, for stdin
 * @param spec - the argument as given on the command line
 */
async function textArg(ctx: Context, spec: string): Promise<string> {
  if (spec === "-") {
    return await ctx.stdin();
  } else if (spec.startsWith("@")) {
    return await readFile(spec.slice(1), "utf8");
  } else {
    return spec;
  }
}

/**
 * resolve a json argument
 *
 * The parsed value is passed to reMarkable as-is; we don't validate its shape.
 *
 * @param ctx - the context, for stdin
 * @param spec - `-`, `@<file>`, or inline json
 * @param command - the full command name, for error messages
 * @throws UsageError if the json doesn't parse
 */
async function jsonArg(
  ctx: Context,
  spec: string,
  command: string,
): Promise<unknown> {
  const text = await textArg(ctx, spec);
  try {
    return JSON.parse(text) as unknown;
  } catch (ex) {
    const message = ex instanceof Error ? ex.message : String(ex);
    throw new UsageError(`couldn't parse json: ${message}`, command);
  }
}

/** the shape every `put*` command reports */
interface PutResult {
  /** the entry reMarkable will know the uploaded file by */
  entry: RawEntry;
  /** always true; the upload finished before this was written */
  uploaded: boolean;
}

function renderEntry(entry: RawEntry): string {
  return columns([
    ["hash", entry.hash],
    ["id", entry.id],
    ["type", String(entry.type)],
    ["subfiles", String(entry.subfiles)],
    ["size", String(entry.size)],
  ]);
}

/**
 * finish a `put*` call and report the resulting entry
 *
 * The upload promise every `raw put*` method returns *is* the request; if it
 * isn't awaited the process can exit with the write unsent, silently and
 * without an error.
 *
 * @param ctx - the context to write the result to
 * @param put - the pending `[entry, upload]` pair
 */
async function finishPut(
  ctx: Context,
  put: Promise<[RawEntry, Promise<void>]>,
): Promise<void> {
  const [entry, upload] = await put;
  // NOTE this await is load bearing; upload is the actual request
  await upload;
  const result: PutResult = { entry, uploaded: true };
  ctx.out.write(result, ({ entry: ent }) => renderEntry(ent));
}

/** the root hash, as reported by `raw get-root-hash` */
interface RootHashResult {
  /** the current root hash */
  hash: string;
  /** the generation to pass to `raw put-root-hash` */
  generation: number;
  /** the schema version the account reports */
  schemaVersion: SchemaVersion;
}

const getRootHashCommand: Command = {
  summary: "print the current root hash, generation, and schema version",
  usage: "",
  options: {},
  details: details(
    "Save this before any raw write; it is the snapshot you can restore to.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "raw get-root-hash");
    const api = await ctx.api();
    const [hash, generation, schemaVersion] = await api.raw.getRootHash();
    const result: RootHashResult = { hash, generation, schemaVersion };
    ctx.out.write(result, (val) =>
      columns([
        ["hash", val.hash],
        ["generation", String(val.generation)],
        ["schemaVersion", String(val.schemaVersion)],
      ]),
    );
  },
};

/** the bytes of a file, as reported by `raw get-hash` */
interface HashResult {
  /** the file name the bytes were requested with */
  fileName: string;
  /** the hash the bytes were requested with */
  hash: string;
  /** how many bytes were fetched */
  size: number;
  /** the bytes, base64 encoded, or undefined when written to a file */
  base64?: string;
  /** the file the bytes were written to, if any */
  output?: string;
}

const getHashCommand: Command = {
  summary: "fetch the raw bytes of a hash",
  usage: "<file-name> <hash>",
  options: { output: { type: "string", short: "o" } },
  descriptions: { output: "write the bytes to this file instead of stdout" },
  details: details(
    "The file name is the logical name of the file, `<id>.<ext>` for files, or\n`<id>.docSchema` / `root.docSchema` for entry indexes; reMarkable validates\nit against the hash. Without --output the bytes are printed base64 encoded,\nsince they may not be text.",
  ),
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    const [fileName, hash] = readTarget(positionals, "raw get-hash");
    const output = stringFlag(values, "output");
    const api = await ctx.api();
    const bytes = await api.raw.getHash(fileName, hash);
    if (output === undefined) {
      const result: HashResult = {
        fileName,
        hash,
        size: bytes.length,
        base64: bytes.toBase64(),
      };
      ctx.out.write(result, (val) => val.base64 ?? "");
    } else {
      await writeFile(output, bytes);
      const result: HashResult = { fileName, hash, size: bytes.length, output };
      ctx.out.write(
        result,
        (val) => `wrote ${val.size} bytes to ${val.output}`,
      );
    }
  },
};

/** the text of a file, as reported by `raw get-text` */
interface TextResult {
  /** the file name the text was requested with */
  fileName: string;
  /** the hash the text was requested with */
  hash: string;
  /** the full text */
  text: string;
}

const getTextCommand: Command = {
  summary: "fetch the text of a hash",
  usage: "<file-name> <hash>",
  options: {},
  details: details(
    "This caches the entire text, so only use it for files you know are small.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [fileName, hash] = readTarget(positionals, "raw get-text");
    const api = await ctx.api();
    const text = await api.raw.getText(fileName, hash);
    const result: TextResult = { fileName, hash, text };
    ctx.out.write(result, (val) => val.text);
  },
};

function renderEntries(entries: Entries, out: Output): string {
  const rows: string[][] = [
    ["hash", "type", "id", "subfiles", "size"].map((cell) =>
      out.style.dim(cell),
    ),
  ];
  for (const entry of entries.entries) {
    rows.push([
      entry.hash,
      String(entry.type),
      entry.id,
      String(entry.subfiles),
      String(entry.size),
    ]);
  }
  const lines = [columns(rows)];
  if (entries.id !== undefined) {
    lines.push(
      out.style.dim(`# id ${entries.id} size ${String(entries.size ?? 0)}`),
    );
  }
  return lines.join("\n");
}

const getEntriesCommand: Command = {
  summary: "list the entries of a list hash",
  usage: "<file-name> <hash>",
  options: {},
  details: details(
    "Pass `root.docSchema` and the root hash for the top level list, or\n`<id>.docSchema` and an item's hash for that item's files. Schema 4 lists\nalso carry an id and a recursive size, printed as a trailing comment.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [fileName, hash] = readTarget(positionals, "raw get-entries");
    const api = await ctx.api();
    const entries = await api.raw.getEntries(fileName, hash);
    ctx.out.write(entries, (val) => renderEntries(val, ctx.out));
  },
};

const getContentCommand: Command = {
  summary: "fetch and validate a content file",
  usage: "<file-name> <hash>",
  options: {},
  details: details(
    "The result is validated against the known content schemas; use\n'raw get-text' to see a file this rejects.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [fileName, hash] = readTarget(positionals, "raw get-content");
    const api = await ctx.api();
    const content = await api.raw.getContent(fileName, hash);
    ctx.out.write(content, (val) => JSON.stringify(val, null, 2));
  },
};

const getMetadataCommand: Command = {
  summary: "fetch and validate a metadata file",
  usage: "<file-name> <hash>",
  options: {},
  details: details(
    "The result is validated against the metadata schema; use 'raw get-text' to\nsee a file this rejects.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [fileName, hash] = readTarget(positionals, "raw get-metadata");
    const api = await ctx.api();
    const metadata = await api.raw.getMetadata(fileName, hash);
    ctx.out.write(metadata, (val) => JSON.stringify(val, null, 2));
  },
};

/** the new root, as reported by `raw put-root-hash` */
interface PutRootHashResult {
  /** the new root hash */
  hash: string;
  /** the new generation */
  generation: number;
}

const putRootHashCommand: Command = {
  summary: "point the account at a new root hash",
  usage: "<hash> <generation>",
  options: { "no-broadcast": { type: "boolean" } },
  descriptions: { "no-broadcast": "don't ask reMarkable to notify devices" },
  details: details(
    "The generation must be the one 'raw get-root-hash' just reported; if the\nserver has moved on this fails rather than clobbering someone else's write.\nThis is the single most dangerous command in the cli: a root hash that\ndoesn't cover your items orphans every document.",
  ),
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    const command = "raw put-root-hash";
    assertRawWriteAllowed(ctx, command);
    const hash = positional(positionals, 0, "a root hash", command);
    const rawGeneration = positional(positionals, 1, "a generation", command);
    noExtra(positionals, 2, command);
    const generation = Number(rawGeneration);
    if (!/^-?\d+$/.test(rawGeneration) || !Number.isSafeInteger(generation)) {
      throw new UsageError(
        `the generation must be a safe integer, but was '${rawGeneration}'`,
        command,
      );
    }
    const api = await ctx.api();
    const [newHash, newGeneration] = await api.raw.putRootHash(
      hash,
      generation,
      !boolFlag(values, "no-broadcast"),
    );
    const result: PutRootHashResult = {
      hash: newHash,
      generation: newGeneration,
    };
    ctx.out.write(result, (val) =>
      columns([
        ["hash", val.hash],
        ["generation", String(val.generation)],
      ]),
    );
  },
};

const putFileCommand: Command = {
  summary: "upload the bytes of a file",
  usage: "<id> <path>",
  options: {},
  details: details(
    "The id is the logical file name, e.g. `<uuid>.pdf`. This only stores the\nbytes; nothing on the reMarkable changes until the resulting entry is written\ninto a list and the root hash is updated.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw put-file";
    assertRawWriteAllowed(ctx, command);
    const id = positional(positionals, 0, "an id", command);
    const path = positional(positionals, 1, "a path", command);
    noExtra(positionals, 2, command);
    const bytes = new Uint8Array(await readFile(path));
    const api = await ctx.api();
    await finishPut(ctx, api.raw.putFile(id, bytes));
  },
};

const putTextCommand: Command = {
  summary: "upload a text file",
  usage: "<id> <text|@file|->",
  options: {},
  details: details(
    "The text can be given inline, read from a file with `@<file>`, or read from\nstdin with `-`.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw put-text";
    assertRawWriteAllowed(ctx, command);
    const id = positional(positionals, 0, "an id", command);
    const spec = positional(positionals, 1, "some text", command);
    noExtra(positionals, 2, command);
    const text = await textArg(ctx, spec);
    const api = await ctx.api();
    await finishPut(ctx, api.raw.putText(id, text));
  },
};

const putContentCommand: Command = {
  summary: "upload a content file",
  usage: "<id> <json|@file|->",
  options: {},
  details: details(
    "The id must end in `.content`. The json can be given inline, read from a\nfile with `@<file>`, or read from stdin with `-`. It is parsed but not\nvalidated locally, so a malformed content object is rejected (or accepted) by\nreMarkable rather than by us.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw put-content";
    assertRawWriteAllowed(ctx, command);
    const id = positional(positionals, 0, "an id", command);
    const spec = positional(positionals, 1, "some json", command);
    noExtra(positionals, 2, command);
    const content = (await jsonArg(ctx, spec, command)) as Content;
    const api = await ctx.api();
    await finishPut(ctx, api.raw.putContent(id, content));
  },
};

const putMetadataCommand: Command = {
  summary: "upload a metadata file",
  usage: "<id> <json|@file|->",
  options: {},
  details: details(
    "The id must end in `.metadata`. The json can be given inline, read from a\nfile with `@<file>`, or read from stdin with `-`. It is parsed but not\nvalidated locally, so a malformed metadata object is rejected (or accepted) by\nreMarkable rather than by us.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw put-metadata";
    assertRawWriteAllowed(ctx, command);
    const id = positional(positionals, 0, "an id", command);
    const spec = positional(positionals, 1, "some json", command);
    noExtra(positionals, 2, command);
    const metadata = (await jsonArg(ctx, spec, command)) as Metadata;
    const api = await ctx.api();
    await finishPut(ctx, api.raw.putMetadata(id, metadata));
  },
};

const putEntriesCommand: Command = {
  summary: "upload an entry list file",
  usage: "<id> <json|@file|-> <schema-version>",
  options: {},
  details: details(
    "The id is an item id, or `root` for the top level list. The json is an array\nof entries, as printed by 'raw get-entries --json'; it is parsed but not\nvalidated locally, so a malformed entry is rejected (or accepted) by\nreMarkable rather than by us. The schema version must be 3 or 4; reMarkable\nrejects newly written schema 3 root lists, so write the root list as 4.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw put-entries";
    assertRawWriteAllowed(ctx, command);
    const id = positional(positionals, 0, "an id", command);
    const spec = positional(positionals, 1, "some json", command);
    const rawVersion = positional(positionals, 2, "a schema version", command);
    noExtra(positionals, 3, command);
    const parsed = await jsonArg(ctx, spec, command);
    if (!Array.isArray(parsed)) {
      throw new UsageError("the entries must be a json array", command);
    }
    if (rawVersion !== "3" && rawVersion !== "4") {
      throw new UsageError(
        `the schema version must be 3 or 4, but was '${rawVersion}'`,
        command,
      );
    }
    const schemaVersion: SchemaVersion = rawVersion === "3" ? 3 : 4;
    const api = await ctx.api();
    await finishPut(
      ctx,
      api.raw.putEntries(id, parsed as RawEntry[], schemaVersion),
    );
  },
};

/** every mime type `raw upload-file` accepts */
const uploadMimeTypes: readonly UploadMimeType[] = [
  "application/pdf",
  "application/epub+zip",
  "folder",
];

function uploadMime(raw: string, command: string): UploadMimeType {
  const found = uploadMimeTypes.find((mime) => mime === raw);
  if (found === undefined) {
    throw new UsageError(
      `the mime type must be one of ${uploadMimeTypes.join(", ")}, but was '${raw}'`,
      command,
    );
  }
  return found;
}

const uploadFileCommand: Command = {
  summary: "upload a file with the simple upload api",
  usage: "<visible-name> <path> <mime>",
  options: {},
  details: details(
    "This uses the same endpoint as the browser extension, so it works on schema\n4 accounts and doesn't touch the root hash. The mime type is one of\napplication/pdf, application/epub+zip, or folder; folders have no content, so\npass `-` as the path for them.",
  ),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const command = "raw upload-file";
    assertRawWriteAllowed(ctx, command);
    const visibleName = positional(positionals, 0, "a visible name", command);
    const path = positional(positionals, 1, "a path", command);
    const mime = uploadMime(
      positional(positionals, 2, "a mime type", command),
      command,
    );
    noExtra(positionals, 3, command);
    // folders have no content, so the path is ignored for them
    const bytes =
      mime === "folder"
        ? new Uint8Array()
        : new Uint8Array(await readFile(path));
    const api = await ctx.api();
    const entry = await api.raw.uploadFile(visibleName, bytes, mime);
    ctx.out.write(entry, (val) =>
      columns([
        ["id", val.id],
        ["hash", val.hash],
      ]),
    );
  },
};

/** the `raw` family of commands */
export const rawCommands: Registry = {
  "raw get-root-hash": getRootHashCommand,
  "raw get-hash": getHashCommand,
  "raw get-text": getTextCommand,
  "raw get-entries": getEntriesCommand,
  "raw get-content": getContentCommand,
  "raw get-metadata": getMetadataCommand,
  "raw put-root-hash": putRootHashCommand,
  "raw put-file": putFileCommand,
  "raw put-text": putTextCommand,
  "raw put-content": putContentCommand,
  "raw put-metadata": putMetadataCommand,
  "raw put-entries": putEntriesCommand,
  "raw upload-file": uploadFileCommand,
};
