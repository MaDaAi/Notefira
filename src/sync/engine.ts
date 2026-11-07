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
import { contentChecksum, decodeFile, encodeFile, remapIds, safeParse, sha256Hex, type NotefiraFile } from "../model/format";
import { assetHash, collectDocFile, storeNotefira, storeNotefiraIf } from "../services/transfer";
import { fnv1a, uid } from "../model/util";

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
  /** Device-only notebooks whose Google Drive copy was moved to the Drive trash, as the user asked. */
  removedFromDrive: number;
  /** Duplicate Drive files cleaned up (identical ones trashed, different ones kept as copies first). */
  duplicates: number;
  /** Notebooks that newly need the user's decision (missing, other account, damaged). */
  attention: number;
  errors: string[];
}

export interface Conflict {
  docId: ID;
  copyId: ID;
  title: string;
  at: number;
  /** The Drive version (nfRev) the copy was made from. */
  fromRev?: string;
}

/** A notebook deleted forever on this device, waiting for its Drive copy to be trashed. */
export interface Tombstone {
  id: string;
  /** The Drive version this device last synced; a different one means another device changed it since. */
  rev?: string;
  title?: string;
  account?: string;
}

/** Things sync did on its own that the user should know about (shown until dismissed). */
export interface SyncNotice {
  id: string;
  kind: "kept-after-delete";
  title: string;
  at: number;
}

/**
 * A notebook file left untouched in Drive for the user to decide: it failed
 * validation and has no local copy ("damaged"), or it is a second, different
 * version of a notebook that could not be verifiably copied to this device
 * ("duplicate"), so it was not trashed.
 */
export interface DamagedRemote {
  fileId: string;
  name: string;
  nfRev: string;
  at: number;
  reason?: "damaged" | "duplicate";
  /** The user chose to ignore it (until the file changes in Drive). */
  dismissed?: boolean;
}

/** A local copy could not be confirmed to hold exactly what was downloaded. */
export class PreservationFailed extends Error {
  name = "PreservationFailed";
}

/** Test seam: runs after a copy is written and before it is verified. */
export const testHooks: { afterCopyStored: ((copyId: ID) => Promise<void>) | null } = { afterCopyStored: null };

export class DamagedFile extends Error {
  name = "DamagedFile";
}

const DOC_MIME = "application/x-notefira";
/** Largest notebook file accepted from Drive (attachments are separate files, so this is pages only). */
const MAX_SYNC_DOC_BYTES = 256 * 1024 * 1024;

/**
 * Attachments in Drive. Current: one file per distinct content, tagged
 * { nfType: "blob", nfHash: <SHA-256> }, shared by every notebook that uses it.
 * Legacy (format 1): one file per attachment id, tagged { nfType: "asset", nfId }.
 */
interface Attachments {
  byHash: Map<string, RemoteFile[]>;
  byId: Map<string, RemoteFile>;
}
/** The Drive folder everything lives in (in My Drive; found by its appProperties tag, so moving it is fine). */
export const ROOT_NAME = "Notefira Sync";
/** Default names used by earlier versions; such a folder is renamed in place (no files are moved or copied). */
const LEGACY_ROOT_NAMES = ["Notefira"];
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

/** Errors that end the whole run (retried later as a whole): offline, sign-in expired, Drive permission missing. */
export function stopsRun(e: any): boolean {
  return e?.status === 0 || e?.name === "AuthRequired" || (e?.status === 403 && e?.message === "PERMISSION");
}

const issue = (kind: SyncIssue["kind"], detail?: string): SyncIssue => ({ kind, at: Date.now(), detail });

const byCreated = (files: RemoteFile[]) => [...files].sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || (a.id < b.id ? -1 : 1));

/**
 * Find (or create) the one Notefira Sync folder. When two devices created a
 * folder at the same moment, every device picks the oldest one and moves the
 * other folder's files into it, so they converge on a single folder.
 */
