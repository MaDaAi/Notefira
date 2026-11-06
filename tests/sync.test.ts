// Google Drive sync, end to end against an in-memory Drive. Each "device" is a
// separate IndexedDB database; switching device closes one and opens the other.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDB, kvGet, put, setDbName } from "../src/storage/db";
import * as repo from "../src/storage/repo";
import { dismissDamagedRemote, resolveSyncIssue, setBeforeApply, syncOnce, syncSummary, type DamagedRemote } from "../src/sync/engine";
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
  async ensureRoot() {
    for (const [id, f] of this.files) if (f.meta.appProperties?.notefiraRoot === "1" && !f.trashed) return id;
    this.rootCreates++;
    const id = "root" + ++this.n;
    this.files.set(id, { meta: { id, name: "Notefira", appProperties: { notefiraRoot: "1" } }, parent: "", data: new Uint8Array(), trashed: false });
    return id;
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
    this.files.set(id, { meta: { id, name, appProperties }, parent, data: await bytes(data), trashed: false });
    return { id, name, appProperties };
  }
  async update(id: string, name: string, _m: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    this.maybeFail("update");
    const f = this.files.get(id)!;
    f.meta = { id, name, appProperties };
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
    expect(await syncSummary(A)).toEqual({ pending: 0, attention: 0, conflicts: 0 });
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

  it("a notebook missing from Drive (deleted folder or file) is kept and flagged, never trashed", async () => {
    const drive = new FakeDrive();
    await device("missing");
    const d = await repo.createDoc({ title: "Thesis" });
    await write(d.id, "chapter 1");
    await syncOnce(drive, A);
    for (const f of drive.files.values()) f.trashed = true; // the whole folder was deleted in Drive
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
