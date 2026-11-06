// A loaded document: pages in memory, undo/redo history and autosave.
import type { Doc, ID, Item, Page } from "../model/types";
import * as repo from "../storage/repo";
import { uid } from "../model/util";
import { log } from "../state/store";

type Entry =
  | { type: "items"; pageId: ID; before: Item[]; after: Item[]; label: string }
  | { type: "page"; pageId: ID; before: Page; after: Page; label: string }
  | { type: "structure"; beforeIds: ID[]; afterIds: ID[]; pages: Page[]; label: string; beforeDoc?: Partial<Doc>; afterDoc?: Partial<Doc> }
  | { type: "doc"; before: Partial<Doc>; after: Partial<Doc>; label: string };

const MAX_UNDO = 300;
const JOURNAL_KEY = "notefira-journal";

export class DocSession {
  doc: Doc;
  pages: Map<ID, Page>;
  corrupted: ID[];
  version = 0;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private dirty = new Set<ID>();
  private removed = new Set<ID>();
  private docDirty = false;
  private timer: any = null;
  private saving: Promise<void> | null = null;
  private subs = new Set<() => void>();
  refs = 0;
  lastError: string | null = null;

  constructor(doc: Doc, loaded: repo.LoadedPages) {
    this.doc = doc;
    this.pages = loaded.pages;
    this.corrupted = loaded.corrupted;
    this.libraryBase = pickLibraryFields(doc);
  }

  /** Library-owned fields as last seen in storage (to tell external edits from the session's own). */
  private libraryBase: Partial<Doc>;

  /**
   * The library (favourite star, rename, move, cover, trash) and sync write the document
   * record directly while this session may hold an older copy in memory. Adopt any of those
   * fields that changed in storage, so the session's next autosave doesn't write the stale
   * values back (e.g. un-favouriting a notebook as soon as you draw in it).
   */
  adoptStoredDoc(stored: Doc) {
    const next = pickLibraryFields(stored);
    const patch: Partial<Doc> = {};
    for (const k of LIBRARY_FIELDS) {
      if (!sameValue(next[k], this.libraryBase[k])) (patch as any)[k] = next[k];
    }
    this.libraryBase = next;
    if (Object.keys(patch).length) {
      this.doc = { ...this.doc, ...patch };
      this.changed();
    }
  }

