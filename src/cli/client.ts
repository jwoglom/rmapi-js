/**
 * building the api the cli talks to
 *
 * The cli deliberately uses {@link auth | `auth`} and {@link session |
 * `session`} instead of {@link remarkable | `remarkable`} so the session token
 * can be cached in the {@link ConfigStore | `ConfigStore`} and reused across
 * invocations. A stale cached token surfaces as a 401, which triggers exactly
 * one re-authorization and retry.
 */
import {
  auth,
  GenerationError,
  type RawRemarkableApi,
  type RemarkableApi,
  ResponseError,
  session,
} from "../index.js";
import type { Config, ConfigStore } from "./config.js";
import { AuthError } from "./error.js";

/** the hosts the api talks to, undefined fields use the library defaults */
export interface Hosts {
  /** the host for authorization requests */
  authHost?: string;
  /** the host for low-level api requests */
  rawHost?: string;
  /** the host for upload requests */
  uploadHost?: string;
}

/**
 * resolve the hosts to use
 *
 * Precedence is command line flags, then the environment
 * (`RMAPI_AUTH_HOST`, `RMAPI_RAW_HOST`, `RMAPI_UPLOAD_HOST`), then the config
 * file. Anything still unset is left undefined so the library's own defaults
 * apply.
 *
 * @param flags - hosts given on the command line
 * @param env - the environment to read
 * @param config - the persisted config
 */
export function resolveHosts(
  flags: Hosts,
  env: Readonly<Record<string, string | undefined>>,
  config: Config,
): Hosts {
  const { RMAPI_AUTH_HOST, RMAPI_RAW_HOST, RMAPI_UPLOAD_HOST } = env;
  return {
    authHost: flags.authHost ?? RMAPI_AUTH_HOST ?? config.authHost,
    rawHost: flags.rawHost ?? RMAPI_RAW_HOST ?? config.rawHost,
    uploadHost: flags.uploadHost ?? RMAPI_UPLOAD_HOST ?? config.uploadHost,
  };
}

/**
 * resolve the device token to use
 *
 * `RMAPI_DEVICE_TOKEN` wins over the config file.
 *
 * @param env - the environment to read
 * @param config - the persisted config
 * @throws AuthError if no device token is available
 */
export function resolveDeviceToken(
  env: Readonly<Record<string, string | undefined>>,
  config: Config,
): string {
  const { RMAPI_DEVICE_TOKEN } = env;
  const token = RMAPI_DEVICE_TOKEN ?? config.deviceToken;
  if (!token) {
    throw new AuthError(
      "no device token found; run 'rmapi auth register <code>' with a code from https://my.remarkable.com/device/apps/connect, or set RMAPI_DEVICE_TOKEN",
    );
  }
  return token;
}

/** true if an error indicates the session token is no longer valid */
function unauthorized(ex: unknown): boolean {
  return ex instanceof ResponseError && ex.status === 401;
}

/** methods that aren't requests, and so can't fail with a 401 */
const syncMethods: ReadonlySet<string> = new Set(["dumpCache", "clearCache"]);

type AnyMethod = (...args: never[]) => unknown;

/** run an operation against the current api, refreshing the session on a 401 */
type Runner = <T>(op: (api: RemarkableApi) => Promise<T>) => Promise<T>;

/**
 * forward every method of `target` through `run`
 *
 * Methods are looked up lazily so that a refreshed api instance is picked up by
 * anything holding a reference to the proxy.
 */
function forward<T extends object>(
  get: () => T,
  run: (op: (target: T) => Promise<unknown>) => Promise<unknown>,
  extra: Readonly<Record<string, unknown>> = {},
): T {
  return new Proxy({} as T, {
    get(_, prop): unknown {
      if (typeof prop === "string" && prop in extra) {
        return extra[prop];
      }
      const target = get();
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") {
        return value;
      } else if (typeof prop === "string" && syncMethods.has(prop)) {
        return (value as AnyMethod).bind(target);
      } else {
        return (...args: never[]): Promise<unknown> =>
          run((current) => {
            const method = (current as Record<string | symbol, unknown>)[
              prop
            ] as AnyMethod;
            return Promise.resolve(
              method.apply(current, args),
            ) as Promise<unknown>;
          });
      }
    },
  });
}

/** holds the current api instance, and swaps it out when the session expires */
class Session {
  #api: RemarkableApi;
  #refreshed = false;
  readonly #store: ConfigStore;
  readonly #deviceToken: string;
  readonly #hosts: Hosts;

