/** registration and credential management commands */
import { register } from "../../index.js";
import {
  boolFlag,
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
} from "../args.js";
import { resolveHosts } from "../client.js";
import { AuthError, UsageError } from "../error.js";

/**
 * mask a token for display
 *
 * Only the last four characters survive, which is enough to tell two tokens
 * apart without leaking one.
 */
export function maskToken(token: string): string {
  const tail = token.slice(-4);
  return `${"*".repeat(Math.max(0, Math.min(token.length - tail.length, 8)))}${tail}`;
}

const registerCommand: Command = {
  summary: "register this machine and persist a device token",
  usage: "<code>",
  options: {},
  details:
    "Get an eight letter code from https://my.remarkable.com/device/apps/connect\nand pass it here. The resulting device token never expires and is stored in\nthe config directory with mode 0600.",
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    const [code] = positionals;
    if (code === undefined) {
      throw new UsageError("a registration code is required", "auth register");
    }
    noExtra(positionals, 1, "auth register");
    const config = await ctx.config.read();
    const { authHost } = resolveHosts(
      { authHost: ctx.authHost },
      ctx.env,
      config,
    );
    const deviceToken = await register(code, { authHost });
    // a new device token invalidates any cached session token
    await ctx.config.write({ deviceToken, sessionToken: undefined });
    ctx.out.write(
      { registered: true, deviceToken: maskToken(deviceToken) },
      () => "registered; device token saved",
    );
  },
};

/** the shape reported by `auth status` */
interface Status {
  /** whether a device token is available */
  registered: boolean;
  /** the masked device token, never the full value */
  deviceToken: string | undefined;
  /** where the device token came from */
  source: "env" | "config" | undefined;
  /** whether a session token is cached */
  session: boolean;
  /** the resolved hosts */
  hosts: Record<string, string | undefined>;
}

const statusCommand: Command = {
  summary: "show whether this machine is registered",
  usage: "",
  options: {},
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "auth status");
    const config = await ctx.config.read();
    const { RMAPI_DEVICE_TOKEN: fromEnv } = ctx.env;
    const token = fromEnv ?? config.deviceToken;
    const hosts = resolveHosts(
      {
        authHost: ctx.authHost,
        rawHost: ctx.rawHost,
        uploadHost: ctx.uploadHost,
      },
      ctx.env,
      config,
    );
    const status: Status = {
      registered: token !== undefined,
      deviceToken: token === undefined ? undefined : maskToken(token),
      source: token === undefined ? undefined : fromEnv ? "env" : "config",
      session: config.sessionToken !== undefined,
      hosts: { ...hosts },
    };
    ctx.out.write(status, (val) => {
      if (!val.registered) {
        return "not registered; get a code from https://my.remarkable.com/device/apps/connect\nand run 'rmapi auth register <code>'";
      }
      const lines = [
        `registered:    yes (${val.source})`,
        `device token:  ${val.deviceToken}`,
        `session token: ${val.session ? "cached" : "none"}`,
      ];
      for (const [host, value] of Object.entries(val.hosts)) {
        if (value !== undefined) {
          lines.push(
            `${host}:${" ".repeat(Math.max(1, 14 - host.length))}${value}`,
          );
        }
      }
      return lines.join("\n");
    });
  },
};

const logoutCommand: Command = {
  summary: "forget the stored device token, session token, and hash cache",
  usage: "",
  options: {},
  async run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "auth logout");
    await ctx.config.write({
      deviceToken: undefined,
      sessionToken: undefined,
    });
    await ctx.config.removeCache();
    ctx.out.write({ loggedOut: true }, () => "forgot stored credentials");
  },
};

const tokenCommand: Command = {
  summary: "print the stored device token",
  usage: "",
  options: { "print-token": { type: "boolean" } },
  descriptions: {
    "print-token": "actually print the secret device token to stdout",
  },
  details:
    "The device token is a long lived credential. It is only printed when you\nexplicitly pass --print-token.",
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "auth token");
    if (!boolFlag(values, "print-token")) {
      throw new UsageError(
        "refusing to print the device token without --print-token",
        "auth token",
      );
    }
    const config = await ctx.config.read();
    const { RMAPI_DEVICE_TOKEN: fromEnv } = ctx.env;
    const token = fromEnv ?? config.deviceToken;
    if (token === undefined) {
      throw new AuthError(
        "no device token found; run 'rmapi auth register <code>' first",
      );
    }
    ctx.out.write({ deviceToken: token }, (val) => val.deviceToken);
  },
};

/** the `auth` family of commands */
export const authCommands: Registry = {
  "auth register": registerCommand,
  "auth status": statusCommand,
  "auth logout": logoutCommand,
  "auth token": tokenCommand,
};
