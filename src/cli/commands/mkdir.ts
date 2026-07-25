/** creating collections (folders) on reMarkable */
import type { CollectionEntry, Entry, RemarkableApi } from "../../index.js";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  type Registry,
} from "../args.js";
import { withGeneration } from "../client.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { children, escapeSegment, parsePath } from "../paths.js";
import { entries } from "../target.js";

/** the name this command is registered under, for error messages */
const name = "mkdir";

/** one folder `mkdir` created, or found already there */
interface Made {
  /** the absolute display path of the folder */
  path: string;
  /** the id of the folder */
  id: string;
  /** the hash of the folder */
  hash: string;
  /** false when the folder already existed and `--parents` made it a no-op */
  created: boolean;
}

/** the container a path is rooted in, and its remaining segments */
function split(path: string): {
  container: string;
  prefix: string;
  rest: string[];
} {
  const segments = parsePath(path);
  return segments[0] === "trash"
    ? { container: "trash", prefix: "/trash", rest: segments.slice(1) }
    : { container: "", prefix: "", rest: segments };
}

/**
 * the entry a newly created folder would have had in a listing
 *
 * `putFolder` only hands back an id and a hash, so this stands in for the new
 * folder while later segments of the same, or a later, path are resolved
 * against the entry list we already fetched.
 */
function madeEntry(
  id: string,
  hash: string,
  visibleName: string,
  parent: string,
): CollectionEntry {
  return {
    id,
    hash,
    visibleName,
    lastModified: Date.now().toFixed(),
    pinned: false,
    parent,
    type: "CollectionType",
  };
}

/**
 * create every folder along a single path
 *
 * Folders are created one at a time, never concurrently, because each
 * `putFolder` bumps the root generation, and a second in-flight put would
 * always lose the race.
 *
 * @param ctx - the command context
 * @param api - the api to create folders with
 * @param items - every known entry, appended to as folders are created
 * @param path - the path to create
 * @param parents - true to create missing intermediates and tolerate an
 *     existing target
 * @returns what was created, and what was already there
 */
async function makePath(
  ctx: Context,
  api: RemarkableApi,
  items: Entry[],
  path: string,
  parents: boolean,
): Promise<Made[]> {
  const { container: start, prefix: start_prefix, rest } = split(path);
  if (rest.length === 0) {
    throw new UsageError(`'${path}' doesn't name a folder to create`, name);
  }
  const made: Made[] = [];
  let container = start;
  let prefix = start_prefix;
  for (const [ind, segment] of rest.entries()) {
    const full = `${prefix}/${escapeSegment(segment)}`;
    const isLast = ind === rest.length - 1;
    const existing = children(items, container).find(
      (entry) => entry.visibleName === segment,
    );
    if (existing !== undefined) {
      if (existing.type !== "CollectionType") {
        throw new UsageError(
          `'${full}' already exists, but isn't a folder`,
          name,
        );
      } else if (isLast && !parents) {
        throw new UsageError(
          `'${full}' already exists; pass --parents to ignore`,
          name,
        );
      }
      if (isLast) {
        made.push({
          path: full,
          id: existing.id,
          hash: existing.hash,
          created: false,
        });
      }
      container = existing.id;
      prefix = full;
      continue;
    }
    if (!isLast && !parents) {
      throw new TargetNotFoundError(full);
    }
    const parent = container;
    const entry = await withGeneration(ctx.retries, (refresh) =>
      api.putFolder(segment, { parent }, refresh || ctx.refresh),
    );
    items.push(madeEntry(entry.id, entry.hash, segment, parent));
    made.push({ path: full, id: entry.id, hash: entry.hash, created: true });
    container = entry.id;
    prefix = full;
  }
  return made;
}

const mkdirCommand: Command = {
  summary: "create collections (folders)",
  usage: "<path>...",
  options: {
    parents: { type: "boolean", short: "p" },
    simple: { type: "boolean" },
  },
  descriptions: {
    parents: "create missing parents, and don't fail if the target exists",
    simple: "use the simpler upload api, which can only create in the root",
  },
  details: [
    "Paths are absolute, so a leading '/' is optional, and a leading 'trash'",
    "segment creates the folder in the trash.",
    "",
    "Folders are created one at a time, because every folder created bumps the",
    "root generation on reMarkable.",
  ].join("\n"),
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    if (positionals.length === 0) {
      throw new UsageError("at least one path is required", name);
    }
    const parents = boolFlag(values, "parents");
    const simple = boolFlag(values, "simple");
    const api = await ctx.api();
    const made: Made[] = [];

    if (simple) {
      if (parents) {
        throw new UsageError("--parents can't be used with --simple", name);
      }
      for (const path of positionals) {
        const { container, rest } = split(path);
        const [segment] = rest;
        if (segment === undefined || rest.length !== 1 || container !== "") {
          throw new UsageError(
            `--simple can only create folders in the root, but '${path}' is nested`,
            name,
          );
        }
        // the simple api takes no refresh, but retrying a stale generation is
        // still the right response if it ever surfaces one
        const entry = await withGeneration(ctx.retries, () =>
          api.uploadFolder(segment),
        );
        made.push({
          path: `/${escapeSegment(segment)}`,
          id: entry.id,
          hash: entry.hash,
          created: true,
        });
      }
    } else {
      const items = await entries(ctx);
      for (const path of positionals) {
        made.push(...(await makePath(ctx, api, items, path, parents)));
      }
    }

    ctx.out.write(made, (vals) =>
      vals
        .map((val) => `${val.created ? "created" : "exists"} ${val.path}`)
        .join("\n"),
    );
  },
};

/** the `mkdir` command */
export const mkdirCommands: Registry = { mkdir: mkdirCommand };
