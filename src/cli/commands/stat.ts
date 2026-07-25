/** inspecting the metadata and content of a single item */
import type { Content, Entry, Metadata } from "../../index.js";
import {
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
} from "../args.js";
import { UsageError } from "../error.js";
import { columns } from "../format.js";
import {
  entryPaths,
  resolveTarget,
  rootEntry,
  trashEntry,
  trashPath,
} from "../paths.js";
import { tagNames, timestamp } from "../render.js";
import { entries as allEntries } from "../target.js";

/** an entry paired with the path it renders at */
interface Located {
  /** the resolved entry */
  readonly entry: Entry;
  /** the entry's absolute display path */
  readonly path: string;
}

/**
 * resolve a required target into an entry that has stored state
 *
 * The root and the trash aren't real entries, so they have no metadata or
 * content to fetch.
 *
 * @param ctx - the command context
 * @param positionals - the command's positionals, the first of which is the target
 * @param command - the command name, for usage errors
 * @param opts - whether the listing has to include each item's content, which
 *     only matters for the fields the command renders off the resolved entry
 */
async function locate(
  ctx: Context,
  positionals: readonly string[],
  command: string,
  { content = false }: { content?: boolean } = {},
): Promise<Located> {
  const [raw] = positionals;
  if (raw === undefined) {
    throw new UsageError("a target is required", command);
  }
  noExtra(positionals, 1, command);
  const items = await allEntries(ctx, { content });
  const entry = resolveTarget(items, raw, { first: ctx.first });
  if (entry.id === rootEntry.id || entry.id === trashEntry.id) {
    throw new UsageError(
      `'${raw}' is a synthetic container with no stored state`,
      command,
    );
  }
  const path = entryPaths(items).get(entry.id);
  return { entry, path: path ?? (entry.parent === "trash" ? trashPath : "") };
}

/** render an object as aligned `key: value` rows, skipping undefined values */
function keyValues(value: object): string {
  const rows: string[][] = [];
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined) {
      continue;
    }
    rows.push([
      `${key}:`,
      typeof val === "object" ? JSON.stringify(val) : String(val),
    ]);
  }
  return columns(rows);
}

const metaCommand: Command = {
  summary: "print the raw metadata of an item",
  usage: "<target>",
  options: {},
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    // the metadata is fetched for the resolved item directly, so the listing
    // that resolves the target doesn't need anyone's content
    const { entry } = await locate(ctx, positionals, "meta");
    const api = await ctx.api();
    const metadata = await api.getMetadata(entry.id, entry.hash);
    ctx.out.write(metadata, (val: Metadata) => keyValues(val));
  },
};

const contentCommand: Command = {
  summary: "print the raw content of an item",
  usage: "<target>",
  options: {},
  details:
    "Content holds the file type, tags, and reader settings. It is deeply nested,\nso it is always rendered as json.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    // likewise, this content is fetched for the resolved item directly, rather
    // than for every item in the listing
    const { entry } = await locate(ctx, positionals, "content");
    const api = await ctx.api();
    const content = await api.getContent(entry.id, entry.hash);
    ctx.out.write(content, (val: Content) => JSON.stringify(val, null, 2));
  },
};

/** the merged summary `stat` reports */
interface Stat {
  /** the resolved entry */
  entry: Entry;
  /** its metadata */
  metadata: Metadata;
  /** its content */
  content: Content;
}

const statCommand: Command = {
  summary: "show a summary of an item's metadata and content",
  usage: "<target>",
  options: {},
  details:
    "Fetches the metadata and the content together. Under --json the full\n{ entry, metadata, content } is emitted rather than the summary.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    // the summary lists the entry's tags, which come from its content
    const { entry, path } = await locate(ctx, positionals, "stat", {
      content: true,
    });
    const api = await ctx.api();
    const [metadata, content] = await Promise.all([
      api.getMetadata(entry.id, entry.hash),
      api.getContent(entry.id, entry.hash),
    ]);
    const stat: Stat = { entry, metadata, content };
    ctx.out.write(stat, (val) => {
      const tags = tagNames(val.entry);
      const fileType =
        "fileType" in val.content ? val.content.fileType : undefined;
      const rows: (readonly string[])[] = [
        ["path:", path],
        ["type:", val.metadata.type],
      ];
      if (fileType !== undefined) {
        rows.push(["file type:", fileType]);
      }
      rows.push(
        ["pinned:", val.metadata.pinned ? "yes" : "no"],
        ["created:", timestamp(val.metadata.createdTime ?? "")],
        ["modified:", timestamp(val.metadata.lastModified)],
      );
      if (val.metadata.lastOpened !== undefined) {
        rows.push(["opened:", timestamp(val.metadata.lastOpened)]);
      }
      rows.push(
        ["tags:", tags.length ? tags.join(", ") : "none"],
        ["id:", val.entry.id],
        ["hash:", val.entry.hash],
      );
      return columns(rows);
    });
  },
};

/** the `stat`, `meta`, and `content` commands */
export const statCommands: Registry = {
  stat: statCommand,
  meta: metaCommand,
  content: contentCommand,
};
