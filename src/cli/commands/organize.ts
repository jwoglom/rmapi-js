/**
 * moving, trashing, renaming, and starring items
 *
 * Every command here resolves its targets with
 * {@link targets | `targets`}, which fetches the entry list exactly once and
 * expands a `-` argument into targets read from stdin.
 */
import type {
  Entry,
  HashEntry,
  HashesEntry,
  RemarkableApi,
} from "../../index.js";
import {
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
} from "../args.js";
import { withGeneration } from "../client.js";
import { UsageError } from "../error.js";
import { columns } from "../format.js";
import { targets } from "../target.js";

/** what one command did to one entry */
interface Change {
  /** the id of the entry */
  id: string;
  /** the name the entry shows up as */
  visibleName: string;
  /** the hash the entry had before */
  hash: string;
  /** the hash the entry has now, undefined if the api didn't report one */
  newHash: string | undefined;
}

/** the destination of a move */
interface Dest {
  /** the id of the collection, `""` for the root and `"trash"` for the trash */
  id: string;
  /** the name the collection shows up as */
  visibleName: string;
}

/** the result of an organize command */
interface Result {
  /** what was done, e.g. `"moved"` */
  action: string;
  /** where the entries were moved, only set by `mv` */
  dest?: Dest;
  /** every entry that changed, in target order */
  changes: Change[];
}

/** the first eight characters of a hash, enough to eyeball a change */
function short(hash: string | undefined): string {
  return hash === undefined ? "?" : hash.slice(0, 8);
}

/** emit a result, showing old and new hashes */
function report(ctx: Context, result: Result): void {
  ctx.out.write(result, (val) => {
    const rows = val.changes.map((change) => [
      val.action,
      `'${change.visibleName}'`,
      ctx.out.style.dim(`${short(change.hash)} -> ${short(change.newHash)}`),
    ]);
    const dest = val.dest;
    return dest === undefined
      ? columns(rows)
      : `${columns(rows)}\n${ctx.out.style.dim(`destination: ${dest.visibleName || "/"} (${dest.id || "root"})`)}`;
  });
}

/** the changes for a bulk operation, which reports old to new hashes */
function bulkChanges(
  items: readonly Entry[],
  hashes: Readonly<Record<string, string>>,
): Change[] {
  return items.map((entry) => ({
    id: entry.id,
    visibleName: entry.visibleName,
    hash: entry.hash,
    newHash: hashes[entry.hash],
  }));
}

/** resolve the targets a multi target command was given */
async function manyTargets(
  ctx: Context,
  strs: readonly string[],
  command: string,
): Promise<[RemarkableApi, Entry[]]> {
  if (strs.length === 0) {
    throw new UsageError("at least one target is required", command);
  }
  const items = await targets(ctx, strs);
  if (items.length === 0) {
    throw new UsageError("no targets were given", command);
  }
  return [await ctx.api(), items];
}

/**
 * apply an operation to every target, single or bulk
 *
 * One target goes through the single entry api, several through the bulk api,
 * which is the one that reports old to new hashes.
 *
 * @param ctx - the command context
 * @param items - the resolved targets
 * @param single - the single entry api call
 * @param bulk - the bulk api call
 * @returns what changed, in target order
 */
async function applyBulk(
  ctx: Context,
  items: readonly Entry[],
  single: (hash: string, refresh: boolean) => Promise<HashEntry>,
  bulk: (hashes: readonly string[], refresh: boolean) => Promise<HashesEntry>,
): Promise<Change[]> {
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const { hash } = await withGeneration(ctx.retries, (refresh) =>
      single(only.hash, refresh || ctx.refresh),
    );
    return [
      {
        id: only.id,
        visibleName: only.visibleName,
        hash: only.hash,
        newHash: hash,
      },
    ];
  }
  const { hashes } = await withGeneration(ctx.retries, (refresh) =>
    bulk(
      items.map((entry) => entry.hash),
      refresh || ctx.refresh,
    ),
  );
  return bulkChanges(items, hashes);
}

