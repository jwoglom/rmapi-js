/**
 * hex-encode bytes
 *
 * @remarks
 * This exists instead of `Uint8Array.prototype.toHex()`, which is part of the
 * uint8array-base64/hex proposal. That is implemented in bun and in node 24+,
 * but not in node 22, which `engines` still supports, nor in every browser this
 * library targets. Calling it there fails at runtime with "toHex is not a
 * function", and only on the write paths, so reads look perfectly healthy.
 *
 * @param bytes - the bytes to encode
 * @returns the lowercase hex encoding, two characters per byte
 */
export function toHex(bytes: Uint8Array): string {
  let res = "";
  for (const byte of bytes) {
    res += byte.toString(16).padStart(2, "0");
  }
  return res;
}

/**
 * decode a hex string into bytes
 *
 * The portable counterpart to `Uint8Array.fromHex()`; see {@link toHex} for why
 * that isn't used.
 *
 * @param hex - an even-length string of hex digits
 * @returns the decoded bytes
 * @throws if `hex` has an odd length or contains a non-hex digit, matching what
 *   `Uint8Array.fromHex()` does rather than silently producing `NaN` bytes
 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(
      `hex string must have an even length, but got ${hex.length}`,
    );
  }
  const res = new Uint8Array(hex.length / 2);
  for (let i = 0; i < res.length; ++i) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex digit in '${hex}' at offset ${i * 2}`);
    }
    res[i] = byte;
  }
  return res;
}

/**
 * base64-encode bytes
 *
 * The portable counterpart to `Uint8Array.prototype.toBase64()`; see
 * {@link toHex} for why that isn't used. `btoa` is used rather than `Buffer` so
 * this keeps working in the browser bundle.
 *
 * @param bytes - the bytes to encode
 * @returns the base64 encoding
 */
export function toBase64(bytes: Uint8Array): string {
  // built one character at a time rather than with String.fromCharCode(...bytes)
  // so that a large input can't blow the argument limit
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

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
