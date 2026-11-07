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

