// Background sync orchestration. A run starts after edits (debounced), when the
// window or tab comes back into view, every minute while it is visible (every
// five while hidden), and when the connection returns. Runs never overlap (one
// at a time per tab, one tab at a time), automatic runs keep a minimum gap and
// wait until the pen has been idle briefly, and failures back off exponentially.
// Progress is exposed for the UI.
import { createStore, settingsStore, log, toast } from "../state/store";
import { auth, getToken, invalidateToken, signOut, AuthRequired, DRIVE_PERMISSION_MESSAGE } from "./google";
import { DriveClient } from "./drive";
import { deleteAllDriveData, restartSync, setBeforeApply, syncOnce, syncSummary, type SyncProgress, type SyncReport, type SyncSummary } from "./engine";
import { onChange } from "../storage/repo";
import { flushAll } from "../editor/session";
import { kvGet } from "../storage/db";

/**
 * What the badge shows. "synced" is only used after Drive confirmed every change;
 * "pending" means local changes are waiting; "attention" means a notebook needs
 * the user's decision; "conflict" means a notebook was edited on two devices and
 * both versions were kept.
 */
export type SyncState = "signed-out" | "synced" | "syncing" | "pending" | "offline" | "conflict" | "attention" | "error" | "paused";

export const syncStore = createStore<{
  state: SyncState;
  progress: SyncProgress | null;
  lastSync: number | null;
  error: string | null;
  lastReport: SyncReport | null;
  pending: boolean;
  summary: SyncSummary;
  /** The sync folder was deleted from Drive after this device synced: paused until the user decides. */
  folderGone: boolean;
}>({
  state: "signed-out",
  progress: null,
  lastSync: null,
  error: null,
  lastReport: null,
  pending: false,
  summary: { pending: 0, attention: 0, conflicts: 0 },
  folderGone: false,
});

let client: DriveClient | null = null;
export function drive(): DriveClient {
  if (!client) client = new DriveClient(() => getToken(), () => invalidateToken());
  return client;
}

let running: Promise<void> | null = null;
let timer: any = null;
let due = 0;
let failures = 0;
let started = false;
let lastFailed = false;
let lastRunStartedAt = 0;
let lastInputAt = 0;
let pointerDown = false;

/** Automatic runs are at least this far apart (manual "Sync now" is not limited). */
export const MIN_AUTO_GAP_MS = 20_000;
/** Automatic runs wait until the pen or keyboard has been idle this long. */
export const IDLE_MS = 2_500;

export interface TriggerContext {
  now: number;
  manual: boolean;
  pointerDown: boolean;
  lastInputAt: number;
  lastRunStartedAt: number;
}

/** 0: start now. Otherwise how long to wait before trying again (never during handwriting, never back to back). */
export function autoSyncWait(c: TriggerContext): number {
  if (c.manual) return 0;
  if (c.pointerDown) return IDLE_MS;
  const idle = c.now - c.lastInputAt;
  if (idle < IDLE_MS) return IDLE_MS - idle;
  const gap = c.now - c.lastRunStartedAt;
  if (gap < MIN_AUTO_GAP_MS) return MIN_AUTO_GAP_MS - gap;
  return 0;
}

/** Recompute the badge state from the database (pending changes, notebooks needing a decision, conflicts). */
export async function refreshSyncState() {
  const acc = auth.get().account;
  const summary = await syncSummary(acc?.email ?? null).catch(() => syncStore.get().summary);
  const cur = syncStore.get();
  let state: SyncState;
  if (!acc) state = "signed-out";
  else if (running) state = "syncing";
  else if (typeof navigator !== "undefined" && !navigator.onLine) state = "offline";
  else if (lastFailed) state = cur.state === "offline" ? "offline" : "error";
  else if (cur.folderGone || summary.attention) state = "attention";
  else if (summary.conflicts) state = "conflict";
  // only real, unconfirmed changes count as waiting (opening a notebook is not a change)
  else if (summary.pending || summary.libraryPending) state = !settingsStore.get().autoSync ? "paused" : "pending";
  else if (!settingsStore.get().autoSync && !cur.lastSync) state = "paused";
  else state = "synced";
  syncStore.set({ summary, state });
}

