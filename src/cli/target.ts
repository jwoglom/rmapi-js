/**
 * resolving command line targets against the cloud
 *
 * Commands take targets as paths, ids, or hashes (see
 * {@link resolveTarget | `resolveTarget`}), which all require the full entry
 * list to interpret. This module is the one place that fetches that list and
 * hands back entries, so every command addresses items the same way.
 */
import type { Entry } from "../index.js";
import type { Context } from "./args.js";
import { resolveMany, resolveTarget } from "./paths.js";

/** options for resolving targets */
export interface TargetOptions {
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
 * @param ctx - the command context
 * @returns every entry in the cloud, including nested ones
 */
export async function entries(ctx: Context): Promise<Entry[]> {
  const api = await ctx.api();
  return await api.listItems(ctx.refresh);
}

/**
 * resolve a single target to its entry
 *
 * @param ctx - the command context
 * @param target - a path, id, or hash, as written on the command line
 * @param opts - resolution options, defaulting `first` to the global `--first`
 * @throws TargetNotFoundError if nothing matches
 * @throws AmbiguousTargetError if a path matches several entries and `first` is unset
 */
export async function target(
  ctx: Context,
  target: string,
  { first = ctx.first }: TargetOptions = {},
): Promise<Entry> {
  return resolveTarget(await entries(ctx), target, { first });
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
 * @returns the resolved entries, in the order their targets were given
 */
export async function targets(
  ctx: Context,
  targets: readonly string[],
  { first = ctx.first }: TargetOptions = {},
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
  return resolveMany(await entries(ctx), expanded, { first });
}
