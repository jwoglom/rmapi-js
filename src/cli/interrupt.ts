/**
 * saving work when a run is interrupted
 *
 * Listing a large account costs thousands of requests, and every one of them
 * fills the hash cache. Without this, a ctrl-c halfway through throws all of
 * that away, so the next attempt is exactly as slow. The signal handler built
 * here persists whatever has been fetched before exiting.
 *
 * The handler itself is pure so it can be tested without sending signals;
 * `main.ts` is the only module that registers it with `process`.
 */
import type { RemarkableApi } from "../index.js";
import type { Diagnostic } from "./format.js";

/** the signals a run persists its cache on */
export type Signal = "SIGINT" | "SIGTERM";

/** the conventional exit code for a run killed by a signal, 128 plus its number */
const codes: Readonly<Record<Signal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** what the interrupt handler needs */
export interface InterruptOptions {
  /**
   * the api this run built, or undefined if it never built one
   *
   * This is a function rather than a value because the api is created lazily,
   * after the handler is installed.
   */
  api: () => RemarkableApi | undefined;
  /** whether the cache should be persisted at all, i.e. `--no-cache` wasn't given */
  cache: boolean;
  /** persist a cache dump */
  writeCache: (dump: string) => Promise<void>;
  /** end the process with the given code */
  exit: (code: number) => void;
  /** where to report what's happening, a no-op unless `--verbose` */
  diagnostic?: Diagnostic;
}

/**
 * build a signal handler that persists the hash cache before exiting
 *
 * The returned function is synchronous, as signal handlers have to be: it
 * starts the write and exits once it settles. Nothing is written, and the exit
 * is immediate, when no api was ever built or the cache is disabled. A second
 * signal exits immediately rather than starting a second write, so an
 * impatient ctrl-c ctrl-c can't hang the process.
 *
 * @param opts - the api, whether to persist, how to write, and how to exit
 * @returns a handler to install for each signal
 */
export function interruptHandler({
  api,
  cache,
  writeCache,
  exit,
  diagnostic = () => {},
}: InterruptOptions): (signal: Signal) => void {
  let handling = false;
  return (signal: Signal): void => {
    const code = codes[signal];
    const current = api();
    if (handling) {
      diagnostic(`caught a second ${signal}, exiting without saving`);
      exit(code);
      return;
    }
    handling = true;
    if (current === undefined || !cache) {
      exit(code);
      return;
    }
    diagnostic(`caught ${signal}, saving the hash cache before exiting`);
    void (async (): Promise<void> => {
      try {
        await writeCache(current.dumpCache());
      } catch {
        // the run is already over; a cache we couldn't save is not worth an
        // error on the way out
      }
      exit(code);
    })();
  };
}
