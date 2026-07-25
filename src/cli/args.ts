/**
 * argument parsing, the command interface, and generated help
 *
 * Commands are registered in a flat record keyed by their full name, e.g.
 * `"ls"` or `"auth register"`, and dispatch prefers the two word key over the
 * one word key.
 */
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { RemarkableApi } from "../index.js";
import type { ConfigStore } from "./config.js";
import { UsageError } from "./error.js";
import type { Output } from "./format.js";

/** the value a single parsed flag can take */
export type FlagValue = string | boolean | (string | boolean)[] | undefined;

/** the parsed flags and positionals for a command invocation */
export interface CommandArgs {
  /** every parsed flag, both global and command specific */
  readonly values: Readonly<Record<string, FlagValue>>;
  /** the positionals after the command name */
  readonly positionals: readonly string[];
}

/** the global settings resolved from the command line */
export interface Globals {
  /** emit machine readable json instead of human readable text */
  readonly json: boolean;
  /** refresh the root hash before reading */
  readonly refresh: boolean;
  /** use the persisted hash cache */
  readonly cache: boolean;
  /** an explicit path for the hash cache */
  readonly cacheFile: string | undefined;
  /** an explicit config directory */
  readonly configDir: string | undefined;
  /** override the host for authorization requests */
  readonly authHost: string | undefined;
  /** override the host for low-level api requests */
  readonly rawHost: string | undefined;
  /** override the host for upload requests */
  readonly uploadHost: string | undefined;
  /** how many times to retry operations that hit a stale generation */
  readonly retries: number;
  /** emit extra diagnostics */
  readonly verbose: boolean;
  /** suppress non-essential output */
  readonly quiet: boolean;
  /** assume yes for every confirmation */
  readonly yes: boolean;
  /**
   * resolve an ambiguous path to its first match
   *
   * Sibling entries may share a `visibleName` on reMarkable, so a path can name
   * several entries. Without this, resolution throws
   * {@link AmbiguousTargetError | `AmbiguousTargetError`}.
   */
  readonly first: boolean;
}

/** everything a command needs to do its job */
export interface Context extends Globals {
  /**
   * get the api, authorizing on first use
   *
   * This is lazy so that commands that don't touch the network, and `--help`,
   * never authorize.
   */
  api(): Promise<RemarkableApi>;
  /** the only way to emit results */
  readonly out: Output;
  /** persistent cli state */
  readonly config: ConfigStore;
  /** the environment, so commands never touch `process` */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * read all of stdin as text
   *
   * Commands that accept `-` in place of a list of targets use this, so that
   * `main.ts` stays the only module that touches `process`.
   */
  stdin(): Promise<string>;
}

/** a single cli command */
export interface Command {
  /** a one line description, shown in the top level help */
  readonly summary: string;
  /** the positionals this command takes, e.g. `"[path]"`, for its usage line */
  readonly usage: string;
  /** the flags this command accepts, in addition to the global flags */
  readonly options: ParseArgsOptionsConfig;
  /** descriptions of this command's flags, keyed by long name */
  readonly descriptions?: Readonly<Record<string, string>>;
  /** extra prose appended to this command's help */
  readonly details?: string;

  /**
   * run the command
   *
   * @param ctx - the api, output, config, and global settings
   * @param args - the parsed flags and positionals
   */
  run(ctx: Context, args: CommandArgs): Promise<void>;
}

/** every command, keyed by full command name */
export type Registry = Readonly<Record<string, Command>>;

/** the flags every command accepts */
export const globalOptions: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  refresh: { type: "boolean" },
  "no-cache": { type: "boolean" },
  "cache-file": { type: "string" },
  config: { type: "string" },
  "raw-host": { type: "string" },
  "upload-host": { type: "string" },
  "auth-host": { type: "string" },
  retries: { type: "string" },
  verbose: { type: "boolean", short: "v" },
  quiet: { type: "boolean" },
  yes: { type: "boolean" },
  first: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean" },
};