const mvCommand: Command = {
  summary: "move items into a collection",
  usage: "<target>... <dest>",
  options: {},
  details: [
    "The last argument is the destination, given as a path or an id, with '/' for",
    "the root and '/trash' for the trash. The destination has to be a collection",
    "that already exists; moving an item to a new name is not a move, use",
    "'rmapi rename' for that.",
    "",
    "A single target uses the move api, several use the bulk move api. A '-'",
    "target reads more targets from stdin.",
  ].join("\n"),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    if (positionals.length < 2) {
      throw new UsageError("a target and a destination are required", "mv");
    }
    const destStr = positionals[positionals.length - 1]!;
    // the destination goes first so one fetch resolves everything: `targets`
    // appends any stdin targets to the end of the list
    const [dest, ...items] = await targets(ctx, [
      destStr,
      ...positionals.slice(0, -1),
    ]);
    if (dest === undefined || items.length === 0) {
      throw new UsageError("a target and a destination are required", "mv");
    } else if (dest.type !== "CollectionType") {
      throw new UsageError(`destination '${destStr}' isn't a collection`, "mv");
    }
    const api = await ctx.api();
    const changes = await applyBulk(
      ctx,
      items,
      (hash, refresh) => api.move(hash, dest.id, refresh),
      (hashes, refresh) => api.bulkMove(hashes, dest.id, refresh),
    );

    report(ctx, {
      action: "moved",
      dest: { id: dest.id, visibleName: dest.visibleName },
      changes,
    });
  },
};

const rmCommand: Command = {
  summary: "move items to the trash",
  usage: "<target>...",
  options: {},
  details: [
    "This moves items to the trash; the api has no way to erase anything, so",
    "nothing here deletes data permanently. Empty the trash from a reMarkable",
    "device or the web app.",
    "",
    "A single target uses the delete api, several use the bulk delete api. A '-'",
    "target reads more targets from stdin.",
  ].join("\n"),
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [api, items] = await manyTargets(ctx, positionals, "rm");
    const changes = await applyBulk(
      ctx,
      items,
      (hash, refresh) => api.delete(hash, refresh),
      (hashes, refresh) => api.bulkDelete(hashes, refresh),
    );

    report(ctx, { action: "trashed", changes });
  },
};

const renameCommand: Command = {
  summary: "rename an item",
  usage: "<target> <name>",
  options: {},
  details:
    "This only changes the item's visible name; use 'rmapi mv' to move it into a\ndifferent collection.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [tgt, visibleName] = positionals;
    if (tgt === undefined || visibleName === undefined) {
      throw new UsageError("a target and a new name are required", "rename");
    }
    noExtra(positionals, 2, "rename");
    const [api, items] = await manyTargets(ctx, [tgt], "rename");
    const [entry] = items;
    if (entry === undefined) {
      throw new UsageError("a target is required", "rename");
    }
    const { hash } = await withGeneration(ctx.retries, (refresh) =>
      api.rename(entry.hash, visibleName, refresh || ctx.refresh),
    );
    report(ctx, {
      action: `renamed to '${visibleName}'`,
      changes: [
        {
          id: entry.id,
          visibleName: entry.visibleName,
          hash: entry.hash,
          newHash: hash,
        },
      ],
    });
  },
};

/**
 * a command that stars, or unstars, every target
 *
 * There is no bulk star api, so entries are updated one at a time, since each
 * update bumps the root generation.
 *
 * @param stared - true for `star`, false for `unstar`
 */
function staredCommand(stared: boolean): Command {
  const name = stared ? "star" : "unstar";
  return {
    summary: stared ? "star items" : "unstar items",
    usage: "<target>...",
    options: {},
    details:
      "Items are updated one at a time, because each update bumps the root\ngeneration on reMarkable. A '-' target reads more targets from stdin.",
    async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
      const [api, items] = await manyTargets(ctx, positionals, name);
      const changes: Change[] = [];
      for (const entry of items) {
        const { hash } = await withGeneration(ctx.retries, (refresh) =>
          api.stared(entry.hash, stared, refresh || ctx.refresh),
        );
        changes.push({
          id: entry.id,
          visibleName: entry.visibleName,
          hash: entry.hash,
          newHash: hash,
        });
      }
      report(ctx, { action: stared ? "starred" : "unstarred", changes });
    },
  };
}

/** the commands that move, trash, rename, and star items */
export const organizeCommands: Registry = {
  mv: mvCommand,
  rm: rmCommand,
  rename: renameCommand,
  star: staredCommand(true),
  unstar: staredCommand(false),
};