/** Ask for a run in `delay` ms. An earlier request is never pushed back, so steady editing cannot postpone sync forever. */
export function scheduleSync(delay = 8000) {
  if (!auth.get().account) return;
  void refreshSyncState();
  const at = Date.now() + delay;
  if (timer && due <= at) return;
  clearTimeout(timer);
  due = at;
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, delay);
}

/** Only one tab syncs at a time; another tab holding the lock is already doing the work. */
async function withSyncLock(fn: () => Promise<void>) {
  const locks = (typeof navigator !== "undefined" && (navigator as any).locks) || null;
  if (!locks) return fn();
  await locks.request("notefira-sync", { ifAvailable: true }, async (lock: unknown) => {
    if (lock) await fn();
  });
}

export async function syncNow(manual = false): Promise<void> {
  if (running) return running;
  const wait = autoSyncWait({ now: Date.now(), manual, pointerDown, lastInputAt, lastRunStartedAt });
  if (wait > 0) {
    scheduleSync(wait);
    return;
  }
  const acc = auth.get().account;
  if (acc && syncStore.get().folderGone && !manual) {
    // the sync folder was deleted: nothing is recreated or uploaded until the user decides
    await refreshSyncState();
    return;
  }
  if (acc && auth.get().needsReconnect && !manual) {
    // waiting for the user to reconnect: don't keep calling Google with an expired sign-in
    await refreshSyncState();
    return;
  }
  if (!acc) {
    syncStore.set({ state: "signed-out" });
    return;
  }
  if (!manual && !settingsStore.get().autoSync) {
    await refreshSyncState();
    return;
  }
  if (!navigator.onLine) {
    syncStore.set({ state: "offline" });
    void refreshSyncState();
    return;
  }
  lastRunStartedAt = Date.now();
  running = (async () => {
    syncStore.set({ state: "syncing", error: null, pending: false });
    try {
      await withSyncLock(async () => {
        await flushAll();
        const rep = await syncOnce(drive(), acc.email, (p) => syncStore.set({ progress: p }));
        failures = 0;
        lastFailed = rep.errors.length > 0;
        syncStore.set({ folderGone: false });
        syncStore.set({
          lastSync: await kvGet<number | null>("lastSync", null),
          progress: null,
          lastReport: rep,
          error: rep.errors.length ? rep.errors.join("\n") : null,
        });
        if (rep.conflicts) toast(`${rep.conflicts} notebook(s) were edited on two devices. Both versions were kept (look for “conflicted copy”).`, "info", undefined, 8000);
        if (rep.removedFromDrive) toast(`${rep.removedFromDrive} notebook(s) removed from Google Drive (moved to the Drive trash). They stay on this device.`, "success", undefined, 8000);
        if (rep.attention) toast(`${rep.attention} notebook(s) need your decision before they can sync. Nothing was deleted. See Settings → Cloud sync.`, "info", undefined, 10000);
        // never log notebook titles or contents
        if (rep.errors.length) log("warn", `Sync finished with ${rep.errors.length} error(s)`);
        if (rep.deferred || rep.errors.length) {
          clearTimeout(timer);
          timer = setTimeout(() => void syncNow(), rep.deferred ? 3000 : 60_000);
        }
      });
    } catch (e: any) {
      failures++;
      lastFailed = true;
      const offline = !navigator.onLine || e?.status === 0;
      const permission = e?.status === 403 && e?.message === "PERMISSION";
      if (e?.name === "SyncFolderGone") {
        failures = 0;
        lastFailed = false;
        syncStore.set({ folderGone: true, error: e.message, progress: null });
        return;
      }
      if (permission) auth.set({ needsReconnect: true });
      const msg = permission ? DRIVE_PERMISSION_MESSAGE : e instanceof AuthRequired ? "Reconnect your Google account to keep syncing. Your changes are saved on this device." : e?.message ?? String(e);
      syncStore.set({ state: offline ? "offline" : "error", error: msg, progress: null });
      log("error", "Sync failed" + (e?.status ? ` (HTTP ${e.status})` : ""));
      if (!(e instanceof AuthRequired) && !permission) {
        const delay = Math.min(10 * 60_000, 5000 * 2 ** Math.min(failures, 7));
        clearTimeout(timer);
        timer = setTimeout(() => void syncNow(), delay);
      }
    } finally {
      running = null;
      await refreshSyncState();
    }
  })();
  return running;
}