const globalDescriptions: Readonly<Record<string, string>> = {
  json: "emit json instead of formatted text",
  refresh: "refresh the root hash before reading",
  "no-cache": "ignore the persisted hash cache",
  "cache-file": "path to the hash cache file",
  config: "path to the config directory",
  "raw-host": "host for low-level api requests",
  "upload-host": "host for upload requests",
  "auth-host": "host for authorization requests",
  retries: "retries for stale generation errors (default 3)",
  verbose: "emit extra diagnostics",
  quiet: "suppress non-essential output",
  yes: "assume yes for every confirmation",
  first: "resolve ambiguous paths to the first match",
  version: "print the version and exit",
  help: "print this help and exit",
};

/** the name the cli is invoked as */
const bin = "rmapi";

/**
 * the last string value of a flag, or undefined if it wasn't given
 *
 * @param values - the parsed flags
 * @param key - the long name of the flag
 */
export function stringFlag(
  values: Readonly<Record<string, FlagValue>>,
  key: string,
): string | undefined {
  const val = values[key];
  const last = Array.isArray(val) ? val[val.length - 1] : val;
  return typeof last === "string" ? last : undefined;
}

/**
 * whether a boolean flag was set
 *
 * @param values - the parsed flags
 * @param key - the long name of the flag
 */
export function boolFlag(
  values: Readonly<Record<string, FlagValue>>,
  key: string,
): boolean {
  const val = values[key];
  const last = Array.isArray(val) ? val[val.length - 1] : val;
  return last === true;
}

/**
 * reject positionals beyond the ones a command's `usage` declares
 *
 * Commands with a fixed number of positionals call this so that an extra
 * argument is a usage error rather than being silently dropped.
 *
 * @param positionals - the command's positionals
 * @param count - how many positionals the command accepts
 * @param command - the full command name, for the error message
 * @throws UsageError if there are more than `count` positionals
 */
export function noExtra(
  positionals: readonly string[],
  count: number,
  command: string,
): void {
  const extra = positionals[count];
  if (extra !== undefined) {
    throw new UsageError(`unexpected argument '${extra}'`, command);
  }
}

function globalsFrom(
  values: Readonly<Record<string, FlagValue>>,
  command: string | undefined,
): Globals {
  const rawRetries = stringFlag(values, "retries");
  const retries = rawRetries === undefined ? 3 : Number(rawRetries);
  if (!Number.isInteger(retries) || retries < 0) {
    throw new UsageError(
      `--retries must be a non-negative integer, but was '${rawRetries}'`,
      command,
    );
  }
  return {
    json: boolFlag(values, "json"),
    refresh: boolFlag(values, "refresh"),
    cache: !boolFlag(values, "no-cache"),
    cacheFile: stringFlag(values, "cache-file"),
    configDir: stringFlag(values, "config"),
    authHost: stringFlag(values, "auth-host"),
    rawHost: stringFlag(values, "raw-host"),
    uploadHost: stringFlag(values, "upload-host"),
    retries,
    verbose: boolFlag(values, "verbose"),
    quiet: boolFlag(values, "quiet"),
    yes: boolFlag(values, "yes"),
    first: boolFlag(values, "first"),
  };
}

/** a fully parsed command line */
export interface Invocation {
  /** the resolved command name, undefined when no command was given */
  readonly name: string | undefined;
  /** the resolved command, undefined when no command was given */
  readonly command: Command | undefined;
  /** the parsed flags and positionals */
  readonly args: CommandArgs;
  /** the resolved global settings */
  readonly globals: Globals;
  /** whether help was requested */
  readonly help: boolean;
  /** whether the version was requested */
  readonly version: boolean;
}

