/** downloading the source file of a document */
import { writeSync } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import type { Entry } from "../../index.js";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  type FlagValue,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { UsageError } from "../error.js";
import { target as resolve } from "../target.js";

/** the kinds of file `get` can download */
type Kind = "pdf" | "epub" | "zip";

/** the extension each kind is saved under */
const extensions: Readonly<Record<Kind, string>> = {
  pdf: ".pdf",
  epub: ".epub",
  zip: ".zip",
};

/**
 * the kind of file to download
 *
 * An explicit flag always wins; otherwise a document's `fileType` decides, and
 * a notebook has no source file at all.
 */
function resolveKind(
  values: Readonly<Record<string, FlagValue>>,
  entry: Entry,
  raw: string,
): Kind {
  const flags = (["pdf", "epub", "zip"] as const).filter((kind) =>
    boolFlag(values, kind),
  );
  const [kind, ...extra] = flags;
  if (extra.length) {
    throw new UsageError(
      `--${kind} and --${extra[0]} are mutually exclusive`,
      "get",
    );
  } else if (kind !== undefined) {
    return kind;
  } else if (entry.type !== "DocumentType") {
    throw new UsageError(
      `'${raw}' is a ${entry.type === "CollectionType" ? "collection" : "template"}, which has no source file`,
      "get",
    );
  } else if (entry.fileType === "notebook") {
    throw new UsageError(
      `'${raw}' is a notebook, which has no source file; pass --zip to download the raw document archive`,
      "get",
    );
  }
  return entry.fileType;
}

/** the default file name for an entry, ensuring it ends in the right extension */
function defaultName(entry: Entry, kind: Kind): string {
  const ext = extensions[kind];
  const name = entry.visibleName;
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** what `get` reports, never the bytes themselves */
interface Downloaded {
  /** where the file was written, `-` for stdout */
  path: string;
  /** how many bytes were written */
  bytes: number;
}

const getCommand: Command = {
  summary: "download the source file of a document",
  usage: "<target>",
  options: {
    output: { type: "string", short: "o" },
    pdf: { type: "boolean" },
    epub: { type: "boolean" },
    zip: { type: "boolean" },
  },
  descriptions: {
    output: "where to write the file, '-' for stdout",
    pdf: "download the pdf source",
    epub: "download the epub source",
    zip: "download the raw document archive as a zip",
  },
  details:
    "Without --pdf, --epub, or --zip the document's own file type is downloaded.\nNotebooks have no source file, so they can only be fetched with --zip.\nWithout -o the file is named after the document and an existing file is\nnever overwritten unless --yes is given.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    const [raw] = positionals;
    if (raw === undefined) {
      throw new UsageError("a target is required", "get");
    }
    noExtra(positionals, 1, "get");

    const entry = await resolve(ctx, raw);
    const kind = resolveKind(values, entry, raw);
    const output = stringFlag(values, "output");
    const file = output ?? defaultName(entry, kind);
    if (file !== "-" && !ctx.yes && (await exists(file))) {
      throw new UsageError(
        `'${file}' already exists; pass --yes to overwrite it`,
        "get",
      );
    }

    const api = await ctx.api();
    const bytes =
      kind === "pdf"
        ? await api.getPdf(entry.id, entry.hash)
        : kind === "epub"
          ? await api.getEpub(entry.id, entry.hash)
          : await api.getDocument(entry.id, entry.hash);

    if (file === "-") {
      writeSync(1, bytes);
    } else {
      await writeFile(file, bytes);
    }
    const done: Downloaded = { path: file, bytes: bytes.length };
    ctx.out.write(done, (val) =>
      val.path === "-" ? "" : `wrote ${val.bytes} bytes to ${val.path}`,
    );
  },
};

/** the `get` command */
export const getCommands: Registry = { get: getCommand };
