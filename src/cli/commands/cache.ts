/**
 * inspecting and maintaining the persisted hash cache
 *
 * reMarkable addresses everything by the hash of its contents, so anything we
 * have read or written can be cached forever. That cache is append only, so it
 * grows without bound until it's pruned; these commands expose that
 * maintenance.
 *
 * `cache load` goes the other way, deliberately reading ahead so that later
 * commands find what they need already cached.
 *
 * `cache path` and `cache info` only read {@link ConfigStore | `ConfigStore`},
 * so they work without a device token and without a network.
 */
import { writeFile } from "node:fs/promises";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  type FlagValue,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { UsageError } from "../error.js";
import { columns } from "../format.js";
import { warmItems } from "../warm.js";

/** the number of entries and characters a cache dump holds */
interface CacheStats {
  /** how many hashes the dump mentions */
  entries: number;
  /** how many of those have their contents cached, rather than just existence */
  cached: number;
  /** the total length of every cached string */
  textLength: number;
  /** the length of the serialized dump */
  bytes: number;
}

/**
 * measure a cache dump
 *
 * @param dump - a dump from {@link RemarkableApi.dumpCache | `dumpCache`}
 * @throws Error if the dump isn't a json object
 */
export function cacheStats(dump: string): CacheStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dump) as unknown;
  } catch {
    throw new Error(
      "the persisted hash cache was not valid json; it's likely corrupted. Run 'rmapi cache clear' to start over.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "the persisted hash cache was not a json object; it's likely corrupted. Run 'rmapi cache clear' to start over.",
    );
  }
  const values = Object.values(parsed as Record<string, unknown>);
  let cached = 0;
  let textLength = 0;
  for (const value of values) {
    if (typeof value === "string") {
      ++cached;
      textLength += value.length;
    }
  }
  return {
    entries: values.length,
    cached,
    textLength,
    bytes: dump.length,
  };
}

/** the result of `cache dump` */
interface DumpResult {
  /** the cache, parsed, so `--json` emits it as an object */
  cache: unknown;
  /** the file the dump was written to, if any */
  output?: string;
}

const dumpCommand: Command = {
  summary: "print the in-memory hash cache",
  usage: "",
  options: { output: { type: "string", short: "o" } },
  descriptions: { output: "write the dump to this file instead of stdout" },
  details:
    "This dumps the cache of the api this invocation built, which starts from the\npersisted cache unless --no-cache was passed.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache dump");
    const output = stringFlag(values, "output");
    const api = await ctx.api();
    const dump = api.dumpCache();
    if (output === undefined) {
      const result: DumpResult = { cache: JSON.parse(dump) as unknown };
      ctx.out.write(result, () => dump);
    } else {
      await writeFile(output, dump);
      const result: DumpResult = {
        cache: JSON.parse(dump) as unknown,
        output,
      };
      ctx.out.write(
        result,
        () => `wrote ${String(dump.length)} characters to ${output}`,
      );
    }
  },
};

/** the result of `cache prune` */
interface PruneResult {
  /** the stats before pruning */
  before: CacheStats;
  /** the stats after pruning */
  after: CacheStats;
}

const pruneCommand: Command = {
  summary: "drop unreachable hashes from the cache",
  usage: "",
  options: {},
  details:
    "Pruning walks every reachable entry list, so it costs a full traversal, and\nmay not shrink the cache at all. The pruned cache is persisted, so the saving\nsurvives to the next invocation. Pass --refresh to refetch the root hash\nfirst.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache prune");
    const api = await ctx.api();
    const before = cacheStats(api.dumpCache());
    await api.pruneCache(ctx.refresh);
    const dump = api.dumpCache();
    await ctx.config.writeCache(dump);
    const result: PruneResult = { before, after: cacheStats(dump) };
    ctx.out.write(result, (val) =>
      columns([
        [
          "entries",
          `${String(val.before.entries)} -> ${String(val.after.entries)}`,
        ],
        [
          "cached",
          `${String(val.before.cached)} -> ${String(val.after.cached)}`,
        ],
        ["bytes", `${String(val.before.bytes)} -> ${String(val.after.bytes)}`],
      ]),
    );
  },
};