  constructor(
    api: RemarkableApi,
    store: ConfigStore,
    deviceToken: string,
    hosts: Hosts,
  ) {
    this.#api = api;
    this.#store = store;
    this.#deviceToken = deviceToken;
    this.#hosts = hosts;
  }

  async #reauth(): Promise<void> {
    const token = await auth(this.#deviceToken, {
      authHost: this.#hosts.authHost,
    });
    await this.#store.write({ sessionToken: token });
    this.#api = session(token, {
      rawHost: this.#hosts.rawHost,
      uploadHost: this.#hosts.uploadHost,
      cache: this.#api.dumpCache(),
    });
  }

  get current(): RemarkableApi {
    return this.#api;
  }

  readonly run: Runner = async <T>(
    op: (api: RemarkableApi) => Promise<T>,
  ): Promise<T> => {
    try {
      return await op(this.#api);
    } catch (ex) {
      if (this.#refreshed || !unauthorized(ex)) {
        throw ex;
      }
      // the cached session token expired, get a new one and try again
      this.#refreshed = true;
      await this.#reauth();
      return await op(this.#api);
    }
  };

  api(): RemarkableApi {
    const raw = forward<RawRemarkableApi>(
      () => this.#api.raw,
      (op) => this.run((api) => op(api.raw)),
    );
    return forward<RemarkableApi>(
      () => this.#api,
      (op) => this.run(op),
      { raw },
    );
  }
}

/** options for {@link client | `client`} */
export interface ClientOptions extends Hosts {
  /** false to start without the persisted hash cache */
  cache?: boolean;
  /** the environment to read overrides from */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * build an api instance for the cli
 *
 * The session token stored in `store` is reused if present, and refreshed
 * exactly once if a request comes back unauthorized. The persisted hash cache
 * is loaded unless disabled; persist the new one with
 * {@link RemarkableApi.dumpCache | `dumpCache`} after a successful run.
 *
 * @param store - where credentials and the hash cache live
 * @param opts - host overrides, the environment, and whether to use the cache
 */
export async function client(
  store: ConfigStore,
  { authHost, rawHost, uploadHost, cache = true, env = {} }: ClientOptions = {},
): Promise<RemarkableApi> {
  const config = await store.read();
  const hosts = resolveHosts({ authHost, rawHost, uploadHost }, env, config);
  const deviceToken = resolveDeviceToken(env, config);

  let sessionToken = config.sessionToken;
  if (!sessionToken) {
    sessionToken = await auth(deviceToken, { authHost: hosts.authHost });
    await store.write({ sessionToken });
  }

  const initial = session(sessionToken, {
    rawHost: hosts.rawHost,
    uploadHost: hosts.uploadHost,
    cache: cache ? await store.readCache() : undefined,
  });
  return new Session(initial, store, deviceToken, hosts).api();
}

/** how long to wait between generation retries */
export interface BackoffOptions {
  /**
   * the delay in milliseconds before the given (zero indexed) retry
   *
   * @defaultValue exponential with up to 100% jitter
   */
  backoff?: (retry: number) => number;
  /** wait for the given number of milliseconds */
  sleep?: (millis: number) => Promise<void>;
}

const defaultBackoff = (retry: number): number =>
  2 ** retry * 50 * (1 + Math.random());

const defaultSleep = (millis: number): Promise<void> =>
  new Promise((res) => setTimeout(res, millis));

/**
 * retry an operation that can fail with a stale root generation
 *
 * The first attempt is passed `refresh: false`, every retry is passed
 * `refresh: true` so the operation refetches the root hash. Only
 * {@link GenerationError | `GenerationError`} is retried, everything else
 * propagates immediately.
 *
 * @param retries - how many times to retry after the first attempt
 * @param op - the operation, called with whether it should refresh first
 * @param opts - injectable backoff and sleep, for tests
 * @throws GenerationError if every attempt hits a stale generation
 */
export async function withGeneration<T>(
  retries: number,
  op: (refresh: boolean) => Promise<T>,
  { backoff = defaultBackoff, sleep = defaultSleep }: BackoffOptions = {},
): Promise<T> {
  for (let attempt = 0; ; ++attempt) {
    try {
      return await op(attempt > 0);
    } catch (ex) {
      if (!(ex instanceof GenerationError) || attempt >= retries) {
        throw ex;
      }
      await sleep(backoff(attempt));
    }
  }
}
