import { describe, expect, test } from "bun:test";
import { diagnostics } from "./format.js";
import { captureDiagnostics, testContext } from "./test-utils.js";

describe("diagnostics", () => {
  test("writes nothing without verbose", () => {
    const written: string[] = [];
    const diagnostic = diagnostics(false, (text) => void written.push(text));
    diagnostic("resolving 1056 items");
    diagnostic("resolved 100/1056 items");
    expect(written).toEqual([]);
  });

  test("writes a prefixed line per message when verbose", () => {
    const written: string[] = [];
    const diagnostic = diagnostics(true, (text) => void written.push(text));
    diagnostic("resolving 1056 items");
    diagnostic("resolved 100/1056 items");
    expect(written).toEqual([
      "rmapi: resolving 1056 items\n",
      "rmapi: resolved 100/1056 items\n",
    ]);
  });
});

describe("captureDiagnostics", () => {
  test("drops messages unless verbose", () => {
    const quiet = captureDiagnostics();
    quiet.diagnostic("hi");
    expect(quiet.messages).toEqual([]);

    const loud = captureDiagnostics({ verbose: true });
    loud.diagnostic("hi");
    expect(loud.messages).toEqual(["hi"]);
  });
});

describe("testContext", () => {
  test("has a diagnostic that honors the verbose global", () => {
    // both are no-ops, but calling them must not throw
    expect(() => testContext().diagnostic("quiet")).not.toThrow();
    expect(() =>
      testContext({ verbose: true }).diagnostic("loud"),
    ).not.toThrow();
  });

  test("takes an explicit diagnostic", () => {
    const captured = captureDiagnostics({ verbose: true });
    testContext({ diagnostic: captured.diagnostic }).diagnostic("hello");
    expect(captured.messages).toEqual(["hello"]);
  });
});