/** find the registered command the leading positionals name */
function findCommand(
  registry: Registry,
  positionals: readonly string[],
): [string, Command, number] | undefined {
  const [first, second] = positionals;
  if (first === undefined) {
    return undefined;
  }
  const pair = second === undefined ? undefined : `${first} ${second}`;
  const paired = pair === undefined ? undefined : registry[pair];
  if (pair !== undefined && paired !== undefined) {
    return [pair, paired, 2];
  }
  const single = registry[first];
  if (single !== undefined) {
    return [first, single, 1];
  }
  throw new UsageError(
    `unknown command '${first}'; run '${bin} --help' for a list of commands`,
  );
}

/**
 * parse a command line
 *
 * @param registry - every registered command
 * @param argv - the arguments after the executable and script, e.g.
 *     `process.argv.slice(2)`
 * @throws UsageError for an unknown command or an invalid flag
 */
export function parse(registry: Registry, argv: readonly string[]): Invocation {
  const args = [...argv];
  // first pass, loosely, only to figure out which command was requested
  const loose = parseArgs({
    args,
    options: globalOptions,
    allowPositionals: true,
    strict: false,
  });
  const found = findCommand(registry, loose.positionals);
  if (found === undefined) {
    const values = loose.values as Readonly<Record<string, FlagValue>>;
    return {
      name: undefined,
      command: undefined,
      args: { values, positionals: [] },
      globals: globalsFrom(values, undefined),
      help: boolFlag(values, "help"),
      version: boolFlag(values, "version"),
    };
  }

  const [name, command, words] = found;
  let values: Readonly<Record<string, FlagValue>>;
  let positionals: string[];
  try {
    const strict = parseArgs({
      args,
      options: { ...globalOptions, ...command.options },
      allowPositionals: true,
      strict: true,
    });
    values = strict.values as Readonly<Record<string, FlagValue>>;
    positionals = strict.positionals;
  } catch (ex) {
    const message = ex instanceof Error ? ex.message : String(ex);
    throw new UsageError(message, name);
  }

  return {
    name,
    command,
    args: { values, positionals: positionals.slice(words) },
    globals: globalsFrom(values, name),
    help: boolFlag(values, "help"),
    version: boolFlag(values, "version"),
  };
}

function optionLines(
  options: ParseArgsOptionsConfig,
  descriptions: Readonly<Record<string, string>>,
): readonly (readonly string[])[] {
  return Object.entries(options).map(([long, config]) => {
    const short = config.short === undefined ? "" : `-${config.short}, `;
    const value = config.type === "string" ? " <value>" : "";
    return [`  ${short}--${long}${value}`, descriptions[long] ?? ""];
  });
}

/** the help for a single command */
export function commandHelp(name: string, command: Command): string {
  const lines = [
    `usage: ${bin} [global options] ${name}${command.usage ? ` ${command.usage}` : ""}`,
    "",
    command.summary,
  ];
  if (command.details) {
    lines.push("", command.details);
  }
  const own = optionLines(command.options, command.descriptions ?? {});
  if (own.length) {
    lines.push("", "options:", columnize(own));
  }
  lines.push(
    "",
    "global options:",
    columnize(optionLines(globalOptions, globalDescriptions)),
  );
  return lines.join("\n");
}

/** the top level help, listing every registered command */
export function help(registry: Registry): string {
  const commands = Object.entries(registry)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, command]) => [
      `  ${name}${command.usage ? ` ${command.usage}` : ""}`,
      command.summary,
    ]);
  return [
    `${bin} - command line client for the reMarkable cloud`,
    "",
    `usage: ${bin} [global options] <command> [options] [args]`,
    "",
    "commands:",
    columnize(commands),
    "",
    "global options:",
    columnize(optionLines(globalOptions, globalDescriptions)),
    "",
    `run '${bin} <command> --help' for details about a command`,
  ].join("\n");
}

/** local alias so help generation doesn't import the whole format module */
function columnize(rows: readonly (readonly string[])[]): string {
  const width = Math.max(0, ...rows.map(([first]) => (first ?? "").length));
  return rows
    .map(([first, ...rest]) =>
      rest.length
        ? `${(first ?? "").padEnd(width)}  ${rest.join(" ")}`.trimEnd()
        : (first ?? ""),
    )
    .join("\n");
}
