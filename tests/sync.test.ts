// Google Drive sync, end to end against an in-memory Drive. Each "device" is a
// separate IndexedDB database; switching device closes one and opens the other.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDB, kvGet, put, setDbName } from "../src/storage/db";
import * as repo from "../src/storage/repo";
import { dismissDamagedRemote, notebookFileName, resolveSyncIssue, setBeforeApply, syncOnce, syncSummary, testHooks, type DamagedRemote } from "../src/sync/engine";
import type { DriveApi, RemoteFile } from "../src/sync/drive";
import { decodeJson, encodeJson } from "../src/model/format";
import type { Doc } from "../src/model/types";

const A = "alice@example.com";
const B = "bob@example.com";

class FakeDrive implements DriveApi {
  files = new Map<string, { meta: RemoteFile; parent: string; data: Uint8Array; trashed: boolean }>();
  private n = 0;
  rootCreates = 0;
  /** Runs before every download (simulates something happening while bytes are in flight). */
  onDownload: ((id: string) => Promise<void>) | null = null;
  /** Throws instead of performing the next matching operation. */
  failNext: { op: string; error: any } | null = null;
  private maybeFail(op: string) {
    if (this.failNext?.op === op) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
  }
  private clock = 0;
  private now() {
    return new Date(1_700_000_000_000 + ++this.clock * 1000).toISOString();
  }
  async listTagged() {
    return [...this.files.values()].filter((f) => f.meta.appProperties?.nfType && !f.trashed).map((f) => ({ ...f.meta }));
  }
  async findRoots() {
    return [...this.files.values()].filter((f) => f.meta.appProperties?.notefiraRoot === "1" && !f.trashed).map((f) => ({ ...f.meta }));
  }
  async createFolder(name: string, appProperties: Record<string, string>) {
    this.rootCreates++;
    const id = "root" + ++this.n;
    const t = this.now();
    this.files.set(id, { meta: { id, name, appProperties, createdTime: t, modifiedTime: t }, parent: "", data: new Uint8Array(), trashed: false });
    return { ...this.files.get(id)!.meta };
  }
  async rename(id: string, name: string) {
    this.files.get(id)!.meta.name = name;
  }
  async move(id: string, from: string, to: string) {
    const f = this.files.get(id)!;
    expect(f.parent).toBe(from);
    f.parent = to;
  }
  roots() {
    return [...this.files.values()].filter((f) => f.meta.appProperties?.notefiraRoot === "1" && !f.trashed);
  }
  async list(folder: string) {
    return [...this.files.values()].filter((f) => f.parent === folder && !f.trashed).map((f) => ({ ...f.meta }));
  }
  async get(id: string) {
    const f = this.files.get(id);
    return f && !f.trashed ? { ...f.meta } : null;
  }
  async download(id: string) {
    this.maybeFail("download");
    if (this.onDownload) await this.onDownload(id);
    return this.files.get(id)!.data;
  }
  async create(parent: string, name: string, _m: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    this.maybeFail("create");
    const id = "f" + ++this.n;
    const t = this.now();
    this.files.set(id, { meta: { id, name, appProperties, createdTime: t, modifiedTime: t }, parent, data: await bytes(data), trashed: false });
    return { ...this.files.get(id)!.meta };
  }
  async update(id: string, name: string, _m: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    this.maybeFail("update");
    const f = this.files.get(id)!;
    f.meta = { ...f.meta, name, appProperties, modifiedTime: this.now() };
    f.data = await bytes(data);
    return { ...f.meta };
  }
  async trash(id: string) {
    this.maybeFail("trash");
    const f = this.files.get(id);
    if (f) f.trashed = true;
  }
  async listRevisions() {
    return [];
  }
  async downloadRevision(): Promise<Uint8Array> {
    throw new Error("not used");
  }
  docFiles() {
    return [...this.files.values()].filter((f) => f.meta.appProperties?.nfType === "doc" && !f.trashed);
  }
  docFile(docId: string) {
    return this.docFiles().find((f) => f.meta.appProperties?.nfId === docId)!;
  }
}

async function bytes(d: Uint8Array | Blob) {
  return d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : d;
}

const run = Math.random().toString(36).slice(2);
async function device(name: string) {
  await closeDB();
  setDbName(`sync-${name}-${run}`);
}

async function write(docId: string, text: string) {
  const d = (await repo.getDoc(docId))!;
  const { pages } = await repo.loadPages(d);
  const p = pages.get(d.pageIds[0])!;
  const item = { id: "t" + Math.random().toString(36).slice(2), kind: "text", x: 10, y: 10, w: 100, h: 20, text } as any;
  return repo.savePages(d, [{ ...p, items: [...p.items, item], updated: Date.now() }]);
}

async function texts(docId: string) {
  const d = (await repo.getDoc(docId))!;
  const { pages } = await repo.loadPages(d);
  return d.pageIds.flatMap((id) => (pages.get(id)?.items ?? []).filter((i: any) => i.kind === "text").map((i: any) => i.text));
}

const doc = async (id: string) => (await repo.getDoc(id)) as Doc;

/** A notebook with one image attachment. */
async function withImage(title: string, assetId: string, bytes: number[]) {
  const d = await repo.createDoc({ title });
  await put("assets", { id: assetId, docId: d.id, mime: "image/png", size: bytes.length, created: 1, blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }) });
  const cur = (await repo.getDoc(d.id))!;
  const { pages } = await repo.loadPages(cur);
  const p = pages.get(cur.pageIds[0])!;
  await repo.savePages(cur, [{ ...p, items: [{ id: "img-" + assetId, kind: "image", x: 0, y: 0, w: 10, h: 10, rot: 0, asset: assetId } as any] }]);
  return d;
}

afterAll(() => closeDB());