export async function resolveRoot(drive: DriveApi, account?: string): Promise<string> {
  const key = account ? `driveRoot:${accountKey(account)}` : null;
  let roots = await drive.findRoots();
  // Drive search can lag behind a create: also trust the folder this device used last time, if it still exists
  const known = key ? await db.kvGet<string | null>(key, null) : null;
  if (known && !roots.some((r) => r.id === known)) {
    const f = await drive.get(known).catch(() => null);
    if (f?.appProperties?.notefiraRoot === "1") roots.push(f);
  }
  if (!roots.length) {
    const made = await drive.createFolder(ROOT_NAME, { notefiraRoot: "1" });
    // look again: another device may have created one at the same time
    roots = await drive.findRoots();
    if (!roots.some((r) => r.id === made.id)) roots.push(made);
  }
  const [root, ...extra] = byCreated(roots);
  if (LEGACY_ROOT_NAMES.includes(root.name)) await drive.rename(root.id, ROOT_NAME);
  for (const x of extra) {
    for (const f of await drive.list(x.id)) await drive.move(f.id, x.id, root.id);
    if (!(await drive.list(x.id)).length) await drive.trash(x.id); // empty now; Drive keeps it in its trash for 30 days
  }
  if (key) await db.kvSet(key, root.id);
  return root.id;
}

/** "Lecture notes (a1b2c3d4).notefira": readable, unique, and stable while the title stays the same. */
export function notebookFileName(title: string, id: string): string {
  const clean =
    title
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Untitled";
  return `${clean} (${id.slice(0, 8)}).notefira`;
}

async function addConflict(c: Conflict) {
  const list = await db.kvGet<Conflict[]>("conflicts", []);
  await db.kvSet("conflicts", [...list, c]);
}

/** Bring a Drive version down as a separate local notebook with fresh ids, so both versions survive. */
async function storeRemoteAsCopy(drive: DriveApi, file: RemoteFile, remoteAssets: Attachments, folderId: ID | null, label: string): Promise<Doc> {
  const nf = await fetchDocFile(drive, file);
  await ensureAssets(drive, nf, remoteAssets);
  const copyFile = remapIds(nf); // fresh doc/page/asset ids, same order as nf.assets
  // give the copy its own asset rows so deleting one copy never removes the other's files
  for (let i = 0; i < nf.assets.length; i++) {
    const src = await db.get<Asset>("assets", nf.assets[i].id);
    if (src) await db.put("assets", { ...src, id: copyFile.assets[i].id, docId: copyFile.doc.id, remoteId: undefined });
  }
  const copyAssetIds = copyFile.assets.map((a) => a.id);
  copyFile.assets = [];
  const when = new Date().toLocaleString();
  copyFile.doc = { ...copyFile.doc, title: `${nf.doc.title} (${label}, ${when})`, conflictOf: nf.doc.id, folderId };
  const copy = await storeNotefira(copyFile, { keepIds: true, strict: true });
  if (testHooks.afterCopyStored) await testHooks.afterCopyStored(copy.id);
  // read it back: only a copy that is verifiably complete counts as preserved
  const problem = await verifyStoredCopy(copyFile, nf, copyAssetIds);
  if (problem) {
    await repo.purgeDoc(copy.id).catch(() => {}); // our own incomplete copy; the Drive file is untouched
    throw new PreservationFailed(problem);
  }
  return copy;
}

async function verifyStoredCopy(copyFile: NotefiraFile, original: NotefiraFile, copyAssetIds: ID[]): Promise<string | null> {
  const doc = await repo.getDoc(copyFile.doc.id);
  if (!doc) return "the copy was not stored";
  if (doc.pageIds.join() !== copyFile.doc.pageIds.join()) return "the copy's page list differs";
  const pages = await db.getMany<any>("pages", doc.pageIds);
  if (pages.some((p) => !p)) return "a page of the copy is missing";
  if (contentChecksum(doc, pages) !== contentChecksum(copyFile.doc, copyFile.pages)) return "the copy's content differs from the download";
  for (const r of copyFile.recordings) if (!(await db.get("recordings", r.id))) return "a recording of the copy is missing";
  for (let i = 0; i < original.assets.length; i++) {
    const src = await db.get<Asset>("assets", original.assets[i].id);
    if (!src) continue; // not available in Drive either; the original notebook has the same gap
    const mine = await db.get<Asset>("assets", copyAssetIds[i]);
    if (!mine || mine.blob.size !== src.blob.size) return "an attachment of the copy is missing";
  }
  return null;
}

