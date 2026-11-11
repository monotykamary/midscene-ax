import type { Rect, TreeQuery, UiNode } from '@midscene/core';

/** One ref-bearing node of a browser-harness-js snapshot. */
export interface HarnessRefEntry {
  ref: string;
  role: string;
  name: string;
  /** Nearest named container, e.g. "dialog: Sign in" (browser-harness-js). */
  context?: string;
  backendNodeId: number;
  frameId: string;
  sessionId: string;
  /** True for the top-level document; refs in child frames are prefixed. */
  mainFrame: boolean;
  /** For a field: whether it takes typing now (not `[readonly]` or `[disabled]` in the snapshot). */
  editable?: boolean;
}

// Document roots carry the page or frame title as their name; they are never
// an element a user means by a label.
const DOCUMENT_ROLES = new Set(['RootWebArea', 'WebArea']);

export const normalizeName = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

/**
 * Every entry the query names, in document order. No ranking and no fuzzy
 * matching beyond what the query asks for: `exact` is a whole-string,
 * case-sensitive match after whitespace normalisation; without it the name
 * is a case-insensitive substring. `role` and `context` must match exactly.
 */
export function matchEntries(
  entries: Iterable<HarnessRefEntry>,
  query: TreeQuery,
): HarnessRefEntry[] {
  const all = [...entries];
  if ('ref' in query) {
    return all.filter((entry) => entry.ref === query.ref);
  }
  const wanted = normalizeName(query.name);
  if (!wanted) {
    return [];
  }
  const role = query.role?.trim().toLowerCase();
  const context =
    query.context !== undefined ? normalizeName(query.context) : undefined;
  return all.filter((entry) => {
    if (DOCUMENT_ROLES.has(entry.role)) return false;
    if (role && entry.role.toLowerCase() !== role) return false;
    if (context !== undefined && normalizeName(entry.context ?? '') !== context)
      return false;
    const name = normalizeName(entry.name);
    return query.exact
      ? name === wanted
      : name.toLowerCase().includes(wanted.toLowerCase());
  });
}

const LINE = /^( *)- (.*)$/;
const REF = /\[ref=([^\]]+)\]/;

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Whether each field ref in a snapshot tree takes typing: a field role whose
 * line carries neither `[readonly]` nor `[disabled]`. Other refs are absent.
 */
export function fieldEditability(tree: string): Map<string, boolean> {
  const editable = new Map<string, boolean>();
  for (const raw of tree.split('\n')) {
    const line = LINE.exec(raw);
    if (!line) continue;
    const role = line[2].split(' ', 1)[0].toLowerCase();
    const ref = REF.exec(line[2])?.[1];
    if (!ref || !FIELD_ROLES.has(role)) continue;
    editable.set(ref, !/\[(readonly|disabled)(=[^\]]*)?\]/.test(line[2]));
  }
  return editable;
}

/**
 * Parse a browser-harness-js snapshot tree into `UiNode`s. Lines look like
 * `  - button "Log in" [ref=s…e3] [disabled] value="x"`; two spaces per level.
 * Text lines (`- text: "…"`) become `text` nodes. `bounds` come from
 * `boundsOf(ref)` and are zero for nodes without a ref or a known box.
 */
export function parseSnapshotTree(
  tree: string,
  boundsOf: (ref: string) => Rect | undefined,
): UiNode[] {
  const zero: Rect = { left: 0, top: 0, width: 0, height: 0 };
  const roots: UiNode[] = [];
  const stack: { depth: number; node: UiNode }[] = [];
  for (const raw of tree.split('\n')) {
    const line = LINE.exec(raw);
    if (!line) continue;
    const depth = line[1].length / 2;
    const body = line[2];
    let node: UiNode;
    if (body.startsWith('text: ')) {
      node = {
        type: 'text',
        attrs: { name: parseQuoted(body.slice(6)) },
        bounds: zero,
        children: [],
      };
    } else {
      const role = body.split(' ', 1)[0];
      const rest = body.slice(role.length).trim();
      const ref = REF.exec(rest)?.[1];
      const attrs: Record<string, string | undefined> = {};
      if (rest.startsWith('"')) {
        attrs.name = parseQuoted(rest);
      }
      for (const flag of rest.matchAll(/\[([a-z]+)(?:=([^\]]*))?\]/g)) {
        if (flag[1] === 'ref') continue;
        attrs[flag[1]] = flag[2] ?? 'true';
      }
      const value = /(?:^|\s)value=("(?:[^"\\]|\\.)*")/.exec(rest)?.[1];
      if (value) attrs.value = parseQuoted(value);
      if (ref) attrs.ref = ref;
      node = {
        type: role,
        attrs,
        bounds: (ref && boundsOf(ref)) || zero,
        children: [],
        ...(ref ? { ref } : {}),
      };
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ depth, node });
  }
  return roots;
}

function parseQuoted(text: string): string {
  const match = /^"(?:[^"\\]|\\.)*"/.exec(text.trim());
  if (!match) return text.trim();
  try {
    return JSON.parse(match[0]);
  } catch {
    return match[0].slice(1, -1);
  }
}
