// Offline-first synchronisation between the local database and Google Drive.
//
// Every notebook is one gzip'd ".notefira" JSON file (strokes, pages, text,
// templates, metadata) plus one Drive file per binary asset (PDF, image, audio).
// Each doc file carries appProperties { nfType, nfId, nfRev }. Locally each doc
// tracks `rev` (bumped on every save), `syncedRev` (the rev last uploaded or
// downloaded) and `remoteRev` (the nfRev seen at that time):
//
//   local changed = rev !== syncedRev     remote changed = file.nfRev !== remoteRev
//
//   neither  -> nothing          local only  -> upload
//   remote   -> download         both        -> conflict: keep both copies
//
// All writes are whole-file replacements and local state is updated only after
// a write succeeds, so an interrupted sync is simply resumed by the next run.

import type { DriveApi, RemoteFile } from "./drive";
import * as repo from "../storage/repo";
import * as db from "../storage/db";
import type { Asset, Deck, Doc, Folder, ID } from "../model/types";
import { decodeFile, encodeFile, type NotefiraFile } from "../model/format";
import { collectDocFile, storeNotefira } from "../services/transfer";
import { uid } from "../model/util";

export interface SyncProgress {
  phase: string;
  done: number;
  total: number;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  trashed: number;
  errors: string[];
}

export interface Conflict {
  docId: ID;
  copyId: ID;
  title: string;
  at: number;
}

const DOC_MIME = "application/x-notefira";
const LIB_NAME = "library.json";

interface LibraryFile {
  folders: Folder[];
  decks: Deck[];
  updated: number;
}

export async function syncOnce(drive: DriveApi, onProgress: (p: SyncProgress) => void = () => {}): Promise<SyncReport> {
  const report: SyncReport = { uploaded: 0, downloaded: 0, conflicts: 0, trashed: 0, errors: [] };
  onProgress({ phase: "Connecting to Google Drive", done: 0, total: 1 });
  const root = await drive.ensureRoot();
  const remote = await drive.list(root);
  const remoteDocs = new Map<string, RemoteFile>();
  const remoteAssets = new Map<string, RemoteFile>();
  let libFile: RemoteFile | undefined;
  for (const f of remote) {
    const t = f.appProperties?.nfType;
    if (t === "doc" && f.appProperties?.nfId) remoteDocs.set(f.appProperties.nfId, f);
    else if (t === "asset" && f.appProperties?.nfId) remoteAssets.set(f.appProperties.nfId, f);
    else if (t === "library") libFile = f;
  }

  // ---- library metadata (folders, study sets): per-record last-writer-wins merge
  onProgress({ phase: "Syncing folders and study sets", done: 0, total: 1 });
  await syncLibrary(drive, root, libFile);

  // ---- tombstones (documents deleted forever on this device)
  const tombs = await db.kvGet<string[]>("tombstones", []);
  if (tombs.length) {
    for (const rid of tombs) {
      await drive.trash(rid);
      report.trashed++;
    }
    await db.kvSet("tombstones", []);
    for (const [k, f] of remoteDocs) if (tombs.includes(f.id)) remoteDocs.delete(k);
  }

  const locals = await repo.listDocs();
  const localIds = new Set(locals.map((d) => d.id));
  const work: { kind: "up" | "down" | "conflict" | "gone" | "new"; doc?: Doc; file?: RemoteFile }[] = [];
  for (const d of locals) {
    const f = remoteDocs.get(d.id);
    const localChanged = d.rev !== d.syncedRev;
    if (!f) {
      if (d.remoteId && !localChanged) work.push({ kind: "gone", doc: d });
      else work.push({ kind: "up", doc: d });
      continue;
    }
    const remoteChanged = (f.appProperties?.nfRev ?? "") !== (d.remoteRev ?? "");
    if (localChanged && remoteChanged) work.push({ kind: "conflict", doc: d, file: f });
    else if (localChanged) work.push({ kind: "up", doc: d, file: f });
    else if (remoteChanged) work.push({ kind: "down", doc: d, file: f });
  }
  for (const [id, f] of remoteDocs) if (!localIds.has(id)) work.push({ kind: "new", file: f });

  let done = 0;
  for (const w of work) {
    onProgress({ phase: w.kind === "up" ? "Uploading" : w.kind === "conflict" ? "Resolving conflict" : "Downloading", done, total: work.length });
    try {
      switch (w.kind) {
        case "up":
          await uploadDoc(drive, root, w.doc!, w.file, remoteAssets);
          report.uploaded++;
          break;
        case "down":
        case "new":
          await downloadDoc(drive, w.file!, remoteAssets, w.doc);
          report.downloaded++;
          break;
        case "conflict":
          await resolveConflict(drive, root, w.doc!, w.file!, remoteAssets);
          report.conflicts++;
          break;
        case "gone": {
          // deleted forever on another device: keep a recoverable copy in this device's trash
          const cur = await repo.getDoc(w.doc!.id);
          if (cur && !cur.deletedAt) await db.put("docs", { ...cur, deletedAt: Date.now(), remoteId: undefined, remoteRev: undefined, syncedRev: undefined });
          else if (cur) await db.put("docs", { ...cur, remoteId: undefined, remoteRev: undefined, syncedRev: cur.rev });
          repo.emit("library");
          break;
        }
      }
    } catch (e: any) {
      report.errors.push(`${w.doc?.title ?? w.file?.name ?? "notebook"}: ${e?.message ?? e}`);
      if (e?.status === 0 || e?.name === "AuthRequired") throw e; // network/auth: abort the run and retry later
    }
    done++;
  }
  onProgress({ phase: "Up to date", done: work.length, total: work.length });
  await db.kvSet("lastSync", Date.now());
  return report;
}