export async function syncOnce(drive: DriveApi, account: string, onProgress: (p: SyncProgress) => void = () => {}): Promise<SyncReport> {
  account = accountKey(account);
  const report: SyncReport = { uploaded: 0, downloaded: 0, conflicts: 0, trashed: 0, deferred: 0, duplicates: 0, removedFromDrive: 0, attention: 0, errors: [] };
  onProgress({ phase: "Connecting to Google Drive", done: 0, total: 1 });
  const root = await resolveRoot(drive, account);
  const remote = await drive.list(root);
  const docGroups = new Map<string, RemoteFile[]>();
  const assetGroups = new Map<string, RemoteFile[]>();
  const blobGroups = new Map<string, RemoteFile[]>();
  const libFiles: RemoteFile[] = [];
  const add = (m: Map<string, RemoteFile[]>, k: string, f: RemoteFile) => m.set(k, [...(m.get(k) ?? []), f]);
  for (const f of remote) {
    const t = f.appProperties?.nfType;
    if (t === "doc" && f.appProperties?.nfId) add(docGroups, f.appProperties.nfId, f);
    else if (t === "asset" && f.appProperties?.nfId) add(assetGroups, f.appProperties.nfId, f);
    else if (t === "blob" && /^[0-9a-f]{64}$/.test(f.appProperties?.nfHash ?? "")) add(blobGroups, f.appProperties!.nfHash, f);
    else if (t === "library") libFiles.push(f);
  }

  // ---- library metadata (folders, study sets): per-record last-writer-wins merge
  onProgress({ phase: "Syncing folders and study sets", done: 0, total: 1 });
  await syncLibrary(drive, root, libFiles);

  // ---- tombstones (documents deleted forever on this device). A Drive copy that another device changed
  // after this device last synced it is NOT trashed: it comes back here, and the user is told.
  const tombs = (await db.kvGet<(string | Tombstone)[]>("tombstones", [])).map((t) => (typeof t === "string" ? { id: t } : t));
  const notices = await db.kvGet<SyncNotice[]>("syncNotices", []);
  if (tombs.length) {
    const left: Tombstone[] = [];
    for (let i = 0; i < tombs.length; i++) {
      const t = tombs[i];
      if (t.account && t.account !== account) {
        left.push(t); // belongs to another Google account: wait until that account is signed in
        continue;
      }
      const group = [...docGroups.entries()].find(([, fs]) => fs.some((f) => f.id === t.id));
      if (group && t.rev !== undefined && group[1].some((f) => (f.appProperties?.nfRev ?? "") !== t.rev)) {
        notices.push({ id: uid(), kind: "kept-after-delete", title: t.title ?? group[1][0].name.replace(/ \([0-9a-f]{8}\)\.notefira$|\.notefira$/, ""), at: Date.now() });
        report.attention++;
        continue;
      }
      const ids = group ? group[1].map((f) => f.id) : [t.id];
      try {
        for (const id of ids) await drive.trash(id);
        report.trashed++;
        if (group) docGroups.delete(group[0]);
      } catch (e: any) {
        left.push(t);
        if (stopsRun(e)) {
          await db.kvSet("tombstones", [...left, ...tombs.slice(i + 1)]);
          await db.kvSet("syncNotices", notices);
          throw e;
        }
      }
    }
    await db.kvSet("tombstones", left);
    await db.kvSet("syncNotices", notices);
  }

  // ---- duplicate files (an upload retried after a lost response, or two devices racing)
  // content-addressed attachments: several files claiming one hash are all kept; each download is verified, so the first good one is used
  const remoteAssets: Attachments = { byHash: new Map([...blobGroups].map(([h, fs]) => [h, byCreated(fs)])), byId: new Map() };
  for (const [id, files] of assetGroups) {
    const [keep, ...extra] = byCreated(files);
    remoteAssets.byId.set(id, keep);
    // asset ids are unique and their bytes never change, so extra copies are identical
    for (const x of extra) {
      await drive.trash(x.id);
      report.duplicates++;
    }
  }
  // ---- Drive files held for the user (damaged, or a duplicate that could not be verifiably copied); dropped once they change or disappear
  const damaged = (await db.kvGet<DamagedRemote[]>("damagedRemote", [])).filter((x) => remote.some((f) => f.id === x.fileId && (f.appProperties?.nfRev ?? "") === x.nfRev));
  const hold = (f: RemoteFile, reason: DamagedRemote["reason"]) => {
    const prev = damaged.find((x) => x.fileId === f.id);
    if (prev) Object.assign(prev, { reason, nfRev: f.appProperties?.nfRev ?? "" });
    else damaged.push({ fileId: f.id, name: f.name, nfRev: f.appProperties?.nfRev ?? "", at: Date.now(), reason });
  };
  const remoteDocs = new Map<string, RemoteFile>();
  const localById = new Map((await repo.listDocs()).map((d) => [d.id, d]));
  for (const [id, files] of docGroups) {
    if (files.length === 1) {
      remoteDocs.set(id, files[0]);
      continue;
    }
    const local = localById.get(id);
    const newest = [...files].sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "") || (a.id < b.id ? -1 : 1));
    const keep = files.find((f) => f.id === local?.remoteId) ?? newest[0];
    remoteDocs.set(id, keep);
    for (const x of files) {
      if (x === keep) continue;
      try {
        // a different version is trashed only after it exists as a verified copy here and as its own verified file in Drive
        const xRev = x.appProperties?.nfRev ?? "";
        if (xRev !== (keep.appProperties?.nfRev ?? "")) {
          if (damaged.some((h) => h.fileId === x.id && h.dismissed)) continue;
          let copyId = await existingCopy(id, xRev);
          if (!copyId) {
            const copy = await storeRemoteAsCopy(drive, x, remoteAssets, local?.folderId ?? null, "duplicate copy");
            copyId = copy.id;
            await addConflict({ docId: id, copyId, title: copy.title, at: Date.now(), fromRev: xRev });
          }
          await preserveInCloud(drive, root, account, copyId, remoteAssets);
        }
        await drive.trash(x.id);
        const i = damaged.findIndex((h) => h.fileId === x.id);
        if (i >= 0) damaged.splice(i, 1);
        report.duplicates++;
      } catch (e: any) {
        if (stopsRun(e)) throw e;
        // not preserved: the duplicate stays in Drive and the user is told
        const known = damaged.some((h) => h.fileId === x.id);
        hold(x, e instanceof DamagedFile ? "damaged" : "duplicate");
        if (!known) report.attention++;
        if (!(e instanceof DamagedFile) && !(e instanceof PreservationFailed)) report.errors.push(`a second version of ${local?.title ?? "a notebook"}: ${e?.message ?? e}`);
      }
    }
  }


  let locals = await repo.listDocs();
  const localIds = new Set(locals.map((d) => d.id));

  // ---- device-only notebooks whose Drive copy the user asked to remove: only after this device's copy checks out
  for (const d of locals) {
    if (!d.localOnly || !d.cloudRemoval || !d.remoteId) continue;
    if (d.syncAccount && d.syncAccount !== account) continue; // that Drive belongs to another account: wait for it
    const problem = await localCopyProblem(d);
    if (problem) {
      await patchDoc(d.id, { cloudRemoval: undefined });
      report.errors.push(`“${d.title}” was not removed from Google Drive because this device's copy could not be verified (${problem}). Nothing was deleted.`);
      continue;
    }
    for (const f of docGroups.get(d.id) ?? []) await drive.trash(f.id);
    // its attachments too, unless another notebook uses them (only decidable when this device has every Drive notebook)
    const everyDriveNotebookHere = [...remoteDocs.keys()].every((id) => localIds.has(id));
    if (everyDriveNotebookHere) {
      const used = new Set<string>();
      for (const o of locals) if (o.id !== d.id) for (const a of await repo.listDocAssets(o.id)) used.add(await assetHash(a));
      for (const a of await repo.listDocAssets(d.id)) {
        const h = await assetHash(a);
        if (!used.has(h)) for (const f of remoteAssets.byHash.get(h) ?? []) await drive.trash(f.id);
      }
    }
    remoteDocs.delete(d.id);
    await patchDoc(d.id, { remoteId: undefined, remoteRev: undefined, syncedRev: undefined, syncAccount: undefined, cloudRemoval: undefined });
    report.removedFromDrive++;
  }
  locals = await repo.listDocs();
  const work: { kind: "up" | "down" | "conflict" | "new"; doc?: Doc; file?: RemoteFile }[] = [];
  for (let d of locals) {
    if (d.localOnly) continue; // kept on this device only: never uploaded, and Drive changes are not applied to it
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
    onProgress({ phase: w.kind === "up" ? "Uploading" : w.kind === "conflict" ? "Keeping both versions" : w.kind === "new" ? "Restoring from Google Drive" : "Downloading", done, total: work.length });
    try {
      switch (w.kind) {
        case "up": {
          // earlier work in this run may already have uploaded it (a conflicted copy preserved in Drive)
          const cur = await repo.getDoc(w.doc!.id);
          if (!cur) break;
          let file = w.file;
          if (!file && cur.remoteId && cur.syncAccount === account) {
            if (cur.rev === cur.syncedRev) break;
            file = (await drive.get(cur.remoteId)) ?? undefined;
          }
          await uploadDoc(drive, root, account, cur, file, remoteAssets);
          report.uploaded++;
          break;
        }
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
        else hold(w.file!, "damaged");
        report.attention++;
      } else {
        report.errors.push(`${w.doc?.title ?? w.file?.name ?? "notebook"}: ${e?.message ?? e}`);
        if (stopsRun(e)) {
          await db.kvSet("damagedRemote", damaged);
          throw e; // network/auth: abort the run and retry later
        }
      }
    }
    done++;
  }
  await db.kvSet("damagedRemote", damaged);

  // ---- give in-sync notebooks their stable file name (older versions used the bare title)
  for (const d of await repo.listDocs()) {
    const f = remoteDocs.get(d.id);
    if (!f || d.localOnly || d.syncIssue || d.syncAccount !== account || d.rev !== d.syncedRev || (f.appProperties?.nfRev ?? "") !== d.remoteRev) continue;
    const want = notebookFileName(d.title, d.id);
    if (f.name === want) continue;
    try {
      await drive.rename(f.id, want);
    } catch (e: any) {
      if (stopsRun(e)) throw e;
    }
  }
  if (report.attention || report.conflicts || report.duplicates) repo.emit("library");
  repo.emit("sync-status", false); // refresh per-notebook status in the library (does not trigger another sync)
  onProgress({ phase: "Up to date", done: work.length, total: work.length });
  // "last synced" means Drive confirmed everything; a run with problems does not count
  if (!report.errors.length && !report.deferred) await db.kvSet("lastSync", Date.now());
  return report;
}

