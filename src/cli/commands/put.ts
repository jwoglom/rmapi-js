/**
 * putting files onto reMarkable
 *
 * The flag table in this module is declared as a total mapping over
 * {@link PutOptions | `PutOptions`}, so a field added to or renamed in the
 * library fails to compile here until the cli grows a flag for it.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ParseArgsOptionsConfig } from "node:util";
import type { FileType, PutOptions, RemarkableApi } from "../../index.js";
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
import { withGeneration } from "../client.js";
import { UsageError } from "../error.js";
import { target } from "../target.js";

/** the name this command is registered under, for error messages */
const name = "put";

/** the document types this command can put */
const fileTypes = ["pdf", "epub"] as const;

/** the file type of a put document, which excludes notebooks */
type PutFileType = (typeof fileTypes)[number];

/** every string value a flag was given, in order, splitting on commas */
function values(raw: FlagValue): string[] {
  const raws = Array.isArray(raw) ? raw : [raw];
  return raws
    .filter((val): val is string => typeof val === "string")
    .flatMap((val) => val.split(","))
    .map((val) => val.trim())
    .filter((val) => val !== "");
}

/** the last string value a flag was given */
function last(raw: FlagValue, flag: string): string {
  const raws = Array.isArray(raw) ? raw : [raw];
  const found = raws.filter((val): val is string => typeof val === "string");
  const val = found[found.length - 1];
  if (val === undefined) {
    throw new UsageError(`--${flag} requires a value`, name);
  }
  return val;
}

/** parse a flag as a string, verbatim */
function str(raw: FlagValue, flag: string): string {
  return last(raw, flag);
}

/** parse a flag as a finite number */
function num(raw: FlagValue, flag: string): number {
  const text = last(raw, flag);
  const val = Number(text);
  if (!Number.isFinite(val)) {
    throw new UsageError(`--${flag} must be a number, but was '${text}'`, name);
  }
  return val;
}

/** parse a flag as an integer */
function int(raw: FlagValue, flag: string): number {
  const val = num(raw, flag);
  if (!Number.isInteger(val)) {
    throw new UsageError(
      `--${flag} must be an integer, but was '${val}'`,
      name,
    );
  }
  return val;
}

/** parse a flag as a comma separated, or repeated, list of strings */
function list(raw: FlagValue): string[] {
  return values(raw);
}

/**
 * parse a repeated `key=value` flag as a record
 *
 * Values may contain `=`, only the first one separates.
 */
function record(raw: FlagValue, flag: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const raws = Array.isArray(raw) ? raw : [raw];
  for (const val of raws) {
    if (typeof val !== "string") continue;
    const split = val.indexOf("=");
    if (split < 1) {
      throw new UsageError(
        `--${flag} must be 'key=value', but was '${val}'`,
        name,
      );
    }
    parsed[val.slice(0, split)] = val.slice(split + 1);
  }
  return parsed;
}

/** parse a flag that must be one of a fixed set of values */
function oneOf<T extends string>(
  ...allowed: T[]
): (raw: FlagValue, flag: string) => T {
  return (raw: FlagValue, flag: string): T => {
    const val = last(raw, flag);
    if (!(allowed as string[]).includes(val)) {
      throw new UsageError(
        `--${flag} must be one of ${allowed.map((one) => `'${one}'`).join(", ")}, but was '${val}'`,
        name,
      );
    }
    return val as T;
  };
}

/** parse a boolean flag, which is true whenever it is present */
function flagged(): boolean {
  return true;
}

/** a {@link PutOptions | `PutOptions`} field set by a command line flag */
interface ParsedFlag<T> {
  /** discriminates this from a {@link DerivedFlag | `DerivedFlag`} */
  readonly kind: "flag";
  /** the kebab-case flag name, without leading dashes */
  readonly flag: string;
  /** the help text for the flag */
  readonly description: string;
  /** how `parseArgs` should read the flag */
  readonly type: "string" | "boolean";
  /** true if the flag may be repeated */
  readonly multiple?: boolean;
  /**
   * coerce the raw flag value into the field's type
   *
   * @throws UsageError for a value the field can't take
   */
  readonly parse: (raw: FlagValue, flag: string) => T;
}

