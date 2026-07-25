/**
 * presentation helpers shared by the listing style commands
 *
 * `ls`, `tree`, `find`, and `stat` all have to label entries, format their
 * timestamps, and walk the entry tree the same way. Those helpers live here so
 * that command modules stay leaves that never import from one another.
 */
import type { Entry } from "../index.js";
import { columns, type Output, type TreeNode } from "./format.js";
import type { TreeNode as EntryNode, Tree } from "./paths.js";

/**
 * format an epoch millisecond timestamp for display
 *
 * Values that aren't a positive number are passed through verbatim, since the
 * cloud isn't always consistent about them.
 *
 * @param lastModified - the raw timestamp string
 */
export function timestamp(lastModified: string): string {
  const millis = Number(lastModified);
  return Number.isFinite(millis) && millis > 0
    ? new Date(millis).toISOString()
    : lastModified;
}

function marker(entry: Entry): string {
  switch (entry.type) {
    case "CollectionType":
      return "d";
    case "TemplateType":
      return "t";
    default:
      return "-";
  }
}

/** an entry paired with the text it should be listed under */
export interface Listing {
  /** the entry being listed */
  readonly entry: Entry;
  /** what to show for it, its `visibleName` or its full path */
  readonly name: string;
}

/**
 * the styled label for an entry
 *
 * Collections get a trailing slash and pinned entries a trailing asterisk.
 *
 * @param entry - the entry to label
 * @param out - the output whose styles to use
 * @param name - the text to label the entry with, its `visibleName` by default
 */
export function entryLabel(
  entry: Entry,
  out: Output,
  name: string = entry.visibleName,
): string {
  const styled =
    entry.type === "CollectionType" ? out.style.name(`${name}/`) : name;
  return entry.pinned ? `${styled} ${out.style.meta("*")}` : styled;
}

/**
 * render listings one per line
 *
 * @param listings - the entries to render, in order
 * @param out - the output whose styles to use
 */
export function shortList(listings: readonly Listing[], out: Output): string {
  return listings
    .map(({ entry, name }) => entryLabel(entry, out, name))
    .join("\n");
}

/**
 * render listings as aligned columns of metadata
 *
 * @param listings - the entries to render, in order
 * @param out - the output whose styles to use
 */
export function longList(listings: readonly Listing[], out: Output): string {
  return columns(
    listings.map(({ entry, name }) => [
      marker(entry),
      entry.type === "DocumentType" ? (entry.fileType ?? "") : "",
      entry.pinned ? "pinned" : "",
      timestamp(entry.lastModified),
      out.style.dim(entry.id),
      out.style.dim(entry.hash),
      entryLabel(entry, out, name),
    ]),
  );
}

/**
 * find the node for a container id anywhere in a tree
 *
 * Every root is searched, so this finds nodes in the trash and in the synthetic
 * orphan and cycle containers too.
 *
 * @param built - the tree to search
 * @param id - the container id to look for, `""` for the root
 * @returns the matching node, or undefined when the id isn't in the tree
 */
export function locateNode(built: Tree, id: string): EntryNode | undefined {
  const roots = [built.root, built.trash, built.orphans, built.cycles];
  for (const root of roots) {
    const found = root === undefined ? undefined : descend(root, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function descend(node: EntryNode, id: string): EntryNode | undefined {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children) {
    const found = descend(child, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** the listing for a node's own entry, or its bare name for a container */
function nodeLabel(node: EntryNode, out: Output): string {
  return node.entry === undefined
    ? out.style.name(`${node.name}/`)
    : entryLabel(node.entry, out, node.name);
}

/**
 * convert a subtree of entries into renderable nodes
 *
 * @param node - the node whose children to convert
 * @param out - the output whose styles to use
 * @param depth - how many more levels of children to include
 */
export function renderNodes(
  node: EntryNode,
  out: Output,
  depth: number,
): TreeNode[] {
  if (depth <= 0) {
    return [];
  }
  return [...node.children]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((child) => ({
      label: nodeLabel(child, out),
      children: renderNodes(child, out, depth - 1),
    }));
}

/**
 * the names of an entry's tags
 *
 * Tags are either rich objects or, in legacy content, bare strings.
 *
 * @param entry - the entry to read tags from
 */
export function tagNames(entry: Entry): string[] {
  return (entry.tags ?? []).map((tag) =>
    typeof tag === "string" ? tag : tag.name,
  );
}
