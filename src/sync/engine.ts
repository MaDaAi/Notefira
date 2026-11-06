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
// Safety rules (each one has a test in tests/sync.test.ts):
// - A notebook linked to one Google account is never synced into another one by
//   itself (`syncAccount`); the user decides (`syncIssue: other-account`).
// - A Drive file that disappeared never deletes or trashes the local notebook;
//   the user decides (`syncIssue: missing`).
// - A Drive copy that fails validation (damaged items, checksum mismatch) is
//   never applied over the local notebook (`syncIssue: damaged`).
// - A download is applied only if the local notebook did not change while it
//   was in flight (checked in the same database transaction as the write);
//   otherwise it is deferred and the next run treats it as a conflict.
// - All writes are whole-file replacements and local state is updated only
//   after a write succeeds, so an interrupted sync is simply resumed later.

import type { DriveApi, RemoteFile } from "./drive";
import * as repo from "../storage/repo";
import * as db from "../storage/db";
import type { Asset, Deck, Doc, Folder, ID, SyncIssue } from "../model/types";
import { decodeFile, encodeFile, remapIds, type NotefiraFile } from "../model/format";
import { collectDocFile, storeNotefira, storeNotefiraIf } from "../services/transfer";
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
  /** Downloads postponed because the notebook was edited meanwhile; the next run resolves them. */
  deferred: number;
  /** Notebooks that newly need the user's decision (missing, other account, damaged). */
  attention: number;
  errors: string[];
}

export interface Conflict {
  docId: ID;
  copyId: ID;
  title: string;
  at: number;
}

/** A notebook file in Drive that has no local copy and failed validation, so it was not imported. */
export interface DamagedRemote {
  fileId: string;
  name: string;
  nfRev: string;
  at: number;
  /** The user chose to ignore it (until the file changes in Drive). */
  dismissed?: boolean;
}

export class DamagedFile extends Error {
  name = "DamagedFile";
}

const DOC_MIME = "application/x-notefira";
const LIB_NAME = "library.json";

interface LibraryFile {
  folders: Folder[];
  decks: Deck[];
  updated: number;
}

/** How a Google account is identified locally. */
export function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

let beforeApply: (docId: ID) => Promise<void> = async () => {};
/** Called right before a download replaces a local notebook (the app flushes the open editor here). */
export function setBeforeApply(fn: (docId: ID) => Promise<void>) {
  beforeApply = fn;
}

async function patchDoc(id: ID, patch: Partial<Doc> | ((cur: Doc) => Partial<Doc> | null)): Promise<boolean> {
  const wrote = await db.readWriteTx<Doc>(["docs"], { store: "docs", key: id }, (cur, w) => {
    if (!cur) return false;
    const p = typeof patch === "function" ? patch(cur) : patch;
    if (!p) return false;
    w.put("docs", { ...cur, ...p });
  });
  if (wrote) repo.emit("doc:" + id, false);
  return wrote;
}

const issue = (kind: SyncIssue["kind"], detail?: string): SyncIssue => ({ kind, at: Date.now(), detail });