  subscribe(fn: () => void) {
    this.subs.add(fn);
    return () => void this.subs.delete(fn);
  }
  private changed() {
    this.version++;
    this.subs.forEach((f) => f());
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  page(id: ID) {
    return this.pages.get(id);
  }
  orderedPages(): Page[] {
    return this.doc.pageIds.map((id) => this.pages.get(id)!).filter(Boolean);
  }

  private push(e: Entry) {
    this.undoStack.push(e);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  // ------------------------------------------------------------------ edits
  setItems(pageId: ID, items: Item[], label = "Edit") {
    const p = this.pages.get(pageId);
    if (!p) return;
    this.push({ type: "items", pageId, before: p.items, after: items, label });
    this.applyItems(pageId, items);
  }

  addItems(pageId: ID, add: Item[], label = "Add") {
    const p = this.pages.get(pageId);
    if (!p) return;
    this.setItems(pageId, [...p.items, ...add], label);
  }

  /** Replace items by id (and optionally remove ids) in one undoable step. */
  replaceItems(pageId: ID, replace: Map<ID, Item[]>, label = "Edit") {
    const p = this.pages.get(pageId);
    if (!p) return;
    const next: Item[] = [];
    for (const it of p.items) {
      const r = replace.get(it.id);
      if (r) next.push(...r);
      else next.push(it);
    }
    this.setItems(pageId, next, label);
  }

  removeItems(pageId: ID, ids: Set<ID>, label = "Delete") {
    const p = this.pages.get(pageId);
    if (!p) return;
    this.setItems(pageId, p.items.filter((i) => !ids.has(i.id)), label);
  }

  private applyItems(pageId: ID, items: Item[]) {
    const p = this.pages.get(pageId);
    if (!p) return;
    this.pages.set(pageId, { ...p, items, updated: Date.now() });
    this.dirty.add(pageId);
    this.schedule();
    this.changed();
  }

  updatePage(pageId: ID, patch: Partial<Page>, label = "Page", undoable = true) {
    const p = this.pages.get(pageId);
    if (!p) return;
    const next = { ...p, ...patch, updated: Date.now() };
    if (undoable) this.push({ type: "page", pageId, before: p, after: next, label });
    this.pages.set(pageId, next);
    this.dirty.add(pageId);
    this.schedule();
    this.changed();
  }

  setDoc(patch: Partial<Doc>, undoable = false, label = "Document") {
    if (undoable) {
      const before: Partial<Doc> = {};
      for (const k of Object.keys(patch) as (keyof Doc)[]) (before as any)[k] = this.doc[k];
      this.push({ type: "doc", before, after: patch, label });
    }
    this.doc = { ...this.doc, ...patch };
    this.docDirty = true;
    this.schedule();
    this.changed();
  }

  /** Change the page list (insert / delete / reorder) in one undoable step. */
  setPageList(afterIds: ID[], newPages: Page[] = [], label = "Pages", docPatch: Partial<Doc> = {}) {
    const beforeIds = this.doc.pageIds;
    const removedIds = beforeIds.filter((id) => !afterIds.includes(id));
    const keep = removedIds.map((id) => this.pages.get(id)!).filter(Boolean);
    const beforeDoc: Partial<Doc> = {};
    for (const k of Object.keys(docPatch) as (keyof Doc)[]) (beforeDoc as any)[k] = this.doc[k];
    this.push({ type: "structure", beforeIds, afterIds, pages: [...newPages, ...keep], label, beforeDoc, afterDoc: docPatch });
    this.applyStructure(afterIds, newPages, docPatch);
  }

  private applyStructure(ids: ID[], ensure: Page[], docPatch: Partial<Doc> = {}) {
    for (const p of ensure) {
      if (ids.includes(p.id)) {
        this.pages.set(p.id, p);
        this.dirty.add(p.id);
        this.removed.delete(p.id);
      }
    }
    for (const id of this.doc.pageIds) {
      if (!ids.includes(id)) {
        this.removed.add(id);
        this.dirty.delete(id);
      }
    }
    const bookmarks = (docPatch.bookmarks ?? this.doc.bookmarks).filter((b) => ids.includes(b));
    const outline = (docPatch.outline ?? this.doc.outline).filter((o) => ids.includes(o.pageId));
    this.doc = { ...this.doc, ...docPatch, pageIds: ids, bookmarks, outline };
    this.docDirty = true;
    this.schedule();
    this.changed();
  }

  newPageLike(ref?: Page, bg = this.doc.defaultBg): Page {
    const w = ref && ref.bg.type === "template" ? ref.w : bg.type === "template" && ref ? ref.w : 595;
    const h = ref && ref.bg.type === "template" ? ref.h : 842;
    return { id: uid(), docId: this.doc.id, w: ref?.bg.type === "pdf" ? ref.w : w, h: ref?.bg.type === "pdf" ? ref.h : h, bg: ref?.bg.type === "template" ? ref.bg : bg, items: [], updated: Date.now() };
  }

  insertPage(index: number, page?: Page) {
    const p = page ?? this.newPageLike(this.pages.get(this.doc.pageIds[Math.max(0, index - 1)]));
    const ids = this.doc.pageIds.slice();
    ids.splice(index, 0, p.id);
    this.setPageList(ids, [p], "Add page");
    return p;
  }

  duplicatePages(pageIds: ID[]) {
    const ids = this.doc.pageIds.slice();
    const created: Page[] = [];
    for (const pid of pageIds) {
      const src = this.pages.get(pid);
      if (!src) continue;
      const copy: Page = { ...src, id: uid(), items: src.items.map((i) => ({ ...i, id: uid() })), updated: Date.now() };
      ids.splice(ids.indexOf(pid) + 1, 0, copy.id);
      created.push(copy);
    }
    this.setPageList(ids, created, "Duplicate page");
    return created;
  }

  deletePages(pageIds: ID[]) {
    const ids = this.doc.pageIds.filter((id) => !pageIds.includes(id));
    if (!ids.length) {
      // a document always keeps one page
      const blank = this.newPageLike(this.pages.get(this.doc.pageIds[0]));
      this.setPageList([blank.id], [blank], "Delete page");
      return;
    }
    this.setPageList(ids, [], "Delete page");
  }

  movePage(from: number, to: number) {
    const ids = this.doc.pageIds.slice();
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    this.setPageList(ids, [], "Move page");
  }

  // ------------------------------------------------------------------ history
  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.revert(e, true);
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.revert(e, false);
  }
  private revert(e: Entry, back: boolean) {
    switch (e.type) {
      case "items":
        return this.applyItems(e.pageId, back ? e.before : e.after);
      case "page": {
        const p = back ? e.before : e.after;
        this.pages.set(e.pageId, { ...p, updated: Date.now() });
        this.dirty.add(e.pageId);
        this.schedule();
        return this.changed();
      }
      case "structure":
        return this.applyStructure(back ? e.beforeIds : e.afterIds, e.pages, (back ? e.beforeDoc : e.afterDoc) ?? {});
      case "doc":
        this.doc = { ...this.doc, ...(back ? e.before : e.after) };
        this.docDirty = true;
        this.schedule();
        return this.changed();
    }
  }
  get undoLabel() {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  // ------------------------------------------------------------------ saving
  private schedule() {
    this.journal();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 450);
  }

  get hasUnsaved() {
    return this.dirty.size > 0 || this.removed.size > 0 || this.docDirty;
  }

  /** Synchronous crash-recovery journal (small, best effort) in localStorage. */
  private journal() {
    try {
      if (typeof localStorage === "undefined") return;
      const pages = [...this.dirty].map((id) => this.pages.get(id)).filter(Boolean);
      const data = JSON.stringify({ docId: this.doc.id, at: Date.now(), doc: this.doc, pages });
      if (data.length < 1_500_000) {
        const all = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "{}");
        all[this.doc.id] = data;
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(all));
      }
    } catch {
      /* quota or private mode — autosave still runs */
    }
  }
  private clearJournal() {
    try {
      const all = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "{}");
      delete all[this.doc.id];
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) await this.saving;
    if (!this.hasUnsaved) return;
    const pages = [...this.dirty].map((id) => this.pages.get(id)!).filter(Boolean);
    const removed = [...this.removed];
    this.dirty.clear();
    this.removed.clear();
    this.docDirty = false;
    this.saving = (async () => {
      try {
        const saved = await repo.savePages(this.doc, pages, removed);
        this.doc = { ...this.doc, rev: saved.rev, updated: saved.updated };
        this.lastError = null;
        if (!this.hasUnsaved) this.clearJournal();
      } catch (e: any) {
        // put the work back so the next attempt retries it
        pages.forEach((p) => this.dirty.add(p.id));
        removed.forEach((id) => this.removed.add(id));
        this.docDirty = true;
        this.lastError = e?.message ?? String(e);
        log("error", "Autosave failed: " + this.lastError);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 3000);
      } finally {
        this.saving = null;
        this.changed();
      }
    })();
    return this.saving;
  }

  async reloadFromStorage() {
    const doc = await repo.getDoc(this.doc.id);
    if (!doc) return;
    const loaded = await repo.loadPages(doc);
    this.doc = doc;
    this.pages = loaded.pages;
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }
}

