// Three-way merge of notebook edits. Used when an editor saves while storage
// changed underneath it (another browser tab, another window): `base` is what
// the editor started from, `mine` is the editor's version, `theirs` is what is
// stored now. The rule is simple: never silently lose an edit. Each side's
// additions and changes are kept; a deletion wins only over an item the other
// side did not change.

import type { Doc, ID, Item, Page } from "./types";

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function mergeItems(base: Item[], mine: Item[], theirs: Item[]): Item[] {
  const B = new Map(base.map((i) => [i.id, i]));
  const M = new Map(mine.map((i) => [i.id, i]));
  const T = new Map(theirs.map((i) => [i.id, i]));
  const out: Item[] = [];
  for (const t of theirs) {
    const b = B.get(t.id);
    const m = M.get(t.id);
    if (b && !m) {
      // I deleted it: honour that unless they changed it meanwhile
      if (!same(b, t)) out.push(t);
    } else if (b && m && !same(m, b)) out.push(m); // I changed it
    else out.push(t);
  }
  for (const m of mine) {
    if (T.has(m.id)) continue;
    const b = B.get(m.id);
    if (!b) out.push(m); // I added it
    else if (!same(m, b)) out.push(m); // they deleted it but I changed it: keep mine
  }
  return out;
}

/** `base` undefined: the page is new in `mine`. `theirs` undefined: deleted in storage. */
export function mergePage(base: Page | undefined, mine: Page, theirs: Page | undefined): Page {
  if (!theirs || !base) return mine;
  if (theirs.sum && theirs.sum === base.sum) return mine; // storage unchanged since the editor loaded it
  const pick = <K extends keyof Page>(k: K) => (same(mine[k], base[k]) ? theirs[k] : mine[k]);
  return {
    ...theirs,
    w: pick("w"),
    h: pick("h"),
    bg: pick("bg"),
    recognized: pick("recognized"),
    items: mergeItems(base.items, mine.items, theirs.items),
    updated: Math.max(mine.updated || 0, theirs.updated || 0),
    sum: undefined,
  };
}

/** Merge page order. `keep`: pages the editor is writing (they must stay listed even if removed elsewhere). */
export function mergePageIds(base: ID[], mine: ID[], theirs: ID[], keep: Set<ID> = new Set(), dontRemove: Set<ID> = new Set()): ID[] {
  if (!dontRemove.size) {
    if (same(theirs, base)) return [...mine];
    if (same(mine, base) && [...keep].every((id) => theirs.includes(id))) return [...theirs];
  }
  const removedByMe = new Set(base.filter((id) => !mine.includes(id) && !dontRemove.has(id)));
  const out = theirs.filter((id) => !removedByMe.has(id));
  const theirNew = (id: ID) => !base.includes(id) && !mine.includes(id);
  const insert = (id: ID) => {
    if (out.includes(id)) return;
    const i = mine.indexOf(id);
    const prev = i < 0 ? undefined : mine.slice(0, i).reverse().find((x) => out.includes(x));
    let at = prev === undefined ? (i <= 0 ? 0 : out.length) : out.indexOf(prev) + 1;
    // after pages the other side inserted at the same spot (theirs were saved first)
    while (prev !== undefined && at < out.length && theirNew(out[at])) at++;
    out.splice(at, 0, id);
  };
  for (const id of mine) if (!base.includes(id) || keep.has(id)) insert(id);
  return out;
}

/** Fields an editor can hold a stale copy of; each one is merged three-way. */
const CONTENT_FIELDS = ["bookmarks", "outline", "defaultBg", "layout", "title", "favorite", "folderId", "cover", "deletedAt"] as const;

export function mergeDocContent(base: Doc, mine: Doc, theirs: Doc, pageIds: ID[]): Doc {
  const out: Doc = { ...mine, pageIds };
  for (const k of CONTENT_FIELDS) if (same(mine[k], base[k])) (out as any)[k] = theirs[k];
  out.bookmarks = (out.bookmarks || []).filter((b) => pageIds.includes(b));
  out.outline = (out.outline || []).filter((o) => pageIds.includes(o.pageId));
  return out;
}
