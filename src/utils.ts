export function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * map over `items` with at most `limit` calls to `fn` in flight at once
 *
 * This is a bounded-concurrency version of
 * `Promise.all(items.map(fn))`. It behaves identically from the outside: the
 * results are in the same order as the inputs, and the returned promise
 * rejects with the first rejection encountered. The only difference is that at
 * most `limit` invocations of `fn` are outstanding at any point in time, which
 * keeps large inputs from opening thousands of simultaneous requests.
 *
 * @example
 * ```ts
 * const metadatas = await mapPool(ids, 16, (id) => fetchMetadata(id));
 * ```
 *
 * @remarks
 * Like `Promise.all`, a rejection doesn't cancel work that has already
 * started, but no worker claims a new item once a rejection has happened, so
 * the remaining items are simply never started.
 *
 * @typeParam T - the type of the input items
 * @typeParam U - the type of the mapped results
 * @param items - the items to map over
 * @param limit - the maximum number of simultaneous calls to `fn`, must be a
 *   positive integer
 * @param fn - the mapping function, called with each item and its index
 * @returns the mapped results, in the same order as `items`
 */
export async function mapPool<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => U | Promise<U>,
): Promise<U[]> {
  if (limit < 1) {
    throw new Error(`limit must be a positive integer, but got ${limit}`);
  }
  const results = new Array<U>(items.length);
  let next = 0;
  let failed = false;
  // each worker pulls the next unclaimed index until they're exhausted, so at
  // most `workers` calls to `fn` are ever in flight
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (err) {
        // stop every worker from claiming more work, then let `Promise.all`
        // surface this as the overall rejection
        failed = true;
        throw err;
      }
    }
  };
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