// ---------------------------------------------------------------------------
// Session registry (shared between tabs / split panes)
// ---------------------------------------------------------------------------
const sessions = new Map<ID, Promise<DocSession>>();
const docWatchers = new Map<ID, () => void>();

/** Document fields edited outside the editor (library actions, sync bookkeeping). */
const LIBRARY_FIELDS = ["title", "favorite", "folderId", "cover", "deletedAt", "syncedRev", "remoteRev", "remoteId", "syncAccount", "syncIssue"] as const;
function pickLibraryFields(d: Doc): Partial<Doc> {
  const o: Partial<Doc> = {};
  for (const k of LIBRARY_FIELDS) (o as any)[k] = d[k];
  return o;
}
function sameValue(a: unknown, b: unknown) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function getSession(docId: ID): Promise<DocSession> {
  let s = sessions.get(docId);
  if (!s) {
    s = (async () => {
      const doc = await repo.getDoc(docId);
      if (!doc) throw new Error("This notebook no longer exists.");
      const loaded = await repo.loadPages(doc);
      const sess = new DocSession(doc, loaded);
      docWatchers.get(docId)?.();
      docWatchers.set(
        docId,
        repo.onChange((topic) => {
          if (topic !== "doc:" + docId) return;
          repo.getDoc(docId).then((stored) => stored && sess.adoptStoredDoc(stored)).catch(() => {});
        }),
      );
      if (loaded.corrupted.length) log("warn", `Doc ${docId}: ${loaded.corrupted.length} page(s) failed integrity check`);
      const opened = { ...sess.doc, opened: Date.now() };
      sess.doc = opened;
      repo.saveDoc(opened, false).catch(() => {});
      const revs = await repo.listRevisions(docId).catch(() => []);
      if (!revs.length || Date.now() - revs[0].created > 30 * 60 * 1000) repo.snapshotDoc(docId, "Opened").catch(() => {});
      return sess;
    })();
    sessions.set(docId, s);
    s.catch(() => sessions.delete(docId));
  }
  return s;
}