describe("Google Drive sync", () => {
  it("first sign-in uploads, a second device downloads the same notebook, and reopening shows the same content", async () => {
    const drive = new FakeDrive();
    await device("first-a");
    const d = await repo.createDoc({ title: "Lecture" });
    await write(d.id, "hello");
    const r1 = await syncOnce(drive, A);
    expect(r1).toMatchObject({ uploaded: 1, errors: [] });
    expect(drive.rootCreates).toBe(1);
    expect((await doc(d.id)).syncAccount).toBe(A);
    expect(await syncSummary(A)).toEqual({ pending: 0, attention: 0, conflicts: 0, libraryPending: false });
    expect(await kvGet("lastSync", null)).not.toBeNull();

    await device("first-b");
    const r2 = await syncOnce(drive, A);
    expect(r2).toMatchObject({ downloaded: 1, errors: [] });
    expect(await texts(d.id)).toEqual(["hello"]);
    // nothing to do on the next run, and the folder is reused
    expect(await syncOnce(drive, A)).toMatchObject({ uploaded: 0, downloaded: 0 });
    expect(drive.rootCreates).toBe(1);
    expect(drive.docFiles()).toHaveLength(1);
  });

  it("edits travel both ways and an edit on two devices keeps both versions", async () => {
    const drive = new FakeDrive();
    await device("conf-a");
    const d = await repo.createDoc({ title: "Lecture" });
    await syncOnce(drive, A);
    await device("conf-b");
    await syncOnce(drive, A);
    await write(d.id, "from B");
    await syncOnce(drive, A);
    await device("conf-a");
    await syncOnce(drive, A);
    expect(await texts(d.id)).toEqual(["from B"]);

    await write(d.id, "A edit");
    await device("conf-b");
    await write(d.id, "B edit");
    await device("conf-a");
    await syncOnce(drive, A);
    await device("conf-b");
    const r = await syncOnce(drive, A);
    expect(r.conflicts).toBe(1);
    const all = (await repo.listDocs()).filter((x) => !x.deletedAt);
    expect(all).toHaveLength(2);
    const copy = all.find((x) => x.conflictOf === d.id)!;
    expect(await texts(d.id)).toEqual(["from B", "B edit"]);
    expect(await texts(copy.id)).toEqual(["from B", "A edit"]);
    expect((await syncSummary(A)).conflicts).toBe(1);
  });

  it("offline edits stay pending and upload on reconnect", async () => {
    const drive = new FakeDrive();
    await device("offline");
    const d1 = await repo.createDoc({ title: "One" });
    const d2 = await repo.createDoc({ title: "Two" });
    await syncOnce(drive, A);
    await write(d1.id, "offline 1");
    await write(d2.id, "offline 2");
    expect((await syncSummary(A)).pending).toBe(2);
    // the connection drops mid-run: nothing is lost and the run stops
    drive.failNext = { op: "update", error: Object.assign(new Error("offline"), { status: 0 }) };
    const before = await kvGet<number | null>("lastSync", null);
    await expect(syncOnce(drive, A)).rejects.toThrow("offline");
    expect(await kvGet("lastSync", null)).toBe(before);
    expect((await syncSummary(A)).pending).toBeGreaterThan(0);
    const r = await syncOnce(drive, A);
    expect(r.errors).toEqual([]);
    expect((await syncSummary(A)).pending).toBe(0);
    await device("offline-b");
    await syncOnce(drive, A);
    expect(await texts(d1.id)).toEqual(["offline 1"]);
    expect(await texts(d2.id)).toEqual(["offline 2"]);
  });

  it("a failed upload or download is reported, does not count as synced, and succeeds on retry", async () => {
    const drive = new FakeDrive();
    await device("fail-a");
    const d = await repo.createDoc({ title: "Retry" });
    await syncOnce(drive, A);
    const firstSync = await kvGet<number>("lastSync", 0);
    await write(d.id, "x");
    drive.failNext = { op: "update", error: Object.assign(new Error("Server error"), { status: 500 }) };
    const r = await syncOnce(drive, A);
    expect(r.errors).toHaveLength(1);
    expect(await kvGet("lastSync", 0)).toBe(firstSync);
    expect((await syncSummary(A)).pending).toBe(1);
    expect((await syncOnce(drive, A)).uploaded).toBe(1);

    await device("fail-b");
    drive.failNext = { op: "download", error: Object.assign(new Error("Server error"), { status: 503 }) };
    await syncOnce(drive, A); // library.json download fails first: treated as empty, not fatal
    drive.failNext = null;
    expect((await repo.listDocs()).length).toBe(1);
    expect(await texts(d.id)).toEqual(["x"]);
  });

  it("switching Google account never trashes notebooks or copies them into the other account", async () => {
    const alice = new FakeDrive();
    const bob = new FakeDrive();
    await device("acct");
    const d = await repo.createDoc({ title: "Private notes" });
    await write(d.id, "secret");
    await syncOnce(alice, A);
    const r = await syncOnce(bob, B);
    expect(r).toMatchObject({ uploaded: 0, attention: 1 });
    expect(bob.docFiles()).toHaveLength(0);
    const cur = await doc(d.id);
    expect(cur.deletedAt).toBeFalsy();
    expect(cur.syncIssue).toMatchObject({ kind: "other-account", detail: A });
    expect(await texts(d.id)).toEqual(["secret"]);
    // a notebook created while signed in as Bob syncs to Bob
    const mine = await repo.createDoc({ title: "Bob's" });
    await syncOnce(bob, B);
    expect(bob.docFiles().map((f) => f.meta.appProperties!.nfId)).toEqual([mine.id]);
    // back to Alice: the issue clears itself; Bob's notebook is not copied to Alice
    const back = await syncOnce(alice, A);
    expect(back.errors).toEqual([]);
    expect((await doc(d.id)).syncIssue).toBeUndefined();
    expect(alice.docFiles().map((f) => f.meta.appProperties!.nfId)).toEqual([d.id]);
    // explicit choice: copy Alice's notebook into Bob's Drive
    await resolveSyncIssue(mine.id, "keep-local"); // no issue on it: no-op
    await syncOnce(bob, B);
    await resolveSyncIssue(d.id, "upload");
    await syncOnce(bob, B);
    expect(bob.docFiles().map((f) => f.meta.appProperties!.nfId).sort()).toEqual([d.id, mine.id].sort());
    expect((await doc(d.id)).syncAccount).toBe(B);
  });

  it("a notebook whose Drive file was deleted is kept and flagged, never trashed", async () => {
    const drive = new FakeDrive();
    await device("missing");
    const d = await repo.createDoc({ title: "Thesis" });
    await write(d.id, "chapter 1");
    await syncOnce(drive, A);
    drive.docFile(d.id).trashed = true; // the notebook file was deleted in Drive
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ attention: 1, uploaded: 0 });
    const cur = await doc(d.id);
    expect(cur.deletedAt).toBeFalsy();
    expect(cur.syncIssue?.kind).toBe("missing");
    expect(await texts(d.id)).toEqual(["chapter 1"]);
    // still flagged (not silently re-uploaded) on later runs
    expect((await syncOnce(drive, A)).uploaded).toBe(0);
    expect((await syncSummary(A)).attention).toBe(1);
    // "keep on this device only" stops asking
    await resolveSyncIssue(d.id, "keep-local");
    expect((await syncSummary(A)).attention).toBe(0);
    expect((await syncOnce(drive, A)).uploaded).toBe(0);
    // "upload again" restores it in Drive
    await resolveSyncIssue(d.id, "upload");
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    expect(drive.docFiles()).toHaveLength(1);
    expect((await doc(d.id)).syncIssue).toBeUndefined();
  });

  it("a notebook deleted forever on one device is flagged on the other, not deleted", async () => {
    const drive = new FakeDrive();
    await device("tomb-a");
    const d = await repo.createDoc({ title: "Old" });
    await syncOnce(drive, A);
    await device("tomb-b");
    await syncOnce(drive, A);
    await device("tomb-a");
    await repo.purgeDoc(d.id);
    expect((await syncOnce(drive, A)).trashed).toBe(1);
    expect(drive.docFiles()).toHaveLength(0);
    await device("tomb-b");
    await syncOnce(drive, A);
    const cur = await doc(d.id);
    expect(cur).toBeTruthy();
    expect(cur.syncIssue?.kind).toBe("missing");
  });

  it("a failing Drive trash keeps the tombstone for the next run instead of aborting sync", async () => {
    const drive = new FakeDrive();
    await device("tomb-fail");
    const d = await repo.createDoc({ title: "Gone" });
    const keep = await repo.createDoc({ title: "Keep" });
    await syncOnce(drive, A);
    await repo.purgeDoc(d.id);
    await write(keep.id, "still syncing");
    drive.failNext = { op: "trash", error: Object.assign(new Error("Server error"), { status: 500 }) };
    const r = await syncOnce(drive, A);
    expect(r.uploaded).toBe(1);
    expect((await kvGet<string[]>("tombstones", [])).length).toBe(1);
    expect((await syncOnce(drive, A)).trashed).toBe(1);
    expect(await kvGet<string[]>("tombstones", [])).toEqual([]);
  });

  it("a damaged Drive copy never replaces the local notebook", async () => {
    const drive = new FakeDrive();
    await device("dmg-a");
    const d = await repo.createDoc({ title: "Notes" });
    await write(d.id, "keep me 1");
    await write(d.id, "keep me 2");
    await syncOnce(drive, A);
    // another device's upload arrives damaged: one item is broken
    const f = drive.docFile(d.id);
    const obj = await decodeJson(f.data);
    obj.pages[0].items[0] = { ...obj.pages[0].items[0], kind: "stroke", pts: "garbage" };
    f.data = await encodeJson(obj);
    f.meta.appProperties = { ...f.meta.appProperties!, nfRev: "damaged-rev" };
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ downloaded: 0, attention: 1 });
    expect(await texts(d.id)).toEqual(["keep me 1", "keep me 2"]);
    expect((await doc(d.id)).syncIssue).toMatchObject({ kind: "damaged", detail: "damaged-rev" });

    // unreadable bytes are handled the same way
    f.data = new Uint8Array([1, 2, 3, 4]);
    f.meta.appProperties = { ...f.meta.appProperties!, nfRev: "garbage-rev" };
    await syncOnce(drive, A); // the newer (still damaged) Drive copy is detected again
    expect(await texts(d.id)).toEqual(["keep me 1", "keep me 2"]);
    expect((await doc(d.id)).syncIssue?.detail).toBe("garbage-rev");

    // the user replaces the Drive copy with this device's version
    await resolveSyncIssue(d.id, "upload");
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    await device("dmg-b");
    await syncOnce(drive, A);
    expect(await texts(d.id)).toEqual(["keep me 1", "keep me 2"]);
  });

  it("a damaged Drive file with no local copy is not imported, and dismissing it sticks", async () => {
    const drive = new FakeDrive();
    await device("dmg-new-a");
    const d = await repo.createDoc({ title: "Broken" });
    await syncOnce(drive, A);
    const f = drive.docFile(d.id);
    f.data = new Uint8Array([0x1f, 0x8b, 0, 0]);
    await device("dmg-new-b");
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ downloaded: 0, attention: 1 });
    expect(await repo.listDocs()).toHaveLength(0);
    expect((await syncSummary(A)).attention).toBe(1);
    await dismissDamagedRemote(f.meta.id);
    await syncOnce(drive, A);
    expect((await syncSummary(A)).attention).toBe(0);
    expect((await kvGet<DamagedRemote[]>("damagedRemote", [])).length).toBe(1);
  });

  it("an edit made while a download is in flight is kept (the next run keeps both versions)", async () => {
    const drive = new FakeDrive();
    await device("race-a");
    const d = await repo.createDoc({ title: "Race" });
    await syncOnce(drive, A);
    await device("race-b");
    await syncOnce(drive, A);
    await write(d.id, "remote edit");
    await syncOnce(drive, A);
    await device("race-a");
    const docFileId = drive.docFile(d.id).meta.id;
    drive.onDownload = async (id) => {
      if (id !== docFileId) return;
      drive.onDownload = null;
      await write(d.id, "typed during download");
    };
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ downloaded: 0, deferred: 1 });
    expect(await texts(d.id)).toEqual(["typed during download"]);
    expect(await kvGet("lastSync", 0)).toBeTruthy();
    const r2 = await syncOnce(drive, A);
    expect(r2.conflicts).toBe(1);
    const all = await repo.listDocs();
    const copy = all.find((x) => x.conflictOf === d.id)!;
    expect(await texts(d.id)).toEqual(["typed during download"]);
    expect(await texts(copy.id)).toEqual(["remote edit"]);
  });

  it("unsaved strokes in an open notebook are flushed before a download is applied", async () => {
    const drive = new FakeDrive();
    await device("flush-a");
    const d = await repo.createDoc({ title: "Open" });
    await syncOnce(drive, A);
    await device("flush-b");
    await syncOnce(drive, A);
    await write(d.id, "remote");
    await syncOnce(drive, A);
    await device("flush-a");
    setBeforeApply(async (id) => {
      if (id === d.id) await write(d.id, "unsaved in editor");
    });
    try {
      expect((await syncOnce(drive, A)).deferred).toBe(1);
    } finally {
      setBeforeApply(async () => {});
    }
    expect(await texts(d.id)).toEqual(["unsaved in editor"]);
  });

  it("an editor holding an old copy of the notebook cannot rewind its revision or sync state", async () => {
    const drive = new FakeDrive();
    await device("stale-a");
    const d = await repo.createDoc({ title: "Stale" });
    await syncOnce(drive, A);
    await device("stale-b");
    await syncOnce(drive, A);
    await write(d.id, "remote");
    await syncOnce(drive, A);
    await device("stale-a");
    const editorCopy = await doc(d.id); // what an open editor holds
    await syncOnce(drive, A); // download raises rev and sets the sync fields
    const synced = await doc(d.id);
    expect(synced.rev).toBeGreaterThan(editorCopy.rev);
    const { pages } = await repo.loadPages(synced);
    const saved = await repo.savePages(editorCopy, [...pages.values()]);
    expect(saved.rev).toBe(synced.rev + 1);
    expect(saved.remoteRev).toBe(synced.remoteRev);
    expect(saved.syncAccount).toBe(A);
    expect((await syncSummary(A)).pending).toBe(1); // the edit is not mistaken for "already synced"
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
  });

  it("notebooks synced before accounts were recorded are adopted only by the account that has them", async () => {
    const drive = new FakeDrive();
    await device("legacy");
    const d = await repo.createDoc({ title: "Legacy" });
    await syncOnce(drive, A);
    // what an older version of Notefira left behind: linked to Drive, no account recorded
    await put("docs", { ...(await doc(d.id)), syncAccount: undefined });
    expect((await syncOnce(new FakeDrive(), B)).uploaded).toBe(0);
    expect((await doc(d.id)).syncIssue?.kind).toBe("missing");
    await put("docs", { ...(await doc(d.id)), syncIssue: undefined, syncAccount: undefined });
    await syncOnce(drive, A);
    expect((await doc(d.id)).syncAccount).toBe(A);
    expect((await doc(d.id)).syncIssue).toBeUndefined();
  });

  it("exported .notefira files never include the Google account", async () => {
    await device("export");
    const d = await repo.createDoc({ title: "Share" });
    await syncOnce(new FakeDrive(), A);
    const { exportNotefira } = await import("../src/services/transfer");
    const obj = await decodeJson(await exportNotefira(d.id));
    expect(JSON.stringify(obj)).not.toContain(A);
  });
});

