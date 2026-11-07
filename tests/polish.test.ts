// v0.1.7: sync timing, request economy, accurate status, conflict choices,
// missing Drive permission and expired sign-in.
import "fake-indexeddb/auto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { closeDB, kvGet, setDbName } from "../src/storage/db";
import * as repo from "../src/storage/repo";
import { resolveConflictChoice, stopsRun, syncOnce, syncSummary } from "../src/sync/engine";
import { autoSyncWait, IDLE_MS, MIN_AUTO_GAP_MS } from "../src/sync/scheduler";
import { DriveClient, HttpError, isPermissionError, retryAfterMs, type DriveApi, type RemoteFile } from "../src/sync/drive";
import { AuthRequired, auth, getToken, hasDriveScope } from "../src/sync/google";

const A = "alice@example.com";

/** In-memory Drive that counts every call (to check how many requests sync makes). */
class CountingDrive implements DriveApi {
  files = new Map<string, { meta: RemoteFile; parent: string; data: Uint8Array; trashed: boolean }>();
  calls: string[] = [];
  failNext: { op: string; error: any } | null = null;
  private n = 0;
  private clock = 0;
  private t() {
    return new Date(1_700_000_000_000 + ++this.clock * 1000).toISOString();
  }
  private hit(op: string) {
    this.calls.push(op);
    if (this.failNext?.op === op) {
      const e = this.failNext.error;
      this.failNext = null;
      throw e;
    }
  }
  async findRoots() {
    this.hit("findRoots");
    return [...this.files.values()].filter((f) => f.meta.appProperties?.notefiraRoot === "1" && !f.trashed).map((f) => ({ ...f.meta }));
  }
  async createFolder(name: string, appProperties: Record<string, string>) {
    this.hit("createFolder");
    const id = "root" + ++this.n;
    const t = this.t();
    this.files.set(id, { meta: { id, name, appProperties, createdTime: t, modifiedTime: t }, parent: "", data: new Uint8Array(), trashed: false });
    return { ...this.files.get(id)!.meta };
  }
  async rename(id: string, name: string) {
    this.hit("rename");
    this.files.get(id)!.meta.name = name;
  }
  async move(id: string, _from: string, to: string) {
    this.hit("move");
    this.files.get(id)!.parent = to;
  }
  async list(folder: string) {
    this.hit("list");
    return [...this.files.values()].filter((f) => f.parent === folder && !f.trashed).map((f) => ({ ...f.meta }));
  }
  async get(id: string) {
    this.hit("get");
    const f = this.files.get(id);
    return f && !f.trashed ? { ...f.meta } : null;
  }
  async download(id: string) {
    this.hit("download");
    return this.files.get(id)!.data;
  }
  async create(parent: string, name: string, _m: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    this.hit("create");
    const id = "f" + ++this.n;
    const t = this.t();
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    this.files.set(id, { meta: { id, name, appProperties, createdTime: t, modifiedTime: t }, parent, data: bytes, trashed: false });
    return { ...this.files.get(id)!.meta };
  }
  async update(id: string, name: string, _m: string, appProperties: Record<string, string>, data: Uint8Array | Blob) {
    this.hit("update");
    const f = this.files.get(id)!;
    f.meta = { ...f.meta, name, appProperties, modifiedTime: this.t() };
    f.data = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    return { ...f.meta };
  }
  async trash(id: string) {
    this.hit("trash");
    const f = this.files.get(id);
    if (f) f.trashed = true;
  }
  async listRevisions() {
    return [];
  }
  async downloadRevision(): Promise<Uint8Array> {
    throw new Error("not used");
  }
}

const run = Math.random().toString(36).slice(2);
async function device(name: string) {
  await closeDB();
  setDbName(`polish-${name}-${run}`);
}
afterAll(() => closeDB());

