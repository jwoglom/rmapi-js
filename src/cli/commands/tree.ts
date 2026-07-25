/** rendering the reMarkable collection hierarchy as a tree */
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { TargetNotFoundError, UsageError } from "../error.js";
import { type TreeNode, tree } from "../format.js";
import {
  buildTree,
  type TreeNode as EntryNode,
  resolveTarget,
} from "../paths.js";
import { locateNode, renderNodes } from "../render.js";
import { entries as allEntries } from "../target.js";

/** how deep to render when `--depth` wasn't given */
const unlimited = Number.POSITIVE_INFINITY;

function parseDepth(raw: string | undefined): number {
  if (raw === undefined) {
    return unlimited;
  }
  const depth = Number(raw);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new UsageError(
      `--depth must be a positive integer, but was '${raw}'`,
      "tree",
    );
  }
  return depth;
}

/** prune a node so that at most `depth` levels of children survive */
function prune(node: EntryNode, depth: number): EntryNode {
  return {
    ...node,
    children:
      depth <= 0 ? [] : node.children.map((child) => prune(child, depth - 1)),
  };
}

const treeCommand: Command = {
  summary: "show the collection hierarchy as a tree",
  usage: "[path]",
  options: {
    depth: { type: "string" },
    trash: { type: "boolean" },
    all: { type: "boolean" },
  },
  descriptions: {
    depth: "only render this many levels of children",
    trash: "render the trash instead of the root",
    all: "also render the synthetic /.orphans and /.cycles containers",
  },
  details:
    "With no path the root is rendered. --trash and --all only apply when no\npath is given. Under --json the node structure is emitted rather than the\ndrawn tree.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 1, "tree");
    const depth = parseDepth(stringFlag(values, "depth"));
    const [path] = positionals;
    const items = await allEntries(ctx);
    const built = buildTree(items);

    let roots: EntryNode[];
    if (path === undefined) {
      const start = boolFlag(values, "trash") ? built.trash : built.root;
      roots = [start];
      if (boolFlag(values, "all")) {
        for (const extra of [built.orphans, built.cycles]) {
          if (extra !== undefined) {
            roots.push(extra);
          }
        }
      }
    } else {
      const entry = resolveTarget(items, path, { first: ctx.first });
      const found = locateNode(built, entry.id);
      if (found === undefined) {
        throw new TargetNotFoundError(path);
      }
      roots = [found];
    }

    const pruned = roots.map((node) => prune(node, depth));
    ctx.out.write(pruned, (vals) =>
      tree(
        vals.map(
          (node): TreeNode => ({
            label: node.path,
            children: renderNodes(node, ctx.out, depth),
          }),
        ),
      ),
    );
  },
};

/** the `tree` command */
export const treeCommands: Registry = { tree: treeCommand };