const EXT: Record<string, string> = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/mpeg": ".mp3" };

/** Upload each attachment of a notebook once per distinct content (already in Drive: nothing to send). */
async function uploadAssets(drive: DriveApi, root: string, docId: ID, remoteAssets: Attachments) {
  for (const a of await repo.listDocAssets(docId)) {
    const hash = await assetHash(a);
    if (remoteAssets.byHash.get(hash)?.length) continue;
    const f = await drive.create(root, `${hash}${EXT[a.mime] ?? ""}`, a.mime, { nfType: "blob", nfHash: hash }, a.blob);
    remoteAssets.byHash.set(hash, [f]);
  }
}

async function uploadDoc(drive: DriveApi, root: string, account: string, d: Doc, file: RemoteFile | undefined, remoteAssets: Attachments): Promise<{ remote: RemoteFile; hash: string }> {
  await uploadAssets(drive, root, d.id, remoteAssets);
  const startRev = (await repo.getDoc(d.id))?.rev ?? d.rev;
  const nf = await collectDocFile(d.id, false);
  const bytes = await encodeFile(nf);
  const nfRev = uid();
  const props = { nfType: "doc", nfId: d.id, nfRev };
  const name = notebookFileName(d.title, d.id);
  let remote: RemoteFile;
  if (file) {
    // re-check right before writing: another device may have uploaded meanwhile
    const fresh = await drive.get(file.id);
    if (fresh && (fresh.appProperties?.nfRev ?? "") !== (d.remoteRev ?? "")) throw Object.assign(new Error("Changed on another device; will merge on the next sync."), { status: 409 });
    remote = fresh ? await drive.update(file.id, name, DOC_MIME, props, bytes) : await drive.create(root, name, DOC_MIME, props, bytes);
  } else remote = await drive.create(root, name, DOC_MIME, props, bytes);
  await patchDoc(d.id, { remoteId: remote.id, remoteRev: nfRev, syncedRev: startRev, syncAccount: account, syncIssue: undefined });
  return { remote: { ...remote, appProperties: props }, hash: nf.integrity!.hash };
}

