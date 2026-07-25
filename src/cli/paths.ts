/**
 * pure path resolution for the `rmapi` cli
 *
 * The reMarkable cloud stores a flat list of {@link Entry | `Entry`}s, each
 * with a `parent` id, so a "path" is something the cli has to synthesize. Every
 * function in this module is pure: it only ever reads the array of entries it
 * is given, and never touches the network, the file system, or the process
 * environment.
 *
 * There are two special parents in the cloud, `""` (the empty string) for the
 * root directory, and `"trash"` for the trash. Those aren't real entries, so
 * this module exposes {@link rootEntry | `rootEntry`} and
 * {@link trashEntry | `trashEntry`} as synthetic stand-ins, which is what
 * resolving `/` or `/trash` returns.
 *
 * Two extra synthetic containers exist for malformed data, since neither
 * condition should crash the cli:
 * - {@link orphanPath | `/.orphans`} holds entries whose `parent` isn't `""`,
 *   `"trash"`, or the id of any entry in the list.
 * - {@link cyclePath | `/.cycles`} holds entries that are part of a `parent`
 *   cycle.
 *
 * @packageDocumentation
 */
import type { CollectionEntry, Entry } from "../index.js";
import { AmbiguousTargetError, TargetNotFoundError } from "./error.js";

/** the parent id of entries in the root directory */
const rootId = "";
/** the parent id of entries in the trash */
const trashId = "trash";

/** the display path of the root directory */
export const rootPath = "/";

/** the display path of the trash */
export const trashPath = "/trash";

/**
 * the display path of the synthetic folder holding orphaned entries
 *
 * An entry is orphaned when its `parent` is neither of the two special parents
 * (`""` and `"trash"`), nor the id of an entry in the list we were given. This
 * happens when listing a subset of entries, or when the cloud is in an
 * inconsistent state. Rather than throwing, those entries (and anything nested
 * under them) are rendered under this path.
 *
 * @remarks a real folder in the root named `.orphans` will render at the same
 * path; use an `id:` target to disambiguate.
 */
export const orphanPath = "/.orphans";

/**
 * the display path of the synthetic folder holding entries in a parent cycle
 *
 * If entries form a `parent` cycle (`a`'s parent is `b`, `b`'s parent is `a`)
 * there is no path to the root, so every member of the cycle is rendered
 * directly under this path, with its own children nested beneath it as usual.
 *
 * @remarks a real folder in the root named `.cycles` will render at the same
 * path; use an `id:` target to disambiguate.
 */
export const cyclePath = "/.cycles";

/** the synthetic entry standing in for the root directory */
export const rootEntry: CollectionEntry = {
  id: rootId,
  hash: "",
  visibleName: "",
  lastModified: "",
  pinned: false,
  type: "CollectionType",
};

/** the synthetic entry standing in for the trash */
export const trashEntry: CollectionEntry = {
  id: trashId,
  hash: "",
  visibleName: "trash",
  lastModified: "",
  pinned: false,
  parent: rootId,
  type: "CollectionType",
};

/** matches a bare document id, a uuid4 as used by the cloud */
const uuidReg =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** matches a bare content hash, sha256 hex */
const hashReg = /^[0-9a-f]{64}$/;

/**
 * escape a `visibleName` for use as a single path segment
 *
 * reMarkable names may contain `/`, which would otherwise look like a path
 * separator, so `\` and `/` are both backslash escaped. A name that is exactly
 * `.` is escaped too, since a bare `.` segment means the current directory.
 * This is the inverse of the unescaping done by
 * {@link parsePath | `parsePath`}, so display paths round trip back into
 * targets.
 *
 * @param name - the raw `visibleName`
 * @returns the escaped segment
 */
export function escapeSegment(name: string): string {
  const escaped = name.replace(/[\\/]/g, (char) => `\\${char}`);
  return escaped === "." ? "\\." : escaped;
}

/**
 * split a display path into its unescaped segments
 *
 * Leading, trailing, and repeated separators are ignored, so `/`, `//`, and the
 * empty string all produce no segments, meaning the root directory. A `\`
 * escapes the character that follows it, so `/a\/b` is the single segment
 * `a/b`, and a trailing lone `\` is dropped.
 *
 * A `.` segment is dropped, since there is no working directory in the cloud,
 * so `.` and `./` also mean the root. An item genuinely named `.` has to be
 * escaped as `\.`, which is what {@link escapeSegment | `escapeSegment`}
 * produces.
 *
 * @param path - the path to split
 * @returns the unescaped segments, in order
 */
