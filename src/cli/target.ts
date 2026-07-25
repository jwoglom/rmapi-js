/**
 * resolving command line targets against the cloud
 *
 * Commands take targets as paths, ids, or hashes (see
 * {@link resolveTarget | `resolveTarget`}), which all require the full entry
 * list to interpret. This module is the one place that fetches that list and
 * hands back entries, so every command addresses items the same way.
 *
 * Listing is the expensive part of most commands: every item costs two requests
 * for its entry list and metadata, plus a third for its content. Content only
 * carries an item's file type and tags, so it is opt in here — a command that
 * says nothing gets the cheap listing, and one that reads
 * {@link DocumentType.fileType | `fileType`} or
 * {@link EntryCommon.tags | `tags`} has to ask.
 */
import type { Entry } from "../index.js";
import type { Context } from "./args.js";
import { resolveMany, resolveTarget } from "./paths.js";
import { warmItems } from "./warm.js";

/** what a command needs from the entry list */
export interface EntriesOptions {
  /**
   * fetch each item's content as well as its metadata
   *
   * This populates {@link DocumentType.fileType | `fileType`} and
   * {@link EntryCommon.tags | `tags`}, which are undefined otherwise, at the
   * cost of one extra request per item. Defaults to false, so only the commands
   * that read those two fields pay for them.
   */
  content?: boolean;
}

/** options for resolving targets */
export interface TargetOptions extends EntriesOptions {
  /**
   * take the first match when a path is ambiguous
   *
   * Sibling entries may share a `visibleName`, in which case resolution throws
   * an {@link AmbiguousTargetError | `AmbiguousTargetError`} unless this is set.
   * Defaults to the global `--first` flag, so commands get it for free.
   */
  first?: boolean;
}

/**
 * fetch every entry, honoring the global `--refresh` flag
 *
 * @remarks
 * Under `--verbose` the item count is fetched first, with the cheap
 * {@link RemarkableApi.listIds | `listIds`} call the listing needs anyway, and
 * the items are then warmed one at a time so progress can be reported. That
 * makes exactly the requests the listing would have made; the listing itself is
 * then served from the cache.
 *
 * @param ctx - the command context
 * @param opts - whether the caller needs each item's content, default false
 * @returns every entry in the cloud, including nested ones
 */
export async function entries(
  ctx: Context,
  { content = false }: EntriesOptions = {},
): Promise<Entry[]> {
  const api = await ctx.api();
  if (!ctx.verbose) {
    return await api.listItems(ctx.refresh, content);
  }
  const ids = await api.listIds(ctx.refresh);
  ctx.diagnostic(
    `resolving ${String(ids.length)} items (${content ? "metadata and content" : "metadata only"})`,
  );
  const { rawCalls } = await warmItems(api, ids, {
    content,
    progress: (done, total) => {
      ctx.diagnostic(`resolved ${String(done)}/${String(total)} items`);
    },
  });
  ctx.diagnostic(`fetched ${String(rawCalls)} objects, building the listing`);
  // the root hash is already resolved, and every item is cached, so this makes
  // no further requests
  return await api.listItems(false, content);
}

/**
 * resolve a single target to its entry
 *
 * @param ctx - the command context
 * @param target - a path, id, or hash, as written on the command line
 * @param opts - resolution options, defaulting `first` to the global `--first`
 *     and fetching no content
 * @throws TargetNotFoundError if nothing matches
 * @throws AmbiguousTargetError if a path matches several entries and `first` is unset
 */
export async function target(
  ctx: Context,
  target: string,
  { first = ctx.first, content = false }: TargetOptions = {},
): Promise<Entry> {
  return resolveTarget(await entries(ctx, { content }), target, { first });
}

/**
 * resolve several targets, expanding `-` to lines read from stdin
 *
 * The entry list is fetched once, so this is what bulk commands should use
 * rather than calling {@link target | `target`} in a loop.
 *
 * @param ctx - the command context
 * @param targets - paths, ids, or hashes; a lone `-` reads targets from stdin
 * @param opts - resolution options, defaulting `first` to the global `--first`
 *     and fetching no content
 * @returns the resolved entries, in the order their targets were given
 */
export async function targets(
  ctx: Context,
  targets: readonly string[],
  { first = ctx.first, content = false }: TargetOptions = {},
): Promise<Entry[]> {
  const expanded = targets.includes("-")
    ? [
        ...targets.filter((val) => val !== "-"),
        ...(await ctx.stdin())
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      ]
    : targets;
  return resolveMany(await entries(ctx, { content }), expanded, { first });
}