/**
 * Make sure a local copy also exists as its own file in Google Drive, read back
 * and verified, so the version it holds survives even if this browser's storage
 * is cleared. Nothing in Drive is overwritten or trashed until this succeeds.
 */
async function preserveInCloud(drive: DriveApi, root: string, account: string, copyId: ID, remoteAssets: Attachments) {
  const copy = await repo.getDoc(copyId);
  if (!copy) throw new PreservationFailed("The local copy is missing.");
  if (copy.remoteId && copy.syncAccount === account && copy.rev === copy.syncedRev) {
    const there = await drive.get(copy.remoteId);
    if (there && (there.appProperties?.nfRev ?? "") === copy.remoteRev) return; // already safely in Drive
  }
  const { remote, hash } = await uploadDoc(drive, root, account, copy, undefined, remoteAssets);
  let back: NotefiraFile;
  try {
    back = await fetchDocFile(drive, remote);
  } catch (e: any) {
    if (stopsRun(e)) throw e;
    throw new PreservationFailed("The copy in Google Drive could not be read back.");
  }
  if (back.integrity?.hash !== hash) throw new PreservationFailed("The copy in Google Drive does not match.");
}

/** Why this device's copy of a notebook can't be trusted as complete (null when every page and attachment is intact). */
async function localCopyProblem(d: Doc): Promise<string | null> {
  const { pages, corrupted } = await repo.loadPages(d);
  if (corrupted.length) return "a page failed its integrity check";
  if (d.pageIds.some((id) => !pages.has(id))) return "a page is missing";
  const assets = new Map((await repo.listDocAssets(d.id)).map((a) => [a.id, a]));
  const needed = new Set<string>();
  for (const p of pages.values()) {
    if (p.bg.type === "pdf" || p.bg.asset) needed.add((p.bg as any).asset);
    for (const it of p.items) if (it.kind === "image") needed.add(it.asset);
  }
  if (d.cover?.type === "image") needed.add(d.cover.asset);
  for (const r of await db.getAllByIndex<any>("recordings", "docId", d.id)) needed.add(r.asset);
  for (const id of needed) {
    const a = assets.get(id);
    if (!a || !a.blob || a.blob.size === 0) return "an attachment is missing";
  }
  return null;
}

