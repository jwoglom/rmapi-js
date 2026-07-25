import { describe, expect, test } from "bun:test";
import { emptyResponse, mockFetch, textResponse } from "../../test-utils.js";
import type { Command, CommandArgs } from "../args.js";
import { AuthError, UsageError } from "../error.js";
import { captureOutput, memStore, testContext } from "../test-utils.js";
import { authCommands, maskToken } from "./auth.js";

function command(name: string): Command {
  const cmd = authCommands[name];
  if (cmd === undefined) {
    throw new Error(`no command ${name}`);
  }
  return cmd;
}

const noArgs: CommandArgs = { values: {}, positionals: [] };

describe("maskToken()", () => {
  test("only shows the last four characters", () => {
    expect(maskToken("0123456789abcdef")).toBe("********cdef");
    expect(maskToken("abc")).toBe("abc");
  });
});

describe("auth register", () => {
  test("persists the device token", async () => {
    mockFetch(textResponse("0123456789abcdef"));
    const config = memStore({ sessionToken: "stale" });
    const out = captureOutput();
    const ctx = testContext({ config, out: out.out });

    await command("auth register").run(ctx, {
      values: {},
      positionals: ["academic"],
    });
    expect(config.state).toEqual({ deviceToken: "0123456789abcdef" });
    expect(out.text()).toContain("registered");
    // never the full token
    expect(out.text()).not.toContain("0123456789abcdef");
  });

  test("requires a code", async () => {
    mockFetch();
    const ctx = testContext();
    expect(command("auth register").run(ctx, noArgs)).rejects.toThrow(
      UsageError,
    );
  });

  test("rejects extra arguments", async () => {
    mockFetch();
    const ctx = testContext();
    expect(
      command("auth register").run(ctx, {
        values: {},
        positionals: ["academic", "extra"],
      }),
    ).rejects.toThrow("unexpected argument 'extra'");
  });

  test("surfaces registration failures", async () => {
    mockFetch(emptyResponse({ status: 400 }));
    const config = memStore();
    const ctx = testContext({ config });
    expect(
      command("auth register").run(ctx, {
        values: {},
        positionals: ["academic"],
      }),
    ).rejects.toThrow("couldn't register api");
    expect(config.state).toEqual({});
  });
});

describe("auth status", () => {
  test("reports an unregistered machine", async () => {
    const out = captureOutput();
    await command("auth status").run(testContext({ out: out.out }), noArgs);
    expect(out.text()).toContain("not registered");
  });

  test("masks the device token", async () => {
    const out = captureOutput();
    const ctx = testContext({
      out: out.out,
      config: memStore({
        deviceToken: "0123456789abcdef",
        sessionToken: "session",
      }),
    });
    await command("auth status").run(ctx, noArgs);
    expect(out.text()).toContain("********cdef");
    expect(out.text()).not.toContain("0123456789abcdef");
    expect(out.text()).toContain("cached");
  });

  test("reports the token source and hosts as json", async () => {
    const out = captureOutput({ json: true });
    const ctx = testContext({
      out: out.out,
      env: { RMAPI_DEVICE_TOKEN: "abcdefgh", RMAPI_RAW_HOST: "https://raw" },
    });
    await command("auth status").run(ctx, noArgs);
    expect(out.json()).toEqual({
      registered: true,
      deviceToken: "****efgh",
      source: "env",
      session: false,
      hosts: {
        authHost: undefined,
        rawHost: "https://raw",
        uploadHost: undefined,
      },
    });
  });
});

describe("auth logout", () => {
  test("forgets everything", async () => {
    const config = memStore(
      { deviceToken: "device", sessionToken: "session", rawHost: "https://x" },
      '{"hash":null}',
    );
    const out = captureOutput();
    await command("auth logout").run(
      testContext({ config, out: out.out }),
      noArgs,
    );
    expect(config.state).toEqual({ rawHost: "https://x" });
    expect(config.cache).toBeUndefined();
    expect(out.text()).toContain("forgot stored credentials");
  });
});

describe("auth token", () => {
  test("refuses without --print-token", async () => {
    const ctx = testContext({ config: memStore({ deviceToken: "device" }) });
    expect(command("auth token").run(ctx, noArgs)).rejects.toThrow(UsageError);
  });

  test("prints the token when asked", async () => {
    const out = captureOutput();
    const ctx = testContext({
      out: out.out,
      config: memStore({ deviceToken: "device" }),
    });
    await command("auth token").run(ctx, {
      values: { "print-token": true },
      positionals: [],
    });
    expect(out.text()).toBe("device\n");
  });

  test("throws without a token", async () => {
    const ctx = testContext();
    expect(
      command("auth token").run(ctx, {
        values: { "print-token": true },
        positionals: [],
      }),
    ).rejects.toThrow(AuthError);
  });
});