describe("when automatic sync runs", () => {
  const base = { now: 100_000, manual: false, pointerDown: false, lastInputAt: 0, lastRunStartedAt: 0 };
  it("never during handwriting, and only after the pen has been idle briefly", () => {
    expect(autoSyncWait({ ...base, pointerDown: true })).toBe(IDLE_MS);
    expect(autoSyncWait({ ...base, lastInputAt: base.now - 1000 })).toBe(IDLE_MS - 1000);
    expect(autoSyncWait({ ...base, lastInputAt: base.now - IDLE_MS })).toBe(0);
  });
  it("never back to back (minimum gap), while a manual sync is always allowed", () => {
    expect(autoSyncWait({ ...base, lastRunStartedAt: base.now - 5000 })).toBe(MIN_AUTO_GAP_MS - 5000);
    expect(autoSyncWait({ ...base, lastRunStartedAt: base.now - MIN_AUTO_GAP_MS })).toBe(0);
    expect(autoSyncWait({ ...base, manual: true, pointerDown: true, lastRunStartedAt: base.now })).toBe(0);
  });
});

describe("Drive request economy", () => {
  it("a check with nothing changed makes two requests (find folder, list) and downloads nothing", async () => {
    const drive = new CountingDrive();
    await device("economy");
    await repo.createDoc({ title: "Quiet" });
    await repo.createFolder("Class", null);
    await syncOnce(drive, A);
    drive.calls = [];
    await syncOnce(drive, A);
    expect(drive.calls).toEqual(["findRoots", "list"]);
  });
  it("still picks up folder changes from this device and from Drive", async () => {
    const drive = new CountingDrive();
    await device("economy-b");
    const f = await repo.createFolder("Class", null);
    await syncOnce(drive, A);
    await (await import("../src/storage/db")).put("folders", { ...f, name: "Renamed", updated: Date.now() + 1 }); // a rename
    drive.calls = [];
    await syncOnce(drive, A);
    expect(drive.calls).toContain("update"); // the library file was rewritten
    // another device changed the library file: it is downloaded again
    const lib = [...drive.files.values()].find((x) => x.meta.appProperties?.nfType === "library")!;
    lib.meta.modifiedTime = "2099-01-01T00:00:00.000Z";
    drive.calls = [];
    await syncOnce(drive, A);
    expect(drive.calls).toContain("download");
  });
  it("Google's Retry-After is honoured (seconds or a date), within a sane cap", () => {
    expect(retryAfterMs("3", 0)).toBe(3000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
    expect(retryAfterMs("9999", 0)).toBe(120_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
  it("a rate-limited request waits as told and then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const responses = [new Response("rate limit", { status: 429, headers: { "Retry-After": "2" } }), new Response(JSON.stringify({ files: [] }), { status: 200 })];
      const fetchImpl = vi.fn(async () => responses.shift()!);
      const client = new DriveClient(async () => "t", () => {}, fetchImpl as any);
      const p = client.findRoots();
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("accurate status", () => {
  it("opening a notebook is not a change; editing one, or a folder, is — until Drive confirms", async () => {
    const drive = new CountingDrive();
    await device("status");
    const d = await repo.createDoc({ title: "Open me" });
    await syncOnce(drive, A);
    expect(await syncSummary(A)).toMatchObject({ pending: 0, libraryPending: false });
    await repo.saveDoc({ ...(await repo.getDoc(d.id))!, opened: Date.now() }, false); // what opening does
    expect(await syncSummary(A)).toMatchObject({ pending: 0, libraryPending: false });
    await repo.createFolder("New folder", null);
    expect((await syncSummary(A)).libraryPending).toBe(true);
    await syncOnce(drive, A);
    expect((await syncSummary(A)).libraryPending).toBe(false);
  });
  it("notebooks in Trash are not counted as needing a decision", async () => {
    await device("status-trash");
    const a = await repo.createDoc({ title: "Visible" });
    const b = await repo.createDoc({ title: "Trashed" });
    for (const d of [a, b]) await (await import("../src/storage/db")).put("docs", { ...(await repo.getDoc(d.id))!, syncAccount: "someone@else.com", remoteId: "x" });
    await repo.trashDoc(b.id);
    expect((await syncSummary(A)).attention).toBe(1);
  });
});

describe("conflict choices", () => {
  it("both versions stay until a choice; Keep both turns the copy into an ordinary notebook on every device", async () => {
    const drive = new CountingDrive();
    await device("cc-a");
    const d = await repo.createDoc({ title: "Report" });
    await syncOnce(drive, A);
    await device("cc-b");
    await syncOnce(drive, A);
    const p = (await repo.loadPages((await repo.getDoc(d.id))!)).pages.get((await repo.getDoc(d.id))!.pageIds[0])!;
    await repo.savePages((await repo.getDoc(d.id))!, [{ ...p, items: [{ id: "b", kind: "text", x: 0, y: 0, w: 1, h: 1, rot: 0, text: "B" } as any] }]);
    await syncOnce(drive, A);
    await device("cc-a");
    const pa = (await repo.loadPages((await repo.getDoc(d.id))!)).pages.get((await repo.getDoc(d.id))!.pageIds[0])!;
    await repo.savePages((await repo.getDoc(d.id))!, [{ ...pa, items: [{ id: "a", kind: "text", x: 0, y: 0, w: 1, h: 1, rot: 0, text: "A" } as any] }]);
    await syncOnce(drive, A);
    expect((await syncSummary(A)).conflicts).toBe(1);
    await device("cc-b");
    await syncOnce(drive, A);
    expect((await syncSummary(A)).conflicts).toBe(1); // the other device sees the same conflict
    const copy = (await repo.listDocs()).find((x) => x.conflictOf)!;
    // nothing is removed before a choice: both versions are here and in Drive
    expect(await repo.getDoc(copy.id)).toBeTruthy();
    await resolveConflictChoice(copy.id, "keep-both");
    expect((await syncSummary(A)).conflicts).toBe(0);
    await syncOnce(drive, A);
    await device("cc-a");
    await syncOnce(drive, A);
    expect((await syncSummary(A)).conflicts).toBe(0);
    expect((await repo.listDocs()).filter((x) => !x.deletedAt)).toHaveLength(2);
  });
});

describe("missing Drive permission and expired sign-in", () => {
  it("detects a sign-in without the Drive permission", () => {
    expect(hasDriveScope("openid email https://www.googleapis.com/auth/drive.file profile")).toBe(true);
    expect(hasDriveScope("openid email profile")).toBe(false);
    expect(isPermissionError(403, '{"error":{"message":"Request had insufficient authentication scopes."}}')).toBe(true);
    expect(isPermissionError(403, "User rate limit exceeded")).toBe(false);
  });
  it("a permission error from Drive is not retried and stops the run", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"Insufficient Permission"}}', { status: 403 }));
    const client = new DriveClient(async () => "t", () => {}, fetchImpl as any);
    const err = await client.findRoots().catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stopsRun(err)).toBe(true);
  });
  it("an expired web sign-in never opens a Google window by itself: it asks to reconnect", async () => {
    auth.set({ account: { email: A, name: "A" }, needsReconnect: false });
    const err = await getToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRequired);
    expect(err.name).toBe("AuthRequired"); // survives production minification
    expect(auth.get().needsReconnect).toBe(true);
    expect(stopsRun(err)).toBe(true);
    auth.set({ account: null, needsReconnect: false });
  });
  it("edits made while the sign-in is expired are kept and upload after reconnecting", async () => {
    const drive = new CountingDrive();
    await device("expired");
    const d = await repo.createDoc({ title: "Lecture" });
    await syncOnce(drive, A);
    const cur = (await repo.getDoc(d.id))!;
    const p = (await repo.loadPages(cur)).pages.get(cur.pageIds[0])!;
    await repo.savePages(cur, [{ ...p, items: [{ id: "n", kind: "text", x: 0, y: 0, w: 1, h: 1, rot: 0, text: "written while expired" } as any] }]);
    const before = await kvGet<number>("lastSync", 0);
    drive.failNext = { op: "findRoots", error: new AuthRequired("expired") };
    await expect(syncOnce(drive, A)).rejects.toBeInstanceOf(AuthRequired);
    expect(await kvGet("lastSync", 0)).toBe(before);
    expect((await syncSummary(A)).pending).toBe(1);
    // reconnected: the edit uploads
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    expect((await syncSummary(A)).pending).toBe(0);
  });
});

describe("Google Drive or this device only", () => {
  it("a device-only notebook is never uploaded, while others sync as usual", async () => {
    const drive = new CountingDrive();
    await device("local-only");
    const cloud = await repo.createDoc({ title: "Synced" });
    const mine = await repo.createDoc({ title: "Private", localOnly: true });
    await syncOnce(drive, A);
    const names = [...drive.files.values()].filter((f) => f.meta.appProperties?.nfType === "doc").map((f) => f.meta.appProperties!.nfId);
    expect(names).toEqual([cloud.id]);
    expect((await syncSummary(A)).pending).toBe(0); // not counted as waiting
    // an editor holding an older copy cannot switch it back to syncing
    const stale = (await repo.getDoc(mine.id))!;
    const { localOnly: _l, ...withoutFlag } = stale;
    await repo.saveDoc(withoutFlag as any);
    expect((await repo.getDoc(mine.id))!.localOnly).toBe(true);
    await syncOnce(drive, A);
    expect([...drive.files.values()].some((f) => f.meta.appProperties?.nfId === mine.id)).toBe(false);
    // the flag is a device setting: never written into exported files
    const { exportNotefira } = await import("../src/services/transfer");
    const { decodeJson } = await import("../src/model/format");
    expect((await decodeJson(await exportNotefira(mine.id))).doc.localOnly).toBeUndefined();
  });

  it("turning sync on uploads it; turning it off later keeps the Drive copy and ignores Drive changes", async () => {
    const drive = new CountingDrive();
    await device("toggle");
    const d = await repo.createDoc({ title: "Later", localOnly: true });
    await syncOnce(drive, A);
    await repo.setLocalOnly(d.id, false);
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
    const file = [...drive.files.values()].find((f) => f.meta.appProperties?.nfId === d.id)!;
    await repo.setLocalOnly(d.id, true);
    file.meta.appProperties = { ...file.meta.appProperties!, nfRev: "changed-elsewhere" };
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ downloaded: 0, uploaded: 0, trashed: 0, attention: 0 });
    expect(file.trashed).toBe(false); // never deleted from Drive
    expect((await repo.getDoc(d.id))!.localOnly).toBe(true);
  });
});

