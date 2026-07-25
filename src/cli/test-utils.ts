import type { RemarkableApi } from "../index.js";
import type { Context, Globals } from "./args.js";
import type { Config, ConfigStore, StorePaths } from "./config.js";
import { type Diagnostic, diagnostics, type Output, output } from "./format.js";

/** an in-memory config store, with the persisted state visible for assertions */
export interface MemStore extends ConfigStore {
  /** the current config, as it would be persisted */
  readonly state: Config;
  /** the current hash cache dump, or undefined if nothing was written */
  readonly cache: string | undefined;
}

/**
 * create an in-memory config store
 *
 * @param initial - the config to start with
 * @param initialCache - the hash cache dump to start with
 */
export function memStore(
  initial: Config = {},
  initialCache?: string,
): MemStore {
  let config: Config = { ...initial };
  let cache = initialCache;
  return {
    paths(): StorePaths {
      return {
        dir: "/mem",
        config: "/mem/config.json",
        cache: "/mem/cache.json",
      };
    },
    get state(): Config {
      return { ...config };
    },
    get cache(): string | undefined {
      return cache;
    },
    read(): Promise<Config> {
      return Promise.resolve({ ...config });
    },
    write(update: Partial<Config>): Promise<void> {
      const merged: Config = { ...config, ...update };
      for (const key of Object.keys(update) as (keyof Config)[]) {
        if (update[key] === undefined) {
          delete merged[key];
        }
      }
      config = merged;
      return Promise.resolve();
    },
    readCache(): Promise<string | undefined> {
      return Promise.resolve(cache);
    },
    writeCache(dump: string): Promise<void> {
      cache = dump;
      return Promise.resolve();
    },
    removeCache(): Promise<boolean> {
      const had = cache !== undefined;
      cache = undefined;
      return Promise.resolve(had);
    },
  };
}

/** an output that captures everything written to it */
export interface CapturedOutput {
  /** the output to hand to commands */
  readonly out: Output;
  /** every chunk written, in order */
  readonly written: readonly string[];
  /** everything written, joined */
  text(): string;
  /** everything written, parsed as json, for `json: true` outputs */
  json(): unknown;
}

/**
 * create an output that captures what it's given
 *
 * @param opts - whether to emit json, and whether to emit color (default false
 *     so assertions don't have to strip escapes)
 */
export function captureOutput({
  json = false,
  color = false,
}: {
  json?: boolean;
  color?: boolean;
} = {}): CapturedOutput {
  const written: string[] = [];
  const out = output({ json, color }, (text) => void written.push(text));
  return {
    out,
    written,
    text(): string {
      return written.join("");
    },
    json(): unknown {
      return JSON.parse(written.join("")) as unknown;
    },
  };
}

/** how a command called `listItems` */
export interface ListItemsCall {
  /** the `refresh` argument, undefined when it wasn't passed */
  readonly refresh: boolean | undefined;
  /** the `includeContent` argument, undefined when it wasn't passed */
  readonly includeContent: boolean | undefined;
}

/** an api whose `listItems` calls are recorded */
export interface WatchedApi {
  /** the api to hand to commands */
  readonly api: RemarkableApi;
  /** every `listItems` call, in order */
  readonly calls: readonly ListItemsCall[];
}

/**
 * wrap an api so its `listItems` arguments can be asserted on
 *
 * Content costs an extra request per item, so commands that don't need it must
 * pass `includeContent` as false; this is how a spec proves that.
 *
 * @param api - the api to wrap, whose `listItems` is still what runs
 */
export function watchListItems(api: RemarkableApi): WatchedApi {
  const calls: ListItemsCall[] = [];
  const watched = new Proxy(api, {
    get(target, prop, receiver): unknown {
      if (prop !== "listItems") {
        return Reflect.get(target, prop, receiver) as unknown;
      }
      return (
        refresh?: boolean,
        includeContent?: boolean,
      ): Promise<unknown[]> => {
        calls.push({ refresh, includeContent });
        return target.listItems(refresh, includeContent);
      };
    },
  });
  return { api: watched, calls };
}

/** a diagnostic that records what it was asked to emit */
export interface CapturedDiagnostics {
  /** the diagnostic to hand to commands */
  readonly diagnostic: Diagnostic;
  /** every line written, in order, with the `rmapi: ` prefix stripped */
  readonly messages: readonly string[];
}

/**
 * create a diagnostic that captures what it's given
 *
 * The real gating is used, so a diagnostic created with `verbose: false`
 * records nothing, exactly as the cli behaves.
 *
 * @param opts - whether `--verbose` was given, false by default
 */
export function captureDiagnostics({
  verbose = false,
}: {
  verbose?: boolean;
} = {}): CapturedDiagnostics {
  const messages: string[] = [];
  const diagnostic = diagnostics(
    verbose,
    (text) => void messages.push(text.replace(/^rmapi: /, "").trimEnd()),
  );
  return { diagnostic, messages };
}

/** the global settings a test context starts from */
export const defaultGlobals: Globals = {
  json: false,
  refresh: false,
  cache: true,
  cacheFile: undefined,
  configDir: undefined,
  authHost: undefined,
  rawHost: undefined,
  uploadHost: undefined,
  retries: 3,
  verbose: false,
  quiet: false,
  yes: false,
  first: false,
};

/** options for {@link testContext | `testContext`} */
export interface TestContextOptions extends Partial<Globals> {
  /** the api commands get, calling `api()` throws if this is omitted */
  api?: RemarkableApi;
  /** the store commands get, an empty {@link memStore | `memStore`} by default */
  config?: ConfigStore;
  /** the output commands write to */
  out?: Output;
  /**
   * where commands write progress diagnostics
   *
   * Defaults to one gated on the `verbose` global, so it drops everything
   * unless the context was made verbose. Pass a
   * {@link captureDiagnostics | `captureDiagnostics`} diagnostic to assert on
   * them.
   */
  diagnostic?: Diagnostic;
  /** the environment commands see */
  env?: Readonly<Record<string, string | undefined>>;
  /** the text commands read when they accept `-` for stdin */
  stdin?: string;
}

/**
 * create a context for testing commands
 *
 * @param opts - the api, store, output, environment, and any global overrides
 */
export function testContext({
  api,
  config = memStore(),
  out = captureOutput().out,
  diagnostic,
  env = {},
  stdin = "",
  ...globals
}: TestContextOptions = {}): Context {
  const merged: Globals = { ...defaultGlobals, ...globals };
  return {
    ...merged,
    out,
    diagnostic:
      diagnostic ?? captureDiagnostics({ verbose: merged.verbose }).diagnostic,
    config,
    env,
    stdin(): Promise<string> {
      return Promise.resolve(stdin);
    },
    api(): Promise<RemarkableApi> {
      if (api === undefined) {
        return Promise.reject(new Error("test context had no api"));
      }
      return Promise.resolve(api);
    },
  };
}