async function uploadAssets(drive: DriveApi, root: string, docId: ID, remoteAssets: Map<string, RemoteFile>) {
  const assets = await repo.listDocAssets(docId);
  for (const a of assets) {
    if (a.remoteId) continue;
    const existing = remoteAssets.get(a.id);
    let remoteId = existing?.id;
    if (!remoteId) {
      const f = await drive.create(root, `asset-${a.id}`, a.mime, { nfType: "asset", nfId: a.id, nfDoc: docId }, a.blob);
      remoteId = f.id;
      remoteAssets.set(a.id, f);
    }
    await db.put("assets", { ...a, remoteId });
  }
}

async function uploadDoc(drive: DriveApi, root: string, d: Doc, file: RemoteFile | undefined, remoteAssets: Map<string, RemoteFile>) {
  await uploadAssets(drive, root, d.id, remoteAssets);
  const startRev = (await repo.getDoc(d.id))?.rev ?? d.rev;
  const nf = await collectDocFile(d.id, false);
  const bytes = await encodeFile(nf);
  const nfRev = uid();
  const props = { nfType: "doc", nfId: d.id, nfRev };
  const name = `${d.title.replace(/[\\/]/g, "_")}.notefira`;
  let remote: RemoteFile;
  if (file) {
    // re-check right before writing: another device may have uploaded meanwhile
    const fresh = await drive.get(file.id);
    if (fresh && (fresh.appProperties?.nfRev ?? "") !== (d.remoteRev ?? "")) throw Object.assign(new Error("Changed on another device; will merge on the next sync."), { status: 409 });
    remote = fresh ? await drive.update(file.id, name, DOC_MIME, props, bytes) : await drive.create(root, name, DOC_MIME, props, bytes);
  } else remote = await drive.create(root, name, DOC_MIME, props, bytes);
  const cur = await repo.getDoc(d.id);
  if (cur) await db.put("docs", { ...cur, remoteId: remote.id, remoteRev: nfRev, syncedRev: startRev });
}

async function fetchDocFile(drive: DriveApi, file: RemoteFile): Promise<NotefiraFile> {
  const report = await decodeFile(await drive.download(file.id));
  return report.file;
}

async function ensureAssets(drive: DriveApi, nf: NotefiraFile, remoteAssets: Map<string, RemoteFile>) {
  for (const a of nf.assets) {
    const local = await db.get<Asset>("assets", a.id);
    if (local) continue;
    const rid = a.remoteId ?? remoteAssets.get(a.id)?.id;
    if (!rid) continue; // missing asset: page renders blank background rather than failing the whole notebook
    const bytes = await drive.download(rid);
    await db.put("assets", { id: a.id, docId: nf.doc.id, mime: a.mime, size: bytes.length, blob: new Blob([bytes as BlobPart], { type: a.mime }), created: Date.now(), name: a.name, remoteId: rid } satisfies Asset);
  }
}

async function downloadDoc(drive: DriveApi, file: RemoteFile, remoteAssets: Map<string, RemoteFile>, local?: Doc) {
  const nf = await fetchDocFile(drive, file);
  await ensureAssets(drive, nf, remoteAssets);
  if (local) await repo.snapshotDoc(local.id, "Before update from Google Drive");
  // replace pages that no longer exist
  if (local) {
    const keep = new Set(nf.pages.map((p) => p.id));
    const old = await db.keysByIndex("pages", "docId", local.id);
    const stale = old.filter((k) => !keep.has(String(k)));
    if (stale.length) await db.writeTx(["pages"], (w) => stale.forEach((k) => w.del("pages", k)));
  }
  const rev = Math.max(local?.rev ?? 0, nf.doc.rev ?? 0) + 1;
  nf.doc = { ...nf.doc, rev, syncedRev: rev, remoteRev: file.appProperties?.nfRev ?? "", remoteId: file.id };
  await storeNotefira(nf, { keepIds: true });
  repo.emit("doc-reload:" + nf.doc.id);
}