export async function syncOnce(drive: DriveApi, account: string, onProgress: (p: SyncProgress) => void = () => {}): Promise<SyncReport> {
  account = accountKey(account);
  const report: SyncReport = { uploaded: 0, downloaded: 0, conflicts: 0, trashed: 0, deferred: 0, attention: 0, errors: [] };
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

  // ---- tombstones (documents deleted forever on this device); a failure keeps the tombstone for the next run
  const tombs = await db.kvGet<string[]>("tombstones", []);
  if (tombs.length) {
    const left: string[] = [];
    for (const rid of tombs) {
      try {
        await drive.trash(rid);
        report.trashed++;
      } catch (e: any) {
        left.push(rid);
        if (e?.status === 0 || e?.name === "AuthRequired") {
          await db.kvSet("tombstones", [...left, ...tombs.slice(tombs.indexOf(rid) + 1)]);
          throw e;
        }
      }
    }
    await db.kvSet("tombstones", left);
    for (const [k, f] of remoteDocs) if (tombs.includes(f.id) && !left.includes(f.id)) remoteDocs.delete(k);
  }

  // ---- damaged Drive files without a local copy: skip them until they change
  const damaged = (await db.kvGet<DamagedRemote[]>("damagedRemote", [])).filter((x) => [...remoteDocs.values()].some((f) => f.id === x.fileId && (f.appProperties?.nfRev ?? "") === x.nfRev));

  const locals = await repo.listDocs();
  const localIds = new Set(locals.map((d) => d.id));
  const work: { kind: "up" | "down" | "conflict" | "new"; doc?: Doc; file?: RemoteFile }[] = [];
  for (let d of locals) {
    const f = remoteDocs.get(d.id);
    const nfRev = f?.appProperties?.nfRev ?? "";

    // notebooks synced before accounts were recorded: adopt them only if this account's Drive has them
    if (d.remoteId && !d.syncAccount) {
      if (f) {
        d = { ...d, syncAccount: account };
        await patchDoc(d.id, { syncAccount: account });
      } else if (!d.syncIssue) {
        await patchDoc(d.id, { syncIssue: issue("missing") });
        report.attention++;
        continue;
      }
    }
    // linked to a different Google account: never upload into this one by itself
    if (d.syncAccount && d.syncAccount !== account) {
      if (d.syncIssue?.kind !== "other-account") {
        await patchDoc(d.id, { syncIssue: issue("other-account", d.syncAccount) });
        report.attention++;
      }
      continue;
    }
    // an open issue blocks syncing until it resolves itself or the user decides
    if (d.syncIssue) {
      const k = d.syncIssue.kind;
      const resolved = (k === "other-account" && d.syncAccount === account) || (k === "missing" && !!f) || (k === "damaged" && !!f && nfRev !== d.syncIssue.detail);
      if (!resolved) continue;
      d = { ...d, syncIssue: undefined };
      await patchDoc(d.id, { syncIssue: undefined });
    }
    if (!f) {
      if (d.remoteId) {
        // the Drive file is gone: keep the notebook untouched and let the user decide
        await patchDoc(d.id, { syncIssue: issue("missing") });
        report.attention++;
      } else work.push({ kind: "up", doc: d });
      continue;
    }
    const localChanged = d.rev !== d.syncedRev;
    const remoteChanged = nfRev !== (d.remoteRev ?? "");
    if (localChanged && remoteChanged) work.push({ kind: "conflict", doc: d, file: f });
    else if (localChanged) work.push({ kind: "up", doc: d, file: f });
    else if (remoteChanged) work.push({ kind: "down", doc: d, file: f });
  }
  for (const [id, f] of remoteDocs) {
    if (localIds.has(id)) continue;
    if (damaged.some((x) => x.fileId === f.id)) continue;
    work.push({ kind: "new", file: f });
  }

  let done = 0;
  for (const w of work) {
    onProgress({ phase: w.kind === "up" ? "Uploading" : w.kind === "conflict" ? "Resolving conflict" : "Downloading", done, total: work.length });
    try {
      switch (w.kind) {
        case "up":
          await uploadDoc(drive, root, account, w.doc!, w.file, remoteAssets);
          report.uploaded++;
          break;
        case "down":
        case "new":
          if (await downloadDoc(drive, account, w.file!, remoteAssets, w.doc)) report.downloaded++;
          else report.deferred++;
          break;
        case "conflict":
          await resolveConflict(drive, root, account, w.doc!, w.file!, remoteAssets);
          report.conflicts++;
          break;
      }
    } catch (e: any) {
      if (e instanceof DamagedFile) {
        const nfRev = w.file!.appProperties?.nfRev ?? "";
        if (w.doc) await patchDoc(w.doc.id, { syncIssue: issue("damaged", nfRev) });
        else damaged.push({ fileId: w.file!.id, name: w.file!.name, nfRev, at: Date.now() });
        report.attention++;
      } else {
        report.errors.push(`${w.doc?.title ?? w.file?.name ?? "notebook"}: ${e?.message ?? e}`);
        if (e?.status === 0 || e?.name === "AuthRequired") {
          await db.kvSet("damagedRemote", damaged);
          throw e; // network/auth: abort the run and retry later
        }
      }
    }
    done++;
  }
  await db.kvSet("damagedRemote", damaged);
  if (report.attention || report.conflicts) repo.emit("library");
  onProgress({ phase: "Up to date", done: work.length, total: work.length });
  // "last synced" means Drive confirmed everything; a run with problems does not count
  if (!report.errors.length && !report.deferred) await db.kvSet("lastSync", Date.now());
  return report;
}

