#!/usr/bin/env node
/**
 * the cli entry point
 *
 * This is the only module that touches `process`, stdio, or exit codes;
 * everything else takes what it needs as an argument and throws on failure.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import {
  GenerationError,
  HashNotFoundError,
  type RemarkableApi,
  ResponseError,
  ValidationError,
} from "../index.js";
import {
  type Context,
  commandHelp,
  help,
  parse,
  type Registry,
} from "./args.js";
import { client } from "./client.js";
import { authCommands } from "./commands/auth.js";
import { cacheCommands } from "./commands/cache.js";
import { devicesCommands } from "./commands/devices.js";
import { findCommands } from "./commands/find.js";
import { getCommands } from "./commands/get.js";
import { lsCommands } from "./commands/ls.js";
import { mkdirCommands } from "./commands/mkdir.js";
import { organizeCommands } from "./commands/organize.js";
import { putCommands } from "./commands/put.js";
import { rawCommands } from "./commands/raw.js";
import { statCommands } from "./commands/stat.js";
import { treeCommands } from "./commands/tree.js";
import { updateCommands } from "./commands/update.js";
import { fileStore } from "./config.js";
import {
  AmbiguousTargetError,
  AuthError,
  TargetNotFoundError,
  UsageError,
} from "./error.js";
import { output, resolveColor } from "./format.js";

/** every command the cli knows about, keyed by full command name */
const registry: Registry = {
  ...authCommands,
  ...lsCommands,
  ...treeCommands,
  ...findCommands,
  ...statCommands,
  ...getCommands,
  ...putCommands,
  ...mkdirCommands,
  ...updateCommands,
  ...organizeCommands,
  ...rawCommands,
  ...cacheCommands,
  ...devicesCommands,
};

/** the exit code for an error */
function exitCode(ex: unknown): number {
  if (ex instanceof UsageError) {
    return 2;
  } else if (
    ex instanceof TargetNotFoundError ||
    ex instanceof AmbiguousTargetError ||
    ex instanceof HashNotFoundError
  ) {
    return 3;
  } else if (
    ex instanceof AuthError ||
    (ex instanceof ResponseError && (ex.status === 401 || ex.status === 403))
  ) {
    return 4;
  } else if (ex instanceof ValidationError) {
    return 5;
  } else if (ex instanceof GenerationError) {
    return 6;
  } else {
    return 1;
  }
}

async function version(): Promise<string> {
  const file = join(import.meta.dirname, "..", "..", "package.json");
  const parsed = JSON.parse(await readFile(file, "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

async function main(argv: readonly string[]): Promise<void> {
  const invocation = parse(registry, argv);
  const { globals, command, name, args } = invocation;
  const out = output(
    {
      json: globals.json,
      color: resolveColor(process.env, process.stdout.isTTY === true),
    },
    (text) => void process.stdout.write(text),
  );

  if (invocation.version) {
    const val = await version();
    out.write({ version: val }, ({ version: ver }) => ver);
    return;
  } else if (invocation.help || command === undefined) {
    if (command === undefined && !invocation.help) {
      throw new UsageError(
        "no command given; run 'rmapi --help' for a list of commands",
      );
    }
    const text =
      command === undefined || name === undefined
        ? help(registry)
        : commandHelp(name, command);
    out.write({ help: text }, ({ help: rendered }) => rendered);
    return;
  }

  const store = fileStore(globals.configDir, {
    env: process.env,
    cacheFile: globals.cacheFile,
  });
  let api: RemarkableApi | undefined;
  const ctx: Context = {
    ...globals,
    out,
    config: store,
    env: process.env,
    async stdin(): Promise<string> {
      process.stdin.setEncoding("utf8");
      const chunks: string[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as string);
      }
      return chunks.join("");
    },
    async api(): Promise<RemarkableApi> {
      api ??= await client(store, {
        authHost: globals.authHost,
        rawHost: globals.rawHost,
        uploadHost: globals.uploadHost,
        cache: globals.cache,
        env: process.env,
      });
      return api;
    },
  };

  await command.run(ctx, args);
  if (api !== undefined && globals.cache) {
    await store.writeCache(api.dumpCache());
  }
}

const argv = process.argv.slice(2);
try {
  await main(argv);
} catch (ex) {
  const code = exitCode(ex);
  const message = ex instanceof Error ? ex.message : String(ex);
  if (argv.includes("--json")) {
    process.stderr.write(`${JSON.stringify({ error: message, code })}\n`);
  } else {
    process.stderr.write(`rmapi: ${message}\n`);
    if (ex instanceof UsageError) {
      const command = ex.command;
      const known = command === undefined ? undefined : registry[command];
      process.stderr.write(
        known === undefined
          ? "run 'rmapi --help' for usage\n"
          : `run 'rmapi ${command} --help' for usage\n`,
      );
    } else if (argv.includes("--verbose") || argv.includes("-v")) {
      process.stderr.write(`${ex instanceof Error ? ex.stack : ""}\n`);
    }
  }
  process.exitCode = code;
}
