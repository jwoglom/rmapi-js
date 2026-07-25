/**
 * persistent cli state
 *
 * The config holds the device token, an optionally cached session token, and
 * any host overrides. The hash cache the library uses is persisted separately
 * since it's large and churns on every invocation.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** the persisted cli configuration */
export interface Config {
  /**
   * the device token from `auth register`
   *
   * This never expires, so it's the only credential that has to be stored.
   */
  deviceToken?: string;
  /**
   * a cached session token
   *
   * Session tokens expire, so this is a cache; when a request fails with a 401
   * it's discarded and a new one is fetched with the device token.
   */
  sessionToken?: string;
  /** an override for the host used for authorization requests */
  authHost?: string;
  /** an override for the host used for low-level api requests */
  rawHost?: string;
  /** an override for the host used for upload requests */
  uploadHost?: string;
}

/** where a store keeps its state, for commands that report locations */
export interface StorePaths {
  /** the directory holding the state */
  dir: string;
  /** the file holding the {@link Config | `Config`} */
  config: string;
  /** the file holding the persisted hash cache */
  cache: string;
}

/**
 * where the cli reads and writes its state
 *
 * Tokens flow through this interface, so implementations must never log their
 * contents.
 */
export interface ConfigStore {
  /**
   * where this store keeps its state
   *
   * Reported by `cache path`, so that it names the files actually in use rather
   * than recomputing them from the environment.
   */
  paths(): StorePaths;
  /** read the current config, an absent config reads as `{}` */
  read(): Promise<Config>;

  /**
   * merge updates into the persisted config
   *
   * Keys that are present with an `undefined` value are removed, so
   * `write({ sessionToken: undefined })` invalidates a cached session token.
   *
   * @param update - the fields to change
   */
  write(update: Partial<Config>): Promise<void>;

  /**
   * read the persisted hash cache
   *
   * @returns the dump from {@link RemarkableApi.dumpCache | `dumpCache`}, or
   *     undefined if nothing was persisted
   */
  readCache(): Promise<string | undefined>;

  /**
   * persist a hash cache
   *
   * @param dump - the result of {@link RemarkableApi.dumpCache | `dumpCache`}
   */
  writeCache(dump: string): Promise<void>;

  /**
   * remove the persisted hash cache entirely
   *
   * This deletes the cache rather than writing an empty one, so that a cleared
   * cache is indistinguishable from one that was never written. Removing an
   * absent cache is not an error.
   *
   * @returns true if a cache was actually removed
   */
  removeCache(): Promise<boolean>;
}

/** only readable and writable by the current user, these hold credentials */
const fileMode = 0o600;

const config: z.ZodType<Config> = z.object({
  deviceToken: z.string().optional(),
  sessionToken: z.string().optional(),
  authHost: z.string().optional(),
  rawHost: z.string().optional(),
  uploadHost: z.string().optional(),
});

/**
 * the directory the cli stores its state in
 *
 * `RMAPI_CONFIG_DIR` wins, then `$XDG_CONFIG_HOME/rmapi-js`, then
 * `~/.config/rmapi-js`.
 *
 * @param env - the environment to read overrides from
 */
export function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const { RMAPI_CONFIG_DIR: explicit, XDG_CONFIG_HOME: xdg } = env;
  if (explicit) {
    return explicit;
  }
  return xdg ? join(xdg, "rmapi-js") : join(homedir(), ".config", "rmapi-js");
}

/** options for {@link fileStore | `fileStore`} */
export interface FileStoreOptions {
  /** the environment used to pick the default directory */
  env?: Readonly<Record<string, string | undefined>>;
  /** an explicit path for the hash cache, e.g. from `--cache-file` */
  cacheFile?: string;
}

function isMissing(ex: unknown): boolean {
  return (
    typeof ex === "object" &&
    ex !== null &&
    "code" in ex &&
    (ex as { code: unknown }).code === "ENOENT"
  );
}

/** the file backed store, the only one the cli uses in anger */
class FileStore implements ConfigStore {
  readonly #configFile: string;
  readonly #cacheFile: string;
  readonly #dir: string;

  constructor(dir: string, cacheFile: string | undefined) {
    this.#dir = dir;
    this.#configFile = join(dir, "config.json");
    this.#cacheFile = cacheFile ?? join(dir, "cache.json");
  }

  paths(): StorePaths {
    return {
      dir: this.#dir,
      config: this.#configFile,
      cache: this.#cacheFile,
    };
  }

  async #readJson(file: string): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (ex) {
      if (isMissing(ex)) {
        return undefined;
      }
      throw ex;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `'${file}' was not valid json; it's likely corrupted. Either fix its format, or delete it to start over.`,
      );
    }
  }

  async #write(file: string, text: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: fileMode });
  }

  async read(): Promise<Config> {
    const raw = await this.#readJson(this.#configFile);
    if (raw === undefined) {
      return {};
    }
    const parsed = config.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `'${this.#configFile}' was not a valid rmapi config; it's likely corrupted. Either fix its format, or delete it and run 'rmapi auth register' again.`,
      );
    }
    return parsed.data;
  }

  async write(update: Partial<Config>): Promise<void> {
    const current = await this.read();
    const merged: Config = { ...current, ...update };
    // an explicit undefined means "forget this"
    for (const key of Object.keys(update) as (keyof Config)[]) {
      if (update[key] === undefined) {
        delete merged[key];
      }
    }
    await this.#write(this.#configFile, `${JSON.stringify(merged, null, 2)}\n`);
  }

  async readCache(): Promise<string | undefined> {
    try {
      return await readFile(this.#cacheFile, "utf8");
    } catch (ex) {
      if (isMissing(ex)) {
        return undefined;
      }
      throw ex;
    }
  }

  async writeCache(dump: string): Promise<void> {
    await this.#write(this.#cacheFile, dump);
  }

  async removeCache(): Promise<boolean> {
    try {
      await rm(this.#cacheFile);
      return true;
    } catch (ex) {
      if (isMissing(ex)) {
        return false;
      }
      throw ex;
    }
  }
}

/**
 * create a store backed by files on disk
 *
 * Both files are written with mode 0o600 since they hold credentials. Missing
 * files read as empty, but malformed files raise an actionable error.
 *
 * @param dir - the directory to store state in, defaults to
 *     {@link defaultConfigDir | `defaultConfigDir`}
 * @param opts - the environment used for the default directory and an optional
 *     explicit cache file path
 */
export function fileStore(
  dir?: string,
  { env = {}, cacheFile }: FileStoreOptions = {},
): ConfigStore {
  return new FileStore(dir ?? defaultConfigDir(env), cacheFile);
}