async function uploadAssets(drive: DriveApi, root: string, docId: ID, remoteAssets: Map<string, RemoteFile>) {
  const assets = await repo.listDocAssets(docId);
  for (const a of assets) {
    const existing = remoteAssets.get(a.id);
    // re-upload when the Drive copy disappeared (deleted folder, other account)
    if (a.remoteId && existing?.id === a.remoteId) continue;
    let remoteId = existing?.id;
    if (!remoteId) {
      const f = await drive.create(root, `asset-${a.id}`, a.mime, { nfType: "asset", nfId: a.id, nfDoc: docId }, a.blob);
      remoteId = f.id;
      remoteAssets.set(a.id, f);
    }
    if (remoteId !== a.remoteId) await db.put("assets", { ...a, remoteId });
  }
}

async function uploadDoc(drive: DriveApi, root: string, account: string, d: Doc, file: RemoteFile | undefined, remoteAssets: Map<string, RemoteFile>) {
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
  await patchDoc(d.id, { remoteId: remote.id, remoteRev: nfRev, syncedRev: startRev, syncAccount: account, syncIssue: undefined });
}

/** Download and validate a notebook. Anything short of a clean, complete file is reported as damaged. */
async function fetchDocFile(drive: DriveApi, file: RemoteFile): Promise<NotefiraFile> {
  const bytes = await drive.download(file.id);
  let report;
  try {
    report = await decodeFile(bytes);
  } catch (e: any) {
    throw new DamagedFile(e?.message ?? "The Drive copy could not be read.");
  }
  if (report.droppedItems || report.repairedPages || !report.checksumOk) throw new DamagedFile("The Drive copy failed its integrity check.");
  if (report.file.doc.id !== file.appProperties?.nfId) throw new DamagedFile("The Drive copy belongs to a different notebook.");
  return report.file;
}

async function ensureAssets(drive: DriveApi, nf: NotefiraFile, remoteAssets: Map<string, RemoteFile>) {
  for (const a of nf.assets) {
    const local = await db.get<Asset>("assets", a.id);
    if (local) continue;
    const rid = remoteAssets.get(a.id)?.id ?? a.remoteId;
    if (!rid) continue; // missing asset: page renders blank background rather than failing the whole notebook
    const bytes = await drive.download(rid);
    await db.put("assets", { id: a.id, docId: nf.doc.id, mime: a.mime, size: bytes.length, blob: new Blob([bytes as BlobPart], { type: a.mime }), created: Date.now(), name: a.name, remoteId: rid } satisfies Asset);
  }
}