/** The local copy made earlier for this exact Drive version, if any (a retried run reuses it instead of making another). */
async function existingCopy(docId: ID, fromRev: string): Promise<ID | null> {
  const list = await db.kvGet<Conflict[]>("conflicts", []);
  for (const c of list) if (c.docId === docId && c.fromRev === fromRev && (await repo.getDoc(c.copyId))) return c.copyId;
  return null;
}

/** Download and validate a notebook. Anything short of a clean, complete file is reported as damaged. */
async function fetchDocFile(drive: DriveApi, file: RemoteFile): Promise<NotefiraFile> {
  const bytes = await drive.download(file.id);
  let report;
  try {
    report = await decodeFile(bytes, { strict: true, maxBytes: MAX_SYNC_DOC_BYTES });
  } catch (e: any) {
    throw new DamagedFile(e?.message ?? "The Drive copy could not be read.");
  }
  if (report.droppedItems || report.repairedPages || !report.checksumOk) throw new DamagedFile("The Drive copy failed its integrity check.");
  if (report.file.doc.id !== file.appProperties?.nfId) throw new DamagedFile("The Drive copy belongs to a different notebook.");
  return report.file;
}

/**
 * Fetch the attachments a downloaded notebook needs. Every download is checked
 * against the SHA-256 the notebook lists before it is stored; one that fails is
 * reported as damaged (nothing of the notebook is applied).
 */
async function ensureAssets(drive: DriveApi, nf: NotefiraFile, remoteAssets: Attachments) {
  for (const a of nf.assets) {
    if (await db.get<Asset>("assets", a.id)) continue;
    let bytes: Uint8Array | null = null;
    let sha256 = a.sha256;
    if (sha256) {
      const candidates = remoteAssets.byHash.get(sha256) ?? [];
      const legacy = remoteAssets.byId.get(a.id);
      for (const f of legacy ? [...candidates, legacy] : candidates) {
        const got = await drive.download(f.id);
        if (got.length === a.size && (await sha256Hex(got)) === sha256) {
          bytes = got;
          break;
        }
      }
      if (!bytes && (candidates.length || legacy)) throw new DamagedFile("An attachment in Google Drive failed its SHA-256 check.");
    } else {
      // format 1 notebook: attachment stored by id
      const rid = remoteAssets.byId.get(a.id)?.id ?? a.remoteId;
      if (rid) {
        bytes = await drive.download(rid);
        sha256 = await sha256Hex(bytes);
      }
    }
    if (!bytes) continue; // not in Drive at all: the page shows an empty background rather than failing the notebook
    await db.put("assets", { id: a.id, docId: nf.doc.id, mime: a.mime, size: bytes.length, sha256, blob: new Blob([bytes as BlobPart], { type: a.mime }), created: Date.now(), name: a.name } satisfies Asset);
  }
}