describe("sign-in configuration", () => {
  it("the test switch is remembered per browser and can be turned off", async () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const { applyTestSwitch, testMode } = await import("../src/sync/config");
    expect(testMode()).toBe(false);
    applyTestSwitch("?google-test=on");
    expect(testMode()).toBe(true);
    applyTestSwitch("?other=1");
    expect(testMode()).toBe(true);
    applyTestSwitch("?google-test=off");
    expect(testMode()).toBe(false);
    delete (globalThis as any).localStorage;
  });
  it("no client secret and no client ID field reach production code paths", async () => {
    const google = (await import("../src/sync/google.ts?raw")).default as string;
    const config = (await import("../src/sync/config.ts?raw")).default as string;
    expect(config).toContain("DEV_BUILD");
    expect(google).not.toMatch(/GOCSPX-/); // Google client secrets start with this
    expect(config).not.toMatch(/GOCSPX-/);
  });
});


/** Everything a Drive holds, as searchable text: file names, tags, and every file's (decompressed) bytes. */
async function driveText(drive: CountingDrive): Promise<string> {
  const { gunzipLimited } = await import("../src/model/format");
  const parts: string[] = [];
  for (const f of drive.files.values()) {
    parts.push(f.meta.name, JSON.stringify(f.meta.appProperties ?? {}));
    let bytes = f.data;
    try {
      bytes = await gunzipLimited(f.data, 1e8);
    } catch {
      /* not compressed */
    }
    parts.push(new TextDecoder().decode(bytes));
  }
  return parts.join("\n");
}

