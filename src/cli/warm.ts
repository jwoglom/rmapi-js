/**
 * warming the hash cache one item at a time
 *
 * {@link RemarkableApi.listItems | `listItems`} is all or nothing: it fetches
 * every item and reports nothing until it's done. This module makes the same
 * requests item by item through {@link RemarkableApi.raw | `raw`}, so a caller
 * can bound how many items it touches, watch progress, and count the calls it
 * issued.
 *
 * Everything the library reads goes through the same per-hash cache, so items
 * warmed here are free for a later `listItems`, and a partially finished warm
 * still pays off as long as the cache is persisted.
 */
import type { RemarkableApi, SimpleEntry } from "../index.js";
import { mapPool } from "../utils.js";

/** how many item fetches to keep in flight, matching the library's own pool */
export const poolLimit = 16;

/** options for {@link warmItems | `warmItems`} */
export interface WarmOptions {
  /**
   * also fetch each item's content
   *
   * Content holds an item's file type and tags, and costs one extra request per
   * item. Defaults to false, the cheap path.
   */
  content?: boolean;
  /** how many item fetches to keep in flight, {@link poolLimit} by default */
  limit?: number;
  /**
   * called as items finish, with how many are done and how many there are
   *
   * Called at most once per {@link WarmOptions.every | `every`} items, plus once
   * when everything is done.
   */
  progress?: (done: number, total: number) => void;
  /** how many items to finish between `progress` calls, 100 by default */
  every?: number;
}

/** what a warm run did */
export interface WarmResult {
  /** how many items were warmed */
  items: number;
  /**
   * how many calls into the raw api were issued
   *
   * This counts calls, not network requests: a call whose hash was already
   * cached makes no request at all. It is an upper bound on the requests the
   * warm caused.
   */
  rawCalls: number;
}

/**
 * fetch the metadata, and optionally the content, of the given items
 *
 * The results are thrown away; the point is the cache they leave behind. Items
 * whose entry list has no metadata are skipped rather than failing the run, so
 * that one malformed item doesn't sink a warm.
 *
 * @param api - the api to fetch through
 * @param ids - the items to warm, as returned by
 *   {@link RemarkableApi.listIds | `listIds`}
 * @param opts - whether to include content, the pool size, and progress
 * @returns how many items were warmed and how many raw calls that took
 */
export async function warmItems(
  api: RemarkableApi,
  ids: readonly SimpleEntry[],
  {
    content = false,
    limit = poolLimit,
    progress,
    every = 100,
  }: WarmOptions = {},
): Promise<WarmResult> {
  let rawCalls = 0;
  let done = 0;
  const total = ids.length;
  await mapPool(ids, limit, async ({ id, hash }) => {
    ++rawCalls;
    const { entries } = await api.raw.getEntries(`${id}.docSchema`, hash);
    const meta = entries.find((ent) => ent.id.endsWith(".metadata"));
    const cont = content
      ? entries.find((ent) => ent.id.endsWith(".content"))
      : undefined;
    const fetches: Promise<unknown>[] = [];
    if (meta !== undefined) {
      ++rawCalls;
      fetches.push(api.raw.getMetadata(meta.id, meta.hash));
    }
    if (cont !== undefined) {
      ++rawCalls;
      fetches.push(api.raw.getContent(cont.id, cont.hash));
    }
    await Promise.all(fetches);
    ++done;
    if (progress !== undefined && (done % every === 0 || done === total)) {
      progress(done, total);
    }
  });
  return { items: total, rawCalls };
}
