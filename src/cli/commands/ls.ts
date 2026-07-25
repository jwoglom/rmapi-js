/** listing items on reMarkable */
import type { SimpleEntry } from "../../index.js";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
} from "../args.js";
import { columns, tree } from "../format.js";
import { buildTree, entryPaths, resolveTarget, rootEntry } from "../paths.js";
import {
  type Listing,
  locateNode,
  longList,
  renderNodes,
  shortList,
} from "../render.js";
import { entries as allEntries } from "../target.js";

function byName(left: Listing, right: Listing): number {
  return left.name < right.name ? -1 : 1;
}

const lsCommand: Command = {
  summary: "list items",
  usage: "[path]",
  options: {
    long: { type: "boolean", short: "l" },
    recursive: { type: "boolean", short: "R" },
    ids: { type: "boolean" },
    all: { type: "boolean" },
  },
  descriptions: {
    long: "show type, file type, pinned, last modified, id, and hash",
    recursive: "list collections recursively as a tree",
    ids: "list raw ids and hashes without fetching metadata",
    all: "flat list of every item by full path, including nested ones",
  },
  details:
    "The path may be a slash separated path ('/Books/Notes'), an 'id:' or\n'hash:' target, a bare uuid, or a bare hash; '/' is the root and '/trash'\nthe trash. Under --json, --all adds a 'path' field to every entry.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 1, "ls");
    const long = boolFlag(values, "long");
    const [path] = positionals;

    if (boolFlag(values, "ids")) {
      const api = await ctx.api();
      const ids = await api.listIds(ctx.refresh);
      ctx.out.write(ids, (vals: readonly SimpleEntry[]) =>
        columns(vals.map(({ id, hash }) => [id, ctx.out.style.dim(hash)])),
      );
      return;
    }

    const items = await allEntries(ctx);
    const render = (listings: readonly Listing[]): string =>
      long ? longList(listings, ctx.out) : shortList(listings, ctx.out);

    if (boolFlag(values, "all")) {
      const paths = entryPaths(items);
      const listings = items
        .map((entry) => ({ entry, name: paths.get(entry.id) ?? "" }))
        .sort(byName);
      ctx.out.write(
        listings.map(({ entry, name }) => ({ ...entry, path: name })),
        () => render(listings),
      );
      return;
    }

    const parent =
      path === undefined
        ? rootEntry
        : resolveTarget(items, path, { first: ctx.first });
    const built = buildTree(items);
    const node = locateNode(built, parent.id);
    const kids = node === undefined ? [] : node.children;

    if (boolFlag(values, "recursive")) {
      const nodes =
        node === undefined
          ? []
          : renderNodes(node, ctx.out, Number.POSITIVE_INFINITY);
      ctx.out.write(nodes, (vals) => tree(vals));
      return;
    }

    const listings = kids
      .map(({ entry, name }) => ({ entry: entry!, name }))
      .sort(byName);
    ctx.out.write(
      listings.map(({ entry }) => entry),
      () => render(listings),
    );
  },
};

/** the `ls` command */
export const lsCommands: Registry = { ls: lsCommand };