async function addText(docId: string, text: string) {
  const d = (await repo.getDoc(docId))!;
  const p = (await repo.loadPages(d)).pages.get(d.pageIds[0])!;
  await repo.savePages(d, [{ ...p, items: [...p.items, { id: "t" + Math.random().toString(36).slice(2), kind: "text", x: 0, y: 0, w: 10, h: 10, rot: 0, text } as any] }]);
}

describe("device-only notebooks never leave the device", () => {
  it("not through the notebook, its title, attachments, study sets, folders, duplicates or another account", async () => {
    const alice = new CountingDrive();
    const bob = new CountingDrive();
    await device("leak");
    const SECRET = "PRIVATE-MARKER-7f3a";
    const synced = await repo.createDoc({ title: "Shared notes" });
    const priv = await repo.createDoc({ title: `Diary ${SECRET}`, localOnly: true });
    await addText(priv.id, `content ${SECRET}`);
    await repo.putAsset(new Blob([new TextEncoder().encode(`attachment ${SECRET}`)], { type: "image/png" }), priv.id, `photo-${SECRET}.png`);
    await repo.saveDeck({ id: "deck-private", name: `Cards ${SECRET}`, docId: priv.id, cards: [{ id: "c", front: { text: `card ${SECRET}` }, back: {}, ease: 2.5, interval: 1, reps: 0, lapses: 0, due: 0, created: 1, updated: 1 }], created: 1, updated: 1 });
    await repo.saveDeck({ id: "deck-shared", name: "Shared cards", docId: synced.id, cards: [], created: 1, updated: 1 });
    const folder = await repo.createFolder("Folder", null);
    await repo.saveDoc({ ...(await repo.getDoc(priv.id))!, folderId: folder.id }); // moved into a synced folder
    const copy = await repo.duplicateDoc(priv.id);
    expect(copy?.localOnly).toBe(true); // a duplicate stays device-only
    await syncOnce(alice, A);
    await addText(priv.id, `edited ${SECRET}`);
    await syncOnce(alice, A);
    await syncOnce(bob, "bob@example.com"); // account switch
    for (const drive of [alice, bob]) {
      const text = await driveText(drive);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(priv.id);
    }
    expect(await driveText(alice)).toContain("Shared cards"); // ordinary study sets still sync
    expect((await syncSummary(A)).pending).toBe(0);
  });

  it("switching a synced notebook to device-only keeps its Drive copy (never removed by itself) and withdraws its study sets", async () => {
    const drive = new CountingDrive();
    await device("switch");
    const d = await repo.createDoc({ title: "Was synced" });
    await repo.saveDeck({ id: "deck-x", name: "Deck of it", docId: d.id, cards: [], created: 1, updated: 1 });
    await syncOnce(drive, A);
    expect(await driveText(drive)).toContain("Deck of it");
    await repo.setLocalOnly(d.id, true);
    const r = await syncOnce(drive, A);
    expect(r).toMatchObject({ trashed: 0, removedFromDrive: 0 });
    const docFile = [...drive.files.values()].find((f) => f.meta.appProperties?.nfId === d.id)!;
    expect(docFile.trashed).toBe(false);
    expect(await driveText(drive)).not.toContain("Deck of it");
  });
});