/** a {@link PutOptions | `PutOptions`} field the command sets itself */
interface DerivedFlag {
  /** discriminates this from a {@link ParsedFlag | `ParsedFlag`} */
  readonly kind: "derived";
  /** why this field has no flag of its own */
  readonly note: string;
}

/** how one {@link PutOptions | `PutOptions`} field is filled in */
type FlagSpec<T> = ParsedFlag<T> | DerivedFlag;

/**
 * every {@link PutOptions | `PutOptions`} field, and how `put` fills it
 *
 * The mapped type strips optionality, which makes this exhaustive: adding or
 * renaming a `PutOptions` field is a compile error until this table is updated,
 * so the cli can never silently drop a new option.
 */
type PutFlags = {
  readonly [K in keyof PutOptions]-?: FlagSpec<NonNullable<PutOptions[K]>>;
};

const putFlags: PutFlags = {
  parent: {
    kind: "flag",
    flag: "parent",
    description: "id of the collection to put this in, instead of [dest]",
    type: "string",
    parse: str,
  },
  pinned: {
    kind: "flag",
    flag: "pinned",
    description: "star the document",
    type: "boolean",
    parse: flagged,
  },
  coverPageNumber: {
    kind: "flag",
    flag: "cover-page-number",
    description: "thumbnail page, 0 for the first page and -1 for last visited",
    type: "string",
    parse: int,
  },
  authors: {
    kind: "flag",
    flag: "authors",
    description: "document authors, comma separated or repeated",
    type: "string",
    multiple: true,
    parse: list,
  },
  title: {
    kind: "flag",
    flag: "title",
    description: "document metadata title, which is not the visible name",
    type: "string",
    parse: str,
  },
  publicationDate: {
    kind: "flag",
    flag: "publication-date",
    description: "publication date, an ISO date or timestamp",
    type: "string",
    parse: str,
  },
  publisher: {
    kind: "flag",
    flag: "publisher",
    description: "the publisher",
    type: "string",
    parse: str,
  },
  extraMetadata: {
    kind: "flag",
    flag: "extra-metadata",
    description: "extra metadata as 'key=value', repeatable",
    type: "string",
    multiple: true,
    parse: record,
  },
  fontName: {
    kind: "flag",
    flag: "font-name",
    description: "font for text rendering, e.g. 'EB Garamond'",
    type: "string",
    parse: str,
  },
  lineHeight: {
    kind: "flag",
    flag: "line-height",
    description: "line height, e.g. 100, 150, 200, or -1 for the default",
    type: "string",
    parse: int,
  },
  margins: {
    kind: "flag",
    flag: "margins",
    description: "page margins, e.g. 125",
    type: "string",
    parse: int,
  },
  orientation: {
    kind: "flag",
    flag: "orientation",
    description: "document orientation",
    type: "string",
    parse: oneOf("portrait", "landscape"),
  },
  tags: {
    kind: "flag",
    flag: "tags",
    description: "tag names, comma separated or repeated",
    type: "string",
    multiple: true,
    parse: list,
  },
  textAlignment: {
    kind: "flag",
    flag: "text-alignment",
    description: "text alignment, the empty string for the default",
    type: "string",
    parse: oneOf("", "justify", "left"),
  },
  textScale: {
    kind: "flag",
    flag: "text-scale",
    description: "text scale, e.g. 1",
    type: "string",
    parse: num,
  },
  zoomMode: {
    kind: "flag",
    flag: "zoom-mode",
    description: "zoom mode",
    type: "string",
    parse: oneOf("bestFit", "customFit", "fitToHeight", "fitToWidth"),
  },
  viewBackgroundFilter: {
    kind: "flag",
    flag: "view-background-filter",
    description: "contrast filter, omit to filter text areas only",
    type: "string",
    parse: oneOf("off", "fullpage"),
  },
  customZoomScale: {
    kind: "flag",
    flag: "custom-zoom-scale",
    description: "zoom scale, only used when --zoom-mode customFit",
    type: "string",
    parse: num,
  },
  customZoomCenterX: {
    kind: "flag",
    flag: "custom-zoom-center-x",
    description: "horizontal offset of the zoom center from the page center",
    type: "string",
    parse: num,
  },
  customZoomCenterY: {
    kind: "flag",
    flag: "custom-zoom-center-y",
    description: "distance of the zoom center down from the top of the page",
    type: "string",
    parse: num,
  },
  customZoomPageWidth: {
    kind: "flag",
    flag: "custom-zoom-page-width",
    description: "rendered page width in device pixels",
    type: "string",
    parse: num,
  },
  customZoomPageHeight: {
    kind: "flag",
    flag: "custom-zoom-page-height",
    description: "rendered page height in device pixels",
    type: "string",
    parse: num,
  },
  customZoomOrientation: {
    kind: "flag",
    flag: "custom-zoom-orientation",
    description: "the orientation the custom zoom was set in",
    type: "string",
    parse: oneOf("portrait", "landscape"),
  },
  refresh: {
    kind: "derived",
    note: "set from the global --refresh, and by every generation retry",
  },
};