const clearCommand: Command = {
  summary: "empty the hash cache",
  usage: "",
  options: {},
  details:
    "This clears the in-memory cache and deletes the persisted one. Nothing on\nreMarkable changes; the only cost is that the next few commands are slower.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache clear");
    const api = await ctx.api();
    api.clearCache();
    const removed = await ctx.config.removeCache();
    ctx.out.write({ cleared: true, removed }, ({ removed: gone }) =>
      gone ? "cleared the hash cache" : "the hash cache was already empty",
    );
  },
};

/** the result of `cache path` */
interface PathResult {
  /** the directory the cli keeps its state in */
  configDir: string;
  /** the config file, which holds the tokens */
  configFile: string;
  /** the hash cache file */
  cacheFile: string;
}

const pathCommand: Command = {
  summary: "print where the config and hash cache live",
  usage: "",
  options: {},
  details:
    "Reports the files the store is actually using, which resolve from --config,\nthen RMAPI_CONFIG_DIR, then $XDG_CONFIG_HOME/rmapi-js, then\n~/.config/rmapi-js, with --cache-file overriding the cache file. This needs\nno token and makes no requests.",
  run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache path");
    const { dir, config, cache } = ctx.config.paths();
    const result: PathResult = {
      configDir: dir,
      configFile: config,
      cacheFile: cache,
    };
    ctx.out.write(result, (val) =>
      columns([
        ["config dir", val.configDir],
        ["config file", val.configFile],
        ["cache file", val.cacheFile],
      ]),
    );
    return Promise.resolve();
  },
};

/** the result of `cache info` */
interface InfoResult extends CacheStats {
  /** whether anything is persisted at all */
  persisted: boolean;
}

const infoCommand: Command = {
  summary: "summarize the persisted hash cache",
  usage: "",
  options: {},
  details:
    "This reads the persisted cache file only; it needs no token and makes no\nrequests. `cached` counts the hashes whose contents we know, the rest are\nhashes we only know exist.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache info");
    const dump = await ctx.config.readCache();
    const result: InfoResult =
      dump === undefined
        ? {
            persisted: false,
            entries: 0,
            cached: 0,
            textLength: 0,
            bytes: 0,
          }
        : { persisted: true, ...cacheStats(dump) };
    ctx.out.write(result, (val) =>
      val.persisted
        ? columns([
            ["entries", String(val.entries)],
            ["cached", String(val.cached)],
            ["text length", String(val.textLength)],
            ["bytes", String(val.bytes)],
          ])
        : "nothing cached yet",
    );
  },
};

/** how much of the cloud a `cache load` warms */
export type LoadLevel = "entries-only" | "metadata" | "content";

/** the result of `cache load` */
interface LoadResult {
  /** how much was warmed */
  level: LoadLevel;
  /** how many items the root entry list names */
  listed: number;
  /** how many of those items were warmed */
  warmed: number;
  /**
   * how many calls into the raw api were issued
   *
   * Only present when this command drove the requests itself, which is the case
   * for `--entries-only` and for `--limit`; the library's own listing doesn't
   * report a count. Calls whose hash was already cached made no request.
   */
  requests?: number;
  /** how many hashes were fetched and cached that weren't cached before */
  newlyCached: number;
  /** whether the warmed cache was written to disk */
  persisted: boolean;
  /** the cache stats before warming */
  before: CacheStats;
  /** the cache stats after warming */
  after: CacheStats;
  /** how long the warm took, in milliseconds */
  elapsedMs: number;
}

/** the level the flags select, rejecting contradictory ones */
function loadLevel(values: Readonly<Record<string, FlagValue>>): LoadLevel {
  const entriesOnly = boolFlag(values, "entries-only");
  const content = boolFlag(values, "content");
  if (entriesOnly && content) {
    throw new UsageError(
      "--entries-only and --content are mutually exclusive",
      "cache load",
    );
  }
  return entriesOnly ? "entries-only" : content ? "content" : "metadata";
}