export function peekSession(docId: ID): DocSession | null {
  let found: DocSession | null = null;
  sessions.get(docId)?.then((s) => (found = s));
  return found;
}

export async function releaseSession(docId: ID) {
  const s = sessions.get(docId);
  if (!s) return;
  const sess = await s.catch(() => null);
  if (sess) await sess.flush();
  sessions.delete(docId);
  docWatchers.get(docId)?.();
  docWatchers.delete(docId);
}

export async function flushAll() {
  await Promise.all([...sessions.values()].map((p) => p.then((s) => s.flush()).catch(() => {})));
}

export function openSessionIds(): ID[] {
  return [...sessions.keys()];
}

/** Apply crash-recovery journals left behind by an unexpected exit. Returns recovered doc titles. */
export async function recoverJournals(): Promise<string[]> {
  const recovered: string[] = [];
  try {
    const all = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "{}");
    for (const [docId, raw] of Object.entries(all)) {
      try {
        const j = JSON.parse(raw as string);
        const stored = await repo.getDoc(docId);
        if (!stored) continue;
        const pages: Page[] = j.pages || [];
        const loaded = await repo.loadPages(stored);
        const newer = pages.filter((p) => (loaded.pages.get(p.id)?.updated ?? 0) < p.updated);
        const docNewer = j.doc && JSON.stringify(j.doc.pageIds) !== JSON.stringify(stored.pageIds) && j.at > stored.updated;
        if (newer.length || docNewer) {
          await repo.savePages(docNewer ? { ...stored, ...j.doc, rev: stored.rev } : stored, newer);
          recovered.push(stored.title);
        }
      } catch {
        /* skip corrupt journal */
      }
    }
    localStorage.removeItem(JOURNAL_KEY);
  } catch {
    /* ignore */
  }
  return recovered;
}

if (typeof window !== "undefined") {
  const flushNow = () => void flushAll();
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  repo.onChange((topic) => {
    if (topic.startsWith("doc-reload:")) {
      const id = topic.slice(11);
      sessions.get(id)?.then((s) => {
        if (!s.hasUnsaved) s.reloadFromStorage();
      });
    }
  });
}