/** the flag table as an iterable of typed pairs */
const specs = Object.entries(putFlags) as readonly [
  keyof PutOptions,
  FlagSpec<unknown>,
][];

/** the flags derived from {@link putFlags | `putFlags`} */
function optionsFrom(flags: PutFlags): ParseArgsOptionsConfig {
  const options: Record<
    string,
    { type: "string" | "boolean"; multiple?: boolean }
  > = {};
  for (const spec of Object.values(flags)) {
    if (spec.kind === "flag") {
      options[spec.flag] = spec.multiple
        ? { type: spec.type, multiple: true }
        : { type: spec.type };
    }
  }
  return options;
}

/** the flag descriptions derived from {@link putFlags | `putFlags`} */
function descriptionsFrom(flags: PutFlags): Record<string, string> {
  const descriptions: Record<string, string> = {};
  for (const spec of Object.values(flags)) {
    if (spec.kind === "flag") {
      descriptions[spec.flag] = spec.description;
    }
  }
  return descriptions;
}

/**
 * read every put option off the command line
 *
 * Fields whose flag wasn't given are left out entirely, so the library's own
 * defaults apply.
 *
 * @param vals - the parsed flags
 * @throws UsageError for a flag value the field can't take
 */
export function putOptions(
  vals: Readonly<Record<string, FlagValue>>,
): PutOptions {
  const opts: Record<string, unknown> = {};
  for (const [key, spec] of specs) {
    if (spec.kind !== "flag") continue;
    const raw = vals[spec.flag];
    if (raw === undefined) continue;
    opts[key] = spec.parse(raw, spec.flag);
  }
  return opts as PutOptions;
}

/**
 * the first put flag that was given, which the simple api can't honor
 *
 * @param vals - the parsed flags
 * @returns the flag name, or undefined if none of them were given
 */
function unsupportedFlag(
  vals: Readonly<Record<string, FlagValue>>,
): string | undefined {
  for (const [, spec] of specs) {
    if (spec.kind === "flag" && vals[spec.flag] !== undefined) {
      return spec.flag;
    }
  }
  return undefined;
}

/**
 * the type of document a file holds
 *
 * @param file - the path the file was read from
 * @param override - the value of `--type`, which wins over the extension
 * @throws UsageError when the extension isn't recognized and there's no override
 */
export function resolveFileType(
  file: string,
  override: string | undefined,
): PutFileType {
  if (override !== undefined) {
    const found = fileTypes.find((one) => one === override.toLowerCase());
    if (found === undefined) {
      throw new UsageError(
        `--type must be one of ${fileTypes.map((one) => `'${one}'`).join(", ")}, but was '${override}'`,
        name,
      );
    }
    return found;
  }
  const ext = extname(file).slice(1).toLowerCase();
  const found = fileTypes.find((one) => one === ext);
  if (found === undefined) {
    throw new UsageError(
      `couldn't tell the type of '${file}' from its extension; pass --type ${fileTypes.join(" or --type ")}`,
      name,
    );
  }
  return found;
}

/** true if a destination names the root collection */
function isRoot(dest: string): boolean {
  return dest === "" || dest === "/" || dest === "id:";
}

/**
 * the id of the collection a destination names
 *
 * @param ctx - the command context
 * @param dest - a path or id naming a collection, `/` for the root
 * @throws UsageError if the destination isn't a collection
 */