describe("Google Drive folder and files", () => {
  it("creates one “Notefira Sync” folder in My Drive and reuses it", async () => {
    const drive = new FakeDrive();
    await device("root-a");
    await repo.createDoc({ title: "One" });
    await syncOnce(drive, A);
    await syncOnce(drive, A);
    await device("root-b");
    await syncOnce(drive, A);
    expect(drive.rootCreates).toBe(1);
    expect(drive.roots().map((r) => r.meta.name)).toEqual(["Notefira Sync"]);
  });

  it("uses the folder it just created even when Drive search has not caught up", async () => {
    const drive = new FakeDrive();
    await device("lag");
    await repo.createDoc({ title: "Lag" });
    // search shows nothing for the first three lookups, across two sync runs
    const orig = drive.findRoots.bind(drive);
    let calls = 0;
    drive.findRoots = async () => (++calls <= 3 ? [] : orig());
    await syncOnce(drive, A);
    await syncOnce(drive, A);
    expect(drive.rootCreates).toBe(1);
    expect(drive.docFiles()).toHaveLength(1);
  });

  it("migrates the old “Notefira” folder in place: renamed, same files, stable names", async () => {
    const drive = new FakeDrive();
    await device("legacy-root");
    const d = await repo.createDoc({ title: "Biology" });
    await write(d.id, "cells");
    // what an earlier version left in Drive
    const old = await drive.createFolder("Notefira", { notefiraRoot: "1" });
    const { encodeFile, buildFile } = await import("../src/model/format");
    const cur = await doc(d.id);
    const { pages } = await repo.loadPages(cur);
    const legacyFile = await drive.create(old.id, "Biology.notefira", "application/x-notefira", { nfType: "doc", nfId: d.id, nfRev: "r1" }, await encodeFile(await buildFile(cur, [...pages.values()], [])));
    await put("docs", { ...cur, remoteId: legacyFile.id, remoteRev: "r1", syncedRev: cur.rev });
    const r = await syncOnce(drive, A);
    expect(r.errors).toEqual([]);
    expect(drive.rootCreates).toBe(1);
    expect(drive.roots().map((x) => x.meta.id)).toEqual([old.id]);
    expect(drive.roots()[0].meta.name).toBe("Notefira Sync");
    const f = drive.docFile(d.id);
    expect(f.meta.id).toBe(legacyFile.id); // same file, not a copy
    expect(f.meta.name).toBe(notebookFileName("Biology", d.id));
    expect(drive.docFiles()).toHaveLength(1);
    expect((await doc(d.id)).syncAccount).toBe(A);
  });

  it("two devices that created a folder at the same moment converge on one", async () => {
    const drive = new FakeDrive();
    await device("race-root-a");
    const da = await repo.createDoc({ title: "From A" });
    const fa = await repo.createFolder("Folder A", null);
    await syncOnce(drive, A);
    // device B created its own folder before it could see A's
    const bRoot = await drive.createFolder("Notefira Sync", { notefiraRoot: "1" });
    await device("race-root-b");
    const db2 = await repo.createDoc({ title: "From B" });
    const fb = await repo.createFolder("Folder B", null);
    const bFile = await drive.create(bRoot.id, "x.notefira", "application/x-notefira", { nfType: "doc", nfId: "placeholder", nfRev: "p" }, new Uint8Array());
    drive.files.get(bFile.id)!.trashed = true; // only the folder matters here
    await drive.create(bRoot.id, "library.json", "application/json", { nfType: "library" }, new TextEncoder().encode(JSON.stringify({ folders: [fb], decks: [], updated: 1 })));
    const r = await syncOnce(drive, A);
    expect(r.errors).toEqual([]);
    expect(drive.roots()).toHaveLength(1);
    const root = drive.roots()[0].meta.id;
    const live = [...drive.files.values()].filter((f) => !f.trashed && f.parent !== "");
    expect(live.every((f) => f.parent === root)).toBe(true);
    expect(live.filter((f) => f.meta.appProperties?.nfType === "library")).toHaveLength(1);
    expect(drive.docFiles().map((f) => f.meta.appProperties!.nfId).sort()).toEqual([da.id, db2.id].sort());
    // device A sees B's notebook and both folders
    await device("race-root-a");
    await syncOnce(drive, A);
    expect((await repo.listDocs()).map((d) => d.title).sort()).toEqual(["From A", "From B"]);
    expect((await repo.listFolders()).map((f) => f.name).sort()).toEqual([fa.name, fb.name].sort());
  });

  it("an identical duplicate notebook file (retried upload) is trashed; a different one is kept as a copy first", async () => {
    const drive = new FakeDrive();
    await device("dup");
    const d = await repo.createDoc({ title: "Dup" });
    await write(d.id, "v1");
    await syncOnce(drive, A);
    const f = drive.docFile(d.id);
    // identical: same nfRev and bytes
    await drive.create(f.parent, f.meta.name, "application/x-notefira", { ...f.meta.appProperties! }, f.data);
    let r = await syncOnce(drive, A);
    expect(r.duplicates).toBe(1);
    expect(drive.docFiles()).toHaveLength(1);
    expect(drive.docFile(d.id).meta.id).toBe(f.meta.id);
    expect((await repo.listDocs()).length).toBe(1);

    // different content under the same notebook id (two devices re-uploaded it)
    const obj = await decodeJson(f.data);
    obj.pages[0].items = [{ ...obj.pages[0].items[0], id: "other", text: "other version" }];
    const { contentHash } = await import("../src/model/format");
    obj.integrity.hash = await contentHash(obj); // a valid, signed second version
    await drive.create(f.parent, "other.notefira", "application/x-notefira", { nfType: "doc", nfId: d.id, nfRev: "other-rev" }, await encodeJson(obj));
    r = await syncOnce(drive, A);
    expect(r.duplicates).toBe(1);
    expect(drive.docFiles().filter((x) => x.meta.appProperties!.nfId === d.id)).toHaveLength(1);
    const copy = (await repo.listDocs()).find((x) => x.conflictOf === d.id)!;
    expect(copy.title).toContain("duplicate copy");
    expect(await texts(copy.id)).toEqual(["other version"]);
    expect(await texts(d.id)).toEqual(["v1"]);
  });

  it("attachments are stored once per content, verified on download, and a bad copy falls back to a good one", async () => {
    const drive = new FakeDrive();
    await device("blob-a");
    const d1 = await withImage("First", "img1", [1, 2, 3]);
    await syncOnce(drive, A);
    const blobs = () => [...drive.files.values()].filter((f) => f.meta.appProperties?.nfType === "blob" && !f.trashed);
    expect(blobs()).toHaveLength(1);
    const { sha256Hex } = await import("../src/model/format");
    const hash = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(blobs()[0].meta.appProperties!.nfHash).toBe(hash);
    // a second notebook using the same picture uploads nothing new
    await withImage("Second", "img2", [1, 2, 3]);
    await syncOnce(drive, A);
    expect(blobs()).toHaveLength(1);
    // editing a page never re-uploads the attachment
    const uploadsBefore = drive.files.size;
    await write(d1.id, "edit");
    await syncOnce(drive, A);
    expect(drive.files.size).toBe(uploadsBefore);
    // a second Drive file claims the same hash but is corrupted: the good one is used
    const good = blobs()[0];
    const bad = await drive.create(good.parent, "bad", "image/png", { nfType: "blob", nfHash: hash }, new Uint8Array([9, 9, 9]));
    drive.files.get(bad.id)!.meta.createdTime = "2000-01-01T00:00:00.000Z"; // sorts first
    await device("blob-b");
    const r = await syncOnce(drive, A);
    expect(r.errors).toEqual([]);
    expect(r.downloaded).toBe(2);
    const { get } = await import("../src/storage/db");
    const got = await get<any>("assets", "img1");
    expect(new Uint8Array(await got.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(got.sha256).toBe(hash);
  });

  it("an attachment that fails its SHA-256 check is never stored and the notebook is not applied", async () => {
    const drive = new FakeDrive();
    await device("blob-bad-a");
    const d = await withImage("Pic", "imgX", [5, 6, 7]);
    await syncOnce(drive, A);
    const blob = [...drive.files.values()].find((f) => f.meta.appProperties?.nfType === "blob")!;
    blob.data = new Uint8Array([6, 6, 6]); // tampered in Drive
    await device("blob-bad-b");
    const r = await syncOnce(drive, A);
    expect(r.downloaded).toBe(0);
    expect(r.attention).toBe(1);
    const { get } = await import("../src/storage/db");
    expect(await get("assets", "imgX")).toBeUndefined();
    expect(await repo.getDoc(d.id)).toBeUndefined();
    expect((await kvGet<DamagedRemote[]>("damagedRemote", []))[0]?.reason).toBe("damaged");
  });

  it("reads notebooks and attachments written by Notefira 0.1.x (format 1, attachments by id)", async () => {
    const drive = new FakeDrive();
    const root = await drive.createFolder("Notefira", { notefiraRoot: "1" });
    const { contentChecksum } = await import("../src/model/format");
    const page = { id: "lp1", docId: "legacy1", w: 595, h: 842, bg: { type: "template", template: "ruled", paper: "#ffffff" }, items: [{ id: "s1", kind: "stroke", pen: "ballpoint", color: "#000000", width: 2, pts: [1, 1, 0.5, 9, 9, 0.6], t0: 1, t1: 2 }, { id: "i1", kind: "image", x: 0, y: 0, w: 5, h: 5, rot: 0, asset: "la1" }], updated: 1 };
    const docV1 = { id: "legacy1", title: "Old notebook", folderId: null, cover: { type: "color", color: "#45bfdb", pattern: "plain" }, created: 1, updated: 1, opened: 1, favorite: false, pageIds: ["lp1"], bookmarks: [], outline: [], defaultBg: page.bg, layout: "vertical", rev: 3 };
    const v1 = { format: "notefira", version: 1, exported: 1, doc: docV1, pages: [page], assets: [{ id: "la1", mime: "image/png", size: 2 }], recordings: [], checksum: contentChecksum(docV1 as any, [page] as any) };
    await drive.create(root.id, "asset-la1", "image/png", { nfType: "asset", nfId: "la1" }, new Uint8Array([4, 2]));
    await drive.create(root.id, "Old notebook.notefira", "application/x-notefira", { nfType: "doc", nfId: "legacy1", nfRev: "old" }, await encodeJson(v1));
    await device("legacy-format");
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ downloaded: 1, errors: [], attention: 0 });
    const { get } = await import("../src/storage/db");
    const asset = await get<any>("assets", "la1");
    expect(new Uint8Array(await asset.blob.arrayBuffer())).toEqual(new Uint8Array([4, 2]));
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the next upload writes format 2 and a content-addressed copy of the attachment
    await write("legacy1", "new note");
    await syncOnce(drive, A);
    const f = drive.docFile("legacy1");
    expect((await decodeJson(f.data)).version).toBe(2);
    expect([...drive.files.values()].some((x) => x.meta.appProperties?.nfHash === asset.sha256)).toBe(true);
    await device("legacy-format-b");
    await syncOnce(drive, A);
    expect(await texts("legacy1")).toEqual(["new note"]);
  });

  it("file names are readable, unique for equal titles, safe, and follow a rename", async () => {
    expect(notebookFileName("Lecture: 1/2", "abcdef1234567890")).toBe("Lecture 1 2 (abcdef12).notefira");
    expect(notebookFileName("   ", "abcdef1234567890")).toBe("Untitled (abcdef12).notefira");
    const drive = new FakeDrive();
    await device("names");
    const x = await repo.createDoc({ title: "Notes" });
    const y = await repo.createDoc({ title: "Notes" });
    await syncOnce(drive, A);
    const names = drive.docFiles().map((f) => f.meta.name);
    expect(new Set(names).size).toBe(2);
    await repo.saveDoc({ ...(await doc(x.id)), title: "Renamed" });
    await syncOnce(drive, A);
    expect(drive.docFile(x.id).meta.name).toBe(notebookFileName("Renamed", x.id));
    expect(drive.docFile(y.id).meta.name).toBe(notebookFileName("Notes", y.id));
  });

  it("deleting a notebook forever removes every identical Drive copy, duplicates included", async () => {
    const drive = new FakeDrive();
    await device("tomb-dup");
    const d = await repo.createDoc({ title: "Bye" });
    await syncOnce(drive, A);
    const f = drive.docFile(d.id);
    await drive.create(f.parent, f.meta.name, "application/x-notefira", { ...f.meta.appProperties! }, f.data); // retried upload
    await repo.purgeDoc(d.id);
    const r = await syncOnce(drive, A);
    expect(r.trashed).toBe(1);
    expect(drive.docFiles()).toHaveLength(0);
    expect(await repo.listDocs()).toHaveLength(0);
  });

  it("deleting forever never trashes a Drive version this device had not seen: it comes back and the user is told", async () => {
    const drive = new FakeDrive();
    await device("tomb-newer-a");
    const d = await repo.createDoc({ title: "Lab report" });
    await syncOnce(drive, A);
    await device("tomb-newer-b");
    await syncOnce(drive, A);
    await write(d.id, "written on B after A last synced");
    await syncOnce(drive, A);
    await device("tomb-newer-a");
    await repo.purgeDoc(d.id); // A never saw B's edit
    const r = await syncOnce(drive, A);
    expect(r.trashed).toBe(0);
    expect(drive.docFiles()).toHaveLength(1);
    expect(await texts(d.id)).toEqual(["written on B after A last synced"]);
    const notices = await kvGet<any[]>("syncNotices", []);
    expect(notices).toMatchObject([{ kind: "kept-after-delete", title: "Lab report" }]);
    expect((await syncSummary(A)).attention).toBe(1);
    const { dismissNotice } = await import("../src/sync/engine");
    await dismissNotice(notices[0].id);
    expect((await syncSummary(A)).attention).toBe(0);
    // deleting it again now that this device has the latest version works
    await repo.purgeDoc(d.id);
    expect((await syncOnce(drive, A)).trashed).toBe(1);
    expect(drive.docFiles()).toHaveLength(0);
  });

  it("a different duplicate is not trashed when its local copy cannot be verified, and is retried later", async () => {
    const drive = new FakeDrive();
    await device("dup-verify");
    const d = await repo.createDoc({ title: "Precious" });
    await write(d.id, "v1");
    await syncOnce(drive, A);
    const f = drive.docFile(d.id);
    const obj = await decodeJson(f.data);
    obj.pages[0].items = [{ ...obj.pages[0].items[0], id: "other", text: "only in the duplicate" }];
    const { contentHash } = await import("../src/model/format");
    obj.integrity.hash = await contentHash(obj); // a valid, signed second version
    const dup = await drive.create(f.parent, "other.notefira", "application/x-notefira", { nfType: "doc", nfId: d.id, nfRev: "other-rev" }, await encodeJson(obj));
    // the copy is written, then something goes wrong before it is confirmed (e.g. storage evicted a page)
    testHooks.afterCopyStored = async (copyId) => {
      const c = (await repo.getDoc(copyId))!;
      const { del } = await import("../src/storage/db");
      await del("pages", c.pageIds[0]);
    };
    let r;
    try {
      r = await syncOnce(drive, A);
    } finally {
      testHooks.afterCopyStored = null;
    }
    expect(r.duplicates).toBe(0);
    expect(r.attention).toBe(1);
    expect(drive.files.get(dup.id)!.trashed).toBe(false); // still safe in Drive
    expect((await repo.listDocs()).filter((x) => x.conflictOf === d.id)).toHaveLength(0); // the incomplete copy was removed
    const held = await kvGet<DamagedRemote[]>("damagedRemote", []);
    expect(held).toMatchObject([{ fileId: dup.id, reason: "duplicate" }]);
    expect((await syncSummary(A)).attention).toBe(1);
    // next run: preserved and verified, then trashed, and the notice clears
    r = await syncOnce(drive, A);
    expect(r.duplicates).toBe(1);
    expect(drive.files.get(dup.id)!.trashed).toBe(true);
    const copy = (await repo.listDocs()).find((x) => x.conflictOf === d.id)!;
    expect(await texts(copy.id)).toEqual(["only in the duplicate"]);
    expect(await kvGet<DamagedRemote[]>("damagedRemote", [])).toEqual([]);
  });

  it("a conflict does not overwrite the Drive version until its local copy is verified", async () => {
    const drive = new FakeDrive();
    await device("conf-verify-a");
    const d = await repo.createDoc({ title: "Both" });
    await syncOnce(drive, A);
    await device("conf-verify-b");
    await syncOnce(drive, A);
    await write(d.id, "B version");
    await syncOnce(drive, A);
    await device("conf-verify-a");
    await write(d.id, "A version");
    const before = drive.docFile(d.id).data;
    testHooks.afterCopyStored = async (copyId) => {
      const { del } = await import("../src/storage/db");
      await del("docs", copyId);
    };
    let r;
    try {
      r = await syncOnce(drive, A);
    } finally {
      testHooks.afterCopyStored = null;
    }
    expect(r.conflicts).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(drive.docFile(d.id).data).toBe(before); // B's version untouched in Drive
    expect(await texts(d.id)).toEqual(["A version"]);
    r = await syncOnce(drive, A);
    expect(r.conflicts).toBe(1);
    const copy = (await repo.listDocs()).find((x) => x.conflictOf === d.id)!;
    expect(await texts(copy.id)).toEqual(["B version"]);
  });

  it("both versions of a conflict are in Drive before anything is overwritten, so clearing this browser loses nothing", async () => {
    const drive = new FakeDrive();
    await device("cloud-conf-a");
    const d = await repo.createDoc({ title: "Essay" });
    await syncOnce(drive, A);
    await device("cloud-conf-b");
    await syncOnce(drive, A);
    await write(d.id, "B's paragraph");
    await syncOnce(drive, A);
    await device("cloud-conf-a");
    await write(d.id, "A's paragraph");
    expect((await syncOnce(drive, A)).conflicts).toBe(1);
    expect(drive.docFiles()).toHaveLength(2); // the shared file (A's version) and the conflicted copy (B's version)
    // this browser's storage is cleared: a fresh device restores both versions from Drive alone
    await device("cloud-conf-fresh");
    await syncOnce(drive, A);
    const all = await repo.listDocs();
    expect(all).toHaveLength(2);
    expect(await texts(d.id)).toEqual(["A's paragraph"]);
    expect(await texts(all.find((x) => x.id !== d.id)!.id)).toEqual(["B's paragraph"]);
  });

  it("if the conflicted copy cannot be put in Drive, the Drive version is not overwritten, and the retry makes no second copy", async () => {
    const drive = new FakeDrive();
    await device("cloud-fail-a");
    const d = await repo.createDoc({ title: "Plan" });
    await syncOnce(drive, A);
    await device("cloud-fail-b");
    await syncOnce(drive, A);
    await write(d.id, "B");
    await syncOnce(drive, A);
    await device("cloud-fail-a");
    await write(d.id, "A");
    const bVersion = drive.docFile(d.id).data;
    drive.failNext = { op: "create", error: Object.assign(new Error("Server error"), { status: 500 }) };
    const r = await syncOnce(drive, A);
    expect(r.conflicts).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(drive.docFile(d.id).data).toBe(bVersion);
    expect(drive.docFiles()).toHaveLength(1);
    const r2 = await syncOnce(drive, A);
    expect(r2.conflicts).toBe(1);
    expect((await repo.listDocs()).filter((x) => x.conflictOf === d.id)).toHaveLength(1);
    expect(drive.docFiles()).toHaveLength(2);
  });

  it("a different duplicate is trashed only after its copy is its own verified file in Drive", async () => {
    const drive = new FakeDrive();
    await device("cloud-dup");
    const d = await repo.createDoc({ title: "Notes" });
    await write(d.id, "mine");
    await syncOnce(drive, A);
    const f = drive.docFile(d.id);
    const obj = await decodeJson(f.data);
    obj.pages[0].items = [{ ...obj.pages[0].items[0], id: "o", text: "theirs" }];
    const { contentHash } = await import("../src/model/format");
    obj.integrity.hash = await contentHash(obj);
    const dup = await drive.create(f.parent, "dup.notefira", "application/x-notefira", { nfType: "doc", nfId: d.id, nfRev: "theirs" }, await encodeJson(obj));
    await syncOnce(drive, A);
    expect(drive.files.get(dup.id)!.trashed).toBe(true);
    await device("cloud-dup-fresh");
    await syncOnce(drive, A);
    const got = await Promise.all((await repo.listDocs()).map((x) => texts(x.id)));
    expect(got.flat().sort()).toEqual(["mine", "theirs"]);
  });

  it("signing in on a new device restores notebooks, folders, study sets, PDFs, handwriting and annotations with no import", async () => {
    const drive = new FakeDrive();
    await device("restore-a");
    const { get, getAll, getAllByIndex } = await import("../src/storage/db");
    const folder = await repo.createFolder("Biology", null);
    const d = await repo.createDoc({ title: "Cells", folderId: folder.id } as any);
    await repo.saveDoc({ ...(await doc(d.id)), folderId: folder.id, favorite: true });
    // a PDF page with handwriting, a highlighter mark, a shape, a text note, a picture and a link on top
    const pdf = new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256));
    const pdfAsset = await repo.putAsset(new Blob([pdf], { type: "application/pdf" }), d.id, "cells.pdf");
    const pic = await repo.putAsset(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }), d.id, "pic.png");
    const cur = await doc(d.id);
    const { pages } = await repo.loadPages(cur);
    const p = pages.get(cur.pageIds[0])!;
    const items = [
      { id: "ink", kind: "stroke", pen: "fountain", color: "#1a2b3c", width: 2.2, pts: [10, 10, 0.2, 30, 40, 0.9, 50, 45, 0.6], t0: 5, t1: 9, stabilization: 0.5 },
      { id: "hl", kind: "stroke", pen: "highlighter", color: "#ffee00", width: 12, opacity: 0.35, pts: [0, 100, 0.5, 200, 100, 0.5], t0: 1, t1: 2 },
      { id: "box", kind: "stroke", pen: "ballpoint", color: "#ff0000", width: 1, pts: [0, 0, 0.5, 40, 0, 0.5, 40, 40, 0.5, 0, 40, 0.5], t0: 1, t1: 2, shape: true, closed: true, dash: "dotted" },
      { id: "note", kind: "text", x: 5, y: 300, w: 200, h: 30, rot: 0, text: "Mitochondria", font: "hand", size: 18, color: "#333", bold: true, italic: false, underline: false, align: "left" },
      { id: "img", kind: "image", x: 0, y: 400, w: 50, h: 50, rot: 0, asset: pic.id },
      { id: "lnk", kind: "link", x: 0, y: 500, w: 50, h: 20, rot: 0, url: "https://example.org" },
    ] as any[];
    await repo.savePages(await doc(d.id), [{ ...p, bg: { type: "pdf", asset: pdfAsset.id, page: 0, rot: 0 }, items, recognized: "mitochondria powerhouse" }]);
    // an audio recording and a study set whose card image belongs to the notebook
    const audio = await repo.putAsset(new Blob([new Uint8Array([9, 8, 7])], { type: "audio/webm" }), d.id, "rec.webm");
    await repo.saveRecording({ id: "rec1", docId: d.id, title: "Lecture", start: 1000, duration: 3000, asset: audio.id, transcript: [{ t: 0, text: "hello class" }], segments: [[1000, 4000]] });
    const cardImg = await repo.putAsset(new Blob([new Uint8Array([5, 5])], { type: "image/png" }), d.id, "flashcard.png");
    await repo.saveDeck({ id: "deck1", name: "Cell parts", docId: d.id, cards: [{ id: "c1", front: { image: cardImg.id }, back: { text: "Nucleus" }, ease: 2.5, interval: 1, reps: 0, lapses: 0, due: 0, created: 1, updated: 1 }], created: 1, updated: 1 });
    // a notebook in the Trash stays in the Trash
    const old = await repo.createDoc({ title: "Old draft" });
    await repo.trashDoc(old.id);
    expect((await syncOnce(drive, A)).errors).toEqual([]);

    const snapshot = async () => {
      const dd = await doc(d.id);
      const pg = (await repo.loadPages(dd)).pages.get(dd.pageIds[0])!;
      const assets = await getAllByIndex<any>("assets", "docId", d.id);
      const bytes = Object.fromEntries(await Promise.all(assets.map(async (a) => [a.id, [...new Uint8Array(await a.blob.arrayBuffer())]])));
      return {
        doc: { title: dd.title, folderId: dd.folderId, favorite: dd.favorite, pageIds: dd.pageIds },
        page: { bg: pg.bg, items: pg.items, recognized: pg.recognized },
        bytes,
        recordings: await getAllByIndex<any>("recordings", "docId", d.id),
        folders: (await repo.listFolders()).map((f) => ({ id: f.id, name: f.name })),
        decks: (await repo.listDecks()).map((x) => ({ id: x.id, name: x.name, cards: x.cards })),
        trashed: !!(await doc(old.id))?.deletedAt,
      };
    };
    const before = await snapshot();
    expect(Object.keys(before.bytes)).toHaveLength(4);

    // a brand-new device: just sign in (one sync), nothing imported by hand
    await device("restore-new-device");
    expect(await getAll("docs")).toHaveLength(0);
    const r = await syncOnce(drive, A);
    expect(r.errors).toEqual([]);
    expect(r.downloaded).toBe(2);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect((await syncSummary(A)).pending).toBe(0);
    // the restored notebook is fully editable and syncs back
    await write(d.id, "added on the new device");
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    void get;
  });

  it("a recording or flashcard image added later is uploaded even if no page changed", async () => {
    const drive = new FakeDrive();
    await device("late-asset-a");
    const d = await repo.createDoc({ title: "Talk" });
    await syncOnce(drive, A);
    const audio = await repo.putAsset(new Blob([new Uint8Array([1, 1, 2])], { type: "audio/webm" }), d.id);
    await repo.saveRecording({ id: "r9", docId: d.id, title: "Q&A", start: 1, duration: 2, asset: audio.id, transcript: [], segments: [] });
    expect((await syncSummary(A)).pending).toBe(1);
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    await device("late-asset-b");
    await syncOnce(drive, A);
    const { getAllByIndex } = await import("../src/storage/db");
    expect((await getAllByIndex<any>("recordings", "docId", d.id)).map((x) => x.title)).toEqual(["Q&A"]);
  });

  it("conflict choices: keep mine moves the other copy to Trash (recoverable); keep both just clears the notice", async () => {
    const { resolveConflictChoice } = await import("../src/sync/engine");
    for (const choice of ["keep-mine", "keep-both"] as const) {
      const drive = new FakeDrive();
      await device("choice-a-" + choice);
      const d = await repo.createDoc({ title: "Choice" });
      await syncOnce(drive, A);
      await device("choice-b-" + choice);
      await syncOnce(drive, A);
      await write(d.id, "B");
      await syncOnce(drive, A);
      await device("choice-a-" + choice);
      await write(d.id, "A");
      await syncOnce(drive, A);
      const copy = (await repo.listDocs()).find((x) => x.conflictOf === d.id)!;
      await resolveConflictChoice(copy.id, choice);
      expect((await syncSummary(A)).conflicts).toBe(0);
      const after = await doc(copy.id);
      expect(after).toBeTruthy(); // never deleted outright
      expect(!!after.deletedAt).toBe(choice === "keep-mine");
    }
  });

  it("accepting a cloud deletion moves the notebook to Trash, where it can still be restored", async () => {
    const drive = new FakeDrive();
    await device("accept-delete");
    const d = await repo.createDoc({ title: "Gone elsewhere" });
    await write(d.id, "still here");
    await syncOnce(drive, A);
    drive.docFile(d.id).trashed = true;
    await syncOnce(drive, A);
    await resolveSyncIssue(d.id, "trash");
    const cur = await doc(d.id);
    expect(cur.deletedAt).toBeTruthy();
    expect(await texts(d.id)).toEqual(["still here"]);
    expect((await syncSummary(A)).attention).toBe(0);
    await repo.restoreDoc(d.id);
    expect((await doc(d.id)).deletedAt).toBeFalsy();
  });

  it("per-notebook status: shown only when a notebook is not in sync", async () => {
    const { docSyncStatus } = await import("../src/screens/library/SyncBadge");
    const base = { rev: 3, syncedRev: 3, syncAccount: A } as any;
    expect(docSyncStatus(base, A)).toBeNull();
    expect(docSyncStatus(base, null)).toBeNull(); // signed out: nothing to show
    expect(docSyncStatus({ ...base, rev: 4 }, A)?.label).toMatch(/waiting to upload/);
    expect(docSyncStatus({ ...base, syncIssue: { kind: "missing", at: 1 } }, A)).toMatchObject({ warn: true });
    expect(docSyncStatus({ ...base, syncIssue: { kind: "missing", at: 1, dismissed: true } }, A)).toMatchObject({ warn: false, label: "Kept on this device only" });
    expect(docSyncStatus({ ...base, syncAccount: B }, A)?.label).toMatch(/another Google account/);
    expect(docSyncStatus({ ...base, rev: 9, deletedAt: 1 }, A)).toBeNull();
  });
});