export function parsePath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let escaped = false;
  let literal = false;
  const push = (): void => {
    // an unescaped "." is the current directory, e.g. the root, not a name
    if (current && !(current === "." && !literal)) {
      segments.push(current);
    }
    current = "";
    literal = false;
  };
  for (const char of path) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
      literal = true;
    } else if (char === "/") {
      push();
    } else {
      current += char;
    }
  }
  push();
  return segments;
}

/**
 * the resolved structure of a list of entries
 *
 * `container` maps an entry id onto the id of the container it is rendered in,
 * which is its `parent` for well formed entries, and one of the synthetic
 * container ids ({@link orphanPath | `orphanPath`} or
 * {@link cyclePath | `cyclePath`}) for orphans and cycle members. Following
 * `container` is always acyclic, which is what makes tree walking safe.
 */
interface Structure {
  /** all entries by id */
  byId: Map<string, Entry>;
  /** entry id to absolute display path */
  paths: Map<string, string>;
  /** entry id to the id of its rendered container */
  container: Map<string, string>;
  /** container id to the ids of its children, in input order */
  children: Map<string, string[]>;
}

/** the display path prefix a container id renders at, without trailing slash */
function containerPrefix(container: string): string {
  if (container === rootId) return "";
  if (container === trashId) return trashPath;
  return container;
}

/** resolve paths and containers for a list of entries, breaking cycles */
function structure(entries: readonly Entry[]): Structure {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  const paths = new Map<string, string>();
  const container = new Map<string, string>();
  for (const entry of entries) {
    if (paths.has(entry.id)) continue;
    // the unresolved ancestors of entry, entry first
    const chain: Entry[] = [];
    const seen = new Map<string, number>();
    let prefix: string | undefined;
    let cursor: Entry | undefined = entry;
    while (prefix === undefined) {
      const known = paths.get(cursor.id);
      if (known !== undefined) {
        // shouldn't happen for entry itself, but an ancestor may be resolved
        prefix = known;
        break;
      }
      const repeat = seen.get(cursor.id);
      if (repeat !== undefined) {
        // every entry from the repeat on is part of a cycle, and gets rendered
        // directly under the synthetic cycle folder
        for (const member of chain.slice(repeat)) {
          const name = escapeSegment(member.visibleName);
          container.set(member.id, cyclePath);
          paths.set(member.id, `${cyclePath}/${name}`);
        }
        prefix = paths.get(cursor.id);
        chain.length = repeat;
        break;
      }
      seen.set(cursor.id, chain.length);
      chain.push(cursor);
      const parent = cursor.parent ?? rootId;
      if (parent === rootId || parent === trashId) {
        container.set(cursor.id, parent);
        prefix = containerPrefix(parent);
        break;
      }
      const next = byId.get(parent);
      if (next === undefined) {
        container.set(cursor.id, orphanPath);
        prefix = orphanPath;
        break;
      }
      cursor = next;
    }
    // assign top down, so every ancestor path is known before its child
    for (let i = chain.length - 1; i >= 0; --i) {
      const item = chain[i]!;
      const path = `${prefix}/${escapeSegment(item.visibleName)}`;
      paths.set(item.id, path);
      if (!container.has(item.id)) {
        container.set(item.id, chain[i + 1]?.id ?? item.parent ?? rootId);
      }
      prefix = path;
    }
  }

  const children = new Map<string, string[]>();
  for (const entry of entries) {
    const parent = container.get(entry.id) ?? rootId;
    const existing = children.get(parent);
    if (existing === undefined) {
      children.set(parent, [entry.id]);
    } else {
      existing.push(entry.id);
    }
  }

  return { byId, paths, container, children };
}

