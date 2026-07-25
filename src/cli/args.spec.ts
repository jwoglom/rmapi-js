import { describe, expect, test } from "bun:test";
import {
  type Command,
  type CommandArgs,
  type Context,
  commandHelp,
  help,
  parse,
  type Registry,
} from "./args.js";
import { UsageError } from "./error.js";

function fake(summary: string, command: Partial<Command> = {}): Command {
  return {
    summary,
    usage: "",
    options: {},
    run(_ctx: Context, _args: CommandArgs): Promise<void> {
      return Promise.resolve();
    },
    ...command,
  };
}

const registry: Registry = {
  ls: fake("list items", {
    usage: "[path]",
    options: { long: { type: "boolean", short: "l" } },
  }),
  "auth register": fake("register", { usage: "<code>" }),
  "auth status": fake("status"),
  "raw get-entries": fake("get entries", { usage: "<hash>" }),
};

describe("parse()", () => {
  test("no arguments", () => {
    const {
      name,
      command,
      help: wanted,
      version,
      globals,
    } = parse(registry, []);
    expect(name).toBeUndefined();
    expect(command).toBeUndefined();
    expect(wanted).toBe(false);
    expect(version).toBe(false);
    expect(globals.retries).toBe(3);
    expect(globals.cache).toBe(true);
  });

  test("top level help and version", () => {
    expect(parse(registry, ["--help"]).help).toBe(true);
    expect(parse(registry, ["--version"]).version).toBe(true);
  });

  test("one word command", () => {
    const { name, args } = parse(registry, ["ls", "-l", "books"]);
    expect(name).toBe("ls");
    expect(args.values).toMatchObject({ long: true });
    expect(args.positionals).toEqual(["books"]);
  });

  test("two word command wins over one word", () => {
    const { name, args } = parse(registry, ["auth", "register", "academic"]);
    expect(name).toBe("auth register");
    expect(args.positionals).toEqual(["academic"]);
  });

  test("two word command with a dash", () => {
    const { name, args } = parse(registry, ["raw", "get-entries", "abc"]);
    expect(name).toBe("raw get-entries");
    expect(args.positionals).toEqual(["abc"]);
  });

  test("globals before and after the command", () => {
    const { name, globals } = parse(registry, [
      "--json",
      "ls",
      "--refresh",
      "--retries",
      "7",
      "--config",
      "/tmp/conf",
      "--raw-host",
      "https://raw",
      "--no-cache",
      "-v",
      "--quiet",
      "--yes",
      "--cache-file",
      "/tmp/cache",
      "--auth-host",
      "https://auth",
      "--upload-host",
      "https://upload",
      "--first",
    ]);
    expect(name).toBe("ls");
    expect(globals).toEqual({
      json: true,
      refresh: true,
      cache: false,
      cacheFile: "/tmp/cache",
      configDir: "/tmp/conf",
      authHost: "https://auth",
      rawHost: "https://raw",
      uploadHost: "https://upload",
      retries: 7,
      verbose: true,
      quiet: true,
      yes: true,
      first: true,
    });
  });

  test("--first defaults to false", () => {
    expect(parse(registry, ["ls"]).globals.first).toBe(false);
    expect(parse(registry, ["ls", "--first"]).globals.first).toBe(true);
  });

  test("command help doesn't require the rest to be valid", () => {
    const { name, help: wanted } = parse(registry, ["ls", "--help"]);
    expect(name).toBe("ls");
    expect(wanted).toBe(true);
  });

  test("unknown command", () => {
    expect(() => parse(registry, ["nope"])).toThrow(UsageError);
    expect(() => parse(registry, ["nope"])).toThrow("unknown command 'nope'");
  });

  test("unknown flag", () => {
    expect(() => parse(registry, ["ls", "--nope"])).toThrow(UsageError);
    try {
      parse(registry, ["ls", "--nope"]);
      expect.unreachable();
    } catch (ex) {
      expect(ex).toBeInstanceOf(UsageError);
      expect((ex as UsageError).command).toBe("ls");
    }
  });

  test("flags from one command aren't valid for another", () => {
    expect(() => parse(registry, ["auth", "status", "-l"])).toThrow(UsageError);
  });

  test("invalid retries", () => {
    expect(() => parse(registry, ["ls", "--retries", "many"])).toThrow(
      "--retries must be a non-negative integer",
    );
    expect(() => parse(registry, ["ls", "--retries", "-1"])).toThrow(
      UsageError,
    );
  });
});

describe("help()", () => {
  test("lists every command", () => {
    const text = help(registry);
    for (const name of Object.keys(registry)) {
      expect(text).toContain(name);
    }
    expect(text).toContain("--json");
    expect(text).toContain("usage: rmapi");
  });
});

describe("commandHelp()", () => {
  test("shows usage, own flags, and global flags", () => {
    const { ls } = registry;
    const text = commandHelp("ls", ls!);
    expect(text).toContain("usage: rmapi [global options] ls [path]");
    expect(text).toContain("-l, --long");
    expect(text).toContain("global options:");
  });

  test("works without any own flags", () => {
    const text = commandHelp("auth status", registry["auth status"]!);
    expect(text).toContain("usage: rmapi [global options] auth status");
    expect(text).not.toContain("\noptions:");
  });
});