/** the item cap `--limit` sets, undefined for every item */
function loadLimit(
  values: Readonly<Record<string, FlagValue>>,
  level: LoadLevel,
): number | undefined {
  const raw = stringFlag(values, "limit");
  if (raw === undefined) {
    return undefined;
  }
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 0) {
    throw new UsageError(
      `--limit must be a non-negative integer, but was '${raw}'`,
      "cache load",
    );
  } else if (level === "entries-only") {
    throw new UsageError(
      "--limit doesn't apply to --entries-only, which never reads individual items",
      "cache load",
    );
  }
  return limit;
}

const loadCommand: Command = {
  summary: "warm the hash cache so later commands are fast",
  usage: "",
  options: {
    "entries-only": { type: "boolean" },
    content: { type: "boolean" },
    limit: { type: "string" },
  },
  descriptions: {
    "entries-only": "only the root hash and root entry list, two requests",
    content: "also each item's content, one extra request per item",
    limit: "warm only the first n items",
  },
  details:
    "Everything reMarkable stores is addressed by the hash of its contents, so\nanything read once can be cached forever. This deliberately reads ahead and\npersists the result, so later commands make far fewer requests.\n\nBy default every item's metadata is read, which is about two requests per\nitem; --content adds each item's file type and tags for a third; and\n--entries-only just learns which items exist. --limit stops after the first n\nitems, for a bounded taste of the work. Interrupting with ctrl-c still keeps\nwhatever was warmed. Pass -v to watch the progress.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "cache load");
    const level = loadLevel(values);
    const limit = loadLimit(values, level);

    const api = await ctx.api();
    const before = cacheStats(api.dumpCache());
    const started = Date.now();

    // this is the root hash and the root entry list, two calls, and the count
    // every level reports
    const ids = await api.listIds(ctx.refresh);
    ctx.diagnostic(`the root entry list names ${String(ids.length)} items`);
    const content = level === "content";
    let warmed: number;
    let requests: number | undefined;
    if (level === "entries-only") {
      warmed = 0;
      requests = 2;
    } else if (limit === undefined) {
      // the library's listing, which is what later commands go through
      const items = await api.listItems(false, content);
      warmed = items.length;
      requests = undefined;
    } else {
      const capped = ids.slice(0, limit);
      ctx.diagnostic(`warming the first ${String(capped.length)} items`);
      const result = await warmItems(api, capped, {
        content,
        progress: (done, total) => {
          ctx.diagnostic(`warmed ${String(done)}/${String(total)} items`);
        },
      });
      warmed = result.items;
      requests = 2 + result.rawCalls;
    }

    const dump = api.dumpCache();
    const elapsedMs = Date.now() - started;
    const after = cacheStats(dump);
    if (ctx.cache) {
      await ctx.config.writeCache(dump);
    }

    const result: LoadResult = {
      level,
      listed: ids.length,
      warmed,
      ...(requests === undefined ? {} : { requests }),
      newlyCached: after.cached - before.cached,
      persisted: ctx.cache,
      before,
      after,
      elapsedMs,
    };
    ctx.out.write(result, (val) => {
      const rows: (readonly string[])[] = [
        ["level", val.level],
        ["items listed", String(val.listed)],
        ["items warmed", String(val.warmed)],
      ];
      if (val.requests !== undefined) {
        rows.push(["raw calls", String(val.requests)]);
      }
      rows.push(
        ["hashes fetched", String(val.newlyCached)],
        [
          "entries",
          `${String(val.before.entries)} -> ${String(val.after.entries)}`,
        ],
        [
          "cached",
          `${String(val.before.cached)} -> ${String(val.after.cached)}`,
        ],
        ["bytes", `${String(val.before.bytes)} -> ${String(val.after.bytes)}`],
        ["elapsed", `${String(val.elapsedMs)}ms`],
        ["persisted", val.persisted ? "yes" : "no (--no-cache)"],
      );
      return columns(rows);
    });
  },
};

/** the `cache` family of commands */
export const cacheCommands: Registry = {
  "cache load": loadCommand,
  "cache dump": dumpCommand,
  "cache prune": pruneCommand,
  "cache clear": clearCommand,
  "cache path": pathCommand,
  "cache info": infoCommand,
};