/**
 * compute the absolute display path of every entry
 *
 * Paths are built by walking `parent` chains up to the root. Entries in the
 * root render as `/<name>`, entries in the trash as `/trash/<name>`, orphans
 * under {@link orphanPath | `/.orphans`}, and members of a `parent` cycle
 * under {@link cyclePath | `/.cycles`}. Names are escaped with
 * {@link escapeSegment | `escapeSegment`}, so a `visibleName` containing `/`
 * appears as `\/` and doesn't look like a nested folder.
 *
 * Note that the root and the trash themselves aren't entries, so `/` and
 * `/trash` never appear as keys.
 *
 * @param entries - the entries to compute paths for
 * @returns a map from entry id to absolute display path
 */
export function entryPaths(entries: readonly Entry[]): Map<string, string> {
  return structure(entries).paths;
}

/**
 * the entries rendered directly inside a container
 *
 * @param entries - the entries to search
 * @param parentId - the container id: an entry id, `""` for the root,
 *   `"trash"` for the trash, or one of {@link orphanPath | `orphanPath`} and
 *   {@link cyclePath | `cyclePath`} for the synthetic containers
 * @returns the child entries, in the order they appeared in `entries`
 */
export function children(entries: readonly Entry[], parentId: string): Entry[] {
  const { byId, children: kids } = structure(entries);
  return (kids.get(parentId) ?? []).map((id) => byId.get(id)!);
}

/** a node in the tree of entries */
export interface TreeNode {
  /**
   * the entry this node renders
   *
   * This is {@link rootEntry | `rootEntry`} or
   * {@link trashEntry | `trashEntry`} for those two containers, and `undefined`
   * for the synthetic orphan and cycle folders, which have no entry at all.
   */
  entry: Entry | undefined;
  /** the container id of this node */
  id: string;
  /** the display name of this node, unescaped */
  name: string;
  /** the absolute display path of this node */
  path: string;
  /** the children of this node, in the order they appeared in the input */
  children: TreeNode[];
}

/** the roots of the tree of entries */
export interface Tree {
  /** the root directory, `/` */
  root: TreeNode;
  /** the trash, `/trash` */
  trash: TreeNode;
  /**
   * the synthetic folder of orphaned entries
   *
   * `undefined` when there are no orphans.
   */
  orphans: TreeNode | undefined;
  /**
   * the synthetic folder of entries in a `parent` cycle
   *
   * `undefined` when there are no cycles.
   */
  cycles: TreeNode | undefined;
}

/**
 * build the tree of entries, for `ls` and `tree` style output
 *
 * Since `parent` cycles are broken by re-rooting their members under
 * {@link cyclePath | `/.cycles`}, the returned tree is always finite, and every
 * entry appears exactly once.
 *
 * @param entries - the entries to build a tree from
 * @returns the roots of the tree
 */
export function buildTree(entries: readonly Entry[]): Tree {
  const { byId, paths, children: kids } = structure(entries);

  const node = (
    id: string,
    entry: Entry | undefined,
    name: string,
    path: string,
  ): TreeNode => ({
    entry,
    id,
    name,
    path,
    children: (kids.get(id) ?? []).map((childId) => {
      const child = byId.get(childId)!;
      return node(childId, child, child.visibleName, paths.get(childId)!);
    }),
  });

  return {
    root: node(rootId, rootEntry, "", rootPath),
    trash: node(trashId, trashEntry, "trash", trashPath),
    orphans: kids.has(orphanPath)
      ? node(orphanPath, undefined, ".orphans", orphanPath)
      : undefined,
    cycles: kids.has(cyclePath)
      ? node(cyclePath, undefined, ".cycles", cyclePath)
      : undefined,
  };
}

/** options for resolving a target */
export interface ResolveOptions {
  /**
   * take the first match when a path is ambiguous
   *
   * Duplicate sibling names are legal on reMarkable, so a path may match more
   * than one entry. By default that throws
   * {@link AmbiguousTargetError | `AmbiguousTargetError`}; with this set the
   * first match, in input order, wins.
   */
  first?: boolean;
}

/** the reserved leading path segments for the synthetic containers */
const reservedRoots = new Map<string, string>([
  ["trash", trashId],
  [".orphans", orphanPath],
  [".cycles", cyclePath],
]);