/** After the sync folder was deleted: the user chose to start syncing again (a new folder; this device's notebooks upload as new copies). */
export async function startSyncingAgain() {
  const acc = auth.get().account;
  if (!acc) return;
  await restartSync(acc.email);
  syncStore.set({ folderGone: false, error: null });
  await syncNow(true);
}

/**
 * Move everything Notefira created in the signed-in account's Google Drive to
 * the Drive trash, then sign out on this device. No sync runs meanwhile.
 */
export async function deleteDriveDataAndSignOut(): Promise<{ trashed: number; revoked: boolean }> {
  const acc = auth.get().account;
  if (!acc) throw new Error("Not signed in.");
  if (running) await running.catch(() => {});
  clearTimeout(timer);
  timer = null;
  let result: { trashed: number } = { trashed: 0 };
  const job = (async () => {
    await withSyncLock(async () => {
      result = await deleteAllDriveData(drive(), acc.email);
    });
  })();
  running = job;
  try {
    await job;
  } finally {
    running = null;
  }
  const { revoked } = await signOut();
  syncStore.set({ folderGone: false, lastSync: null, lastReport: null, error: null });
  return { trashed: result.trashed, revoked };
}

export async function startSyncScheduler() {
  if (started) return;
  started = true;
  // an open notebook saves its unsaved strokes before a download is applied; the engine then sees the edit and keeps both versions
  setBeforeApply(() => flushAll());
  syncStore.set({ lastSync: await kvGet<number | null>("lastSync", null) });
  await refreshSyncState();
  let lastEmail = auth.get().account?.email ?? null;
  auth.subscribe(() => {
    const email = auth.get().account?.email ?? null;
    if (email !== lastEmail) {
      // a different account: "last synced" belonged to the previous one
      lastEmail = email;
      lastFailed = false;
      syncStore.set({ lastSync: null, lastReport: null, error: null, folderGone: false });
    }
    void refreshSyncState();
  });
  onChange((topic) => {
    if (topic === "library" || topic === "decks" || topic.startsWith("recordings:")) scheduleSync(10_000);
  });
  window.addEventListener("online", () => scheduleSync(1500));
  window.addEventListener("offline", () => void refreshSyncState());
  // handwriting in progress: automatic runs wait until the pen is idle
  const input = () => (lastInputAt = Date.now());
  window.addEventListener("pointerdown", () => ((pointerDown = true), input()), { capture: true, passive: true });
  for (const t of ["pointerup", "pointercancel"]) window.addEventListener(t, () => ((pointerDown = false), input()), { capture: true, passive: true });
  window.addEventListener("keydown", input, { capture: true, passive: true });
  // coming back to Notefira: look for changes made on other devices
  const returned = () => {
    if (document.visibilityState === "visible" && Date.now() - lastRunStartedAt > 15_000) scheduleSync(800);
  };
  document.addEventListener("visibilitychange", returned);
  window.addEventListener("focus", returned);
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (document.visibilityState === "visible" || ticks % 5 === 0) scheduleSync(0);
  }, 60_000);
  if (auth.get().account) scheduleSync(2500);
}