/** Returns false when the local notebook changed while downloading (nothing was written; the next run handles it as a conflict). */
async function downloadDoc(drive: DriveApi, account: string, file: RemoteFile, remoteAssets: Attachments, local?: Doc): Promise<boolean> {
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

async function resolveConflict(drive: DriveApi, root: string, account: string, local: Doc, file: RemoteFile, remoteAssets: Attachments) {
  const remoteRev = file.appProperties?.nfRev ?? "";
  // 1. the Drive version becomes a separate "conflicted copy" here (verified), unless an earlier run already made it
  let copyId = await existingCopy(local.id, remoteRev);
  if (!copyId) {
    const copy = await storeRemoteAsCopy(drive, file, remoteAssets, local.folderId, "conflicted copy");
    copyId = copy.id;
    await addConflict({ docId: local.id, copyId, title: local.title, at: Date.now(), fromRev: remoteRev });
  }
  // 2. ...and its own file in Drive, read back and verified
  await preserveInCloud(drive, root, account, copyId, remoteAssets);
  // 3. only now does this device's version replace the shared Drive file
  await patchDoc(local.id, { remoteRev });
  await uploadDoc(drive, root, account, { ...(await repo.getDoc(local.id))!, remoteRev }, file, remoteAssets);
}

/** Fingerprint of this device's folders and study sets, to tell whether they changed since the last sync. */
async function localLibraryFingerprint(): Promise<string> {
  const [folders, decks, docs] = await Promise.all([repo.listFolders(), repo.listDecks(), repo.listDocs()]);
  // includes which notebooks are device-only: switching one changes what may be shared
  const localOnly = docs.filter((d) => d.localOnly).map((d) => d.id).sort();
  return fnv1a(JSON.stringify([sortById(folders), sortById(decks), localOnly]));
}

async function syncLibrary(drive: DriveApi, root: string, files: RemoteFile[]) {
  const [folders, decks] = await Promise.all([repo.listFolders(), repo.listDecks()]);
  // normally one file; after two folders were merged there can be several: combine them, keep one
  const [file, ...extra] = byCreated(files);
  // nothing changed here or in Drive since the last sync: no need to download it again
  const seen = await db.kvGet<string | null>("librarySeen", null);
  if (file && !extra.length && seen === `${file.id}@${file.modifiedTime ?? ""}` && (await db.kvGet<string | null>("libraryLocal", null)) === (await localLibraryFingerprint())) return;
  const remote: LibraryFile = { folders: [], decks: [], updated: 0 };
  const newer = <T extends { id: string; updated: number }>(into: T[], from: T[]) => {
    for (const x of from) {
      const i = into.findIndex((y) => y.id === x.id);
      if (i < 0) into.push(x);
      else if ((x.updated ?? 0) > (into[i].updated ?? 0)) into[i] = x;
    }
  };
  let unreadable = false;
  for (const f of files) {
    try {
      const raw = await drive.download(f.id);
      if (raw.length > 16 * 1024 * 1024) throw new Error("library file too large");
      const j = safeParse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      newer(remote.folders, Array.isArray(j?.folders) ? j.folders.filter(validLibraryEntry) : []);
      newer(remote.decks, Array.isArray(j?.decks) ? j.decks.filter(validLibraryEntry) : []);
    } catch (e: any) {
      if (stopsRun(e)) throw e;
      unreadable = true;
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
  // study sets made from a notebook kept on this device only stay on this device too (their cards hold its content)
  const localOnlyDocs = new Set((await repo.listDocs()).filter((d) => d.localOnly).map((d) => d.id));
  const shareDecks = md.filter((d) => !(d.docId && localOnlyDocs.has(d.docId)));
  const changedRemote = JSON.stringify(sortById(mf)) !== JSON.stringify(sortById(remote.folders ?? [])) || JSON.stringify(sortById(shareDecks)) !== JSON.stringify(sortById(remote.decks ?? []));
  if (changedLocal) {
    await db.writeTx(["folders", "decks"], (w) => {
      mf.forEach((f) => w.put("folders", f));
      md.forEach((d) => w.put("decks", d));
    });
    repo.emit("library");
    repo.emit("decks");
  }
  let current = file;
  if (changedRemote || !file || extra.length || unreadable) {
    const body = new TextEncoder().encode(JSON.stringify({ folders: mf, decks: shareDecks, updated: Date.now() } satisfies LibraryFile));
    current = file ? await drive.update(file.id, LIB_NAME, "application/json", { nfType: "library" }, body) : await drive.create(root, LIB_NAME, "application/json", { nfType: "library" }, body);
  }
  // only after their content is merged into the kept file
  if (!unreadable) for (const x of extra) await drive.trash(x.id);
  await db.kvSet("lastLibraryIds", { folders: mf.map((f) => f.id), decks: md.map((d) => d.id) });
  await db.kvSet("librarySeen", current?.modifiedTime ? `${current.id}@${current.modifiedTime}` : null);
  await db.kvSet("libraryLocal", await localLibraryFingerprint());
}

/** Folders and study sets from Drive: only well-formed records are merged. */
function validLibraryEntry(x: any): boolean {
  return !!x && typeof x === "object" && typeof x.id === "string" && x.id.length > 0 && x.id.length <= 128 && (x.updated === undefined || (typeof x.updated === "number" && isFinite(x.updated))) && (x.name === undefined || (typeof x.name === "string" && x.name.length <= 1000));
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
  /** Conflicted copies the user has not decided about yet (both versions were kept). */
  conflicts: number;
  /** Folders or study sets changed on this device since Drive last confirmed them. */
  libraryPending?: boolean;
}

export async function syncSummary(account: string | null): Promise<SyncSummary> {
  const acc = account ? accountKey(account) : null;
  let pending = 0;
  let attention = 0;
  let conflicts = 0;
  for (const d of await repo.listDocs()) {
    if (d.localOnly) continue;
    if (d.conflictOf && !d.deletedAt) conflicts++;
    // notebooks in Trash don't ask for decisions (they are still kept and synced as trashed)
    if (d.deletedAt && (d.syncIssue || (acc && d.syncAccount && d.syncAccount !== acc))) continue;
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
  attention += (await db.kvGet<SyncNotice[]>("syncNotices", [])).length;
  const known = await db.kvGet<string | null>("libraryLocal", null);
  const libraryPending = !!acc && known !== null && known !== (await localLibraryFingerprint());
  return { pending, attention, conflicts, libraryPending };
}

/**
 * The user's decision for a notebook that stopped syncing:
 * - "upload": put this device's version in the signed-in account's Drive (a damaged Drive copy is replaced; Drive keeps its old versions).
 * - "keep-local": keep it on this device only; it is not synced until the user chooses "upload".
 */
export async function resolveSyncIssue(docId: ID, action: "upload" | "keep-local" | "trash") {
  if (action === "trash") {
    // the user accepts the deletion: this device's copy goes to Trash (recoverable) and is no longer linked to Drive
    await patchDoc(docId, (cur) => ({ syncIssue: cur.syncIssue ? { ...cur.syncIssue, dismissed: true } : undefined }));
    await repo.trashDoc(docId);
    repo.emit("library");
    return;
  }
  await patchDoc(docId, (cur) => {
    const is = cur.syncIssue;
    if (action === "keep-local") return is ? { syncIssue: { ...is, dismissed: true } } : null;
    if (is?.kind === "damaged") return { syncIssue: undefined, remoteRev: is.detail, syncedRev: undefined };
    return { syncIssue: undefined, remoteId: undefined, remoteRev: undefined, syncedRev: undefined, syncAccount: undefined };
  });
  repo.emit("library");
}

export async function dismissNotice(id: string) {
  const list = await db.kvGet<SyncNotice[]>("syncNotices", []);
  await db.kvSet(
    "syncNotices",
    list.filter((n) => n.id !== id),
  );
  repo.emit("library");
}

/**
 * Settle a conflict. "keep-both": just stop showing it. "keep-mine": move the
 * other version to Trash (recoverable; its Drive copy stays until the Trash is emptied).
 */
export async function resolveConflictChoice(copyId: ID, choice: "keep-both" | "keep-mine") {
  const copy = await repo.getDoc(copyId);
  if (copy && choice === "keep-mine") await repo.trashDoc(copyId);
  // keeping both: it becomes an ordinary notebook on every device (the change syncs)
  if (copy && choice === "keep-both") await repo.saveDoc({ ...copy, conflictOf: undefined });
  const list = await db.kvGet<Conflict[]>("conflicts", []);
  await db.kvSet(
    "conflicts",
    list.filter((c) => c.copyId !== copyId),
  );
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
  const report = await decodeFile(bytes, { strict: true, maxBytes: MAX_SYNC_DOC_BYTES });
  const root = await resolveRoot(drive);
  const remoteAssets: Attachments = { byHash: new Map(), byId: new Map() };
  for (const f of await drive.list(root)) {
    const ap = f.appProperties ?? {};
    if (ap.nfType === "asset" && ap.nfId) remoteAssets.byId.set(ap.nfId, f);
    if (ap.nfType === "blob" && ap.nfHash) remoteAssets.byHash.set(ap.nfHash, [...(remoteAssets.byHash.get(ap.nfHash) ?? []), f]);
  }
  await ensureAssets(drive, report.file, remoteAssets);
  await repo.restoreSnapshot(docId, { ...report.file.doc, id: docId }, report.file.pages, "Before restoring a Drive version");
}