/** Returns false when the local notebook changed while downloading (nothing was written; the next run handles it as a conflict). */
async function downloadDoc(drive: DriveApi, account: string, file: RemoteFile, remoteAssets: Map<string, RemoteFile>, local?: Doc): Promise<boolean> {
  const nf = await fetchDocFile(drive, file);
  await ensureAssets(drive, nf, remoteAssets);
  let dropPages: IDBValidKey[] | undefined;
  if (local) {
    await beforeApply(local.id);
    await repo.snapshotDoc(local.id, "Before update from Google Drive");
    const keep = new Set(nf.pages.map((p) => p.id));
    dropPages = (await db.keysByIndex("pages", "docId", local.id)).filter((k) => !keep.has(String(k)));
  }
  const rev = Math.max(local?.rev ?? 0, nf.doc.rev ?? 0) + 1;
  nf.doc = { ...nf.doc, rev, syncedRev: rev, remoteRev: file.appProperties?.nfRev ?? "", remoteId: file.id, syncAccount: account, syncIssue: undefined };
  const stored = await storeNotefiraIf(nf, { keepIds: true, expectRev: local ? local.rev : null, dropPages });
  if (!stored) return false;
  repo.emit("doc:" + nf.doc.id, false);
  repo.emit("doc-reload:" + nf.doc.id);
  return true;
}

async function resolveConflict(drive: DriveApi, root: string, account: string, local: Doc, file: RemoteFile, remoteAssets: Map<string, RemoteFile>) {
  // 1. bring the Drive version down as a separate "conflicted copy" (fresh ids so both survive)
  const nf = await fetchDocFile(drive, file);
  await ensureAssets(drive, nf, remoteAssets);
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
  const remoteRev = file.appProperties?.nfRev ?? "";
  await patchDoc(local.id, { remoteRev });
  await uploadDoc(drive, root, account, { ...(await repo.getDoc(local.id))!, remoteRev }, file, remoteAssets);
  const list = await db.kvGet<Conflict[]>("conflicts", []);
  await db.kvSet("conflicts", [...list, { docId: local.id, copyId: copy.id, title: local.title, at: Date.now() }]);
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

// ---------------------------------------------------------------------------
// Status and user decisions

export interface SyncSummary {
  /** Notebooks with local changes Drive has not confirmed yet. */
  pending: number;
  /** Notebooks (or Drive files) waiting for the user's decision. */
  attention: number;
  /** Edited-on-two-devices events the user has not dismissed (both versions were kept). */
  conflicts: number;
}

export async function syncSummary(account: string | null): Promise<SyncSummary> {
  const acc = account ? accountKey(account) : null;
  let pending = 0;
  let attention = 0;
  for (const d of await repo.listDocs()) {
    if (d.syncIssue) {
      if (!d.syncIssue.dismissed) attention++;
      continue;
    }
    if (acc && d.syncAccount && d.syncAccount !== acc) {
      attention++;
      continue;
    }
    if (d.rev !== d.syncedRev) pending++;
  }
  attention += (await db.kvGet<DamagedRemote[]>("damagedRemote", [])).filter((x) => !x.dismissed).length;
  const conflicts = (await db.kvGet<Conflict[]>("conflicts", [])).length;
  return { pending, attention, conflicts };
}

/**
 * The user's decision for a notebook that stopped syncing:
 * - "upload": put this device's version in the signed-in account's Drive (a damaged Drive copy is replaced; Drive keeps its old versions).
 * - "keep-local": keep it on this device only; it is not synced until the user chooses "upload".
 */
export async function resolveSyncIssue(docId: ID, action: "upload" | "keep-local") {
  await patchDoc(docId, (cur) => {
    const is = cur.syncIssue;
    if (action === "keep-local") return is ? { syncIssue: { ...is, dismissed: true } } : null;
    if (is?.kind === "damaged") return { syncIssue: undefined, remoteRev: is.detail, syncedRev: undefined };
    return { syncIssue: undefined, remoteId: undefined, remoteRev: undefined, syncedRev: undefined, syncAccount: undefined };
  });
  repo.emit("library");
}

/** Forget a damaged Drive file without a local copy (the file itself stays in Drive). */
export async function dismissDamagedRemote(fileId: string) {
  const list = await db.kvGet<DamagedRemote[]>("damagedRemote", []);
  await db.kvSet(
    "damagedRemote",
    list.map((x) => (x.fileId === fileId ? { ...x, dismissed: true } : x)),
  );
  repo.emit("library");
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
