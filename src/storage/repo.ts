import * as db from "./db";
import type { Asset, Deck, Doc, Folder, Item, Page, Recording, Sticker, ID, Background, Cover } from "../model/types";
import { fnv1a, uid } from "../model/util";
import { templateBg } from "../model/templates";
import { mergeDocContent, mergePage, mergePageIds } from "../model/merge";

// ---------------------------------------------------------------------------
// Change notifications (this window + other windows/tabs of the app)
// ---------------------------------------------------------------------------
type Listener = (topic: string) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
try {
  channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("notefira") : null;
  if (channel) channel.onmessage = (e) => listeners.forEach((l) => l(String(e.data)));
} catch {
  channel = null;
}
export function onChange(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}
export function emit(topic: string, broadcast = true, local = true) {
  if (local) listeners.forEach((l) => l(topic));
  if (broadcast) channel?.postMessage(topic);
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------
export function pageChecksum(p: Pick<Page, "w" | "h" | "bg" | "items" | "recognized">): string {
  return fnv1a(JSON.stringify([p.w, p.h, p.bg, p.items, p.recognized ?? ""]));
}

export function sealPage(p: Page): Page {
  return { ...p, sum: pageChecksum(p) };
}

export function verifyPage(p: Page): boolean {
  if (!p || typeof p !== "object" || !Array.isArray(p.items)) return false;
  if (!p.sum) return true;
  return p.sum === pageChecksum(p);
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------
export interface NewDocOptions {
  title?: string;
  folderId?: ID | null;
  bg?: Background;
  w?: number;
  h?: number;
  cover?: Cover;
  pages?: number;
  /** Keep on this device only (never synced). */
  localOnly?: boolean;
}

export function makeDoc(o: NewDocOptions = {}): { doc: Doc; pages: Page[] } {
  const now = Date.now();
  const id = uid();
  const bg = o.bg ?? templateBg("ruled");
  const w = o.w ?? 595,
    h = o.h ?? 842;
  const pages: Page[] = [];
  for (let i = 0; i < (o.pages ?? 1); i++) pages.push(sealPage({ id: uid(), docId: id, w, h, bg, items: [], updated: now }));
  const doc: Doc = {
    id,
    title: o.title?.trim() || "Untitled notebook",
    folderId: o.folderId ?? null,
    cover: o.cover ?? { type: "color", color: "#45bfdb", pattern: "plain" },
    created: now,
    updated: now,
    opened: now,
    favorite: false,
    pageIds: pages.map((p) => p.id),
    bookmarks: [],
    outline: [],
    defaultBg: bg,
    layout: "vertical",
    rev: 1,
    ...(o.localOnly ? { localOnly: true } : {}),
  };
  return { doc, pages };
}

export async function createDoc(o: NewDocOptions = {}): Promise<Doc> {
  const { doc, pages } = makeDoc(o);
  await db.writeTx(["docs", "pages"], (w) => {
    w.put("docs", doc);
    pages.forEach((p) => w.put("pages", p));
  });
  emit("library");
  return doc;
}

export async function listDocs(): Promise<Doc[]> {
  return db.getAll<Doc>("docs");
}

export async function getDoc(id: ID) {
  return db.get<Doc>("docs", id);
}

/** Fields owned by the sync engine. An editor holding an older copy of the document must never overwrite them. */
const SYNC_FIELDS = ["syncedRev", "remoteRev", "remoteId", "syncAccount", "syncIssue", "localOnly", "cloudRemoval"] as const;

/** Ask sync to move a device-only notebook's Google Drive copy to the Drive trash (only after verifying this device's copy). */
export async function requestCloudRemoval(id: ID, remove = true) {
  const wrote = await db.readWriteTx<Doc>(["docs"], { store: "docs", key: id }, (cur, w) => {
    if (!cur || !cur.localOnly || !cur.remoteId) return false;
    const next: Doc = { ...cur };
    if (remove) next.cloudRemoval = true;
    else delete next.cloudRemoval;
    w.put("docs", next);
  });
  if (wrote) {
    emit("doc:" + id, false);
    emit("library");
  }
  return wrote;
}

/** Keep a notebook on this device only, or sync it again. Turning sync off never deletes the copy already in Google Drive. */
export async function setLocalOnly(id: ID, localOnly: boolean) {
  const wrote = await db.readWriteTx<Doc>(["docs"], { store: "docs", key: id }, (cur, w) => {
    if (!cur) return false;
    const next: Doc = { ...cur };
    if (localOnly) next.localOnly = true;
    else {
      delete next.localOnly;
      delete next.cloudRemoval;
    }
    w.put("docs", next);
  });
  if (wrote) {
    emit("doc:" + id, false);
    emit("library");
  }
}

/** Keep sync bookkeeping from the stored record and never let `rev` go backwards (a lower rev could look "already synced"). */
function mergeStored(doc: Doc, stored: Doc | undefined, bump: boolean): Doc {
  const next: Doc = { ...doc };
  if (stored) for (const k of SYNC_FIELDS) (next as any)[k] = stored[k];
  const base = Math.max(doc.rev || 0, stored?.rev || 0);
  if (bump) {
    next.updated = Date.now();
    next.rev = base + 1;
  } else next.rev = base;
  return next;
}

/** Save document metadata. `bump` marks a content change (new local revision → needs sync). */
export async function saveDoc(doc: Doc, bump = true): Promise<Doc> {
  let next = doc;
  await db.readWriteTx<Doc>(["docs"], { store: "docs", key: doc.id }, (stored, w) => {
    next = mergeStored(doc, stored, bump);
    w.put("docs", next);
  });
  emit("library");
  emit("doc:" + doc.id, false);
  return next;
}

/** What an editor started from: the document and each page as they were in storage (undefined: page new in the editor). */
export interface SaveBase {
  doc: Doc;
  pages: Map<ID, Page | undefined>;
}

export interface MergedSave {
  doc: Doc;
  /** Every page as stored (merged where storage had changed underneath the editor). */
  pages: Page[];
  /** Pages that were merged with changes made elsewhere (another tab or window). */
  merged: ID[];
  /** Pages removed in the editor but kept, because they had changed elsewhere (as stored). */
  keptPages: Page[];
}

/**
 * Save an editor's changes without overwriting edits made elsewhere since it
 * loaded the notebook (another browser tab or window): pages that changed in
 * storage are merged item by item, in the same transaction as the write.
 */
export async function savePagesMerged(doc: Doc, pages: Page[], removedPageIds: ID[], base: SaveBase): Promise<MergedSave> {
  const ids = [...new Set([...pages.map((p) => p.id), ...removedPageIds])];
  let result: MergedSave | null = null;
  await db.readManyWriteTx(
    ["docs", "pages", "texts"],
    [{ store: "docs", key: doc.id }, ...ids.map((id) => ({ store: "pages" as const, key: id }))],
    ([stored, ...storedPages], w) => {
      const byId = new Map<ID, Page | undefined>(ids.map((id, i) => [id, storedPages[i]]));
      const merged: ID[] = [];
      const out: Page[] = [];
      for (const p of pages) {
        const b = base.pages.get(p.id);
        const t = byId.get(p.id);
        const m = mergePage(b, p, t);
        if (m !== p) merged.push(p.id);
        const sealed = sealPage(m);
        out.push(sealed);
        w.put("pages", sealed);
      }
      // a page removed here but changed elsewhere is kept
      const keptPages: Page[] = [];
      for (const id of removedPageIds) {
        const b = base.pages.get(id);
        const t = byId.get(id);
        if (t && b && t.sum !== b.sum) keptPages.push(t);
        else {
          w.del("pages", id);
          w.del("texts", id);
        }
      }
      const theirs: Doc = stored ?? doc;
      const pageIds = mergePageIds(base.doc.pageIds, doc.pageIds, theirs.pageIds, new Set(pages.map((p) => p.id)), new Set(keptPages.map((p) => p.id)));
      const content = stored ? mergeDocContent(base.doc, doc, theirs, pageIds) : { ...doc, pageIds };
      const next = mergeStored(content, stored, true);
      w.put("docs", next);
      result = { doc: next, pages: out, merged, keptPages };
    },
  );
  emit("library");
  emit("doc-saved:" + doc.id, true, false);
  return result!;
}

/** Atomically store changed pages together with the bumped document record. */
export async function savePages(doc: Doc, pages: Page[], removedPageIds: ID[] = []): Promise<Doc> {
  let next = doc;
  await db.readWriteTx<Doc>(["docs", "pages", "texts"], { store: "docs", key: doc.id }, (stored, w) => {
    next = mergeStored(doc, stored, true);
    w.put("docs", next);
    for (const p of pages) w.put("pages", sealPage(p));
    for (const id of removedPageIds) {
      w.del("pages", id);
      w.del("texts", id);
    }
  });
  emit("library");
  return next;
}

export interface LoadedPages {
  pages: Map<ID, Page>;
  corrupted: ID[];
}

export async function loadPages(doc: Doc): Promise<LoadedPages> {
  const list = await db.getAllByIndex<Page>("pages", "docId", doc.id);
  const pages = new Map<ID, Page>();
  const corrupted: ID[] = [];
  for (const p of list) {
    if (!verifyPage(p)) {
      corrupted.push(p.id);
      // keep whatever is structurally usable so the user does not lose work
      if (p && Array.isArray(p.items)) pages.set(p.id, { ...p, items: p.items.filter(isValidItem) });
      continue;
    }
    pages.set(p.id, p);
  }
  // Pages referenced by the doc but missing from storage are recreated blank so the doc still opens.
  for (const pid of doc.pageIds) {
    if (!pages.has(pid)) {
      corrupted.push(pid);
      pages.set(pid, { id: pid, docId: doc.id, w: 595, h: 842, bg: doc.defaultBg, items: [], updated: Date.now() });
    }
  }
  return { pages, corrupted };
}

export function isValidItem(it: any): it is Item {
  if (!it || typeof it !== "object" || typeof it.id !== "string") return false;
  switch (it.kind) {
    case "stroke":
      return Array.isArray(it.pts) && it.pts.length % 3 === 0 && it.pts.every((n: unknown) => typeof n === "number" && isFinite(n as number));
    case "text":
    case "image":
    case "link":
      return [it.x, it.y, it.w, it.h].every((n) => typeof n === "number" && isFinite(n));
    default:
      return false;
  }
}

export async function trashDoc(id: ID) {
  const d = await getDoc(id);
  if (!d) return;
  await saveDoc({ ...d, deletedAt: Date.now() });
}

export async function restoreDoc(id: ID) {
  const d = await getDoc(id);
  if (!d) return;
  const { deletedAt, ...rest } = d;
  // if its folder is gone, restore to the top level
  let folderId = rest.folderId;
  if (folderId) {
    const f = await db.get<Folder>("folders", folderId);
    if (!f || f.deletedAt) folderId = null;
  }
  await saveDoc({ ...rest, folderId } as Doc);
}

/** Permanently delete a document and everything that belongs to it. */
export async function purgeDoc(id: ID) {
  const [pageKeys, assetKeys, recKeys, revKeys, textKeys] = await Promise.all([
    db.keysByIndex("pages", "docId", id),
    db.keysByIndex("assets", "docId", id),
    db.keysByIndex("recordings", "docId", id),
    db.keysByIndex("revisions", "docId", id),
    db.keysByIndex("texts", "docId", id),
  ]);
  const doc = await getDoc(id);
  await db.writeTx(["docs", "pages", "assets", "recordings", "revisions", "texts", "kv"], (w) => {
    w.del("docs", id);
    pageKeys.forEach((k) => w.del("pages", k));
    assetKeys.forEach((k) => w.del("assets", k));
    recKeys.forEach((k) => w.del("recordings", k));
    revKeys.forEach((k) => w.del("revisions", k));
    textKeys.forEach((k) => w.del("texts", k));
  });
  if (doc?.remoteId) {
    // remember which Drive version this device knew: if another device changed it since, sync keeps it instead of trashing it
    const tomb = await db.kvGet<unknown[]>("tombstones", []);
    await db.kvSet("tombstones", [...tomb, { id: doc.remoteId, rev: doc.remoteRev, title: doc.title, account: doc.syncAccount }]);
  }
  emit("library");
}

export async function duplicateDoc(id: ID, title?: string): Promise<Doc | null> {
  const doc = await getDoc(id);
  if (!doc) return null;
  const { pages } = await loadPages(doc);
  const assets = await db.getAllByIndex<Asset>("assets", "docId", id);
  const now = Date.now();
  const newId = uid();
  const assetMap = new Map<ID, ID>();
  for (const a of assets) assetMap.set(a.id, uid());
  const mapAsset = (a: ID) => assetMap.get(a) ?? a;
  const pageMap = new Map<ID, ID>();
  for (const pid of doc.pageIds) pageMap.set(pid, uid());
  const newPages: Page[] = doc.pageIds.map((pid) => {
    const p = pages.get(pid)!;
    return sealPage({
      ...p,
      id: pageMap.get(pid)!,
      docId: newId,
      bg: p.bg.type === "pdf" ? { ...p.bg, asset: mapAsset(p.bg.asset) } : p.bg.asset ? { ...p.bg, asset: mapAsset(p.bg.asset) } : p.bg,
      items: p.items.map((it) =>
        it.kind === "image" ? { ...it, asset: mapAsset(it.asset) } : it.kind === "link" && it.pageId ? { ...it, pageId: pageMap.get(it.pageId) ?? it.pageId } : it,
      ),
      updated: now,
    });
  });
  const nd: Doc = {
    ...doc,
    id: newId,
    title: title ?? `${doc.title} copy`,
    created: now,
    updated: now,
    opened: now,
    favorite: false,
    pageIds: newPages.map((p) => p.id),
    bookmarks: doc.bookmarks.map((b) => pageMap.get(b) ?? b),
    outline: doc.outline.map((o) => ({ ...o, id: uid(), pageId: pageMap.get(o.pageId) ?? o.pageId })),
    cover: doc.cover.type === "image" ? { type: "image", asset: mapAsset(doc.cover.asset) } : doc.cover,
    defaultBg: doc.defaultBg,
    rev: 1,
    syncedRev: undefined,
    remoteRev: undefined,
    remoteId: undefined,
    syncAccount: undefined,
    syncIssue: undefined,
    deletedAt: undefined,
  };
  await db.writeTx(["docs", "pages", "assets"], (w) => {
    w.put("docs", nd);
    newPages.forEach((p) => w.put("pages", p));
    assets.forEach((a) => w.put("assets", { ...a, id: assetMap.get(a.id), docId: newId, remoteId: undefined }));
  });
  emit("library");
  return nd;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
export async function listFolders(): Promise<Folder[]> {
  return db.getAll<Folder>("folders");
}

export async function createFolder(name: string, parentId: ID | null, color = "#7aa7c7"): Promise<Folder> {
  const now = Date.now();
  const f: Folder = { id: uid(), name: name.trim() || "New folder", parentId, color, created: now, updated: now };
  await db.put("folders", f);
  emit("library");
  return f;
}

export async function saveFolder(f: Folder) {
  await db.put("folders", { ...f, updated: Date.now() });
  emit("library");
}

/** True if `candidate` is `folderId` or one of its descendants (used to prevent moving a folder into itself). */
export function isDescendant(folders: Folder[], folderId: ID, candidate: ID | null): boolean {
  let cur: ID | null = candidate;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (cur === folderId) return true;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

export async function moveFolder(id: ID, parentId: ID | null) {
  const folders = await listFolders();
  if (parentId && isDescendant(folders, id, parentId)) throw new Error("A folder cannot be moved inside itself.");
  const f = folders.find((x) => x.id === id);
  if (f) await saveFolder({ ...f, parentId });
}

/** Moves a folder and everything inside it to the trash. */
export async function trashFolder(id: ID) {
  const [folders, docs] = await Promise.all([listFolders(), listDocs()]);
  const now = Date.now();
  const ids = new Set<ID>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
  }
  await db.writeTx(["folders", "docs"], (w) => {
    for (const f of folders) if (ids.has(f.id)) w.put("folders", { ...f, deletedAt: now, updated: now });
    for (const d of docs) if (d.folderId && ids.has(d.folderId) && !d.deletedAt) w.put("docs", { ...d, deletedAt: now, updated: now, rev: d.rev + 1 });
  });
  emit("library");
}

export async function restoreFolder(id: ID) {
  const folders = await listFolders();
  const f = folders.find((x) => x.id === id);
  if (!f) return;
  const parentOk = !f.parentId || folders.some((x) => x.id === f.parentId && !x.deletedAt);
  const { deletedAt, ...rest } = f;
  await saveFolder({ ...(rest as Folder), parentId: parentOk ? f.parentId : null });
}

export async function purgeFolder(id: ID) {
  const [folders, docs] = await Promise.all([listFolders(), listDocs()]);
  const ids = new Set<ID>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
  }
  for (const d of docs) if (d.folderId && ids.has(d.folderId)) await purgeDoc(d.id);
  await db.writeTx(["folders"], (w) => ids.forEach((fid) => w.del("folders", fid)));
  emit("library");
}

// ---------------------------------------------------------------------------
// Assets (images, PDFs, audio)
// ---------------------------------------------------------------------------
const urlCache = new Map<ID, string>();

export async function putAsset(blob: Blob, docId: ID | null, name?: string, id = uid()): Promise<Asset> {
  const a: Asset = { id, docId, mime: blob.type || "application/octet-stream", size: blob.size, blob, created: Date.now(), name };
  await db.put("assets", a);
  if (docId) await touchDoc(docId); // the notebook's file lists its attachments, so it needs uploading again
  return a;
}

/** Mark a notebook as changed (new revision) when something stored beside its pages changed: attachments, recordings. */
export async function touchDoc(id: ID) {
  const wrote = await db.readWriteTx<Doc>(["docs"], { store: "docs", key: id }, (cur, w) => {
    if (!cur) return false;
    w.put("docs", { ...cur, rev: (cur.rev || 0) + 1, updated: Date.now() });
  });
  if (wrote) emit("library");
}

export async function getAsset(id: ID) {
  return db.get<Asset>("assets", id);
}

export async function assetUrl(id: ID): Promise<string | null> {
  const c = urlCache.get(id);
  if (c) return c;
  const a = await getAsset(id);
  if (!a) return null;
  const u = URL.createObjectURL(a.blob);
  urlCache.set(id, u);
  return u;
}

export async function listDocAssets(docId: ID) {
  return db.getAllByIndex<Asset>("assets", "docId", docId);
}

// ---------------------------------------------------------------------------
// Revisions (local version history)
// ---------------------------------------------------------------------------
export interface Revision {
  id: ID;
  docId: ID;
  created: number;
  reason: string;
  doc: Doc;
  pages: Page[];
}

const MAX_REVISIONS = 20;

export async function snapshotDoc(docId: ID, reason: string): Promise<void> {
  const doc = await getDoc(docId);
  if (!doc) return;
  const { pages } = await loadPages(doc);
  const rev: Revision = { id: uid(), docId, created: Date.now(), reason, doc, pages: doc.pageIds.map((id) => pages.get(id)!).filter(Boolean) };
  await db.put("revisions", rev);
  const all = (await db.getAllByIndex<Revision>("revisions", "docId", docId)).sort((a, b) => b.created - a.created);
  const extra = all.slice(MAX_REVISIONS);
  if (extra.length) await db.writeTx(["revisions"], (w) => extra.forEach((r) => w.del("revisions", r.id)));
}

export async function listRevisions(docId: ID) {
  return (await db.getAllByIndex<Revision>("revisions", "docId", docId)).sort((a, b) => b.created - a.created);
}

/** Replace a document's content with a snapshot (the current state is snapshotted first, so this is undoable). */
export async function restoreSnapshot(docId: ID, doc: Doc, pages: Page[], reason = "Before restoring a version") {
  await snapshotDoc(docId, reason);
  const cur = await getDoc(docId);
  const oldPageIds = new Set((await db.keysByIndex("pages", "docId", docId)).map(String));
  const next: Doc = {
    ...doc,
    id: docId,
    rev: Math.max(cur?.rev ?? 0, doc.rev) + 1,
    syncedRev: cur?.syncedRev,
    remoteRev: cur?.remoteRev,
    remoteId: cur?.remoteId,
    syncAccount: cur?.syncAccount,
    syncIssue: cur?.syncIssue,
    updated: Date.now(),
  };
  await db.writeTx(["docs", "pages"], (w) => {
    for (const id of oldPageIds) if (!pages.some((p) => p.id === id)) w.del("pages", id);
    pages.forEach((p) => w.put("pages", sealPage({ ...p, docId })));
    w.put("docs", next);
  });
  emit("library");
  emit("doc-reload:" + docId);
}

// ---------------------------------------------------------------------------
// Recordings, decks, stickers, text layers
// ---------------------------------------------------------------------------
export async function listRecordings(docId: ID) {
  return (await db.getAllByIndex<Recording>("recordings", "docId", docId)).sort((a, b) => a.start - b.start);
}
export async function saveRecording(r: Recording) {
  await db.put("recordings", r);
  await touchDoc(r.docId);
  emit("recordings:" + r.docId);
}
export async function deleteRecording(r: Recording) {
  await db.writeTx(["recordings", "assets"], (w) => {
    w.del("recordings", r.id);
    w.del("assets", r.asset);
  });
  await touchDoc(r.docId);
  emit("recordings:" + r.docId);
}

export async function listDecks(): Promise<Deck[]> {
  return db.getAll<Deck>("decks");
}
export async function saveDeck(d: Deck) {
  await db.put("decks", { ...d, updated: Date.now() });
  emit("decks");
}
export async function deleteDeck(id: ID) {
  await db.del("decks", id);
  emit("decks");
}

export async function listStickers(): Promise<Sticker[]> {
  return (await db.getAll<Sticker>("stickers")).sort((a, b) => b.created - a.created);
}
export async function saveSticker(s: Sticker) {
  await db.put("stickers", s);
  emit("stickers");
}
export async function deleteSticker(id: ID) {
  await db.del("stickers", id);
  emit("stickers");
}

export interface TextRun {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PageText {
  pageId: ID;
  docId: ID;
  source: "pdf" | "ocr";
  text: string;
  runs: TextRun[];
}
export async function getPageText(pageId: ID) {
  return db.get<PageText>("texts", pageId);
}
export async function savePageText(t: PageText) {
  await db.put("texts", t);
}
export async function listDocTexts(docId: ID) {
  return db.getAllByIndex<PageText>("texts", "docId", docId);
}
export async function listAllTexts() {
  return db.getAll<PageText>("texts");
}
export async function listAllPages() {
  return db.getAll<Page>("pages");
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  const nav: any = typeof navigator !== "undefined" ? navigator : null;
  const est = nav?.storage?.estimate ? await nav.storage.estimate() : { usage: 0, quota: 0 };
  const persisted = nav?.storage?.persisted ? await nav.storage.persisted() : false;
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
}

export async function requestPersistentStorage(): Promise<boolean> {
  const nav: any = typeof navigator !== "undefined" ? navigator : null;
  return nav?.storage?.persist ? nav.storage.persist() : false;
}

/** Purge documents that have been in the trash for more than 30 days. */
export async function autoPurgeTrash(days = 30) {
  const cutoff = Date.now() - days * 86400000;
  const docs = await listDocs();
  for (const d of docs) if (d.deletedAt && d.deletedAt < cutoff) await purgeDoc(d.id);
}
