/**
 * updating the content metadata of an item
 *
 * Values are coerced from the command line's strings into the scalars the
 * content schemas expect, but nothing here knows which keys are valid: the
 * library validates the merged content, so an unknown key or a value of the
 * wrong shape surfaces as a
 * {@link ValidationError | `ValidationError`} from `rmapi-js` itself.
 */
import { z } from "zod";
import type {
  CollectionContent,
  DocumentContent,
  Entry,
  TemplateContent,
} from "../../index.js";
import {
  type Command,
  type CommandArgs,
  type Context,
  type FlagValue,
  noExtra,
  type Registry,
  stringFlag,
} from "../args.js";
import { withGeneration } from "../client.js";
import { UsageError } from "../error.js";
import { target } from "../target.js";

/** the name this command is registered under, for error messages */
const name = "update";

/** the kinds of item that have their own update method */
const kinds = ["document", "collection", "template"] as const;

/** which update method a `--set` applies to */
type Kind = (typeof kinds)[number];

/** the kind of update each entry type takes */
const kindOfType: Readonly<Record<Entry["type"], Kind>> = {
  DocumentType: "document",
  CollectionType: "collection",
  TemplateType: "template",
};

/** matches a value that should be coerced to a number */
const numberReg = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * the scalar a `key=value` value coerces to
 *
 * The variants are tried in order, so `true` and `false` become booleans,
 * anything that looks like a number becomes one, and everything else stays a
 * string.
 */
const scalar = z.union([
  z.literal("true").transform((): boolean => true),
  z.literal("false").transform((): boolean => false),
  z
    .string()
    .regex(numberReg)
    .transform((val): number => Number(val)),
  z.string(),
]);

/** the string array a comma separated value coerces to */
const strings = z.string().transform((val): string[] =>
  val
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== ""),
);

/**
 * the content keys that hold a list rather than a scalar
 *
 * Values for these are split on commas, so `--set labels=a,b` sets two labels
 * and `--set labels=a` sets one.
 */
const listKeys: ReadonlySet<string> = new Set([
  "authors",
  "categories",
  "labels",
  "supportedScreens",
  "tags",
]);

/** a single field to write */
export interface Field {
  /** the content key to set */
  key: string;
  /** the coerced value to set it to */
  value: unknown;
}

/**
 * coerce one `key=value` argument
 *
 * @param arg - the raw argument, as written on the command line
 * @returns the key and its coerced value
 * @throws UsageError when the argument isn't of the form `key=value`
 */
export function parseSet(arg: string): Field {
  const split = arg.indexOf("=");
  if (split < 1) {
    throw new UsageError(`--set must be 'key=value', but was '${arg}'`, name);
  }
  const key = arg.slice(0, split);
  const raw = arg.slice(split + 1);
  return {
    key,
    value: listKeys.has(key) ? strings.parse(raw) : scalar.parse(raw),
  };
}

/** every `--set` argument, in order */
function setArgs(values: Readonly<Record<string, FlagValue>>): string[] {
  const { set: raw } = values;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((val): val is string => typeof val === "string");
}

/** the kind of update to make */
function resolveKind(entry: Entry, override: string | undefined): Kind {
  if (override === undefined) {
    return kindOfType[entry.type];
  }
  const found = kinds.find((kind) => kind === override.toLowerCase());
  if (found === undefined) {
    throw new UsageError(
      `--type must be one of ${kinds.map((kind) => `'${kind}'`).join(", ")}, but was '${override}'`,
      name,
    );
  }
  return found;
}

/** the result of a successful update */
interface Updated {
  /** the id of the item that was updated */
  id: string;
  /** the name the item shows up as */
  visibleName: string;
  /** which update method was used */
  kind: Kind;
  /** the hash the item had before the update */
  hash: string;
  /** the hash the item has now */
  newHash: string;
  /** the content that was written */
  set: Record<string, unknown>;
}

const updateCommand: Command = {
  summary: "update the content metadata of an item",
  usage: "<target> --set key=value...",
  options: {
    set: { type: "string", multiple: true },
    type: { type: "string" },
  },
  descriptions: {
    set: "a 'key=value' content field to write, repeatable",
    type: "update as a 'document', 'collection', or 'template'",
  },
  details: [
    "The item's own type picks the update method unless --type says otherwise.",
    "",
    "Values are coerced: 'true' and 'false' become booleans, numbers become",
    "numbers, and a comma separated value becomes a list for the keys that hold",
    "one. Which keys and values are legal is decided by rmapi-js, so a bad key",
    "comes back as a validation error rather than being rejected here.",
  ].join("\n"),
  async run(ctx: Context, { values, positionals }: CommandArgs): Promise<void> {
    const [tgt] = positionals;
    if (tgt === undefined) {
      throw new UsageError("a target is required", name);
    }
    noExtra(positionals, 1, name);
    const args = setArgs(values);
    if (args.length === 0) {
      throw new UsageError("at least one --set key=value is required", name);
    }
    const set: Record<string, unknown> = {};
    for (const arg of args) {
      const { key, value } = parseSet(arg);
      set[key] = value;
    }

    const entry = await target(ctx, tgt);
    const kind = resolveKind(entry, stringFlag(values, "type"));
    const api = await ctx.api();
    const { hash } = await withGeneration(ctx.retries, (refresh) => {
      const fresh = refresh || ctx.refresh;
      switch (kind) {
        case "document":
          return api.updateDocument(
            entry.hash,
            set as Partial<DocumentContent>,
            fresh,
          );
        case "collection":
          return api.updateCollection(
            entry.hash,
            set as Partial<CollectionContent>,
            fresh,
          );
        case "template":
          return api.updateTemplate(
            entry.hash,
            set as Partial<TemplateContent>,
            fresh,
          );
      }
    });

    const updated: Updated = {
      id: entry.id,
      visibleName: entry.visibleName,
      kind,
      hash: entry.hash,
      newHash: hash,
      set,
    };
    ctx.out.write(
      updated,
      (val) =>
        `updated ${val.kind} '${val.visibleName}' (${Object.keys(val.set).join(", ")})`,
    );
  },
};

/** the `update` command */
export const updateCommands: Registry = { update: updateCommand };