/** resolve an absolute display path into an entry */
function resolvePath(
  entries: readonly Entry[],
  target: string,
  path: string,
  first: boolean,
): Entry {
  const segments = parsePath(path);
  if (segments.length === 0) return rootEntry;
  const reserved = reservedRoots.get(segments[0]!);
  const rest = reserved === undefined ? segments : segments.slice(1);
  if (rest.length === 0) {
    // the container itself was named; only the trash has an entry to return
    if (reserved === trashId) return trashEntry;
    throw new TargetNotFoundError(target);
  }

  const { byId, children: kids } = structure(entries);
  let container = reserved ?? rootId;
  let current: Entry | undefined;
  for (const segment of rest) {
    const matches = (kids.get(container) ?? [])
      .map((id) => byId.get(id)!)
      .filter((entry) => entry.visibleName === segment);
    const [initial] = matches;
    if (initial === undefined) {
      throw new TargetNotFoundError(target);
    } else if (matches.length > 1 && !first) {
      throw new AmbiguousTargetError(target, matches);
    }
    current = initial;
    container = initial.id;
  }
  return current!;
}

/**
 * resolve a single cli target into an entry
 *
 * The interpretation of `target` is detected from its shape, unless it carries
 * an explicit prefix:
 * - `id:<id>` forces a document id, where `id:` is the root and `id:trash` is
 *   the trash
 * - `hash:<hash>` forces a content hash
 * - `path:<path>` forces a display path, which is how to name a file that
 *   looks like a uuid or a hash
 *
 * Without a prefix, a 64 character hex string is a hash, a uuid4 is a document
 * id, and anything else is a path. Paths are always absolute, so a leading `/`
 * is optional: `Books/Notes.pdf` and `/Books/Notes.pdf` are the same target.
 * `/` resolves to {@link rootEntry | `rootEntry`} and `/trash` to
 * {@link trashEntry | `trashEntry`}.
 *
 * Path segments are compared against `visibleName` exactly, including case, and
 * unescaped by {@link parsePath | `parsePath`}, so `\/` matches a literal `/`
 * in a name. A leading `trash`, `.orphans`, or `.cycles` segment always names
 * the corresponding container, so a real root folder with one of those names
 * has to be addressed by id.
 *
 * @param entries - the entries to search
 * @param target - the target to resolve
 * @param opts - resolution options
 * @returns the matching entry
 * @throws TargetNotFoundError - when nothing matches
 * @throws AmbiguousTargetError - when a path matches several sibling entries
 *   and `first` isn't set
 */
export function resolveTarget(
  entries: readonly Entry[],
  target: string,
  { first = false }: ResolveOptions = {},
): Entry {
  if (target.startsWith("path:")) {
    return resolvePath(entries, target, target.slice(5), first);
  } else if (target.startsWith("id:")) {
    const id = target.slice(3);
    if (id === rootId) return rootEntry;
    if (id === trashId) return trashEntry;
    const found = entries.find((entry) => entry.id === id);
    if (found === undefined) throw new TargetNotFoundError(target);
    return found;
  } else if (target.startsWith("hash:")) {
    const hash = target.slice(5);
    const found = entries.find((entry) => entry.hash === hash);
    if (found === undefined) throw new TargetNotFoundError(target);
    return found;
  } else if (hashReg.test(target)) {
    const found = entries.find((entry) => entry.hash === target);
    if (found === undefined) throw new TargetNotFoundError(target);
    return found;
  } else if (uuidReg.test(target)) {
    const found = entries.find((entry) => entry.id === target);
    if (found === undefined) throw new TargetNotFoundError(target);
    return found;
  } else {
    return resolvePath(entries, target, target, first);
  }
}

/**
 * resolve several cli targets into entries
 *
 * Targets are resolved independently and in order, so the first bad target
 * throws, and duplicates resolve to the same entry twice. This is what the bulk
 * `mv` and `rm` commands take.
 *
 * @param entries - the entries to search
 * @param targets - the targets to resolve
 * @param opts - resolution options
 * @returns the matching entries, in target order
 * @throws TargetNotFoundError - when a target matches nothing
 * @throws AmbiguousTargetError - when a target is an ambiguous path and `first`
 *   isn't set
 */
export function resolveMany(
  entries: readonly Entry[],
  targets: readonly string[],
  opts: ResolveOptions = {},
): Entry[] {
  return targets.map((target) => resolveTarget(entries, target, opts));
}