async function resolveConflict(drive: DriveApi, root: string, local: Doc, file: RemoteFile, remoteAssets: Map<string, RemoteFile>) {
  // 1. bring the Drive version down as a separate "conflicted copy" (fresh ids so both survive)
  const nf = await fetchDocFile(drive, file);
  await ensureAssets(drive, nf, remoteAssets);
  const { remapIds } = await import("../model/format");
  const copyFile = remapIds(nf); // fresh doc/page/asset ids, same order as nf.assets
  // give the copy its own asset rows so deleting one copy never removes the other's files
  for (let i = 0; i < nf.assets.length; i++) {
    const src = await db.get<Asset>("assets", nf.assets[i].id);
    if (src) await db.put("assets", { ...src, id: copyFile.assets[i].id, docId: copyFile.doc.id, remoteId: undefined });
  }
  copyFile.assets = [];
  const when = new Date().toLocaleString();
  copyFile.doc = { ...copyFile.doc, title: `${nf.doc.title} (conflicted copy, ${when})`, conflictOf: local.id, folderId: local.folderId };
  const copy = await storeNotefira(copyFile, { keepIds: true });
  // 2. upload the local version over the Drive file (it becomes the new shared version)
  await db.put("docs", { ...(await repo.getDoc(local.id))!, remoteRev: file.appProperties?.nfRev ?? "" });
  await uploadDoc(drive, root, (await repo.getDoc(local.id))!, file, remoteAssets);
  const list = await db.kvGet<Conflict[]>("conflicts", []);
  await db.kvSet("conflicts", [...list, { docId: local.id, copyId: copy.id, title: local.title, at: Date.now() }]);
  repo.emit("library");
}

async function syncLibrary(drive: DriveApi, root: string, file: RemoteFile | undefined) {
  const [folders, decks] = await Promise.all([repo.listFolders(), repo.listDecks()]);
  let remote: LibraryFile = { folders: [], decks: [], updated: 0 };
  if (file) {
    try {
      const bytes = await drive.download(file.id);
      remote = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      remote = { folders: [], decks: [], updated: 0 };
    }
  }
  const lastLib = await db.kvGet<{ folders: string[]; decks: string[] }>("lastLibraryIds", { folders: [], decks: [] });
  const merge = <T extends { id: string; updated: number }>(local: T[], rem: T[], prevIds: string[]) => {
    const map = new Map<string, T>();
    const localIds = new Set(local.map((x) => x.id));
    for (const x of rem) {
      // removed locally since the last sync -> do not resurrect
      if (!localIds.has(x.id) && prevIds.includes(x.id)) continue;
      map.set(x.id, x);
    }
    for (const x of local) {
      const r = map.get(x.id);
      if (!r || (x.updated ?? 0) >= (r.updated ?? 0)) map.set(x.id, x);
    }
    return [...map.values()];
  };
  const mf = merge(folders, remote.folders ?? [], lastLib.folders);
  const md = merge(decks, remote.decks ?? [], lastLib.decks);
  const changedLocal = JSON.stringify(sortById(mf)) !== JSON.stringify(sortById(folders)) || JSON.stringify(sortById(md)) !== JSON.stringify(sortById(decks));
  const changedRemote = JSON.stringify(sortById(mf)) !== JSON.stringify(sortById(remote.folders ?? [])) || JSON.stringify(sortById(md)) !== JSON.stringify(sortById(remote.decks ?? []));
  if (changedLocal) {
    await db.writeTx(["folders", "decks"], (w) => {
      mf.forEach((f) => w.put("folders", f));
      md.forEach((d) => w.put("decks", d));
    });
    repo.emit("library");
    repo.emit("decks");
  }
  if (changedRemote || !file) {
    const body = new TextEncoder().encode(JSON.stringify({ folders: mf, decks: md, updated: Date.now() } satisfies LibraryFile));
    if (file) await drive.update(file.id, LIB_NAME, "application/json", { nfType: "library" }, body);
    else await drive.create(root, LIB_NAME, "application/json", { nfType: "library" }, body);
  }
  await db.kvSet("lastLibraryIds", { folders: mf.map((f) => f.id), decks: md.map((d) => d.id) });
}

function sortById<T extends { id: string }>(a: T[]) {
  return [...a].sort((x, y) => (x.id < y.id ? -1 : 1));
}

/** Restore a previous Drive revision of a notebook into the local copy (current state is snapshotted first). */
export async function restoreDriveRevision(drive: DriveApi, docId: ID, fileId: string, revId: string) {
  const bytes = await drive.downloadRevision(fileId, revId);
  const report = await decodeFile(bytes);
  const root = await drive.ensureRoot();
  const remoteAssets = new Map<string, RemoteFile>();
  for (const f of await drive.list(root)) if (f.appProperties?.nfType === "asset" && f.appProperties.nfId) remoteAssets.set(f.appProperties.nfId, f);
  await ensureAssets(drive, report.file, remoteAssets);
  await repo.restoreSnapshot(docId, { ...report.file.doc, id: docId }, report.file.pages, "Before restoring a Drive version");
}