describe("removing the Google Drive copy of a device-only notebook", () => {
  async function setup(name: string) {
    const drive = new CountingDrive();
    await device(name);
    const d = await repo.createDoc({ title: "To remove" });
    await addText(d.id, "keep me");
    const own = await repo.putAsset(new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }), d.id);
    const shared = await repo.putAsset(new Blob([new Uint8Array([7, 7, 7])], { type: "image/png" }), d.id);
    const other = await repo.createDoc({ title: "Other" });
    await repo.putAsset(new Blob([new Uint8Array([7, 7, 7])], { type: "image/png" }), other.id); // same picture
    const cur = (await repo.getDoc(d.id))!;
    const p = (await repo.loadPages(cur)).pages.get(cur.pageIds[0])!;
    await repo.savePages(cur, [{ ...p, bg: { type: "pdf", asset: own.id, page: 0, rot: 0 }, items: [...p.items, { id: "im", kind: "image", x: 0, y: 0, w: 1, h: 1, rot: 0, asset: shared.id } as any] }]);
    await syncOnce(drive, A);
    return { drive, d };
  }
  const live = (drive: CountingDrive, type: string) => [...drive.files.values()].filter((f) => f.meta.appProperties?.nfType === type && !f.trashed);

  it("happens only when asked, after verifying this device's copy, and only to unshared attachments", async () => {
    const { drive, d } = await setup("remove");
    expect(live(drive, "doc")).toHaveLength(2);
    expect(live(drive, "blob")).toHaveLength(2);
    await repo.setLocalOnly(d.id, true);
    await syncOnce(drive, A);
    expect(live(drive, "doc")).toHaveLength(2); // switching alone removes nothing
    expect(await repo.requestCloudRemoval(d.id)).toBe(true);
    const r = await syncOnce(drive, A);
    expect(r.removedFromDrive).toBe(1);
    expect(live(drive, "doc").map((f) => f.meta.name)).toEqual([expect.stringContaining("Other")]);
    expect(live(drive, "blob")).toHaveLength(1); // the picture the other notebook also uses stays
    const after = (await repo.getDoc(d.id))!;
    expect(after.localOnly).toBe(true);
    expect(after.remoteId).toBeUndefined();
    expect(after.cloudRemoval).toBeUndefined();
    const texts = (await repo.loadPages(after)).pages.get(after.pageIds[0])!.items.map((i: any) => i.text).filter(Boolean);
    expect(texts).toEqual(["keep me"]); // this device's copy is untouched
    // turning sync back on uploads it again as a fresh copy
    await repo.setLocalOnly(d.id, false);
    expect((await syncOnce(drive, A)).uploaded).toBe(1);
  });

  it("is refused, leaving Drive untouched, when this device's copy is incomplete", async () => {
    const { drive, d } = await setup("remove-refused");
    await repo.setLocalOnly(d.id, true);
    await repo.requestCloudRemoval(d.id);
    const cur = (await repo.getDoc(d.id))!;
    const pdf = (await repo.loadPages(cur)).pages.get(cur.pageIds[0])!.bg as any;
    await (await import("../src/storage/db")).del("assets", pdf.asset); // the PDF went missing locally
    const r = await syncOnce(drive, A);
    expect(r.removedFromDrive).toBe(0);
    expect(r.errors[0]).toMatch(/not removed from Google Drive.*Nothing was deleted/);
    expect(live(drive, "doc")).toHaveLength(2);
    expect(live(drive, "blob")).toHaveLength(2);
    expect((await repo.getDoc(d.id))!.cloudRemoval).toBeUndefined();
  });

  it("waits while a different Google account is signed in", async () => {
    const { drive, d } = await setup("remove-account");
    await repo.setLocalOnly(d.id, true);
    await repo.requestCloudRemoval(d.id);
    expect((await syncOnce(new CountingDrive(), "bob@example.com")).removedFromDrive).toBe(0);
    expect((await repo.getDoc(d.id))!.cloudRemoval).toBe(true);
    expect((await syncOnce(drive, A)).removedFromDrive).toBe(1);
  });

  it("other devices keep their copy and are asked what to do", async () => {
    const { drive, d } = await setup("remove-other-a");
    await device("remove-other-b");
    await syncOnce(drive, A);
    await device("remove-other-a");
    await repo.setLocalOnly(d.id, true);
    await repo.requestCloudRemoval(d.id);
    await syncOnce(drive, A);
    await device("remove-other-b");
    await syncOnce(drive, A);
    const there = (await repo.getDoc(d.id))!;
    expect(there.deletedAt).toBeFalsy();
    expect(there.syncIssue?.kind).toBe("missing");
  });
});