async function parentId(ctx: Context, dest: string): Promise<string> {
  const entry = await target(ctx, dest);
  if (entry.type !== "CollectionType") {
    throw new UsageError(`'${dest}' isn't a collection`, name);
  }
  return entry.id;
}

/** the result of a successful put */
interface PutResult {
  /** the id of the new document */
  id: string;
  /** the hash of the new document */
  hash: string;
  /** the name the document shows up as */
  visibleName: string;
  /** the type of the file that was put */
  fileType: FileType;
  /** the id of the collection it was put in, `""` for the root */
  parent: string;
  /** whether the simple upload api was used */
  simple: boolean;
}

/** put a file with the low-level api, retrying stale generations */
async function putFile(
  ctx: Context,
  api: RemarkableApi,
  fileType: PutFileType,
  visibleName: string,
  buffer: Uint8Array,
  opts: PutOptions,
): Promise<{ id: string; hash: string }> {
  return await withGeneration(ctx.retries, (refresh) => {
    const full: PutOptions = { ...opts, refresh: refresh || ctx.refresh };
    return fileType === "pdf"
      ? api.putPdf(visibleName, buffer, full)
      : api.putEpub(visibleName, buffer, full);
  });
}

const putCommand: Command = {
  summary: "put a pdf or epub onto reMarkable",
  usage: "<file> [dest]",
  options: {
    type: { type: "string" },
    name: { type: "string" },
    simple: { type: "boolean" },
    ...optionsFrom(putFlags),
  },
  descriptions: {
    type: "treat the file as a 'pdf' or an 'epub', instead of guessing",
    name: "the name to show on the reMarkable, defaults to the file name",
    simple: "use the simpler upload api, which takes no other options",
    ...descriptionsFrom(putFlags),
  },
  details: [
    "The destination is a collection, given as a path or an id, and defaults to",
    "the root. The visible name defaults to the file's name without its",
    "extension.",
    "",
    "--simple uses the upload api, which is more robust but accepts no options at",
    "all: it always uploads into the root under the given name. Combining it with",
    "any other option is an error rather than a silent no-op.",
  ].join("\n"),
  async run(ctx: Context, { values: vals, positionals }: CommandArgs) {
    const [file, dest] = positionals;
    if (file === undefined) {
      throw new UsageError("a file to put is required", name);
    }
    noExtra(positionals, 2, name);

    const fileType = resolveFileType(file, stringFlag(vals, "type"));
    const visibleName =
      stringFlag(vals, "name") ?? basename(file, extname(file));
    const simple = boolFlag(vals, "simple");
    const buffer = await readFile(file);
    const api = await ctx.api();

    if (simple) {
      const offender = unsupportedFlag(vals);
      if (offender !== undefined) {
        throw new UsageError(
          `--simple can't honor --${offender}; drop one of them`,
          name,
        );
      } else if (dest !== undefined && !isRoot(dest)) {
        throw new UsageError(
          `--simple can only put into the root, but the destination '${dest}' was given`,
          name,
        );
      }
      // the simple api takes no refresh, but retrying a stale generation is
      // still the right response if it ever surfaces one
      const entry = await withGeneration(ctx.retries, () =>
        fileType === "pdf"
          ? api.uploadPdf(visibleName, buffer)
          : api.uploadEpub(visibleName, buffer),
      );
      const result: PutResult = {
        ...entry,
        visibleName,
        fileType,
        parent: "",
        simple,
      };
      ctx.out.write(result, (val) => `put '${val.visibleName}' (${val.id})`);
      return;
    }

    const opts = putOptions(vals);
    if (dest !== undefined && opts.parent !== undefined) {
      throw new UsageError(
        `pass either a destination or --parent, but '${dest}' and --parent were both given`,
        name,
      );
    }
    const parent =
      dest === undefined
        ? (opts.parent ?? "")
        : isRoot(dest)
          ? ""
          : await parentId(ctx, dest);
    const entry = await putFile(ctx, api, fileType, visibleName, buffer, {
      ...opts,
      parent,
    });
    const result: PutResult = {
      ...entry,
      visibleName,
      fileType,
      parent,
      simple,
    };
    ctx.out.write(result, (val) => `put '${val.visibleName}' (${val.id})`);
  },
};

/** the `put` command */
export const putCommands: Registry = { put: putCommand };
