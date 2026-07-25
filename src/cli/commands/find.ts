/** searching for items on reMarkable */
import type { Entry } from "../../index.js";
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
import {
  entryPaths,
  resolveTarget,
  rootEntry,
  trashEntry,
  trashPath,
} from "../paths.js";
import { type Listing, longList, shortList, tagNames } from "../render.js";
import { entries as allEntries } from "../target.js";

/** the `--type` values, mapped onto the entry `type` they select */
const types: Readonly<Record<string, Entry["type"]>> = {
  collection: "CollectionType",
  document: "DocumentType",
  template: "TemplateType",
};

/** the `--file-type` values */
const fileTypes: readonly string[] = ["epub", "pdf", "notebook"];

/**
 * a predicate matching a `visibleName`
 *
 * A pattern wrapped in slashes, e.g. `/^ch\d+/i`, is a regular expression,
 * anything else is a case sensitive substring.
 */
function nameMatcher(pattern: string): (name: string) => boolean {
  const match = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  if (match === null) {
    return (name) => name.includes(pattern);
  }
  const [, source, flags] = match;
  let regex: RegExp;
  try {
    regex = new RegExp(source!, flags);
  } catch (ex) {
    const message = ex instanceof Error ? ex.message : String(ex);
    throw new UsageError(
      `invalid --name regex '${pattern}': ${message}`,
      "find",
    );
  }
  return (name) => regex.test(name);
}

/** the display path prefix that restricts the search to a subtree */
function basePath(entry: Entry, paths: ReadonlyMap<string, string>): string {
  if (entry.id === rootEntry.id) {
    return "";
  } else if (entry.id === trashEntry.id) {
    return trashPath;
  }
  return paths.get(entry.id) ?? "";
}

const findCommand: Command = {
  summary: "find items matching a filter",
  usage: "[path]",
  options: {
    long: { type: "boolean", short: "l" },
    name: { type: "string" },
    type: { type: "string" },
    tag: { type: "string" },
    pinned: { type: "boolean" },
    "file-type": { type: "string" },
  },
  descriptions: {
    long: "show type, file type, pinned, last modified, id, and hash",
    name: "a substring of the name, or /regex/ for a regular expression",
    type: "only collection, document, or template entries",
    tag: "only entries carrying this tag",
    pinned: "only pinned entries",
    "file-type": "only documents of this file type: epub, pdf, or notebook",
  },
  details:
    "Every filter given has to match. With a path only that subtree is searched,\nincluding the path itself; the whole cloud, trash included, is searched\notherwise. Under --json every match is an entry with a 'path' field.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 1, "find");
    const rawName = stringFlag(values, "name");
    const matchesName =
      rawName === undefined ? undefined : nameMatcher(rawName);

    const rawType = stringFlag(values, "type");
    const type = rawType === undefined ? undefined : types[rawType];
    if (rawType !== undefined && type === undefined) {
      throw new UsageError(
        `--type must be one of ${Object.keys(types).join(", ")}, but was '${rawType}'`,
        "find",
      );
    }

    const fileType = stringFlag(values, "file-type");
    if (fileType !== undefined && !fileTypes.includes(fileType)) {
      throw new UsageError(
        `--file-type must be one of ${fileTypes.join(", ")}, but was '${fileType}'`,
        "find",
      );
    }

    const tag = stringFlag(values, "tag");
    const pinned = boolFlag(values, "pinned");
    const long = boolFlag(values, "long");
    const [path] = positionals;

    const items = await allEntries(ctx);
    const paths = entryPaths(items);
    const base =
      path === undefined
        ? ""
        : basePath(resolveTarget(items, path, { first: ctx.first }), paths);

    const matches: Listing[] = [];
    for (const entry of items) {
      const full = paths.get(entry.id) ?? "";
      if (base !== "" && full !== base && !full.startsWith(`${base}/`)) {
        continue;
      } else if (matchesName !== undefined && !matchesName(entry.visibleName)) {
        continue;
      } else if (type !== undefined && entry.type !== type) {
        continue;
      } else if (
        fileType !== undefined &&
        (entry.type !== "DocumentType" || entry.fileType !== fileType)
      ) {
        continue;
      } else if (tag !== undefined && !tagNames(entry).includes(tag)) {
        continue;
      } else if (pinned && !entry.pinned) {
        continue;
      }
      matches.push({ entry, name: full });
    }
    matches.sort((left, right) => (left.name < right.name ? -1 : 1));

    ctx.out.write(
      matches.map(({ entry, name }) => ({ ...entry, path: name })),
      () => (long ? longList(matches, ctx.out) : shortList(matches, ctx.out)),
    );
  },
};

/** the `find` command */
export const findCommands: Registry = { find: findCommand };
