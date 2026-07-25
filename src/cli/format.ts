/**
 * output formatting for the cli
 *
 * Every command emits results through {@link Output | `Output`} so that
 * `--json` is honored in exactly one place, and no command can forget it.
 */

/** the ansi styles available to renderers */
export interface Style {
  /** render text bold */
  bold(text: string): string;
  /** render text dim */
  dim(text: string): string;
  /** render text in a color that reads as a "name" */
  name(text: string): string;
  /** render text in a color that reads as "extra information" */
  meta(text: string): string;
}

/**
 * the sink that rendered output is written to
 *
 * The value passed in already ends with a newline.
 */
export type Sink = (text: string) => void;

/**
 * the single way commands emit their results
 *
 * Commands pass the structured value they computed alongside a function that
 * renders that value for humans. When `--json` is set the value is serialized
 * and the renderer is never called, otherwise the renderer's output is written
 * to the sink.
 */
export interface Output {
  /** the styles to use when rendering, no-ops when color is disabled */
  readonly style: Style;

  /**
   * emit a value
   *
   * @param value - the structured result, serialized verbatim under `--json`
   * @param render - renders `value` for humans, only called when not in json mode
   */
  write<T>(value: T, render: (value: T) => string): void;
}

/** options for creating an {@link Output | `Output`} */
export interface OutputOptions {
  /** true to emit json instead of calling renderers */
  json: boolean;
  /** true to emit ansi escapes */
  color: boolean;
}

const identity = (text: string): string => text;

/** the escape character that starts an ansi sequence */
const esc = String.fromCharCode(27);

function wrap(code: string): (text: string) => string {
  return (text: string) => `${esc}[${code}m${text}${esc}[0m`;
}

/**
 * create the styles for a given color setting
 *
 * @param color - false to make every style the identity function
 */
export function styler(color: boolean): Style {
  return color
    ? {
        bold: wrap("1"),
        dim: wrap("2"),
        name: wrap("36"),
        meta: wrap("35"),
      }
    : { bold: identity, dim: identity, name: identity, meta: identity };
}

/**
 * whether color output should be used
 *
 * Honors the [NO_COLOR](https://no-color.org) convention, which takes
 * precedence over everything else.
 *
 * @param env - the environment to inspect
 * @param tty - whether the destination is an interactive terminal
 */
export function resolveColor(
  env: Readonly<Record<string, string | undefined>>,
  tty: boolean,
): boolean {
  const { NO_COLOR, FORCE_COLOR } = env;
  if (NO_COLOR) {
    return false;
  } else if (FORCE_COLOR) {
    return true;
  } else {
    return tty;
  }
}

/**
 * create an output
 *
 * @param opts - whether to emit json and whether to use color
 * @param sink - where rendered text is written, e.g. a bound `console.log`
 */
export function output({ json, color }: OutputOptions, sink: Sink): Output {
  const style = styler(color);
  return {
    style,
    write<T>(value: T, render: (value: T) => string): void {
      const text = json ? JSON.stringify(value, null, 2) : render(value);
      if (text) {
        sink(text.endsWith("\n") ? text : `${text}\n`);
      }
    },
  };
}

/**
 * emits progress diagnostics, a no-op unless verbose
 *
 * Diagnostics are prefixed with the binary name and always end in a newline, so
 * the sink is a plain writer. The sink must be stderr, never stdout, so that
 * piping `--json` output stays clean.
 */
export type Diagnostic = (message: string) => void;

/**
 * create the {@link Diagnostic | `Diagnostic`} a run should use
 *
 * Gating lives here rather than at every call site so commands can emit
 * progress unconditionally.
 *
 * @param verbose - whether `--verbose` was given; nothing is written when false
 * @param sink - where diagnostics are written, stderr in the real cli
 * @returns a function that writes one prefixed line per message
 */
export function diagnostics(verbose: boolean, sink: Sink): Diagnostic {
  if (!verbose) {
    return () => {};
  }
  return (message: string): void => {
    sink(`rmapi: ${message}\n`);
  };
}

/**
 * render rows as space aligned columns
 *
 * Alignment ignores ansi escapes so styled cells still line up.
 *
 * @param rows - the rows to render, each an array of cells
 * @param sep - the separator placed between columns
 * @returns the rendered rows joined by newlines
 */
export function columns(
  rows: readonly (readonly string[])[],
  { sep = "  " }: { sep?: string } = {},
): string {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          // don't pad the final cell, trailing whitespace is noise
          i === row.length - 1
            ? cell
            : cell + " ".repeat((widths[i] ?? 0) - visibleLength(cell)),
        )
        .join(sep)
        .trimEnd(),
    )
    .join("\n");
}

const ansiReg = new RegExp(`${esc}\\[[0-9;]*m`, "g");

/** the length of text ignoring ansi escapes */
export function visibleLength(text: string): number {
  return text.replace(ansiReg, "").length;
}

/** a node in a renderable tree */
export interface TreeNode {
  /** the text to render for this node */
  label: string;
  /** this node's children, rendered indented below it */
  children?: readonly TreeNode[];
}

function renderNodes(nodes: readonly TreeNode[], prefix: string): string[] {
  const lines: string[] = [];
  for (const [i, node] of nodes.entries()) {
    const last = i === nodes.length - 1;
    lines.push(`${prefix}${last ? "└── " : "├── "}${node.label}`);
    const children = node.children ?? [];
    if (children.length) {
      lines.push(
        ...renderNodes(children, `${prefix}${last ? "    " : "│   "}`),
      );
    }
  }
  return lines;
}

/**
 * render a tree of nodes with box drawing characters
 *
 * @param roots - the top level nodes, rendered without any prefix
 */
export function tree(roots: readonly TreeNode[]): string {
  const lines: string[] = [];
  for (const root of roots) {
    lines.push(root.label);
    lines.push(...renderNodes(root.children ?? [], ""));
  }
  return lines.join("\n");
}
