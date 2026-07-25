/**
 * reMarkable device screens, and the custom zoom math that depends on them
 *
 * Neither command here needs a token or the network; everything comes from
 * {@link deviceScreens | `deviceScreens`}.
 */
import {
  type DeviceModel,
  type DeviceScreen,
  deviceScreens,
} from "../../index.js";
import {
  type Command,
  type CommandArgs,
  type Context,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { UsageError } from "../error.js";
import { columns } from "../format.js";

/** a device screen, with its model number and aspect ratio */
interface ModelRow extends DeviceScreen {
  /** the model number this describes */
  model: DeviceModel;
  /** the screen aspect ratio, in lowest terms, e.g. `"3:4"` */
  aspectRatio: string;
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

function aspectRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${String(width / divisor)}:${String(height / divisor)}`;
}

function modelRows(): ModelRow[] {
  return Object.entries(deviceScreens).map(([model, screen]) => ({
    model: model as DeviceModel,
    ...screen,
    aspectRatio: aspectRatio(screen.width, screen.height),
  }));
}

const devicesCommand: Command = {
  summary: "list the known reMarkable devices and their screens",
  usage: "",
  options: {},
  details:
    "Widths and heights are native portrait pixels, and the dpi is what converts\npdf points to those pixels for 'devices zoom'.",
  run(ctx: Context, { positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "devices");
    const rows = modelRows();
    ctx.out.write(rows, (vals) =>
      columns([
        ["model", "name", "width", "height", "dpi", "aspect"].map((cell) =>
          ctx.out.style.dim(cell),
        ),
        ...vals.map((val) => [
          val.model,
          val.name,
          String(val.width),
          String(val.height),
          String(val.dpi),
          val.aspectRatio,
        ]),
      ]),
    );
    return Promise.resolve();
  },
};

/** the named page sizes `devices zoom` understands, in pdf points */
const pageSizes: Readonly<Record<string, readonly [number, number]>> = {
  // 210mm x 297mm
  a4: [595.276, 841.89],
  letter: [612, 792],
};

/** round to a tenth of a thousandth, so output is stable and readable */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function numberFlag(
  values: CommandArgs["values"],
  key: string,
): number | undefined {
  const raw = stringFlag(values, key);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(
      `--${key} must be a number, but was '${raw}'`,
      "devices zoom",
    );
  }
  return value;
}

/** the page dimensions in pdf points, from the flags that describe them */
function pagePoints(values: CommandArgs["values"]): [number, number] {
  const size = stringFlag(values, "page-size");
  const width = numberFlag(values, "page-width");
  const height = numberFlag(values, "page-height");
  if (size !== undefined) {
    if (width !== undefined || height !== undefined) {
      throw new UsageError(
        "--page-size can't be combined with --page-width or --page-height",
        "devices zoom",
      );
    }
    const known = pageSizes[size.toLowerCase()];
    if (known === undefined) {
      throw new UsageError(
        `--page-size must be one of ${Object.keys(pageSizes).join(", ")}, but was '${size}'`,
        "devices zoom",
      );
    }
    return [known[0], known[1]];
  }
  if (width === undefined || height === undefined) {
    throw new UsageError(
      "either --page-size, or both --page-width and --page-height in points, are required",
      "devices zoom",
    );
  }
  if (width <= 0 || height <= 0) {
    throw new UsageError(
      "--page-width and --page-height must be positive",
      "devices zoom",
    );
  }
  return [width, height];
}

function model(values: CommandArgs["values"]): DeviceModel {
  const raw = stringFlag(values, "model");
  if (raw === undefined) {
    throw new UsageError("--model is required", "devices zoom");
  }
  if (!(raw in deviceScreens)) {
    throw new UsageError(
      `--model must be one of ${Object.keys(deviceScreens).join(", ")}, but was '${raw}'`,
      "devices zoom",
    );
  }
  return raw as DeviceModel;
}

/** the custom zoom settings `devices zoom` computes */
interface ZoomResult {
  /** the model the numbers were computed for */
  model: DeviceModel;
  /** that model's marketing name */
  name: string;
  /** the zoom mode these settings apply to */
  zoomMode: "customFit";
  /** the page width in pdf points that was given */
  pageWidthPt: number;
  /** the page height in pdf points that was given */
  pageHeightPt: number;
  /** the page width in device pixels */
  customZoomPageWidth: number;
  /** the page height in device pixels */
  customZoomPageHeight: number;
  /** the ratio of screen height to view height */
  customZoomScale: number;
  /** the horizontal offset of the view from the page center, in device pixels */
  customZoomCenterX: number;
  /** the distance of the view center down from the page top, in device pixels */
  customZoomCenterY: number;
  /** the orientation the zoom was computed in, from the page's own shape */
  customZoomOrientation: "portrait" | "landscape";
  /** the width of the visible view in device pixels */
  viewWidth: number;
  /** the height of the visible view in device pixels */
  viewHeight: number;
  /** the fraction of the page's height the view covers */
  visibleHeightFraction: number;
}

/**
 * compute the `customFit` zoom settings for a page on a device
 *
 * This follows the math documented on
 * {@link RemarkableApi.putPdf | `putPdf`}: the page is measured in device
 * pixels as `pagePt * dpi / 72`, `customZoomScale` is
 * `screenHeight / viewHeight` in those pixels (so `1` makes the view exactly
 * screen-tall), the view keeps the device's aspect ratio, `customZoomCenterY`
 * is the absolute distance of the view center down from the top of the page,
 * and `customZoomCenterX` is an offset from the page's horizontal center.
 *
 * @param modelNumber - the model the numbers are for, echoed in the result
 * @param screen - that model's screen, from
 *     {@link deviceScreens | `deviceScreens`}
 * @param page - the page width and height in pdf points
 * @param opts - the scale and center overrides; the center defaults to the
 *     middle of the page
 * @throws UsageError if the scale isn't positive
 */
export function customZoom(
  modelNumber: DeviceModel,
  screen: DeviceScreen,
  [pageWidthPt, pageHeightPt]: readonly [number, number],
  {
    scale = 1,
    centerX = 0,
    centerY,
  }: { scale?: number; centerX?: number; centerY?: number } = {},
): ZoomResult {
  if (!(scale > 0)) {
    throw new UsageError("--scale must be positive", "devices zoom");
  }
  const pageWidth = (pageWidthPt * screen.dpi) / 72;
  const pageHeight = (pageHeightPt * screen.dpi) / 72;
  // customZoomScale = screenHeight / viewHeight, so the view is this tall
  const viewHeight = screen.height / scale;
  // the view always has the device's aspect ratio
  const viewWidth = (viewHeight * screen.width) / screen.height;
  return {
    model: modelNumber,
    name: screen.name,
    zoomMode: "customFit",
    pageWidthPt: round(pageWidthPt),
    pageHeightPt: round(pageHeightPt),
    customZoomPageWidth: round(pageWidth),
    customZoomPageHeight: round(pageHeight),
    customZoomScale: round(scale),
    customZoomCenterX: round(centerX),
    // centering is half the page's rendered height
    customZoomCenterY: round(centerY ?? pageHeight / 2),
    customZoomOrientation:
      pageHeightPt >= pageWidthPt ? "portrait" : "landscape",
    viewWidth: round(viewWidth),
    viewHeight: round(viewHeight),
    visibleHeightFraction: round(viewHeight / pageHeight),
  };
}

/** the flags `put` takes, in the order they read best */
function zoomFlags(val: ZoomResult): string {
  return [
    "--zoom-mode customFit",
    `--custom-zoom-scale ${String(val.customZoomScale)}`,
    `--custom-zoom-center-x ${String(val.customZoomCenterX)}`,
    `--custom-zoom-center-y ${String(val.customZoomCenterY)}`,
    `--custom-zoom-page-width ${String(val.customZoomPageWidth)}`,
    `--custom-zoom-page-height ${String(val.customZoomPageHeight)}`,
    `--custom-zoom-orientation ${val.customZoomOrientation}`,
  ].join(" ");
}

const zoomCommand: Command = {
  summary: "compute the customFit zoom settings for a device and page size",
  usage: "",
  options: {
    model: { type: "string" },
    "page-size": { type: "string" },
    "page-width": { type: "string" },
    "page-height": { type: "string" },
    scale: { type: "string" },
    "center-x": { type: "string" },
    "center-y": { type: "string" },
  },
  descriptions: {
    model: "the device model code, e.g. RM110, as listed by 'rmapi devices'",
    "page-size": "a named page size, a4 or letter",
    "page-width": "the page width in pdf points",
    "page-height": "the page height in pdf points",
    scale: "screen height over view height, 1 fits the height (default 1)",
    "center-x": "offset of the view from the page center, in device pixels",
    "center-y": "distance of the view center below the page top, in pixels",
  },
  details:
    "Prints the flags 'rmapi put --zoom-mode customFit' wants, so the output can\nbe pasted onto a put. The page is measured in device pixels as\n`pagePt * dpi / 72`, the scale is `screenHeight / viewHeight` in those pixels\n(so 1 shows a screen-tall slice, 2 shows half of that), --center-y is the\nabsolute distance of the view center down from the top of the page, and\n--center-x is an offset from the page's horizontal center. Both centers\ndefault to the middle of the page.\n\nThe zoom is one document-wide setting applied to every page, so pages that\ndon't match the size given here will sit higher or lower than this centering\nintends. This makes no requests and needs no token.",
  run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    noExtra(positionals, 0, "devices zoom");
    const modelNumber = model(values);
    const screen = deviceScreens[modelNumber];
    const result = customZoom(modelNumber, screen, pagePoints(values), {
      scale: numberFlag(values, "scale"),
      centerX: numberFlag(values, "center-x"),
      centerY: numberFlag(values, "center-y"),
    });
    ctx.out.write(result, (val) => {
      const lines: string[] = [];
      if (!ctx.quiet) {
        const { style } = ctx.out;
        lines.push(
          style.dim(
            `# ${val.name} (${val.model}), page ${String(val.pageWidthPt)}x${String(val.pageHeightPt)}pt = ${String(val.customZoomPageWidth)}x${String(val.customZoomPageHeight)}px`,
          ),
          style.dim(
            `# view ${String(val.viewWidth)}x${String(val.viewHeight)}px, ${String(round(val.visibleHeightFraction * 100))}% of the page height`,
          ),
        );
      }
      lines.push(zoomFlags(val));
      return lines.join("\n");
    });
    return Promise.resolve();
  },
};

/** the `devices` command and its `zoom` helper */
export const devicesCommands: Registry = {
  devices: devicesCommand,
  "devices zoom": zoomCommand,
};
