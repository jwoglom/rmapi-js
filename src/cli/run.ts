/**
 * running a command and persisting whatever it cached
 *
 * This lives outside `main.ts` so it can be tested; `main.ts` itself runs the
 * cli as a side effect of being imported.
 */
import type { RemarkableApi } from "../index.js";

/** what {@link runCommand | `runCommand`} needs to persist a cache */
export interface RunOptions {
  /**
   * the api the command used, or undefined if it never asked for one
   *
   * This is a callback rather than a value because the api is created lazily,
   * during the run.
   */
  api: () => RemarkableApi | undefined;
  /** whether the persisted cache is in use, e.g. false for `--no-cache` */
  cache: boolean;
  /** persist a cache dump */
  writeCache: (dump: string) => Promise<void>;
}

/**
 * run a command, persisting the hash cache whether or not it succeeded
 *
 * Everything reMarkable stores is addressed by the hash of its contents, so a
 * hash read once stays valid forever. A command that fails part way through a
 * long listing has still done real work, and discarding it makes every retry
 * pay for the same requests again, so the cache is written in a `finally`.
 *
 * @param run - the command invocation
 * @param opts - how to reach the api and persist its cache
 * @returns whatever `run` returned
 * @throws whatever `run` threw, after the cache has been persisted
 */
export async function runCommand(
  run: () => Promise<void>,
  { api, cache, writeCache }: RunOptions,
): Promise<void> {
  try {
    await run();
  } finally {
    const instance = api();
    if (instance !== undefined && cache) {
      await writeCache(instance.dumpCache());
    }
  }
}
