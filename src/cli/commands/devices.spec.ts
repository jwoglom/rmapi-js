import { describe, expect, test } from "bun:test";
import type { Command, CommandArgs } from "../args.js";
import { UsageError } from "../error.js";
import { captureOutput, testContext } from "../test-utils.js";
import { devicesCommands } from "./devices.js";

function command(name: string): Command {
  const cmd = devicesCommands[name];
  if (cmd === undefined) {
    throw new Error(`no command ${name}`);
  }
  return cmd;
}

const noArgs: CommandArgs = { values: {}, positionals: [] };

function args(values: Record<string, string>): CommandArgs {
  return { values, positionals: [] };
}

describe("devices", () => {
  test("lists every model with its aspect ratio", async () => {
    const out = captureOutput();
    // no api, so this proves it never touches the network
    await command("devices").run(testContext({ out: out.out }), noArgs);
    const text = out.text();
    expect(text).toContain("RM110");
    expect(text).toContain("reMarkable Paper Pro Move");
    expect(text).toContain("3:4");
    expect(text).toContain("9:16");
    expect(text).toContain("264");
  });

  test("rejects extra arguments", () => {
    const ctx = testContext();
    expect(() =>
      command("devices").run(ctx, { values: {}, positionals: ["extra"] }),
    ).toThrow(UsageError);
  });
});

describe("devices zoom", () => {
  test("computes letter on a reMarkable 2", async () => {
    const out = captureOutput({ json: true });
    await command("devices zoom").run(
      testContext({ out: out.out }),
      args({ model: "RM110", "page-size": "letter" }),
    );
    // hand checked: 612 * 226 / 72 = 1921, 792 * 226 / 72 = 2486, and the
    // default center is half the page height, 2486 / 2 = 1243
    expect(out.json()).toEqual({
      model: "RM110",
      name: "reMarkable 2",
      zoomMode: "customFit",
      pageWidthPt: 612,
      pageHeightPt: 792,
      customZoomPageWidth: 1921,
      customZoomPageHeight: 2486,
      customZoomScale: 1,
      customZoomCenterX: 0,
      customZoomCenterY: 1243,
      customZoomOrientation: "portrait",
      // scale 1 makes the view exactly screen tall
      viewWidth: 1404,
      viewHeight: 1872,
      visibleHeightFraction: 0.753,
    });
  });

  test("halves the view at scale 2", async () => {
    const out = captureOutput({ json: true });
    await command("devices zoom").run(
      testContext({ out: out.out }),
      args({
        model: "RM110",
        "page-size": "letter",
        scale: "2",
        "center-x": "-100",
        "center-y": "500",
      }),
    );
    expect(out.json()).toMatchObject({
      customZoomScale: 2,
      customZoomCenterX: -100,
      customZoomCenterY: 500,
      viewWidth: 702,
      viewHeight: 936,
    });
  });

  test("scales points by the paper pro dpi", async () => {
    const out = captureOutput({ json: true });
    await command("devices zoom").run(
      testContext({ out: out.out }),
      args({ model: "RM02A", "page-width": "720", "page-height": "1440" }),
    );
    // 720 * 229 / 72 = 2290, 1440 * 229 / 72 = 4580
    expect(out.json()).toMatchObject({
      customZoomPageWidth: 2290,
      customZoomPageHeight: 4580,
      customZoomCenterY: 2290,
    });
  });

  test("reports landscape pages", async () => {
    const out = captureOutput({ json: true });
    await command("devices zoom").run(
      testContext({ out: out.out }),
      args({ model: "RM110", "page-width": "792", "page-height": "612" }),
    );
    expect(out.json()).toMatchObject({ customZoomOrientation: "landscape" });
  });

  test("prints pasteable put flags", async () => {
    const out = captureOutput();
    await command("devices zoom").run(
      testContext({ out: out.out, quiet: true }),
      args({ model: "RM110", "page-size": "letter" }),
    );
    expect(out.text()).toBe(
      "--zoom-mode customFit --custom-zoom-scale 1 --custom-zoom-center-x 0 --custom-zoom-center-y 1243 --custom-zoom-page-width 1921 --custom-zoom-page-height 2486 --custom-zoom-orientation portrait\n",
    );
  });

  test("annotates the flags unless quiet", async () => {
    const out = captureOutput();
    await command("devices zoom").run(
      testContext({ out: out.out }),
      args({ model: "RM110", "page-size": "letter" }),
    );
    expect(out.text()).toContain("# reMarkable 2 (RM110)");
    expect(out.text()).toContain("1404x1872px");
  });

  test("requires a known model", () => {
    const ctx = testContext();
    expect(() => command("devices zoom").run(ctx, args({}))).toThrow(
      "--model is required",
    );
    expect(() =>
      command("devices zoom").run(ctx, args({ model: "RM999" })),
    ).toThrow("--model must be one of");
  });

  test("requires a page size", () => {
    const ctx = testContext();
    expect(() =>
      command("devices zoom").run(ctx, args({ model: "RM110" })),
    ).toThrow("--page-size");
    expect(() =>
      command("devices zoom").run(
        ctx,
        args({ model: "RM110", "page-width": "612" }),
      ),
    ).toThrow("--page-height");
    expect(() =>
      command("devices zoom").run(
        ctx,
        args({ model: "RM110", "page-size": "a3" }),
      ),
    ).toThrow("--page-size must be one of");
    expect(() =>
      command("devices zoom").run(
        ctx,
        args({ model: "RM110", "page-size": "a4", "page-width": "612" }),
      ),
    ).toThrow("can't be combined");
  });

  test("rejects a non-numeric or non-positive scale", () => {
    const ctx = testContext();
    expect(() =>
      command("devices zoom").run(
        ctx,
        args({ model: "RM110", "page-size": "a4", scale: "wide" }),
      ),
    ).toThrow("--scale must be a number");
    expect(() =>
      command("devices zoom").run(
        ctx,
        args({ model: "RM110", "page-size": "a4", scale: "0" }),
      ),
    ).toThrow("--scale must be positive");
  });
});
